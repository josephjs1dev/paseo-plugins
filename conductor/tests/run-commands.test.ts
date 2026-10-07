import assert from "node:assert/strict";
import test from "node:test";
import { runAgentCommandSchema } from "../shared/concerts/commands";
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
  assert.deepEqual(runAgentCommandSchema.parse(get), get);
  for (const legacy of ["runId", "performanceId"]) {
    assert.deepEqual(
      runAgentCommandSchema.parse({ kind: "get", [legacy]: id }),
      get,
    );
    assert.deepEqual(
      runAgentCommandSchema.parse({ kind: "get", [legacy]: id, concertId: id }),
      get,
    );
    assert.throws(() =>
      runAgentCommandSchema.parse({
        kind: "get",
        [legacy]: id,
        concertId: otherId,
      }),
    );
  }
  assert.deepEqual(
    runAgentCommandSchema.parse({ kind: "get", runId: id, performanceId: id }),
    get,
  );
  assert.throws(() =>
    runAgentCommandSchema.parse({
      kind: "get",
      runId: id,
      performanceId: otherId,
    }),
  );
});

void test("a task or retry uses either a profile or an inline worker choice", () => {
  const define = (worker: Record<string, string>) =>
    runAgentCommandSchema.safeParse({
      kind: "define",
      concertId: id,
      tasks: [{ ...task, ...worker }],
    }).success;
  assert.equal(define({ profile: "Small" }), true);
  assert.equal(define({ provider: "pi", model: "pi-test" }), true);
  assert.equal(define({ profile: "Small", provider: "pi" }), false);
  assert.equal(define({ profile: "Small", thinkingOptionId: "high" }), false);
  const dispatch = (worker: Record<string, string>) =>
    runAgentCommandSchema.safeParse({
      kind: "dispatch",
      concertId: id,
      retryTaskId: "a",
      ...worker,
    }).success;
  assert.equal(dispatch({ model: "pi-test" }), true);
  assert.equal(dispatch({ profile: "Small", model: "pi-test" }), false);
  assert.equal(
    runAgentCommandSchema.safeParse({ kind: "models" }).success,
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
