import assert from "node:assert/strict";
import test from "node:test";
import {
  conflictReason,
  graphIssues,
  projectGraph,
} from "../shared/concerts/graph";
import { graphSchema, scopeSchema } from "../shared/concerts/models";
import { graph, task } from "./run-fixtures";

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
