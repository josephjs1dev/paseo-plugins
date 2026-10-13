import assert from "node:assert/strict";
import test from "node:test";
import {
  agentCommandRequestSchema,
  symphonyCommandSchema,
} from "../shared/symphonies/commands";
import {
  attemptSchema,
  executionSchema,
  SYMPHONY_LIMITS,
  taskReportSchema,
  taskSchema,
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

void test("reports distinguish needs-changes from failed with findings and diagnosis rules", () => {
  const blocking = {
    id: "F1",
    severity: "blocking" as const,
    taskId: "api",
    paths: ["src/api.ts:41"],
    summary: "concertId is validated after its lookup.",
  };
  const report = (patch: Record<string, unknown>) =>
    taskReportSchema.safeParse({
      outcome: "needs-changes",
      summary: "The work ran but is not acceptable yet",
      evidence: ["Checks still red after fix rounds"],
      checks: [],
      ...patch,
    });
  // needs-changes requires a blocking finding or a failed check.
  assert.equal(report({ findings: [blocking] }).success, true);
  assert.equal(
    report({
      checks: [
        { name: "Regression", status: "failed" as const, detail: "Red." },
      ],
    }).success,
    true,
  );
  assert.equal(
    report({ findings: [{ ...blocking, severity: "minor" }] }).success,
    false,
  );
  assert.equal(report({}).success, false);
  assert.equal(report({ findings: [blocking], checks: [] }).success, true);
  // Diagnosis stays failed-only, so needs-changes cannot carry one.
  assert.equal(
    report({
      findings: [blocking],
      diagnosis: { tried: ["tried"], suspectedCause: "cause", need: "harness" },
    }).success,
    false,
  );
  // completed allows only minor findings and no diagnosis.
  const completed = {
    outcome: "completed" as const,
    summary: "Done",
    evidence: ["Observed the behavior"],
    checks: [],
  };
  assert.equal(
    taskReportSchema.safeParse({
      ...completed,
      findings: [{ ...blocking, severity: "minor" }],
    }).success,
    true,
  );
  assert.equal(
    taskReportSchema.safeParse({ ...completed, findings: [blocking] }).success,
    false,
  );
  // failed carries the diagnosis; need gains harness and keeps none.
  assert.equal(
    taskReportSchema.safeParse({
      outcome: "failed",
      summary: "Agent unreachable",
      evidence: ["Cannot launch"],
      checks: [],
      diagnosis: {
        tried: ["tried"],
        suspectedCause: "Launcher",
        need: "harness",
      },
    }).success,
    true,
  );
  assert.equal(
    taskReportSchema.safeParse({
      outcome: "failed",
      summary: "Stored before needs-changes",
      evidence: ["Old record"],
      checks: [],
      diagnosis: { tried: ["tried"], suspectedCause: "cause", need: "none" },
    }).success,
    true,
  );
  // Finding ids must be unique and the count is bounded.
  assert.equal(
    taskReportSchema.safeParse({
      ...completed,
      findings: [
        { ...blocking, severity: "minor" },
        { ...blocking, id: "F1" },
      ],
    }).success,
    false,
  );
  const many = Array.from(
    { length: SYMPHONY_LIMITS.findingsPerReport + 1 },
    (_, index) => ({ ...blocking, id: `F${index}` }),
  );
  assert.equal(report({ findings: many }).success, false);
  assert.equal(SYMPHONY_LIMITS.findingsPerReport, 24);
});

void test("loop reopens owning tasks, appends tasks, defers, and records approval", () => {
  const loop = {
    kind: "loop" as const,
    symphonyId: id,
    reason: "Fix review findings F1-F3",
    reopen: [
      {
        taskId: "api",
        findings: ["review#F1", "review#F2"],
        note: "Validate concertId before lookup.",
        addWrites: ["shared/schema.ts"],
        after: ["plan-2"],
      },
      { taskId: "ui", findings: ["review#F3"] },
    ],
    tasks: [
      {
        id: "plan-2",
        title: "Plan the concertId validation",
        description: "Design the ordering fix",
        dependsOn: [],
        reads: ["server", "shared"],
        writes: [],
        checks: [],
      },
    ],
    deferred: [{ finding: "review#F4", reason: "Needs a user decision" }],
    approval: { loops: 4, userAnswer: "Continue, we ship Friday." },
  };
  const parsed = symphonyCommandSchema.parse(loop);
  if (parsed.kind !== "loop") {
    throw new Error("expected a loop command");
  }
  assert.deepEqual(parsed.reopen, loop.reopen);
  assert.deepEqual(parsed.deferred, loop.deferred);
  assert.deepEqual(parsed.approval, loop.approval);
  assert.equal(parsed.tasks?.[0]?.id, "plan-2");
  // reopen is optional and defaults to an empty list.
  const withoutReopen = symphonyCommandSchema.parse({
    ...loop,
    reopen: undefined,
  });
  if (withoutReopen.kind !== "loop") {
    throw new Error("expected a loop command");
  }
  assert.deepEqual(withoutReopen.reopen, []);
  // A deferred entry needs a finding or a task, and approval loops are positive.
  assert.equal(
    symphonyCommandSchema.safeParse({
      ...loop,
      deferred: [{ reason: "No reason given" }],
    }).success,
    false,
  );
  assert.equal(
    symphonyCommandSchema.safeParse({
      ...loop,
      approval: { loops: 0, userAnswer: "No" },
    }).success,
    false,
  );
  // Appended tasks follow the same worker choice rule as define.
  assert.equal(
    symphonyCommandSchema.safeParse({
      ...loop,
      tasks: [
        {
          id: "t",
          title: "T",
          description: "D",
          profile: "Small",
          model: "pi-test",
        },
      ],
    }).success,
    false,
  );
  // Finding references per reopened task are bounded.
  assert.equal(
    symphonyCommandSchema.safeParse({
      ...loop,
      reopen: [
        {
          taskId: "api",
          findings: Array.from(
            { length: SYMPHONY_LIMITS.findingsPerReport + 1 },
            (_, index) => `F${index}`,
          ),
        },
      ],
    }).success,
    false,
  );
  assert.equal(SYMPHONY_LIMITS.maxLoops, 5);
  assert.equal(SYMPHONY_LIMITS.defaultLoops, 3);
  assert.equal(SYMPHONY_LIMITS.failedRetriesPerLoop, 2);
});

void test("orchestrate bounds the loop budget and finish accepts unresolved", () => {
  const orchestrate = {
    kind: "orchestrate" as const,
    key: "key",
    title: "Fix pagination",
    goal: "Migrate cursor pagination",
  };
  assert.equal(symphonyCommandSchema.safeParse(orchestrate).success, true);
  for (const maxLoops of [1, 5]) {
    assert.equal(
      symphonyCommandSchema.safeParse({ ...orchestrate, maxLoops }).success,
      true,
    );
  }
  for (const maxLoops of [0, 6]) {
    assert.equal(
      symphonyCommandSchema.safeParse({ ...orchestrate, maxLoops }).success,
      false,
      `maxLoops ${maxLoops}`,
    );
  }
  const finish = {
    kind: "finish" as const,
    symphonyId: id,
    summary: "Stopped at the loop budget.",
    unresolved: [{ finding: "review#F1", reason: "User chose to stop." }],
  };
  assert.deepEqual(symphonyCommandSchema.parse(finish), finish);
  assert.equal(
    symphonyCommandSchema.safeParse({
      ...finish,
      unresolved: [{ reason: "No item named" }],
    }).success,
    false,
  );
  assert.equal(
    symphonyCommandSchema.safeParse({ ...finish, unresolved: undefined })
      .success,
    true,
  );
});

void test("define tasks may be marked review and attempts record loops and reopen context", () => {
  // A define task accepts the review marker.
  assert.equal(
    symphonyCommandSchema.safeParse({
      kind: "define",
      symphonyId: id,
      tasks: [{ ...task, review: true }],
    }).success,
    true,
  );
  // The stored task definition carries the review role and the mirror flag;
  // older stored definitions parse without it.
  const reviewTask = {
    id: "review",
    title: "Review the work",
    outcome: "Materialize review findings",
    prerequisites: ["api"],
    inputs: ["Prerequisite reports"],
    reads: ["src"],
    writes: [],
    resources: [],
    worker: { role: "review" as const, profile: "default" },
    criteria: ["Findings name the owning task"],
    checks: [],
    review: true,
    stopWhen: "Return the review",
  };
  assert.equal(taskSchema.safeParse(reviewTask).success, true);
  assert.equal(
    taskSchema.safeParse({ ...reviewTask, review: undefined }).success,
    true,
  );

  // An attempt records the loop it ran in, reopen context, and a recheck flag.
  const firstFinding = {
    id: "F1",
    severity: "blocking" as const,
    taskId: "api",
    paths: ["src/api.ts:41"],
    summary: "concertId is validated after its lookup.",
  };
  const needs = {
    id: otherId,
    taskId: "review",
    agentId: "agent-1",
    state: "needs-changes" as const,
    startedAt: 1,
    endedAt: 2,
    message: null,
    report: {
      outcome: "needs-changes" as const,
      summary: "Found a blocking ordering bug",
      evidence: ["Reviewed the endpoint path"],
      checks: [
        { name: "Order", status: "failed" as const, detail: "reversed" },
      ],
      findings: [firstFinding],
    },
    reportHash: null,
  };
  assert.equal(attemptSchema.safeParse(needs).success, true);
  const parsed = attemptSchema.parse({
    ...needs,
    loop: 2,
    reopen: {
      reason: "Fix F1 (api)",
      findings: [firstFinding],
    },
    recheck: false,
  });
  assert.equal(parsed.loop, 2);
  assert.equal(parsed.reopen?.reason, "Fix F1 (api)");
  assert.equal(parsed.reopen?.findings[0]?.id, "F1");
  assert.equal(parsed.recheck, false);
  assert.equal(attemptSchema.safeParse({ ...needs, loop: 0 }).success, false);
  assert.equal(
    attemptSchema.safeParse({ ...needs, recheck: true }).success,
    true,
  );
});

void test("conducting metadata carries the loop budget, loop records, and unresolved items", () => {
  const execution = {
    origin: "conducted" as const,
    conducting: {
      phase: "working" as const,
      concurrency: 2,
      requestedBy: null,
      conductorLaunch: "started" as const,
      conductor: "self" as const,
      prompt: "Carry out the shared plan",
      notification: null,
      maxLoops: 4,
      loops: [
        {
          number: 2,
          reason: "Fix review findings F1-F3",
          startedAt: 10,
          reopened: [
            {
              taskId: "api",
              findings: ["review#F1", "review#F2"],
              after: ["plan-2"],
            },
          ],
          added: ["plan-2"],
          deferred: [{ finding: "review#F4", reason: "User decision" }],
          approval: { loops: 4, userAnswer: "Continue." },
        },
      ],
    },
    attempts: [],
    summary: null,
    finishedAt: null,
    interruption: null,
    unresolved: [{ taskId: "ui", reason: "User stopped" }],
  };
  assert.deepEqual(executionSchema.parse(execution), execution);
  // Loop records before loops existed stay parsable: maxLoops, loops, and the
  // loop-only fields are all optional, and repeated fields do not default.
  assert.equal(
    executionSchema.safeParse({
      ...execution,
      conducting: {
        ...execution.conducting,
        maxLoops: undefined,
        loops: undefined,
      },
      unresolved: undefined,
    }).success,
    true,
  );
  assert.equal(
    executionSchema.safeParse({ ...execution, unresolved: [{ reason: "?" }] })
      .success,
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
