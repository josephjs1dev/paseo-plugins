import assert from "node:assert/strict";
import test from "node:test";
import { concertExecution } from "../server/concerts/execution";
import { fileConcertStore } from "../server/concerts/store";
import { ConcertError, LaunchRejectedError } from "../server/concerts/errors";
import type { WorkerLaunch, WorkerRuntime } from "../server/concerts/workers";
import type { ExecutionRuntime } from "../server/concerts/identity";
import { latestAttempt, type StoredConcert } from "../shared/concerts/models";
import { placement } from "./concert-fixtures";
import { testDirectory } from "./fixtures";

async function fixture() {
  const store = fileConcertStore(await testDirectory());
  const launches = new Map<string, WorkerLaunch>();
  const active = new Map<string, boolean>();
  const wakes: string[] = [];
  const wakePrompts: Array<{
    agentId: string;
    prompt: string;
    key?: string;
  }> = [];
  let uncertain = false;
  let rejected = false;
  const busy = new Set<string>();
  const undeliverable = new Set<string>();
  let validateGraph: (graph: {
    tasks: { writes: string[] }[];
  }) => void = () => {};
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
    launchCheckDelaysMs: [],
    inspect: async (id) => ({
      exists: launches.has(id),
      active: active.get(id) ?? false,
      deliverable: launches.has(id) && !undeliverable.has(id),
    }),
    wake: async (id, prompt, key) => {
      if (busy.has(id)) {
        throw new ConcertError("Worker is busy");
      }
      wakePrompts.push({ agentId: id, prompt, ...(key ? { key } : {}) });
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
    validate: async (_source, graph) => validateGraph(graph),
  };
  let engine = concertExecution(
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
  const define = async (run: StoredConcert, tasks: unknown[]) => {
    assert.ok(run.source.agentId);
    await send(run.source.agentId, {
      kind: "define",
      concertId: run.id,
      tasks,
    });
    await send(run.source.agentId, { kind: "dispatch", concertId: run.id });
    return read(run.id);
  };
  const report = async (
    id: string,
    taskId: string,
    outcome = "completed",
    extra: Record<string, unknown> = {},
  ) => {
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
        ...extra,
      },
    });
    return attempt;
  };
  return {
    store,
    launches,
    active,
    wakes,
    wakePrompts,
    send,
    read,
    orchestrate,
    start,
    define,
    report,
    workers,
    reconcile: () => engine.reconcile(),
    interrupt: () => engine.interrupt(null, "Plugin reloaded"),
    reload: () => {
      engine = concertExecution(
        store,
        () => runtime,
        () => workers,
      );
    },
    busy,
    undeliverable,
    setValidate: (fn: (graph: { tasks: { writes: string[] }[] }) => void) => {
      validateGraph = fn;
    },
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

type OrchestrationFixture = Awaited<ReturnType<typeof fixture>>;

/**
 * Parses the bounded per-task failure summaries from the latest Conductor
 * notification for one concert. Callers reconcile before reading.
 */
function notificationSummary(
  f: OrchestrationFixture,
  concertId: string,
  conductorId: string,
) {
  const wake = f.wakePrompts
    .filter(
      (entry) =>
        entry.agentId === conductorId &&
        entry.prompt.startsWith(`Conductor concert ${concertId}:`),
    )
    .at(-1);
  assert.ok(wake, "expected a Conductor notification");
  return JSON.parse(wake.prompt.split("\n").slice(1).join("\n")) as Array<{
    taskId: string;
    kind: string;
    failedChecks: string[];
    message: string;
  }>;
}

void test("Conductor agent creates distinct children and joins explicit reports only after settlement", async () => {
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
  assert.equal(first.state, "running");
  assert.equal(run.status, "running");
  f.reload();
  await f.reconcile();
  assert.equal(f.launches.size, 2);
  const adopted = latestAttempt(await f.read(plan.id), "a");
  assert.equal(adopted?.id, first.id);
  assert.equal(adopted?.agentId, first.agentId);
  assert.equal(adopted?.launch?.state, "started");
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

void test("a stopped worker is nudged once, then blocked, and a failed retry continues on the same agent", async () => {
  const f = await fixture();
  const plan = await f.start();
  const run = await f.define(plan, [task("a", [], ["src"])]);
  const a = latestAttempt(run, "a");
  assert.ok(a && plan.source.agentId);
  f.active.set(a.agentId, false);
  await f.reconcile();
  // The first stop without a report only nudges the same worker.
  const nudged = latestAttempt(await f.read(plan.id), "a");
  assert.equal(nudged?.state, "running");
  assert.ok(nudged?.nudgedAt);
  assert.equal((await f.read(plan.id)).status, "running");
  assert.equal(
    f.wakes.filter((w) => w.startsWith(`${a.agentId}:nudge:${a.id}:`)).length,
    1,
  );
  // A reload must not nudge again.
  f.reload();
  await f.reconcile();
  assert.equal(
    f.wakes.filter((w) => w.startsWith(`${a.agentId}:nudge:${a.id}:`)).length,
    1,
  );
  // The second stop blocks.
  f.active.set(a.agentId, false);
  await f.reconcile();
  assert.equal(latestAttempt(await f.read(plan.id), "a")?.state, "blocked");
  assert.equal((await f.read(plan.id)).status, "blocked");
  // Resume keeps the attempt identity and carries the note.
  await f.send(plan.source.agentId, {
    kind: "dispatch",
    concertId: plan.id,
    retryTaskId: "a",
    note: "Check the shared schema",
  });
  assert.equal(latestAttempt(await f.read(plan.id), "a")?.id, a.id);
  assert.equal(f.launches.size, 2);
  await f.report(plan.id, "a", "failed", {
    checks: [{ name: "typecheck", status: "failed", detail: "TS2345" }],
    diagnosis: {
      tried: ["Narrowed the input type"],
      suspectedCause: "shared/schema.ts exports the old shape",
      need: "scope",
      requestedWrites: ["shared/schema.ts"],
    },
  });
  f.active.set(a.agentId, false);
  await f.reconcile();
  await f.send(plan.source.agentId, {
    kind: "dispatch",
    concertId: plan.id,
    retryTaskId: "a",
    note: "Widen to the schema file",
  });
  const retry = latestAttempt(await f.read(plan.id), "a");
  assert.ok(retry && retry.id !== a.id);
  assert.equal(retry.agentId, a.agentId);
  assert.equal(retry.state, "running");
  assert.equal(f.launches.size, 2);
  const continued = f.wakePrompts.find((w) =>
    w.key?.startsWith(`continue:${retry.id}`),
  );
  assert.ok(continued);
  assert.match(continued.prompt, /Widen to the schema file/);
  assert.match(continued.prompt, /3 fix rounds/);
});

void test("a failed retry with a changed worker choice seeds a new agent with the failed report", async () => {
  const f = await fixture();
  const plan = await f.start();
  const run = await f.define(plan, [task("a", [], ["src"])]);
  const a = latestAttempt(run, "a");
  assert.ok(a && plan.source.agentId);
  await f.report(plan.id, "a", "failed", {
    checks: [{ name: "typecheck", status: "failed", detail: "TS2345" }],
    diagnosis: {
      tried: ["Narrowed the input type"],
      suspectedCause: "shared/schema.ts exports the old shape",
      need: "scope",
      requestedWrites: ["shared/schema.ts"],
    },
  });
  f.active.set(a.agentId, false);
  await f.reconcile();
  await f.send(plan.source.agentId, {
    kind: "dispatch",
    concertId: plan.id,
    retryTaskId: "a",
    provider: "pi",
    note: "Continue on a different provider",
  });
  const retry = latestAttempt(await f.read(plan.id), "a");
  assert.ok(retry && retry.id !== a.id);
  assert.notEqual(retry.agentId, a.agentId);
  const prompt = f.launches.get(retry.agentId)?.prompt ?? "";
  assert.match(prompt, /previous attempt failed/i);
  assert.match(prompt, /shared\/schema\.ts exports the old shape/);
  assert.match(prompt, /Continue on a different provider/);
});

void test("uncertain conductor creation retries preserve the planning concert", async () => {
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
  // The first stop nudges; the second settles and blocks the launch.
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

void test("busy coordinator notifications do not starve another concert", async () => {
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
  // The first stop nudges; the second blocks and wakes the conductor once.
  f.active.set(a.agentId, false);
  await f.reconcile();
  assert.equal(
    f.wakes.filter((w) => w.startsWith(`${plan.source.agentId}:`)).length,
    0,
  );
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

void test("a requesting agent coordinates its own concert without creating a Conductor agent", async () => {
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

void test("a dedicated Conductor agent remains available and coordinatorProfile names one", async () => {
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

void test("dispatch addWrites grows only the retried task and refuses a path a reader holds", async () => {
  const f = await fixture();
  const plan = await f.start();
  const run = await f.define(plan, [
    task("a", [], ["src/a"]),
    {
      id: "b",
      title: "b",
      description: "Read the shared schema",
      dependsOn: [],
      reads: ["shared/schema.ts"],
      writes: [],
      checks: [],
      profile: "Small",
    },
  ]);
  const a = latestAttempt(run, "a");
  const b = latestAttempt(run, "b");
  assert.ok(a && b && plan.source.agentId);
  await f.report(plan.id, "a", "failed");
  f.active.set(a.agentId, false);
  await f.reconcile();
  // The running reader holds shared/schema.ts, so addWrites refuses it.
  await assert.rejects(
    f.send(plan.source.agentId, {
      kind: "dispatch",
      concertId: plan.id,
      retryTaskId: "a",
      addWrites: ["shared/schema.ts"],
    }),
    /addWrites refused/,
  );
  await f.send(plan.source.agentId, {
    kind: "dispatch",
    concertId: plan.id,
    retryTaskId: "a",
    addWrites: ["shared/helper.ts"],
    note: "Use the shared helper",
  });
  const grown = await f.read(plan.id);
  assert.equal(grown.revisions.length, 2);
  const tasks = grown.revisions.at(-1)?.graph.tasks ?? [];
  assert.deepEqual(tasks.find((t) => t.id === "a")?.writes, [
    "src/a",
    "shared/helper.ts",
  ]);
  const retry = latestAttempt(grown, "a");
  assert.equal(retry?.agentId, a.agentId);
  const continued = f.wakePrompts.find((w) =>
    w.key?.startsWith(`continue:${retry?.id}`),
  );
  assert.ok(continued);
  assert.match(continued.prompt, /shared\/helper\.ts/);
  assert.match(continued.prompt, /Use the shared helper/);
});

void test("the conductor notification carries a bounded per-task failure summary", async () => {
  const f = await fixture();
  const plan = await f.start();
  const run = await f.define(plan, [task("a")]);
  const a = latestAttempt(run, "a");
  assert.ok(a && plan.source.agentId);
  await f.report(plan.id, "a", "failed", {
    summary: "Typecheck fails in the new RPC handler. ".repeat(40),
    checks: [
      { name: "typecheck", status: "failed", detail: "TS2345" },
      { name: "lint", status: "failed", detail: "no-unused" },
    ],
    diagnosis: {
      tried: ["Narrowed the input type", "Regenerated the schema"],
      suspectedCause: "shared/schema.ts exports the old shape",
      need: "scope",
      requestedWrites: ["shared/schema.ts"],
    },
  });
  f.active.set(a.agentId, false);
  await f.reconcile();
  const wake = f.wakePrompts.find((w) => w.agentId === plan.source.agentId);
  assert.ok(wake);
  const payload = wake.prompt.split("\n").slice(1).join("\n");
  const summary = JSON.parse(payload) as Array<{
    taskId: string;
    kind: string;
    failedChecks: string[];
    message: string;
    diagnosis?: { need: string };
  }>;
  assert.equal(summary[0]?.taskId, "a");
  assert.equal(summary[0]?.kind, "checks-failed");
  assert.deepEqual(summary[0]?.failedChecks, ["typecheck", "lint"]);
  assert.equal(summary[0]?.diagnosis?.need, "scope");
  assert.ok((summary[0]?.message.length ?? 0) <= 400);
  assert.ok(wake.prompt.length <= 3600);
});

void test("an uncertain launch is re-checked with bounded backoff before it is adopted", async () => {
  const f = await fixture();
  const plan = await f.start();
  f.loseAck();
  const run = await f.define(plan, [task("a")]);
  const a = latestAttempt(run, "a");
  assert.ok(a);
  assert.equal(a.launch?.state, "uncertain");
  f.workers.launchCheckDelaysMs = [0, 0];
  let lookups = 0;
  f.workers.inspect = async (id) => {
    lookups++;
    if (lookups === 1) {
      return { exists: false, active: false, deliverable: false };
    }
    return {
      exists: f.launches.has(id),
      active: f.active.get(id) ?? false,
      deliverable: f.launches.has(id),
    };
  };
  // Each reconciliation performs at most one identity lookup; the schedule is
  // persisted on the launch across ticks.
  await f.reconcile();
  assert.equal(lookups, 1);
  await f.reconcile();
  assert.equal(lookups, 2);
  const adopted = latestAttempt(await f.read(plan.id), "a");
  assert.equal(adopted?.id, a.id);
  assert.equal(adopted?.launch?.state, "started");
  assert.equal(adopted?.state, "running");
});

void test("an uncertain launch that never appears is blocked after the bounded re-checks", async () => {
  const f = await fixture();
  const plan = await f.start();
  f.loseAck();
  const run = await f.define(plan, [task("a")]);
  const a = latestAttempt(run, "a");
  assert.ok(a);
  f.workers.launchCheckDelaysMs = [0, 0];
  let lookups = 0;
  f.workers.inspect = async () => {
    lookups++;
    return { exists: false, active: false, deliverable: false };
  };
  await f.reconcile();
  await f.reconcile();
  await f.reconcile();
  assert.equal(lookups, 3);
  const blocked = latestAttempt(await f.read(plan.id), "a");
  assert.equal(blocked?.id, a.id);
  assert.equal(blocked?.state, "blocked");
  assert.equal(blocked?.launch?.settled, true);
});

void test("a retry of a blocked uncertain launch re-opens reconciliation", async () => {
  const f = await fixture();
  const plan = await f.start();
  f.loseAck();
  const run = await f.define(plan, [task("a")]);
  const a = latestAttempt(run, "a");
  assert.ok(a && plan.source.agentId);
  // The acknowledgement was lost and the identity never appears, so the
  // bounded re-checks settle the attempt as blocked while the launch is still
  // uncertain and settled.
  f.workers.launchCheckDelaysMs = [0, 0];
  f.workers.inspect = async () => ({
    exists: false,
    active: false,
    deliverable: false,
  });
  await f.reconcile();
  await f.reconcile();
  await f.reconcile();
  const blocked = latestAttempt(await f.read(plan.id), "a");
  assert.equal(blocked?.state, "blocked");
  assert.equal(blocked?.launch?.state, "uncertain");
  assert.equal(blocked?.launch?.settled, true);
  // The child agent does exist but is inactive; a retry must reuse that same
  // identity, leave the attempt unsettled, and restart its check schedule.
  f.active.set(a.agentId, false);
  f.workers.inspect = async (id) => ({
    exists: f.launches.has(id),
    active: f.active.get(id) ?? false,
    deliverable: f.launches.has(id),
  });
  await f.send(plan.source.agentId, {
    kind: "dispatch",
    concertId: plan.id,
    retryTaskId: "a",
    note: "Reconfirm the launch",
  });
  const retried = latestAttempt(await f.read(plan.id), "a");
  assert.equal(retried?.id, a.id);
  assert.equal(retried?.agentId, a.agentId);
  assert.equal(retried?.state, "running");
  assert.equal(retried?.launch?.state, "started");
  assert.equal(retried?.launch?.settled, false);
  assert.equal(retried?.launch?.checks, undefined);
  assert.equal(retried?.launch?.nextCheckAt, undefined);
  assert.equal(f.launches.size, 2, "no replacement agent is created");
  // The worker is inactive, so reconcile nudges it instead of skipping the
  // settled launch forever.
  f.active.set(a.agentId, false);
  await f.reconcile();
  assert.ok(latestAttempt(await f.read(plan.id), "a")?.nudgedAt);
  assert.equal(
    f.wakes.filter((w) => w.startsWith(`${a.agentId}:nudge:${a.id}:`)).length,
    1,
  );
  // A reload keeps processing the attempt and settles the missing report.
  f.active.set(a.agentId, false);
  f.reload();
  await f.reconcile();
  const settled = latestAttempt(await f.read(plan.id), "a");
  assert.equal(settled?.state, "blocked");
  assert.equal(settled?.blockedBy, "server");
  assert.equal(settled?.launch?.settled, true);
});

void test("a failed continuation waits while another writer holds resources", async () => {
  const f = await fixture();
  const plan = await f.start();
  const run = await f.define(plan, [
    task("a", [], ["src/a"]),
    task("b", [], ["src/b"]),
  ]);
  const a = latestAttempt(run, "a");
  assert.ok(a && plan.source.agentId);
  // b cannot launch while writer a holds its resources.
  assert.equal(latestAttempt(run, "b"), undefined);
  await f.report(plan.id, "a", "failed");
  f.active.set(a.agentId, false);
  await f.reconcile();
  const b = latestAttempt(await f.read(plan.id), "b");
  assert.ok(b);
  // b now holds its writer resources, so a retry is refused before any
  // mutation and names the holder.
  await assert.rejects(
    f.send(plan.source.agentId, {
      kind: "dispatch",
      concertId: plan.id,
      retryTaskId: "a",
    }),
    /Retry cannot start now: task "b"/,
  );
  assert.equal(latestAttempt(await f.read(plan.id), "a")?.id, a.id);
  assert.equal(
    f.wakePrompts.some((w) => w.key?.startsWith("continue:")),
    false,
  );
  // b reports completion and releases its resources.
  await f.report(plan.id, "b");
  f.active.set(b.agentId, false);
  await f.reconcile();
  await f.send(plan.source.agentId, {
    kind: "dispatch",
    concertId: plan.id,
    retryTaskId: "a",
  });
  const retry = latestAttempt(await f.read(plan.id), "a");
  assert.ok(retry && retry.id !== a.id);
  assert.equal(retry.agentId, a.agentId);
});

void test("dispatch addWrites validates the grown scope before it is stored", async () => {
  const f = await fixture();
  const plan = await f.start();
  const run = await f.define(plan, [task("a", [], ["src/a"])]);
  const a = latestAttempt(run, "a");
  assert.ok(a && plan.source.agentId);
  await f.report(plan.id, "a", "failed");
  f.active.set(a.agentId, false);
  await f.reconcile();
  f.setValidate((graph) => {
    if (graph.tasks.some((task) => task.writes.includes("link/file"))) {
      throw new Error("Task scopes cannot include symbolic links.");
    }
  });
  await assert.rejects(
    f.send(plan.source.agentId, {
      kind: "dispatch",
      concertId: plan.id,
      retryTaskId: "a",
      addWrites: ["link/file"],
    }),
    /symbolic links/,
  );
  assert.equal(
    (await f.read(plan.id)).revisions.length,
    1,
    "A refused grown scope is never stored",
  );
});

void test("dispatch addWrites promotes a blocked reader but refuses while a writer holds", async () => {
  const f = await fixture();
  const plan = await f.start();
  const run = await f.define(plan, [
    {
      id: "reader",
      title: "reader",
      description: "Read the shared helper",
      dependsOn: [],
      reads: ["shared/read"],
      writes: [],
      checks: [],
      profile: "Small",
    },
    task("writer", [], ["src/b"]),
  ]);
  const reader = latestAttempt(run, "reader");
  const writer = latestAttempt(run, "writer");
  assert.ok(reader && writer && plan.source.agentId);
  // Reader blocks while the writer still holds its writer resources.
  f.active.set(reader.agentId, false);
  await f.reconcile();
  f.active.set(reader.agentId, false);
  await f.reconcile();
  assert.equal(
    latestAttempt(await f.read(plan.id), "reader")?.state,
    "blocked",
  );
  await assert.rejects(
    f.send(plan.source.agentId, {
      kind: "dispatch",
      concertId: plan.id,
      retryTaskId: "reader",
      addWrites: ["shared/helper.ts"],
    }),
    /another writer holds resources/,
  );
  // With the writer done, the promotion is safe and grows one revision.
  await f.report(plan.id, "writer");
  f.active.set(writer.agentId, false);
  await f.reconcile();
  await f.send(plan.source.agentId, {
    kind: "dispatch",
    concertId: plan.id,
    retryTaskId: "reader",
    addWrites: ["shared/helper.ts"],
  });
  const grown = await f.read(plan.id);
  assert.equal(grown.revisions.length, 2);
  assert.deepEqual(
    grown.revisions.at(-1)?.graph.tasks.find((t) => t.id === "reader")?.writes,
    ["shared/helper.ts"],
  );
  assert.equal(latestAttempt(grown, "reader")?.id, reader.id);
});

void test("a failed continuation replays its saved wake after a failed send", async () => {
  const f = await fixture();
  const plan = await f.start();
  const run = await f.define(plan, [task("a", [], ["src"])]);
  const a = latestAttempt(run, "a");
  assert.ok(a && plan.source.agentId);
  await f.report(plan.id, "a", "failed");
  f.active.set(a.agentId, false);
  await f.reconcile();
  // The wake fails before delivery; the continuation stays pending.
  f.busy.add(a.agentId);
  await f.send(plan.source.agentId, {
    kind: "dispatch",
    concertId: plan.id,
    retryTaskId: "a",
    note: "Use the shared helper",
  });
  const pending = latestAttempt(await f.read(plan.id), "a");
  assert.ok(pending && pending.id !== a.id);
  assert.equal(pending.agentId, a.agentId);
  assert.ok(pending.wake);
  assert.equal(pending.wake.key, `continue:${pending.id}`);
  assert.equal(
    f.wakePrompts.some((w) => w.key === `continue:${pending.id}`),
    false,
  );
  // A reload with the worker available replays the exact saved continuation.
  f.busy.delete(a.agentId);
  f.reload();
  await f.reconcile();
  const delivered = f.wakePrompts.find(
    (w) => w.key === `continue:${pending.id}`,
  );
  assert.ok(delivered);
  assert.match(delivered.prompt, /Use the shared helper/);
  assert.equal(
    latestAttempt(await f.read(plan.id), "a")?.wake,
    undefined,
    "A delivered continuation clears its pending wake",
  );
});

void test("a failed nudge send is replayed with the same identity", async () => {
  const f = await fixture();
  const plan = await f.start();
  const run = await f.define(plan, [task("a")]);
  const a = latestAttempt(run, "a");
  assert.ok(a);
  f.active.set(a.agentId, false);
  // The first nudge send fails, so nothing is delivered and no nudge is
  // consumed.
  f.busy.add(a.agentId);
  await f.reconcile();
  const pending = latestAttempt(await f.read(plan.id), "a");
  assert.equal(pending?.state, "running");
  assert.equal(pending?.nudgedAt, undefined);
  assert.ok(pending?.wake);
  const key = pending.wake.key;
  assert.ok(key.startsWith(`nudge:${a.id}:`));
  assert.equal(
    f.wakePrompts.some((w) => w.key === key),
    false,
  );
  // A reload with the worker available delivers exactly one nudge.
  f.busy.delete(a.agentId);
  f.reload();
  await f.reconcile();
  assert.equal(f.wakePrompts.filter((w) => w.key === key).length, 1);
  const delivered = latestAttempt(await f.read(plan.id), "a");
  assert.equal(delivered?.wake, undefined);
  assert.ok(delivered?.nudgedAt);
});

void test("a failed retry with an unavailable agent creates a replacement", async () => {
  const f = await fixture();
  const plan = await f.start();
  const run = await f.define(plan, [task("a", [], ["src"])]);
  const a = latestAttempt(run, "a");
  assert.ok(a && plan.source.agentId);
  await f.report(plan.id, "a", "failed");
  f.active.set(a.agentId, false);
  await f.reconcile();
  // Archived and closed agents inspect as existing but not deliverable.
  f.undeliverable.add(a.agentId);
  await f.send(plan.source.agentId, {
    kind: "dispatch",
    concertId: plan.id,
    retryTaskId: "a",
  });
  const retry = latestAttempt(await f.read(plan.id), "a");
  assert.ok(retry && retry.id !== a.id);
  assert.notEqual(retry.agentId, a.agentId);
  assert.ok(f.launches.has(retry.agentId));
  assert.equal(
    f.wakePrompts.some((w) => w.key?.startsWith("continue:")),
    false,
    "an unwakeable agent is never continued",
  );
});

void test("a blocked retry replaces an unavailable agent on the same attempt", async () => {
  const f = await fixture();
  const plan = await f.start();
  const run = await f.define(plan, [task("a")]);
  const a = latestAttempt(run, "a");
  assert.ok(a && plan.source.agentId);
  f.active.set(a.agentId, false);
  await f.reconcile();
  f.active.set(a.agentId, false);
  await f.reconcile();
  assert.equal(latestAttempt(await f.read(plan.id), "a")?.state, "blocked");
  f.undeliverable.add(a.agentId);
  await f.send(plan.source.agentId, {
    kind: "dispatch",
    concertId: plan.id,
    retryTaskId: "a",
  });
  const resumed = latestAttempt(await f.read(plan.id), "a");
  assert.equal(resumed?.id, a.id);
  assert.notEqual(resumed?.agentId, a.agentId);
  assert.equal(resumed?.state, "running");
  assert.equal(
    f.wakePrompts.some((w) => w.key?.startsWith("resume:")),
    false,
  );
  assert.ok(f.launches.has(resumed.agentId));
});

void test("a worker block settles without a nudge and keeps its message", async () => {
  const f = await fixture();
  const plan = await f.start();
  const run = await f.define(plan, [task("a")]);
  const a = latestAttempt(run, "a");
  assert.ok(a && plan.source.agentId);
  const workerMessage =
    "Need the user's decision on the pagination compatibility rule.";
  await f.send(a.agentId, {
    kind: "block",
    concertId: plan.id,
    attemptId: a.id,
    message: workerMessage,
  });
  f.active.set(a.agentId, false);
  await f.reconcile();
  const blocked = latestAttempt(await f.read(plan.id), "a");
  assert.equal(blocked?.state, "blocked");
  assert.equal(blocked?.launch?.settled, true);
  assert.equal(blocked?.blockedBy, "worker");
  assert.equal(blocked?.message, workerMessage);
  assert.equal(
    f.wakes.some((w) => w.startsWith(`${a.agentId}:nudge:`)),
    false,
    "a worker block is never nudged",
  );
  const summary = notificationSummary(f, plan.id, plan.source.agentId);
  assert.equal(summary[0]?.kind, "blocked");
  assert.equal(summary[0]?.message, workerMessage);
  // A reload neither nudges again nor rewrites the worker's message.
  f.reload();
  await f.reconcile();
  const afterReload = latestAttempt(await f.read(plan.id), "a");
  assert.equal(afterReload?.message, workerMessage);
  assert.equal(afterReload?.blockedBy, "worker");
  assert.equal(
    f.wakes.some((w) => w.startsWith(`${a.agentId}:nudge:`)),
    false,
  );
});

void test("a worker block is classified as blocked before its turn ends", async () => {
  const f = await fixture();
  const plan = await f.start();
  const run = await f.define(plan, [task("a")]);
  const a = latestAttempt(run, "a");
  assert.ok(a && plan.source.agentId);
  const workerMessage = "Waiting on the user's decision.";
  await f.send(a.agentId, {
    kind: "block",
    concertId: plan.id,
    attemptId: a.id,
    message: workerMessage,
  });
  // The marker is stored atomically with the block, before reconcile settles
  // the launch, so the notification can classify the attempt immediately.
  const blocked = latestAttempt(await f.read(plan.id), "a");
  assert.equal(blocked?.state, "blocked");
  assert.equal(blocked?.blockedBy, "worker");
  assert.equal(blocked?.message, workerMessage);
  // The worker is still active, so reconcile only notifies; it must not label
  // the worker's block as a server no-report settlement.
  assert.equal(f.active.get(a.agentId), true);
  await f.reconcile();
  const first = notificationSummary(f, plan.id, plan.source.agentId);
  assert.equal(first[0]?.kind, "blocked");
  assert.equal(first[0]?.message, workerMessage);
  // Once the worker stops, the settled classification stays blocked and the
  // saved notification is not corrected to a different kind later.
  f.active.set(a.agentId, false);
  await f.reconcile();
  const settled = latestAttempt(await f.read(plan.id), "a");
  assert.equal(settled?.blockedBy, "worker");
  assert.equal(settled?.launch?.settled, true);
  assert.equal(
    notificationSummary(f, plan.id, plan.source.agentId)[0]?.kind,
    "blocked",
  );
});

void test("failure kinds separate server settlements, plain failures, and launcher rejections", async () => {
  const server = await fixture();
  const serverPlan = await server.start("server");
  const serverRun = await server.define(serverPlan, [task("a")]);
  const serverAttempt = latestAttempt(serverRun, "a");
  assert.ok(serverAttempt && serverPlan.source.agentId);
  server.active.set(serverAttempt.agentId, false);
  await server.reconcile();
  server.active.set(serverAttempt.agentId, false);
  await server.reconcile();
  const settled = latestAttempt(await server.read(serverPlan.id), "a");
  assert.equal(settled?.state, "blocked");
  assert.equal(settled?.blockedBy, "server");
  assert.equal(
    notificationSummary(server, serverPlan.id, serverPlan.source.agentId)[0]
      ?.kind,
    "no-report",
  );

  const plain = await fixture();
  const plainPlan = await plain.start("plain");
  const plainRun = await plain.define(plainPlan, [task("a")]);
  const plainAttempt = latestAttempt(plainRun, "a");
  assert.ok(plainAttempt && plainPlan.source.agentId);
  await plain.report(plainPlan.id, "a", "failed");
  plain.active.set(plainAttempt.agentId, false);
  await plain.reconcile();
  assert.equal(
    notificationSummary(plain, plainPlan.id, plainPlan.source.agentId)[0]?.kind,
    "failed",
  );

  const launcher = await fixture();
  const launcherPlan = await launcher.start("launcher");
  launcher.rejectNext();
  const launcherRun = await launcher.define(launcherPlan, [task("a")]);
  const launcherAttempt = latestAttempt(launcherRun, "a");
  assert.equal(launcherAttempt?.reportedBy, "launcher");
  assert.ok(launcherPlan.source.agentId);
  await launcher.reconcile();
  assert.equal(
    notificationSummary(
      launcher,
      launcherPlan.id,
      launcherPlan.source.agentId,
    )[0]?.kind,
    "launch",
  );
});

void test("an uncertain launch re-check is persisted and waits for its next tick", async () => {
  const f = await fixture();
  const plan = await f.start();
  f.loseAck();
  const run = await f.define(plan, [task("a")]);
  const a = latestAttempt(run, "a");
  assert.ok(a);
  f.workers.launchCheckDelaysMs = [60_000, 60_000];
  let lookups = 0;
  f.workers.inspect = async () => {
    lookups++;
    return { exists: false, active: false, deliverable: false };
  };
  await f.reconcile();
  assert.equal(lookups, 1);
  const scheduled = latestAttempt(await f.read(plan.id), "a");
  assert.equal(scheduled?.launch?.checks, 1);
  assert.ok((scheduled?.launch?.nextCheckAt ?? 0) > Date.now());
  // A reload keeps the saved progress and does not inspect before the tick.
  f.reload();
  await f.reconcile();
  assert.equal(lookups, 1);
  // Drive the schedule forward by moving the saved next check into the past.
  const current = await f.read(plan.id);
  await f.store.update(current.id, current.version, (value) => {
    const attempt = latestAttempt(value, "a");
    if (attempt?.launch) {
      attempt.launch.nextCheckAt = 0;
    }
    return value;
  });
  await f.reconcile();
  assert.equal(lookups, 2);
  assert.equal(latestAttempt(await f.read(plan.id), "a")?.launch?.checks, 2);
});

void test("a refused retry names the concurrency limit and saves no added writes", async () => {
  const f = await fixture();
  const limited = await f.orchestrate("limited", {
    coordinator: "agent",
    concurrency: 1,
  });
  assert.ok("run" in limited);
  const run = await f.define(limited.run, [
    task("a", [], ["src/a"]),
    task("b", [], ["src/b"]),
  ]);
  const a = latestAttempt(run, "a");
  assert.ok(a && limited.run.source.agentId);
  assert.equal(latestAttempt(run, "b"), undefined);
  await f.report(limited.run.id, "a", "failed");
  f.active.set(a.agentId, false);
  await f.reconcile();
  // b now holds the only writer slot while a's retry cannot start.
  assert.ok(latestAttempt(await f.read(limited.run.id), "b"));
  await assert.rejects(
    f.send(limited.run.source.agentId, {
      kind: "dispatch",
      concertId: limited.run.id,
      retryTaskId: "a",
      addWrites: ["shared/helper.ts"],
    }),
    /Retry cannot start now: the concert concurrency limit \(1\) is reached/,
  );
  const refused = await f.read(limited.run.id);
  assert.equal(
    refused.revisions.length,
    1,
    "a refused retry must not save its added writes",
  );
  assert.equal(latestAttempt(refused, "a")?.id, a.id);
});
