import assert from "node:assert/strict";
import test from "node:test";
import { runExecution } from "../server/concerts/execution";
import { fileRunStore } from "../server/concerts/store";
import { LaunchRejectedError } from "../server/concerts/errors";
import type { WorkerLaunch, WorkerRuntime } from "../server/concerts/workers";
import type { ExecutionRuntime } from "../server/concerts/identity";
import { latestAttempt, type StoredRun } from "../shared/concerts/models";
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
      {
        id: "small",
        name: "Small",
        notes: "Bounded read-only assignments",
        provider: "fake",
      },
    ],
    models: async () => [{ provider: "fake", models: ["model", "other"] }],
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
  const orchestrate = (key: string, fields: Record<string, unknown> = {}) =>
    send("requester", {
      kind: "orchestrate",
      key,
      title: "Delegated work",
      goal: "Inspect API and UI independently and combine findings",
      concurrency: 2,
      ...fields,
    });
  const start = async (key = "team") => {
    const result = await orchestrate(key, { coordinator: "agent" });
    assert.ok("run" in result);
    return result.run;
  };
  const define = async (run: StoredRun, tasks: unknown[]) => {
    assert.ok(run.source.agentId);
    await send(run.source.agentId, {
      kind: "define",
      concertId: run.id,
      tasks,
    });
    await send(run.source.agentId, { kind: "dispatch", concertId: run.id });
    return read(run.id);
  };
  const report = async (id: string, taskId: string, outcome = "completed") => {
    const attempt = latestAttempt(await read(id), taskId);
    assert.ok(attempt);
    await send(attempt.agentId, {
      kind: "report",
      concertId: id,
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
    orchestrate,
    start,
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
      concertId: planning.id,
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
    concertId: planning.id,
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
      concertId: planning.id,
      attemptId: a.id,
      message: "Forged",
    }),
    /assigned task agent/,
  );
  await assert.rejects(
    f.send(planning.source.agentId, {
      kind: "claim",
      concertId: planning.id,
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
      concertId: planning.id,
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
      concertId: planning.id,
      summary: "Not coordinator",
    }),
    /original source/,
  );
  await f.send(planning.source.agentId, {
    kind: "finish",
    concertId: planning.id,
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
  await f.send(plan.source.agentId, {
    kind: "dispatch",
    concertId: plan.id,
  });
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
    concertId: plan.id,
    retryTaskId: "a",
  });
  assert.equal(latestAttempt(await f.read(plan.id), "a")?.id, a.id);
  assert.equal(f.launches.size, 2);
  await f.report(plan.id, "a", "failed");
  await assert.rejects(
    f.send(plan.source.agentId, {
      kind: "dispatch",
      concertId: plan.id,
      retryTaskId: "a",
    }),
    /settled/,
  );
  f.active.set(a.agentId, false);
  await f.reconcile();
  await f.send(plan.source.agentId, {
    kind: "dispatch",
    concertId: plan.id,
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
    concertId: plan.id,
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
    concertId: plan.id,
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

void test("a requesting agent coordinates its own run without creating a Conductor agent", async () => {
  const f = await fixture();
  const first = await f.orchestrate("self");
  assert.ok("run" in first && "instructions" in first);
  const { run } = first;
  assert.equal(run.source.agentId, "requester");
  assert.equal(run.status, "planning");
  assert.equal(run.execution?.orchestration?.coordinator, "self");
  assert.equal(run.execution?.orchestration?.coordinatorLaunch, "started");
  assert.equal(f.launches.size, 0);
  assert.match(String(first.instructions), /--agent 'requester'/);
  assert.match(String(first.instructions), /do not edit this checkout/);
  const replay = await f.orchestrate("self");
  assert.ok("run" in replay);
  assert.equal(replay.run.id, run.id);
  assert.equal(f.launches.size, 0);
  const running = await f.define(run, [task("a")]);
  const a = latestAttempt(running, "a");
  assert.ok(a);
  assert.equal(f.launches.get(a.agentId)?.parentAgentId, "requester");
  await f.report(run.id, "a");
  f.active.set(a.agentId, false);
  await f.reconcile();
  assert.deepEqual(f.wakes, [`requester:${run.id}:all-reported`]);
  await f.send("requester", {
    kind: "finish",
    concertId: run.id,
    summary: "Reviewed worker reports",
  });
  assert.equal((await f.read(run.id)).status, "completed");
});

void test("a dedicated coordinator remains available and profiles require one", async () => {
  const f = await fixture();
  await assert.rejects(
    f.orchestrate("profile", {
      coordinatorProfile: "Small",
      coordinator: "self",
    }),
    /coordinatorProfile requires/,
  );
  const result = await f.orchestrate("profile", {
    coordinatorProfile: "Small",
  });
  assert.ok("run" in result);
  assert.equal("instructions" in result, false);
  assert.equal(result.run.execution?.orchestration?.coordinator, "agent");
  assert.notEqual(result.run.source.agentId, "requester");
  assert.equal(f.launches.size, 1);
  // Changing how an existing key is coordinated is a different request.
  await assert.rejects(
    f.orchestrate("profile", { coordinator: "agent" }),
    /belongs to another plan/,
  );
});

const inlineTask = (id: string) => ({
  id,
  title: id,
  description: `Inspect ${id}`,
  dependsOn: [],
  reads: [],
  writes: ["src"],
  checks: [],
  provider: "pi",
  model: "pi-test",
  thinkingOptionId: "high",
});

void test("inline worker choices persist on tasks and reach the worker launch", async () => {
  const f = await fixture();
  const plan = await f.start();
  const run = await f.define(plan, [inlineTask("a")]);
  assert.deepEqual(run.revisions.at(-1)?.graph.tasks[0]?.worker, {
    role: "implementation",
    provider: "pi",
    model: "pi-test",
    thinkingOptionId: "high",
    profile: "inherit",
  });
  const a = latestAttempt(run, "a");
  assert.ok(a);
  const launch = f.launches.get(a.agentId);
  assert.equal(launch?.profile, undefined);
  assert.equal(launch?.provider, "pi");
  assert.equal(launch?.model, "pi-test");
  assert.equal(launch?.thinkingOptionId, "high");
});

void test("a failed retry can replace a profile with an inline worker choice", async () => {
  const f = await fixture();
  const plan = await f.start();
  assert.ok(plan.source.agentId);
  f.rejectNext();
  const failed = latestAttempt(
    await f.define(plan, [task("a", [], ["src"])]),
    "a",
  );
  assert.equal(failed?.state, "failed");
  await assert.rejects(
    f.send(plan.source.agentId, {
      kind: "dispatch",
      concertId: plan.id,
      retryTaskId: "a",
      profile: "Small",
      provider: "pi",
    }),
  );
  await f.send(plan.source.agentId, {
    kind: "dispatch",
    concertId: plan.id,
    retryTaskId: "a",
    provider: "pi",
  });
  const retry = latestAttempt(await f.read(plan.id), "a");
  assert.ok(retry && retry.id !== failed?.id);
  assert.equal(retry.launch?.profile, "inherit");
  assert.equal(retry.launch?.provider, "pi");
  const launch = f.launches.get(retry.agentId);
  assert.equal(launch?.profile, undefined);
  assert.equal(launch?.provider, "pi");
});
