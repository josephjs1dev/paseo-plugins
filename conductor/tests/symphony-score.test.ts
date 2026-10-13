import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import {
  attemptLoop,
  conflictReason,
  currentLoop,
  effectiveTask,
  loopVerdict,
  prerequisiteCycle,
  overlap,
  projectScore,
  scopeConflictReason,
  scoreIssues,
  transitiveDependents,
} from "../shared/symphonies/score";
import {
  attemptNumber,
  scoreSchema,
  scopeSchema,
  latestAttempt,
  taskAttempts,
  type Attempt,
  type Score,
  type StoredSymphony,
  type TaskDefinition,
  type TaskReport,
} from "../shared/symphonies/models";
import { score, storedSymphony, task } from "./symphony-fixtures";

/** A single-task score whose execution carries the given attempts. */
function symphonyWith(
  definition: ReturnType<typeof task>,
  attempts: Attempt[],
): StoredSymphony {
  const base = storedSymphony();
  const first = base.revisions[0];
  return {
    ...base,
    status: "running",
    execution: { ...base.execution, origin: "conducted", attempts },
    revisions: [
      {
        number: 1,
        parent: null,
        reason: first?.reason ?? "Accepted plan",
        acceptedAt: base.createdAt,
        score: { tasks: [definition] },
      },
    ],
  };
}

void test("admission rejects duplicate identities, missing prerequisites, cycles, and explorer writes", () => {
  assert.deepEqual(scoreIssues(score()), []);
  assert.match(scoreIssues({ tasks: [task("a"), task("a")] }).join(), /unique/);
  assert.match(
    scoreIssues({ tasks: [task("a", { prerequisites: ["absent"] })] }).join(),
    /missing/,
  );
  assert.match(
    scoreIssues({
      tasks: [
        task("a", { prerequisites: ["b"] }),
        task("b", { prerequisites: ["a"] }),
      ],
    }).join(),
    /cycle/,
  );
  assert.match(
    scoreIssues({ tasks: [task("a", { prerequisites: ["a"] })] }).join(),
    /cycle/,
  );
  assert.match(
    scoreIssues({ tasks: [task("a", { writes: ["src"] })] }).join(),
    /exploration/,
  );
  assert.equal(
    scoreSchema.safeParse({
      tasks: Array.from({ length: 41 }, (_, index) => task(`t${index}`)),
    }).success,
    false,
  );
});

void test("scopes reject traversal, absolute paths, globs, and alternate separators", () => {
  for (const value of [
    "../secret",
    "/etc",
    "src/../secret",
    "src//api",
    "src/./api",
    "C:\\temp",
    "src\\api",
    "src/**",
    "src/\u0000",
  ]) {
    assert.equal(scopeSchema.safeParse(value).success, false, value);
  }
  for (const value of [".", "src", "src/api.ts", "a name/file"]) {
    assert.equal(scopeSchema.safeParse(value).success, true);
  }
});

void test("resource serialization stays distinct from semantic prerequisites", () => {
  const writer = task("writer", {
    reads: [],
    writes: ["src/api"],
    worker: { role: "implementation", profile: "default" },
  });
  assert.equal(
    conflictReason(writer, task("reader", { reads: ["src"] })),
    "overlapping read/write scope",
  );
  assert.equal(
    conflictReason(writer, task("other", { reads: ["src/apis"] })),
    null,
  );
  assert.equal(
    conflictReason(
      task("a", { resources: ["generator"] }),
      task("b", { resources: ["generator"] }),
    ),
    "shared exclusive resource",
  );
  const projected = projectScore({ tasks: [writer, task("reader")] });
  assert.deepEqual(projected[0]?.waitsFor, []);
  assert.equal(projected[0]?.conflicts[0]?.taskId, "reader");
  assert.deepEqual(projectScore(score())[2]?.waitsFor, ["api", "ui"]);
});

void test("effectiveTask unions declared, Conductor-added, and widened writes", () => {
  const writer = task("writer", {
    reads: [],
    writes: ["src/api", "src/shared"],
    worker: { role: "implementation", profile: "default" },
  });
  const first: Attempt = {
    id: "b410f767-1197-469b-8b89-af35338a4e01",
    taskId: "writer",
    agentId: "agent-1",
    state: "failed",
    startedAt: 1,
    endedAt: 2,
    message: null,
    report: null,
    reportHash: null,
    addedWrites: [
      { path: "shared/schema.ts", reason: "needs the exported type", at: 1 },
    ],
  };
  const second: Attempt = {
    ...first,
    id: "b410f767-1197-469b-8b89-af35338a4e02",
    state: "running",
    endedAt: null,
    addedWrites: [{ path: "lib/util.ts", reason: "shared helper", at: 3 }],
    grantedWrites: [
      { path: "src/shared", reason: "Already declared", at: 4 },
      { path: "docs/api.md", reason: "Document the change", at: 4 },
    ],
  };
  // No additions or grants: the helper returns the same definition, so callers
  // can pass it to conflictReason without changing behavior.
  assert.equal(effectiveTask(symphonyWith(writer, []), writer), writer);

  const effective = effectiveTask(
    symphonyWith(writer, [first, second]),
    writer,
  );
  assert.deepEqual(effective.writes, [
    "src/api",
    "src/shared",
    "shared/schema.ts",
    "lib/util.ts",
    "docs/api.md",
  ]);
  // The original definition is untouched; the helper is pure.
  assert.deepEqual(writer.writes, ["src/api", "src/shared"]);
  // Conductor additions last for the task; only the latest attempt's widen
  // grants count.
  assert.deepEqual(
    effectiveTask(symphonyWith(writer, [first]), writer).writes,
    ["src/api", "src/shared", "shared/schema.ts"],
  );

  // The granted path conflicts with a reader even though the definition alone
  // does not.
  const grantedReader = task("reader", { reads: ["shared/schema.ts"] });
  assert.equal(conflictReason(writer, grantedReader), null);
  assert.equal(
    conflictReason(effective, grantedReader),
    "overlapping read/write scope",
  );
  // A parent path granted to the attempt also conflicts.
  assert.equal(
    conflictReason(effective, task("parent", { reads: ["shared"] })),
    "overlapping read/write scope",
  );
  // A Conductor-added path on any attempt of the task conflicts too.
  assert.equal(
    conflictReason(effective, task("added-reader", { reads: ["lib/util.ts"] })),
    "overlapping read/write scope",
  );
});

void test("a read-only task that gains writes becomes an implementation", () => {
  const explorer = task("explorer", { reads: [], writes: [] });
  assert.equal(
    effectiveTask(symphonyWith(explorer, []), explorer).worker.role,
    "exploration",
  );
  const added: Attempt = {
    id: "b410f767-1197-469b-8b89-af35338a4e03",
    taskId: "explorer",
    agentId: "agent-1",
    state: "failed",
    startedAt: 1,
    endedAt: 2,
    message: null,
    report: null,
    reportHash: null,
    addedWrites: [{ path: "src/new", reason: "scope grew", at: 5 }],
  };
  const effective = effectiveTask(symphonyWith(explorer, [added]), explorer);
  assert.deepEqual(effective.writes, ["src/new"]);
  assert.equal(effective.worker.role, "implementation");
  assert.equal(explorer.worker.role, "exploration");
});

void test("a widen grant lasts only for the attempt that received it", () => {
  const writer = task("writer", {
    reads: [],
    writes: ["src/api"],
    worker: { role: "implementation", profile: "default" },
  });
  const first: Attempt = {
    id: "b410f767-1197-469b-8b89-af35338a4e21",
    taskId: "writer",
    agentId: "agent-1",
    state: "failed",
    startedAt: 1,
    endedAt: 2,
    message: null,
    report: null,
    reportHash: null,
    grantedWrites: [{ path: "docs/old.md", reason: "Earlier widen", at: 1 }],
  };
  const second: Attempt = {
    id: "b410f767-1197-469b-8b89-af35338a4e22",
    taskId: "writer",
    agentId: "agent-1",
    state: "running",
    startedAt: 3,
    endedAt: null,
    message: null,
    report: null,
    reportHash: null,
    grantedWrites: [{ path: "docs/new.md", reason: "This attempt", at: 4 }],
  };
  assert.deepEqual(
    effectiveTask(symphonyWith(writer, [first, second]), writer).writes,
    ["src/api", "docs/new.md"],
  );
});

void test("attemptNumber and taskAttempts number attempts per task, oldest first", () => {
  const first: Attempt = {
    id: "b410f767-1197-469b-8b89-af35338a4e11",
    taskId: "api",
    agentId: "agent-1",
    state: "failed",
    startedAt: 1,
    endedAt: 2,
    message: null,
    report: null,
    reportHash: null,
  };
  const second: Attempt = {
    ...first,
    id: "b410f767-1197-469b-8b89-af35338a4e12",
    state: "running",
    endedAt: null,
  };
  const other: Attempt = {
    ...first,
    id: "b410f767-1197-469b-8b89-af35338a4e13",
    taskId: "ui",
  };
  const symphony = symphonyWith(task("api"), [first, other, second]);
  assert.deepEqual(
    taskAttempts(symphony, "api").map((attempt) => attempt.id),
    [first.id, second.id],
  );
  assert.equal(attemptNumber(symphony, first), 1);
  assert.equal(attemptNumber(symphony, second), 2);
  assert.equal(attemptNumber(symphony, other), 1);
  assert.equal(latestAttempt(symphony, "api")?.id, second.id);
});

void test("overlap compares repository scopes by root, ancestry, and identity", () => {
  assert.equal(overlap(".", "src/api"), true);
  assert.equal(overlap("src/api", "."), true);
  assert.equal(overlap("src/api", "src/api"), true);
  assert.equal(overlap("src", "src/api"), true);
  assert.equal(overlap("src/api", "src"), true);
  assert.equal(overlap("src/api", "src/apis"), false);
  assert.equal(overlap("src/api", "docs"), false);
  assert.equal(overlap("src", "srcx"), false);
});

// === Review loops ===

function symphonyFor(
  tasks: TaskDefinition[],
  attempts: Attempt[],
  conducting?: NonNullable<StoredSymphony["execution"]["conducting"]>,
): StoredSymphony {
  const base = storedSymphony();
  return {
    ...base,
    status: "running",
    execution: {
      origin: "conducted",
      ...(conducting ? { conducting } : {}),
      attempts,
      summary: null,
      finishedAt: null,
      interruption: null,
    },
    revisions: [
      {
        number: 1,
        parent: null,
        reason: base.revisions[0]?.reason ?? "Accepted plan",
        acceptedAt: base.createdAt,
        score: { tasks },
      },
    ],
  };
}

function settledAttempt(
  taskId: string,
  state: Attempt["state"],
  report: TaskReport | null,
  loop?: number,
  launch?: NonNullable<Attempt["launch"]>,
): Attempt {
  return {
    id: randomUUID(),
    taskId,
    agentId: `agent-${taskId}`,
    state,
    startedAt: 1,
    endedAt: report ? 2 : null,
    message: null,
    report,
    reportHash: report ? "c".repeat(64) : null,
    ...(loop !== undefined ? { loop } : {}),
    ...(launch ? { launch } : {}),
  };
}

const done: TaskReport = {
  outcome: "completed",
  summary: "Done.",
  evidence: ["Observed the behavior"],
  checks: [],
};
const blockingFinding = {
  id: "F1",
  severity: "blocking" as const,
  taskId: "api",
  paths: ["src/api.ts:41"],
  summary: "concertId is validated after its lookup.",
  suggestedFix: "Move the lookup after the validation.",
};
const needsChanges: TaskReport = {
  outcome: "needs-changes",
  summary: "Blocking defects remain.",
  evidence: ["Reviewed the endpoint path"],
  checks: [{ name: "Regression", status: "failed", detail: "Still red." }],
  findings: [blockingFinding],
};
const writer = task("api", {
  reads: [],
  writes: ["src"],
  worker: { role: "implementation", profile: "default" },
});
const review = task("review", {
  prerequisites: ["api"],
  reads: ["src"],
  writes: [],
  worker: { role: "review", profile: "default" },
});

void test("attemptLoop defaults old records to 1 and currentLoop tracks the highest", () => {
  const first = settledAttempt("api", "needs-changes", needsChanges);
  assert.equal(attemptLoop(first), 1);
  assert.equal(attemptLoop({ ...first, loop: 3 }), 3);
  assert.equal(currentLoop(storedSymphony()), 1);
  assert.equal(
    currentLoop(symphonyFor([writer], [first, { ...first, loop: 2 }])),
    2,
  );
  // A recorded loop counts even before its first attempt settles.
  const conducting = {
    phase: "working" as const,
    concurrency: 1,
    requestedBy: null,
    conductorLaunch: "started" as const,
    conductor: "self" as const,
    prompt: "p",
    notification: null,
    loops: [
      {
        number: 3,
        reason: "r",
        startedAt: 1,
        reopened: [],
        added: [],
        deferred: [],
      },
    ],
  };
  assert.equal(currentLoop(symphonyFor([writer], [], conducting)), 3);
});

void test("transitiveDependents returns every downstream task in score order", () => {
  const api = task("api");
  const ui = task("ui", { prerequisites: ["api"] });
  const backend = task("backend", { prerequisites: ["api"] });
  const collect = task("collect", { prerequisites: ["ui", "backend"] });
  const ship = task("ship", { prerequisites: ["collect"] });
  const plan: Score = { tasks: [api, ui, backend, collect, ship] };
  assert.deepEqual(transitiveDependents(plan, ["api"]), [
    "ui",
    "backend",
    "collect",
    "ship",
  ]);
  assert.deepEqual(transitiveDependents(plan, ["ui"]), ["collect", "ship"]);
  assert.deepEqual(transitiveDependents(plan, ["backend"]), [
    "collect",
    "ship",
  ]);
  assert.deepEqual(transitiveDependents(plan, ["collect"]), ["ship"]);
  assert.deepEqual(transitiveDependents(plan, ["ship"]), []);
  assert.deepEqual(transitiveDependents(plan, ["ui", "backend"]), [
    "collect",
    "ship",
  ]);
  assert.deepEqual(transitiveDependents(plan, ["absent"]), []);
});

void test("loopVerdict succeeds when every task completed", () => {
  const symphony = symphonyFor(
    [writer, review],
    [
      settledAttempt("api", "completed", done, 1),
      settledAttempt("review", "completed", done, 1),
    ],
  );
  assert.deepEqual(loopVerdict(symphony), {
    loop: 1,
    ended: true,
    verdict: "succeeded",
    findings: [],
    failedChecks: [],
  });
});

void test("loopVerdict needs-changes collects blocking findings and failed checks", () => {
  const symphony = symphonyFor(
    [writer, review],
    [
      settledAttempt("api", "completed", done, 1),
      settledAttempt("review", "needs-changes", needsChanges, 1),
    ],
  );
  const verdict = loopVerdict(symphony);
  assert.equal(verdict.loop, 1);
  assert.equal(verdict.ended, true);
  assert.equal(verdict.verdict, "needs-changes");
  assert.equal(verdict.findings.length, 1);
  assert.equal(verdict.findings[0]?.reporterTaskId, "review");
  assert.deepEqual(verdict.findings[0]?.finding, blockingFinding);
  assert.equal(verdict.failedChecks.length, 1);
  assert.equal(verdict.failedChecks[0]?.reporterTaskId, "review");
  assert.equal(verdict.failedChecks[0]?.check.name, "Regression");
});

void test("loopVerdict ends needs-changes when a dependent waits on open work", () => {
  // A non-review dependent cannot start on a needs-changes prerequisite, so the
  // loop ends and the failed check stays open.
  const collect = task("collect", { prerequisites: ["api"] });
  const symphony = symphonyFor(
    [writer, collect],
    [settledAttempt("api", "needs-changes", needsChanges, 1)],
  );
  const verdict = loopVerdict(symphony);
  assert.equal(verdict.ended, true);
  assert.equal(verdict.verdict, "needs-changes");
  assert.equal(verdict.failedChecks[0]?.reporterTaskId, "api");
  // A review may start on the needs-changes prerequisite, so the loop is not
  // over until it runs.
  const withReview = symphonyFor(
    [writer, review],
    [settledAttempt("api", "needs-changes", needsChanges, 1)],
  );
  const open = loopVerdict(withReview);
  assert.equal(open.ended, false);
  assert.equal(open.verdict, "attention");
});

void test("loopVerdict returns attention for running and failed tasks", () => {
  const running = symphonyFor(
    [writer],
    [
      settledAttempt("api", "running", null, 1, {
        state: "started",
        profile: "inherit",
        generation: 0,
        prompt: "p",
        settled: false,
      }),
    ],
  );
  const runningVerdict = loopVerdict(running);
  assert.equal(runningVerdict.ended, false);
  assert.equal(runningVerdict.verdict, "attention");
  const failed = symphonyFor(
    [writer],
    [
      settledAttempt(
        "api",
        "failed",
        { outcome: "failed", summary: "Launcher", evidence: ["x"], checks: [] },
        1,
      ),
    ],
  );
  const failedVerdict = loopVerdict(failed);
  assert.equal(failedVerdict.ended, true);
  assert.equal(failedVerdict.verdict, "attention");
});

void test("loopVerdict carries open findings across loops and waits for scheduled tasks", () => {
  const record = (
    reopened: { taskId: string; findings: string[] }[],
    deferred: { finding?: string; taskId?: string; reason: string }[] = [],
  ) => ({
    phase: "working" as const,
    concurrency: 1,
    requestedBy: null,
    conductorLaunch: "started" as const,
    conductor: "self" as const,
    prompt: "p",
    notification: null,
    maxLoops: 3,
    loops: [
      {
        number: 2,
        reason: "Fix F1",
        startedAt: 5,
        reopened,
        added: [],
        deferred,
      },
    ],
  });
  // api is reopened in loop 2 but has not run in it yet: it is pending and
  // can start, so the loop is not over. Its open finding is still listed.
  const scheduled = loopVerdict(
    symphonyFor(
      [writer],
      [settledAttempt("api", "needs-changes", needsChanges, 1)],
      record([{ taskId: "api", findings: ["api#F1"] }]),
    ),
  );
  assert.equal(scheduled.loop, 2);
  assert.equal(scheduled.ended, false);
  assert.equal(scheduled.verdict, "attention");
  assert.equal(scheduled.findings.length, 1);
  assert.equal(scheduled.findings[0]?.loop, 1);
  // A deferred finding is carried, not dropped: loop 2 ends needing changes
  // and still lists the loop-1 finding and failed check.
  const deferred = loopVerdict(
    symphonyFor(
      [writer],
      [settledAttempt("api", "needs-changes", needsChanges, 1)],
      record([], [{ finding: "api#F1", reason: "Needs a user decision" }]),
    ),
  );
  assert.equal(deferred.ended, true);
  assert.equal(deferred.verdict, "needs-changes");
  assert.equal(deferred.findings.length, 1);
  assert.equal(deferred.failedChecks.length, 1);
  // The review is a dependent of the reopened api: it is pending until it
  // runs in loop 2, even though its loop-1 attempt completed.
  const reviewPending = loopVerdict(
    symphonyFor(
      [writer, review],
      [
        settledAttempt("api", "completed", done, 1),
        settledAttempt("review", "completed", done, 1),
        settledAttempt("api", "completed", done, 2),
      ],
      record([{ taskId: "api", findings: [] }]),
    ),
  );
  assert.equal(reviewPending.ended, false);
  assert.equal(reviewPending.verdict, "attention");
  // Once the review re-ran in loop 2 the loop succeeded.
  const fixed = loopVerdict(
    symphonyFor(
      [writer, review],
      [
        settledAttempt("api", "completed", done, 1),
        settledAttempt("review", "completed", done, 1),
        settledAttempt("api", "completed", done, 2),
        settledAttempt("review", "completed", done, 2),
      ],
      record([{ taskId: "api", findings: [] }]),
    ),
  );
  assert.equal(fixed.verdict, "succeeded");
});

void test("loopVerdict treats an unsettled needs-changes launch as active", () => {
  const unsettled = loopVerdict(
    symphonyFor(
      [writer],
      [
        settledAttempt("api", "needs-changes", needsChanges, 1, {
          state: "started",
          profile: "inherit",
          generation: 0,
          prompt: "p",
          settled: false,
        }),
      ],
    ),
  );
  assert.equal(unsettled.ended, false);
  assert.equal(unsettled.verdict, "attention");
});

void test("prerequisiteCycle detects cycles through loop-only edges", () => {
  assert.equal(
    prerequisiteCycle([
      { id: "api", prerequisites: [] },
      { id: "review", prerequisites: ["api"] },
    ]),
    false,
  );
  assert.equal(
    prerequisiteCycle([
      { id: "api", prerequisites: ["review"] },
      { id: "review", prerequisites: ["api"] },
    ]),
    true,
  );
  assert.equal(
    prerequisiteCycle([{ id: "api", prerequisites: ["api"] }]),
    true,
  );
});

void test("scopeConflictReason adds the writer fence to read/write overlap", () => {
  const first = task("first", {
    reads: [],
    writes: ["src/a"],
    worker: { role: "implementation", profile: "default" },
  });
  const second = task("second", {
    reads: [],
    writes: ["src/b"],
    worker: { role: "implementation", profile: "default" },
  });
  // Disjoint writers still serialize on one checkout.
  assert.equal(
    scopeConflictReason(first, second),
    "another writer holds resources",
  );
  assert.equal(
    scopeConflictReason(second, first),
    "another writer holds resources",
  );
  // A reader that does not overlap the writer stays independent.
  assert.equal(
    scopeConflictReason(first, task("read", { reads: ["docs"] })),
    null,
  );
  // Read/write overlap keeps its more specific reason.
  assert.equal(
    scopeConflictReason(first, task("reader", { reads: ["src"] })),
    "overlapping read/write scope",
  );
});
