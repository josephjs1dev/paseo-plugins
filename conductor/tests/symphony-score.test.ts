import assert from "node:assert/strict";
import test from "node:test";
import {
  conflictReason,
  effectiveTask,
  scoreIssues,
  overlap,
  projectScore,
  scopeConflictReason,
} from "../shared/symphonies/score";
import {
  attemptNumber,
  scoreSchema,
  scopeSchema,
  latestAttempt,
  taskAttempts,
  type Attempt,
  type StoredSymphony,
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
