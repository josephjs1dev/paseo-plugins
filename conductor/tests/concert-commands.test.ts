import assert from "node:assert/strict";
import test from "node:test";
import {
  concertCommandSchema,
  widenCommandSchema,
  widenedAgentCommandRequestSchema,
} from "../shared/concerts/commands";
import {
  attemptSchema,
  CONCERT_LIMITS,
  taskReportSchema,
} from "../shared/concerts/models";
import { concertAck } from "../server/concerts/commands/ack";

const id = "6f1c2b9e-4b7a-4c1e-9f0a-2d3e4f5a6b7c";
const otherId = "0b8e7d6c-5a4b-4c3d-8e2f-1a0b9c8d7e6f";
const task = {
  id: "a",
  title: "Inspect",
  description: "Inspect the API",
};

void test("commands take concertId and accept runId and performanceId from older prompts", () => {
  const get = { kind: "get", concertId: id };
  assert.deepEqual(concertCommandSchema.parse(get), get);
  for (const legacy of ["runId", "performanceId"]) {
    assert.deepEqual(
      concertCommandSchema.parse({ kind: "get", [legacy]: id }),
      get,
    );
    assert.deepEqual(
      concertCommandSchema.parse({ kind: "get", [legacy]: id, concertId: id }),
      get,
    );
    assert.throws(() =>
      concertCommandSchema.parse({
        kind: "get",
        [legacy]: id,
        concertId: otherId,
      }),
    );
  }
  assert.deepEqual(
    concertCommandSchema.parse({ kind: "get", runId: id, performanceId: id }),
    get,
  );
  assert.throws(() =>
    concertCommandSchema.parse({
      kind: "get",
      runId: id,
      performanceId: otherId,
    }),
  );
});

void test("a task or retry uses either a profile or an inline worker choice", () => {
  const define = (worker: Record<string, string>) =>
    concertCommandSchema.safeParse({
      kind: "define",
      concertId: id,
      tasks: [{ ...task, ...worker }],
    }).success;
  assert.equal(define({ profile: "Small" }), true);
  assert.equal(define({ provider: "pi", model: "pi-test" }), true);
  assert.equal(define({ profile: "Small", provider: "pi" }), false);
  assert.equal(define({ profile: "Small", thinkingOptionId: "high" }), false);
  const dispatch = (worker: Record<string, string>) =>
    concertCommandSchema.safeParse({
      kind: "dispatch",
      concertId: id,
      retryTaskId: "a",
      ...worker,
    }).success;
  assert.equal(dispatch({ model: "pi-test" }), true);
  assert.equal(dispatch({ profile: "Small", model: "pi-test" }), false);
  assert.equal(
    concertCommandSchema.safeParse({ kind: "models" }).success,
    true,
  );
});

void test("acknowledgements expose concert naming and pass other fields through", () => {
  const run = { id, status: "planning" };
  assert.deepEqual(concertAck({ run, instructions: "Define tasks" }), {
    concertId: id,
    concert: run,
    instructions: "Define tasks",
  });
  assert.deepEqual(concertAck({ runs: [run], next: null }), {
    concerts: [run],
    next: null,
  });
  assert.deepEqual(concertAck({ profiles: [] }), { profiles: [] });
  assert.equal(concertAck(null), null);
});

void test("dispatch note and addWrites are accepted only together with retryTaskId", () => {
  const retry = { kind: "dispatch", concertId: id, retryTaskId: "a" };
  assert.equal(concertCommandSchema.safeParse(retry).success, true);
  assert.deepEqual(
    concertCommandSchema.parse({
      ...retry,
      note: "Try the shared schema first",
      addWrites: ["shared/schema.ts"],
    }),
    {
      ...retry,
      note: "Try the shared schema first",
      addWrites: ["shared/schema.ts"],
    },
  );
  for (const extra of [
    { note: "guidance" },
    { addWrites: ["shared/schema.ts"] },
  ]) {
    assert.equal(
      concertCommandSchema.safeParse({
        kind: "dispatch",
        concertId: id,
        ...extra,
      }).success,
      false,
      JSON.stringify(extra),
    );
  }
  // A retry stays free of both fields, and addWrites cannot be empty.
  assert.equal(concertCommandSchema.safeParse(retry).success, true);
  assert.equal(
    concertCommandSchema.safeParse({ ...retry, addWrites: [] }).success,
    false,
  );
  assert.equal(
    concertCommandSchema.safeParse({ ...retry, addWrites: ["../secret"] })
      .success,
    false,
  );
});

void test("widen accepts 1 to 5 literal paths with a reason and rejects malformed input", () => {
  assert.equal(CONCERT_LIMITS.widenPathsPerCall, 5);
  assert.equal(CONCERT_LIMITS.widenCallsPerAttempt, 2);
  const widen = {
    kind: "widen",
    concertId: id,
    attemptId: otherId,
    paths: ["shared/schema.ts"],
    reason: "My change breaks the exported schema that typecheck reads",
  };
  assert.deepEqual(widenCommandSchema.parse(widen), widen);
  assert.equal(
    widenCommandSchema.safeParse({
      ...widen,
      paths: Array.from(
        { length: CONCERT_LIMITS.widenPathsPerCall },
        (_, index) => `src/file-${index}.ts`,
      ),
    }).success,
    true,
  );
  assert.equal(
    widenCommandSchema.safeParse({ ...widen, paths: [] }).success,
    false,
  );
  assert.equal(
    widenCommandSchema.safeParse({
      ...widen,
      paths: Array.from(
        { length: CONCERT_LIMITS.widenPathsPerCall + 1 },
        (_, index) => `src/file-${index}.ts`,
      ),
    }).success,
    false,
  );
  assert.equal(
    widenCommandSchema.safeParse({ ...widen, reason: "   " }).success,
    false,
  );
  assert.equal(
    widenCommandSchema.safeParse({ ...widen, paths: ["../secret"] }).success,
    false,
  );
  assert.equal(
    widenCommandSchema.safeParse({ ...widen, paths: ["src/**"] }).success,
    false,
  );
  assert.equal(
    widenCommandSchema.safeParse({ ...widen, extra: true }).success,
    false,
  );
  // The widened request schema routes both ordinary commands and widen.
  assert.equal(
    widenedAgentCommandRequestSchema.safeParse({
      agentId: "worker-1",
      command: widen,
    }).success,
    true,
  );
  assert.equal(
    widenedAgentCommandRequestSchema.safeParse({
      agentId: "worker-1",
      command: { kind: "get", concertId: id },
    }).success,
    true,
  );
});

void test("failed reports may carry a diagnosis and completed reports reject it", () => {
  const base = {
    outcome: "failed" as const,
    summary: "Typecheck fails in the new RPC handler",
    evidence: ["npm run typecheck: TS2345 in server/rpc.ts:41"],
    checks: [],
  };
  const diagnosis = {
    tried: ["Narrowed the input type", "Regenerated the schema"],
    suspectedCause: "shared/schema.ts exports the old shape",
    need: "scope" as const,
    requestedWrites: ["shared/schema.ts"],
  };
  assert.equal(
    taskReportSchema.safeParse({ ...base, diagnosis }).success,
    true,
  );
  assert.equal(taskReportSchema.safeParse(base).success, true);
  // need scope requires at least one requested path.
  assert.equal(
    taskReportSchema.safeParse({
      ...base,
      diagnosis: { tried: ["tried"], suspectedCause: "cause", need: "scope" },
    }).success,
    false,
  );
  // Other needs do not require paths, and an unknown need is rejected.
  assert.equal(
    taskReportSchema.safeParse({
      ...base,
      diagnosis: { tried: ["tried"], suspectedCause: "cause", need: "input" },
    }).success,
    true,
  );
  assert.equal(
    taskReportSchema.safeParse({
      ...base,
      diagnosis: { tried: ["tried"], suspectedCause: "cause", need: "other" },
    }).success,
    false,
  );
  // A completed report cannot include a diagnosis.
  assert.equal(
    taskReportSchema.safeParse({ ...base, outcome: "completed", diagnosis })
      .success,
    false,
  );
  // Requested paths use the same literal-path validation as define scopes.
  assert.equal(
    taskReportSchema.safeParse({
      ...base,
      diagnosis: { ...diagnosis, requestedWrites: ["../secret"] },
    }).success,
    false,
  );
  // The diagnosis shape is strict.
  assert.equal(
    taskReportSchema.safeParse({
      ...base,
      diagnosis: { ...diagnosis, extra: true },
    }).success,
    false,
  );
});

void test("attempts without the recovery fields still parse and new fields are bounded", () => {
  const legacyAttempt = {
    id,
    taskId: "a",
    agentId: "agent-1",
    state: "completed" as const,
    startedAt: 1,
    endedAt: 2,
    message: null,
    report: {
      outcome: "completed" as const,
      summary: "Done",
      evidence: ["Observed the behavior"],
      checks: [],
    },
    reportHash: null,
  };
  assert.equal(attemptSchema.safeParse(legacyAttempt).success, true);
  const parsed = attemptSchema.parse({
    ...legacyAttempt,
    grantedWrites: [
      { path: "shared/schema.ts", reason: "Typecheck reads it", at: 5 },
    ],
    nudgedAt: 3,
  });
  assert.deepEqual(parsed.grantedWrites, [
    { path: "shared/schema.ts", reason: "Typecheck reads it", at: 5 },
  ]);
  assert.equal(parsed.nudgedAt, 3);
  assert.equal(
    attemptSchema.safeParse({ ...legacyAttempt, nudgedAt: -1 }).success,
    false,
  );
  assert.equal(
    attemptSchema.safeParse({
      ...legacyAttempt,
      grantedWrites: Array.from(
        {
          length:
            CONCERT_LIMITS.widenPathsPerCall *
              CONCERT_LIMITS.widenCallsPerAttempt +
            1,
        },
        (_, index) => ({ path: `src/${index}`, reason: "reason", at: 1 }),
      ),
    }).success,
    false,
  );
  assert.equal(
    attemptSchema.safeParse({
      ...legacyAttempt,
      grantedWrites: [{ path: "src/a", reason: "", at: 1 }],
    }).success,
    false,
  );
});
