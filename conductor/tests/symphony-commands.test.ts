import assert from "node:assert/strict";
import test from "node:test";
import {
  agentCommandRequestSchema,
  symphonyCommandSchema,
} from "../shared/symphonies/commands";
import {
  attemptSchema,
  SYMPHONY_LIMITS,
  taskReportSchema,
} from "../shared/symphonies/models";
import { symphonyAck } from "../server/entrypoints/commands/ack";

const id = "6f1c2b9e-4b7a-4c1e-9f0a-2d3e4f5a6b7c";
const otherId = "0b8e7d6c-5a4b-4c3d-8e2f-1a0b9c8d7e6f";
const task = {
  id: "a",
  title: "Inspect",
  description: "Inspect the API",
};

void test("a task or retry uses either a profile or an inline worker choice", () => {
  const define = (worker: Record<string, string>) =>
    symphonyCommandSchema.safeParse({
      kind: "define",
      symphonyId: id,
      tasks: [{ ...task, ...worker }],
    }).success;
  assert.equal(define({ profile: "Small" }), true);
  assert.equal(define({ provider: "pi", model: "pi-test" }), true);
  assert.equal(define({ profile: "Small", provider: "pi" }), false);
  assert.equal(define({ profile: "Small", thinkingOptionId: "high" }), false);
  const dispatch = (worker: Record<string, string>) =>
    symphonyCommandSchema.safeParse({
      kind: "dispatch",
      symphonyId: id,
      retryTaskId: "a",
      ...worker,
    }).success;
  assert.equal(dispatch({ model: "pi-test" }), true);
  assert.equal(dispatch({ profile: "Small", model: "pi-test" }), false);
  assert.equal(
    symphonyCommandSchema.safeParse({ kind: "models" }).success,
    true,
  );
});

void test("acknowledgements expose symphony naming and pass other fields through", () => {
  const symphony = { id, status: "planning" };
  assert.deepEqual(symphonyAck({ symphony, instructions: "Define tasks" }), {
    symphonyId: id,
    symphony: symphony,
    instructions: "Define tasks",
  });
  assert.deepEqual(symphonyAck({ symphonies: [symphony], next: null }), {
    symphonies: [symphony],
    next: null,
  });
  assert.deepEqual(symphonyAck({ profiles: [] }), { profiles: [] });
  assert.equal(symphonyAck(null), null);
});

void test("dispatch note and addWrites are accepted only together with retryTaskId", () => {
  const retry = { kind: "dispatch", symphonyId: id, retryTaskId: "a" };
  assert.equal(symphonyCommandSchema.safeParse(retry).success, true);
  assert.deepEqual(
    symphonyCommandSchema.parse({
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
      symphonyCommandSchema.safeParse({
        kind: "dispatch",
        symphonyId: id,
        ...extra,
      }).success,
      false,
      JSON.stringify(extra),
    );
  }
  // A retry stays free of both fields, and addWrites cannot be empty.
  assert.equal(symphonyCommandSchema.safeParse(retry).success, true);
  assert.equal(
    symphonyCommandSchema.safeParse({ ...retry, addWrites: [] }).success,
    false,
  );
  assert.equal(
    symphonyCommandSchema.safeParse({ ...retry, addWrites: ["../secret"] })
      .success,
    false,
  );
});

void test("widen accepts 1 to 5 literal paths with a reason and rejects malformed input", () => {
  assert.equal(SYMPHONY_LIMITS.widenPathsPerCall, 5);
  assert.equal(SYMPHONY_LIMITS.widenCallsPerAttempt, 2);
  const widen = {
    kind: "widen",
    symphonyId: id,
    attemptId: otherId,
    paths: ["shared/schema.ts"],
    reason: "My change breaks the exported schema that typecheck reads",
  };
  assert.deepEqual(symphonyCommandSchema.parse(widen), widen);
  assert.equal(
    symphonyCommandSchema.safeParse({
      ...widen,
      paths: Array.from(
        { length: SYMPHONY_LIMITS.widenPathsPerCall },
        (_, index) => `src/file-${index}.ts`,
      ),
    }).success,
    true,
  );
  assert.equal(
    symphonyCommandSchema.safeParse({ ...widen, paths: [] }).success,
    false,
  );
  assert.equal(
    symphonyCommandSchema.safeParse({
      ...widen,
      paths: Array.from(
        { length: SYMPHONY_LIMITS.widenPathsPerCall + 1 },
        (_, index) => `src/file-${index}.ts`,
      ),
    }).success,
    false,
  );
  assert.equal(
    symphonyCommandSchema.safeParse({ ...widen, reason: "   " }).success,
    false,
  );
  assert.equal(
    symphonyCommandSchema.safeParse({ ...widen, paths: ["../secret"] }).success,
    false,
  );
  assert.equal(
    symphonyCommandSchema.safeParse({ ...widen, paths: ["src/**"] }).success,
    false,
  );
  assert.equal(
    symphonyCommandSchema.safeParse({ ...widen, extra: true }).success,
    false,
  );
  // The agent request schema routes both ordinary commands and widen.
  assert.equal(
    agentCommandRequestSchema.safeParse({
      agentId: "worker-1",
      command: widen,
    }).success,
    true,
  );
  assert.equal(
    agentCommandRequestSchema.safeParse({
      agentId: "worker-1",
      command: { kind: "get", symphonyId: id },
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
  const basicAttempt = {
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
  assert.equal(attemptSchema.safeParse(basicAttempt).success, true);
  const parsed = attemptSchema.parse({
    ...basicAttempt,
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
    attemptSchema.safeParse({ ...basicAttempt, nudgedAt: -1 }).success,
    false,
  );
  assert.equal(
    attemptSchema.safeParse({
      ...basicAttempt,
      grantedWrites: Array.from(
        {
          length:
            SYMPHONY_LIMITS.widenPathsPerCall *
              SYMPHONY_LIMITS.widenCallsPerAttempt +
            1,
        },
        (_, index) => ({ path: `src/${index}`, reason: "reason", at: 1 }),
      ),
    }).success,
    false,
  );
  assert.equal(
    attemptSchema.safeParse({
      ...basicAttempt,
      grantedWrites: [{ path: "src/a", reason: "", at: 1 }],
    }).success,
    false,
  );
});
