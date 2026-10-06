import assert from "node:assert/strict";
import test from "node:test";
import { runExecution } from "../server/run-execution";
import { fileRunStore } from "../server/run-store";
import {
  LaunchRejectedError,
  type WorkerLaunch,
  type WorkerRuntime,
} from "../server/run-workers";
import type { ExecutionRuntime } from "../server/run-identity";
import { latestAttempt, type StoredRun } from "../shared/run-models";
import { placement } from "./run-fixtures";
import { testDirectory } from "./fixtures";

async function fixture() {
  const store = fileRunStore(await testDirectory());
  const launches = new Map<string, WorkerLaunch>();
  const active = new Map<string, boolean>();
  const wakes: string[] = [];
  let uncertain = false;
  let rejected = false;
  const busy = new Set<string>();
  const workers: WorkerRuntime = {
    prepare: async () => JSON.stringify({ provider: "fake/model" }),
    profiles: async () => [
      { name: "Small", notes: "Bounded read-only assignments" },
    ],
    inspect: async (id) => ({
      exists: launches.has(id),
      active: active.get(id) ?? false,
    }),
    wake: async (id, _prompt, key) => {
      if (busy.has(id)) {
        throw new Error("Coordinator busy");
      }
      wakes.push(`${id}:${key ?? ""}`);
      active.set(id, true);
    },
    launch: async (input) => {
      if (rejected) {
        rejected = false;
        throw new LaunchRejectedError("Unknown worker profile");
      }
      if (launches.has(input.agentId)) {
        assert.deepEqual(input, launches.get(input.agentId));
        return;
      }
      launches.set(input.agentId, input);
      active.set(input.agentId, true);
      if (uncertain) {
        uncertain = false;
        throw new Error("Lost acknowledgement");
      }
    },
  };
  const runtime: ExecutionRuntime = {
    source: async (agentId) => ({
      agentId,
      workspaceId: placement.workspaceId,
    }),
    capture: async (source) => ({ ...placement, ...source }),
    validate: async () => {},
  };
  let engine = runExecution(
    store,
    () => runtime,
    () => workers,
  );
  const send = (agentId: string, command: unknown) =>
    engine.execute({ agentId, command });
  const read = async (id: string) => (await store.read(id)).run;
  const start = async (key = "team") => {
    const result = await send("requester", {
      kind: "orchestrate",
      key,
      title: "Delegated work",
      goal: "Inspect API and UI independently and combine findings",
      concurrency: 2,
    });
    assert.ok("run" in result);
    return result.run;
  };
  const define = async (run: StoredRun, tasks: unknown[]) => {
    assert.ok(run.source.agentId);
    await send(run.source.agentId, { kind: "define", runId: run.id, tasks });
    await send(run.source.agentId, { kind: "dispatch", runId: run.id });
    return read(run.id);
  };
  const report = async (id: string, taskId: string, outcome = "completed") => {
    const attempt = latestAttempt(await read(id), taskId);
    assert.ok(attempt);
    await send(attempt.agentId, {
      kind: "report",
      runId: id,
      attemptId: attempt.id,
      report: {
        outcome,
        summary: "Inspected assignment",
        evidence: ["Verified concrete fixture result"],
        checks: [],
      },
    });
    return attempt;
  };
  return {
    store,
    launches,
    active,
    wakes,
    send,
    read,
    start,
    startWorkspace: (workspaceId = placement.workspaceId) =>
      engine.startWorkspace(workspaceId, {
        kind: "orchestrate",
        key: "workspace-goal",
        title: "New workspace goal",
        goal: "Split and delegate this request",
      }),
    define,
    report,
    reconcile: () => engine.reconcile(),
    interrupt: () => engine.interrupt(null, "Plugin reloaded"),
    reload: () => {
      engine = runExecution(
        store,
        () => runtime,
        () => workers,
      );
    },
    busy,
    rejectNext: () => {
      rejected = true;
    },
    loseAck: () => {
      uncertain = true;
    },
  };
}
const task = (id: string, dependsOn: string[] = [], writes: string[] = []) => ({
  id,
  title: id,
  description: `Inspect ${id}`,
  dependsOn,
  reads: [],
  writes,
  checks: [],
  profile: "Small",
});

void test("orchestrator creates distinct children and joins explicit reports only after settlement", async () => {
  const f = await fixture();
  const planning = await f.start();
  assert.equal(planning.status, "planning");
  assert.notEqual(planning.source.agentId, "requester");
  assert.equal(f.launches.size, 1);
  assert.equal((await f.start()).id, planning.id);
  assert.equal(f.launches.size, 1);
  assert.ok(planning.source.agentId);
  await assert.rejects(
    f.send("requester", {
      kind: "define",
      runId: planning.id,
      tasks: [task("a")],
    }),
    /Conductor agent/,
  );
  const tasks = [task("a"), task("b"), task("join", ["a", "b"])];
  const running = await f.define(planning, tasks);
  assert.equal(f.launches.size, 3);
  assert.equal(running.execution?.attempts.length, 2);
  await f.send(planning.source.agentId, {
    kind: "define",
    runId: planning.id,
    tasks,
  });
  const a = latestAttempt(running, "a");
  const b = latestAttempt(running, "b");
  assert.ok(a && b);
  assert.notEqual(a.agentId, b.agentId);
  assert.notEqual(a.agentId, planning.source.agentId);
  assert.equal(
    f.launches.get(a.agentId)?.parentAgentId,
    planning.source.agentId,
  );
  await assert.rejects(
    f.send(b.agentId, {
      kind: "block",
      runId: planning.id,
      attemptId: a.id,
      message: "Forged",
    }),
    /assigned task agent/,
  );
  await assert.rejects(
    f.send(planning.source.agentId, {
      kind: "claim",
      runId: planning.id,
      taskId: "a",
    }),
    /dispatched/,
  );
  await f.report(planning.id, "a");
  await f.report(planning.id, "b");
  await f.reconcile();
  assert.equal(f.launches.size, 3);
  f.active.set(a.agentId, false);
  f.active.set(b.agentId, false);
  await f.reconcile();
  assert.equal(f.launches.size, 4);
  const join = latestAttempt(await f.read(planning.id), "join");
  assert.ok(join);
  await f.report(planning.id, "join");
  await assert.rejects(
    f.send(planning.source.agentId, {
      kind: "finish",
      runId: planning.id,
      summary: "Too soon",
    }),
    /settled/,
  );
  f.active.set(join.agentId, false);
  await f.reconcile();
  assert.equal(f.wakes.length, 1);
  await f.reconcile();
  assert.equal(f.wakes.length, 1);
  await assert.rejects(
    f.send(a.agentId, {
      kind: "finish",
      runId: planning.id,
      summary: "Not coordinator",
    }),
    /original source/,
  );
  await f.send(planning.source.agentId, {
    kind: "finish",
    runId: planning.id,
    summary: "Reviewed worker reports",
  });
  assert.equal((await f.read(planning.id)).status, "completed");
});

void test("writers stay serialized across report and reload until their worker stops", async () => {
  const f = await fixture();
  const plan = await f.start();
  const run = await f.define(plan, [
    task("a", [], ["a"]),
    task("b", [], ["b"]),
  ]);
  assert.equal(run.execution?.attempts.length, 1);
  const a = await f.report(plan.id, "a");
  await f.interrupt();
  f.reload();
  await f.reconcile();
  assert.equal((await f.read(plan.id)).execution?.attempts.length, 1);
  assert.equal(f.launches.size, 2);
  f.active.set(a.agentId, false);
  await f.reconcile();
  assert.equal((await f.read(plan.id)).execution?.attempts.length, 2);
});

void test("uncertain launch retries reuse durable worker and attempt identities", async () => {
  const f = await fixture();
  const plan = await f.start();
  f.loseAck();
  const run = await f.define(plan, [task("a")]);
  const first = latestAttempt(run, "a");
  assert.ok(first);
  assert.equal(first.launch?.state, "uncertain");
  assert.equal(run.status, "blocked");
  f.reload();
  await f.reconcile();
  assert.equal(f.launches.size, 2);
  assert.ok(plan.source.agentId);
  await f.send(plan.source.agentId, { kind: "dispatch", runId: plan.id });
  const current = latestAttempt(await f.read(plan.id), "a");
  assert.equal(current?.id, first.id);
  assert.equal(current?.agentId, first.agentId);
  assert.equal(current?.launch?.state, "started");
  assert.equal(f.launches.size, 2);
});

void test("unreported stopped workers block; resume keeps identity and failure retry gets a new agent", async () => {
  const f = await fixture();
  const plan = await f.start();
  const run = await f.define(plan, [task("a")]);
  const a = latestAttempt(run, "a");
  assert.ok(a && plan.source.agentId);
  f.active.set(a.agentId, false);
  await f.reconcile();
  assert.equal((await f.read(plan.id)).status, "blocked");
  await f.send(plan.source.agentId, {
    kind: "dispatch",
    runId: plan.id,
    retryTaskId: "a",
  });
  assert.equal(latestAttempt(await f.read(plan.id), "a")?.id, a.id);
  assert.equal(f.launches.size, 2);
  await f.report(plan.id, "a", "failed");
  await assert.rejects(
    f.send(plan.source.agentId, {
      kind: "dispatch",
      runId: plan.id,
      retryTaskId: "a",
    }),
    /settled/,
  );
  f.active.set(a.agentId, false);
  await f.reconcile();
  await f.send(plan.source.agentId, {
    kind: "dispatch",
    runId: plan.id,
    retryTaskId: "a",
  });
  const retry = latestAttempt(await f.read(plan.id), "a");
  assert.notEqual(retry?.id, a.id);
  assert.notEqual(retry?.agentId, a.agentId);
});

void test("uncertain conductor creation retries preserve the planning run", async () => {
  const f = await fixture();
  f.loseAck();
  const first = await f.start();
  assert.equal(first.status, "blocked");
  assert.equal(first.execution?.orchestration?.coordinatorLaunch, "uncertain");
  const second = await f.start();
  assert.equal(second.id, first.id);
  assert.equal(second.source.agentId, first.source.agentId);
  assert.equal(second.status, "planning");
  assert.equal(f.launches.size, 1);
});

void test("reload resumes a pending saved launch without allocating another attempt", async () => {
  const f = await fixture();
  const plan = await f.start();
  let run = await f.define(plan, [task("a")]);
  const a = latestAttempt(run, "a");
  assert.ok(a);
  f.launches.delete(a.agentId);
  f.active.delete(a.agentId);
  run = await f.store.update(run.id, run.version, (current) => {
    const pending = latestAttempt(current, "a");
    assert.ok(pending?.launch);
    pending.launch.state = "pending";
    return current;
  });
  f.reload();
  await f.reconcile();
  assert.equal(latestAttempt(await f.read(run.id), "a")?.id, a.id);
  assert.ok(f.launches.has(a.agentId));
  assert.equal(f.launches.size, 2);
});

void test("definitively rejected creation releases reservation and supports a corrected profile retry", async () => {
  const f = await fixture();
  const plan = await f.start();
  f.rejectNext();
  let run = await f.define(plan, [task("a", [], ["src"])]);
  const a = latestAttempt(run, "a");
  assert.ok(a && plan.source.agentId);
  assert.equal(a.state, "failed");
  assert.equal(a.reportedBy, "launcher");
  assert.equal(a.launch?.settled, true);
  assert.equal(f.launches.size, 1);
  await f.send(plan.source.agentId, {
    kind: "dispatch",
    runId: plan.id,
    retryTaskId: "a",
    profile: "Small",
  });
  run = await f.read(plan.id);
  assert.notEqual(latestAttempt(run, "a")?.id, a.id);
  assert.equal(latestAttempt(run, "a")?.state, "running");
  assert.equal(f.launches.size, 2);
});

void test("a report after manual resume requires a fresh settlement observation", async () => {
  const f = await fixture();
  const plan = await f.start();
  const run = await f.define(plan, [task("a"), task("join", ["a"])]);
  const a = latestAttempt(run, "a");
  assert.ok(a);
  f.active.set(a.agentId, false);
  await f.reconcile();
  assert.equal(
    latestAttempt(await f.read(plan.id), "a")?.launch?.settled,
    true,
  );
  f.active.set(a.agentId, true);
  await f.report(plan.id, "a");
  await f.reconcile();
  assert.equal(
    latestAttempt(await f.read(plan.id), "a")?.launch?.settled,
    false,
  );
  assert.equal(latestAttempt(await f.read(plan.id), "join"), undefined);
  f.active.set(a.agentId, false);
  await f.reconcile();
  assert.ok(latestAttempt(await f.read(plan.id), "join"));
});

void test("busy coordinator notifications do not starve another run", async () => {
  const f = await fixture();
  const one = await f.start("one");
  const two = await f.start("two");
  await f.define(one, [task("a")]);
  await f.define(two, [task("b")]);
  const a = await f.report(one.id, "a");
  const b = await f.report(two.id, "b");
  f.active.set(a.agentId, false);
  f.active.set(b.agentId, false);
  assert.ok(two.source.agentId);
  f.busy.add(two.source.agentId);
  await f.reconcile();
  assert.ok(
    f.wakes.some((value) => value.startsWith(`${one.source.agentId}:`)),
  );
  assert.equal(
    f.wakes.some((value) => value.startsWith(`${two.source.agentId}:`)),
    false,
  );
});

void test("the same blocker after resume wakes the conductor once in each generation", async () => {
  const f = await fixture();
  const plan = await f.start();
  const run = await f.define(plan, [task("a")]);
  const a = latestAttempt(run, "a");
  assert.ok(a && plan.source.agentId);
  f.active.set(a.agentId, false);
  await f.reconcile();
  assert.equal(
    f.wakes.filter((w) => w.startsWith(`${plan.source.agentId}:`)).length,
    1,
  );
  await f.send(plan.source.agentId, {
    kind: "dispatch",
    runId: plan.id,
    retryTaskId: "a",
  });
  f.active.set(a.agentId, false);
  await f.reconcile();
  await f.reconcile();
  assert.equal(
    f.wakes.filter((w) => w.startsWith(`${plan.source.agentId}:`)).length,
    2,
  );
});

void test("an empty workspace starts a coordinator without a bootstrap agent and preserves workspace retry identity", async () => {
  const f = await fixture();
  const first = await f.startWorkspace();
  assert.equal(first.run.status, "planning");
  assert.equal(first.run.execution?.orchestration?.requestedBy, null);
  assert.ok(first.run.source.agentId);
  assert.equal(f.launches.size, 1);
  assert.equal(f.launches.get(first.run.source.agentId)?.parentAgentId, null);
  const replay = await f.startWorkspace();
  assert.equal(replay.run.id, first.run.id);
  assert.equal(f.launches.size, 1);
  const other = await f.startWorkspace("another-workspace");
  assert.notEqual(other.run.id, first.run.id);
  assert.equal(f.launches.size, 2);
});
