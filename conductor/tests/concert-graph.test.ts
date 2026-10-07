import assert from "node:assert/strict";
import test from "node:test";
import {
  conflictReason,
  effectiveTask,
  graphIssues,
  overlap,
  projectGraph,
  scopeConflictReason,
} from "../shared/concerts/graph";
import {
  graphSchema,
  scopeSchema,
  type ConcertAttempt,
} from "../shared/concerts/models";
import { graph, task } from "./concert-fixtures";

void test("admission rejects duplicate identities, missing prerequisites, cycles, and explorer writes", () => {
  assert.deepEqual(graphIssues(graph()), []);
  assert.match(graphIssues({ tasks: [task("a"), task("a")] }).join(), /unique/);
  assert.match(
    graphIssues({ tasks: [task("a", { prerequisites: ["absent"] })] }).join(),
    /missing/,
  );
  assert.match(
    graphIssues({
      tasks: [
        task("a", { prerequisites: ["b"] }),
        task("b", { prerequisites: ["a"] }),
      ],
    }).join(),
    /cycle/,
  );
  assert.match(
    graphIssues({ tasks: [task("a", { prerequisites: ["a"] })] }).join(),
    /cycle/,
  );
  assert.match(
    graphIssues({ tasks: [task("a", { writes: ["src"] })] }).join(),
    /exploration/,
  );
  assert.equal(
    graphSchema.safeParse({
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
  const projected = projectGraph({ tasks: [writer, task("reader")] });
  assert.deepEqual(projected[0]?.waitsFor, []);
  assert.equal(projected[0]?.conflicts[0]?.taskId, "reader");
  assert.deepEqual(projectGraph(graph())[2]?.waitsFor, ["api", "ui"]);
});

void test("effectiveTask folds an attempt's granted writes into the definition", () => {
  const writer = task("writer", {
    reads: [],
    writes: ["src/api", "src/shared"],
    worker: { role: "implementation", profile: "default" },
  });
  // No grants: the helper returns the same definition, so callers can pass it
  // to conflictReason without changing behavior.
  assert.equal(effectiveTask(writer), writer);
  assert.equal(effectiveTask(writer, undefined), writer);

  const attempt: ConcertAttempt = {
    id: "b410f767-1197-469b-8b89-af35338a4e01",
    taskId: "writer",
    agentId: "agent-1",
    state: "running",
    startedAt: 1,
    endedAt: null,
    message: null,
    report: null,
    reportHash: null,
    grantedWrites: [
      { path: "shared/schema.ts", reason: "Typecheck reads it", at: 1 },
      { path: "src/shared", reason: "Already declared", at: 2 },
    ],
  };
  const effective = effectiveTask(writer, attempt);
  assert.deepEqual(effective.writes, [
    "src/api",
    "src/shared",
    "shared/schema.ts",
  ]);
  // The original definition is untouched; the helper is pure.
  assert.deepEqual(writer.writes, ["src/api", "src/shared"]);

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
