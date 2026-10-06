import assert from "node:assert/strict";
import test from "node:test";
import { runExecution } from "../server/run-execution";
import { commandRunId, type ExecutionRuntime } from "../server/run-identity";
import { contentHash, fileRunStore } from "../server/run-store";
import { storedRun, planContext } from "./run-fixtures";
import { latestAttempt, type TaskReport } from "../shared/run-models";
import { testDirectory } from "./fixtures";

void test("legacy cleanup checks source, workspace and version and cannot remove execution runs", async () => {
  const f = await fixture();
  const legacy = {
    ...storedRun(),
    contextHash: contentHash(JSON.stringify(planContext)),
  };
  await f.store.create(legacy, planContext);
  const removal = {
    kind: "remove-legacy",
    runId: legacy.id,
    expectedVersion: legacy.version,
  };
  await assert.rejects(f.send(removal, "another-agent"), /original source/);
  await assert.rejects(
    f.store.removeLegacy(legacy.id, legacy.version, {
      agentId: "agent-1",
      workspaceId: "other-workspace",
    }),
    /original source/,
  );
  await assert.rejects(
    f.send({ ...removal, expectedVersion: 1 }),
    /changed elsewhere/,
  );
  const managedId = await f.start("cleanup-protected");
  await assert.rejects(
    f.send({ ...removal, runId: managedId }),
    /Execution runs cannot/,
  );
  const attempt = await f.claim(managedId);
  await f.send({
    kind: "report",
    runId: managedId,
    attemptId: attempt.id,
    report,
  });
  await f.send({ kind: "finish", runId: managedId, summary: "Finished" });
  await assert.rejects(
    f.send({
      ...removal,
      runId: managedId,
      expectedVersion: (await f.read(managedId)).version,
    }),
    /Execution runs cannot/,
  );
  await f.send(removal);
  assert.deepEqual(
    (await f.store.list()).runs.map((run) => run.id),
    [managedId],
  );
  await assert.rejects(f.read(legacy.id));
  assert.equal((await f.read(managedId)).status, "completed");
  // A second legacy record can reuse the immutable context after removal.
  await f.store.create(
    { ...legacy, id: commandRunId("agent-1", "shared-context") },
    planContext,
  );
  assert.equal((await f.store.list()).runs.length, 2);
});
import { placement } from "./run-fixtures";

const runtime: ExecutionRuntime = {
  source: async (agentId) => ({ agentId, workspaceId: "ws-api" }),
  capture: async (source) => ({ ...placement, ...source }),
  validate: async () => {},
};
const report: TaskReport = {
  outcome: "completed",
  summary: "Implemented the requested behavior",
  evidence: ["Changed code and inspected the resulting behavior"],
  checks: [],
};
async function fixture() {
  const directory = await testDirectory();
  const store = fileRunStore(directory);
  const engine = runExecution(store, () => runtime);
  const send = (command: unknown, agentId = "agent-1") =>
    engine.execute({ agentId, command });
  const start = async (key: string, tasks?: unknown[]) => {
    await send({
      kind: "start",
      key,
      title: "Agent-owned work",
      goal: "Implement the requested fix",
      ...(tasks ? { tasks } : {}),
    });
    return commandRunId("agent-1", key);
  };
  const read = async (runId: string) => (await store.read(runId)).run;
  const claim = async (runId: string, taskId = "work", retry = false) => {
    await send({ kind: "claim", runId, taskId, retry });
    const attempt = latestAttempt(await read(runId), taskId);
    assert.ok(attempt);
    return attempt;
  };
  return { directory, store, engine, send, start, read, claim };
}

void test("agent commands create, execute and report without a draft or manual acceptance", async () => {
  const f = await fixture();
  const id = await f.start("one");
  const initial = await f.read(id);
  assert.equal(initial.status, "ready");
  assert.equal(initial.draft, null);
  assert.equal(initial.revisions[0]?.authority, "agent");
  assert.equal(await f.start("one"), id);
  assert.equal((await f.store.list()).runs.length, 1);
  await assert.rejects(
    f.send({ kind: "start", key: "one", title: "Changed", goal: "Different" }),
    /another plan/,
  );
  const attempt = await f.claim(id);
  assert.equal((await f.claim(id)).id, attempt.id);
  assert.equal((await f.read(id)).version, 1);
  await assert.rejects(
    f.send({ kind: "finish", runId: id, summary: "Premature" }),
    /every task/,
  );
  await f.send({ kind: "report", runId: id, attemptId: attempt.id, report });
  const version = (await f.read(id)).version;
  await f.send({ kind: "report", runId: id, attemptId: attempt.id, report });
  assert.equal((await f.read(id)).version, version);
  assert.equal(
    (await f.read(id)).status,
    "ready",
    "A task report is not the run summary",
  );
  await f.send({
    kind: "finish",
    runId: id,
    summary: "Completed with check evidence",
  });
  const done = await f.read(id);
  assert.equal(done.status, "completed");
  assert.deepEqual((await fileRunStore(f.directory).read(id)).run, done);
  await f.send({
    kind: "finish",
    runId: id,
    summary: "Completed with check evidence",
  });
  assert.equal((await f.read(id)).version, done.version);
  await assert.rejects(
    f.send({ kind: "finish", runId: id, summary: "Changed report" }),
    /different final/,
  );
});

void test("joins and required checks must have actual explicit reports", async () => {
  const f = await fixture();
  const id = await f.start("join", [
    {
      id: "a",
      title: "A",
      description: "Investigate A",
      writes: [],
      checks: ["focused tests"],
    },
    { id: "b", title: "B", description: "Investigate B", writes: [] },
    {
      id: "join",
      title: "Join",
      description: "Combine findings",
      dependsOn: ["a", "b"],
    },
  ]);
  await assert.rejects(f.claim(id, "join"), /prerequisites/);
  const a = await f.claim(id, "a");
  const b = await f.claim(id, "b");
  await assert.rejects(
    f.send({ kind: "report", runId: id, attemptId: a.id, report }),
    /declared check/,
  );
  await f.send({
    kind: "report",
    runId: id,
    attemptId: a.id,
    report: {
      ...report,
      checks: [
        { name: "focused tests", status: "passed", detail: "3 tests passed" },
      ],
    },
  });
  await assert.rejects(f.claim(id, "join"), /prerequisites/);
  await f.send({ kind: "report", runId: id, attemptId: b.id, report });
  assert.equal((await f.claim(id, "join")).state, "running");
});

void test("same-checkout claims remain reserved through blockers and reload", async () => {
  const f = await fixture();
  const first = await f.start("first");
  const second = await f.start("second");
  const attempt = await f.claim(first);
  await f.send({
    kind: "block",
    runId: first,
    attemptId: attempt.id,
    message: "Need the user's decision",
  });
  assert.equal((await f.read(first)).status, "blocked");
  await assert.rejects(f.claim(second), /still owned/);
  const fresh = runExecution(fileRunStore(f.directory), () => runtime);
  await fresh.interrupt(null, "Reloaded");
  await assert.rejects(f.claim(second), /still owned/);
  assert.equal((await f.claim(first)).id, attempt.id);
  await f.send({ kind: "report", runId: first, attemptId: attempt.id, report });
  assert.equal((await f.claim(second)).state, "running");
});

void test("turn endings preserve ownership and never fabricate completed tasks", async () => {
  const f = await fixture();
  const id = await f.start("ended");
  const attempt = await f.claim(id);
  await f.engine.interrupt("agent-1", "Turn ended without a report");
  const paused = await f.read(id);
  assert.equal(paused.status, "blocked");
  assert.equal(latestAttempt(paused, "work")?.report, null);
  assert.equal((await f.claim(id)).id, attempt.id);
  await f.send({ kind: "report", runId: id, attemptId: attempt.id, report });
  await f.engine.interrupt("agent-1", "Another turn ended");
  assert.equal((await f.read(id)).status, "ready");
});

void test("source and workspace mismatches cannot take over an assignment", async () => {
  const f = await fixture();
  const id = await f.start("owner");
  const attempt = await f.claim(id);
  await assert.rejects(
    f.send(
      { kind: "report", runId: id, attemptId: attempt.id, report },
      "agent-2",
    ),
    /original source/,
  );
  await assert.rejects(
    f.send({ kind: "get", runId: id }, "agent-2"),
    /another source/,
  );
  const moved = runExecution(f.store, () => ({
    ...runtime,
    source: async (agentId) => ({ agentId, workspaceId: "elsewhere" }),
  }));
  await assert.rejects(
    moved.execute({
      agentId: "agent-1",
      command: { kind: "claim", runId: id, taskId: "work" },
    }),
    /original source/,
  );
});

void test("explicit retries preserve prior reports and reject superseded or changed output", async () => {
  const f = await fixture();
  const id = await f.start("retry");
  const first = await f.claim(id);
  await f.send({
    kind: "report",
    runId: id,
    attemptId: first.id,
    report: { ...report, outcome: "failed", summary: "Check failed" },
  });
  await assert.rejects(f.claim(id), /Explicitly/);
  const next = await f.claim(id, "work", true);
  assert.notEqual(next.id, first.id);
  await assert.rejects(
    f.send({ kind: "report", runId: id, attemptId: first.id, report }),
    /superseded/,
  );
  await f.send({ kind: "report", runId: id, attemptId: next.id, report });
  await assert.rejects(
    f.send({
      kind: "report",
      runId: id,
      attemptId: next.id,
      report: { ...report, summary: "Changed" },
    }),
    /different report/,
  );
  assert.equal((await f.read(id)).execution?.attempts.length, 2);
});

void test("schema bounds and graph rejection do not create runs", async () => {
  const f = await fixture();
  await assert.rejects(
    f.start("cycle", [
      { id: "a", title: "A", description: "A", dependsOn: ["a"] },
    ]),
    /cycle/,
  );
  await assert.rejects(f.start("empty", []));
  await assert.rejects(
    f.send({
      kind: "start",
      key: "bad",
      title: "Bad",
      goal: "x".repeat(16001),
    }),
  );
  assert.equal((await f.store.list()).runs.length, 0);
});

void test("disjoint writer scopes still serialize on the same checkout", async () => {
  const f = await fixture();
  const id = await f.start("writers", [
    { id: "a", title: "A", description: "Edit A", reads: ["a"], writes: ["a"] },
    { id: "b", title: "B", description: "Edit B", reads: ["b"], writes: ["b"] },
  ]);
  await f.claim(id, "a");
  await assert.rejects(f.claim(id, "b"), /still owned/);
});
