import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { symphonyExecution } from "../server/symphonies/execution";
import { fileSymphonyStore } from "../server/symphonies/store";
import {
  SymphonyError,
  LaunchRejectedError,
} from "../server/symphonies/errors";
import type { WorkerLaunch, WorkerRuntime } from "../server/symphonies/workers";
import type { ExecutionRuntime } from "../server/symphonies/identity";
import {
  changesRuntime,
  type SymphonyChangesRuntime,
} from "../server/symphonies/changes";
import {
  latestAttempt,
  type StoredSymphony,
} from "../shared/symphonies/models";
import { effectiveTask } from "../shared/symphonies/score";
import { placement } from "./symphony-fixtures";
import { testDirectory } from "./fixtures";

async function fixture() {
  const store = fileSymphonyStore(await testDirectory());
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
  let validateScore: (score: {
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
        throw new SymphonyError("Task agent is busy");
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
  let fingerprintImpl: SymphonyChangesRuntime["fingerprint"] = async () => null;
  const runtime: ExecutionRuntime & SymphonyChangesRuntime = {
    source: async (agentId) => ({
      agentId,
      concertId: placement.concertId,
    }),
    capture: async (source) => ({ ...placement, ...source }),
    validate: async (_source, score) => validateScore(score),
    // Tests that care about changed paths install a stateful fake; the default
    // reports an unavailable observation, as a non-Git checkout would.
    fingerprint: async (checkout, writes) => fingerprintImpl(checkout, writes),
  };
  let engine = symphonyExecution(
    store,
    () => runtime,
    () => workers,
  );
  const send = (agentId: string, command: unknown) =>
    engine.execute({ agentId, command });
  const read = async (id: string) => (await store.read(id)).symphony;
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
    const result = await orchestrate(key, { conductor: "agent" });
    assert.ok("symphony" in result);
    return result.symphony;
  };
  const define = async (symphony: StoredSymphony, tasks: unknown[]) => {
    assert.ok(symphony.source.agentId);
    await send(symphony.source.agentId, {
      kind: "define",
      symphonyId: symphony.id,
      tasks,
    });
    await send(symphony.source.agentId, {
      kind: "dispatch",
      symphonyId: symphony.id,
    });
    return read(symphony.id);
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
      symphonyId: id,
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
      engine = symphonyExecution(
        store,
        () => runtime,
        () => workers,
      );
    },
    busy,
    undeliverable,
    setValidate: (fn: (score: { tasks: { writes: string[] }[] }) => void) => {
      validateScore = fn;
    },
    setFingerprint: (fn: SymphonyChangesRuntime["fingerprint"]) => {
      fingerprintImpl = fn;
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

const execute = promisify(execFile);

/** A committed Git checkout with one tracked file under `src`. */
async function repository(): Promise<string> {
  const directory = await testDirectory();
  const git = (args: string[]) =>
    execute("git", ["-c", "core.fsmonitor=false", ...args], {
      cwd: directory,
      timeout: 5000,
      maxBuffer: 1_000_000,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    });
  await git(["init", "-q"]);
  await git(["config", "user.email", "test@example.com"]);
  await git(["config", "user.name", "Test"]);
  await mkdir(join(directory, "src"), { recursive: true });
  await writeFile(join(directory, "src", "a.ts"), "export const a = 1;\n");
  await git(["add", "."]);
  await git(["commit", "-q", "-m", "initial"]);
  return directory;
}

type OrchestrationFixture = Awaited<ReturnType<typeof fixture>>;

/**
 * Parses the bounded per-task failure summaries from the latest Conductor
 * notification for one symphony. Callers reconcile before reading.
 */
function notificationSummary(
  f: OrchestrationFixture,
  symphonyId: string,
  conductorId: string,
) {
  const wake = f.wakePrompts
    .filter(
      (entry) =>
        entry.agentId === conductorId &&
        entry.prompt.startsWith(`Conductor symphony ${symphonyId}:`),
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
      symphonyId: planning.id,
      tasks: [task("a")],
    }),
    /Conductor agent/,
  );
  const tasks = [task("a"), task("b"), task("join", ["a", "b"])];
  const running = await f.define(planning, tasks);
  assert.equal(f.launches.size, 3);
  assert.equal(running.execution.attempts.length, 2);
  await f.send(planning.source.agentId, {
    kind: "define",
    symphonyId: planning.id,
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
      symphonyId: planning.id,
      attemptId: a.id,
      message: "Forged",
    }),
    /assigned task agent/,
  );
  await assert.rejects(
    f.send(planning.source.agentId, {
      kind: "claim",
      symphonyId: planning.id,
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
      symphonyId: planning.id,
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
      symphonyId: planning.id,
      summary: "Not conductor",
    }),
    /original source/,
  );
  await f.send(planning.source.agentId, {
    kind: "finish",
    symphonyId: planning.id,
    summary: "Reviewed task agent reports",
  });
  assert.equal((await f.read(planning.id)).status, "completed");
});

void test("writers stay serialized across report and reload until their task agent stops", async () => {
  const f = await fixture();
  const plan = await f.start();
  const symphony = await f.define(plan, [
    task("a", [], ["a"]),
    task("b", [], ["b"]),
  ]);
  assert.equal(symphony.execution.attempts.length, 1);
  const a = await f.report(plan.id, "a");
  await f.interrupt();
  f.reload();
  await f.reconcile();
  assert.equal((await f.read(plan.id)).execution.attempts.length, 1);
  assert.equal(f.launches.size, 2);
  f.active.set(a.agentId, false);
  await f.reconcile();
  assert.equal((await f.read(plan.id)).execution.attempts.length, 2);
});

void test("uncertain launch retries reuse durable task agent and attempt identities", async () => {
  const f = await fixture();
  const plan = await f.start();
  f.loseAck();
  const symphony = await f.define(plan, [task("a")]);
  const first = latestAttempt(symphony, "a");
  assert.ok(first);
  assert.equal(first.launch?.state, "uncertain");
  assert.equal(first.state, "running");
  assert.equal(symphony.status, "running");
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
    symphonyId: plan.id,
  });
  const current = latestAttempt(await f.read(plan.id), "a");
  assert.equal(current?.id, first.id);
  assert.equal(current?.agentId, first.agentId);
  assert.equal(current?.launch?.state, "started");
  assert.equal(f.launches.size, 2);
});

void test("a stopped task agent is nudged once, then blocked, and a failed retry continues on the same agent", async () => {
  const f = await fixture();
  const plan = await f.start();
  const symphony = await f.define(plan, [task("a", [], ["src"])]);
  const a = latestAttempt(symphony, "a");
  assert.ok(a && plan.source.agentId);
  f.active.set(a.agentId, false);
  await f.reconcile();
  // The first stop without a report only nudges the same task agent.
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
    symphonyId: plan.id,
    retryTaskId: "a",
    note: "Check the shared schema",
  });
  assert.equal(latestAttempt(await f.read(plan.id), "a")?.id, a.id);
  assert.equal(f.launches.size, 2);
  // The same worker choice resumes the same agent with a short continuation.
  const resumed = f.wakePrompts.find((w) =>
    w.key?.startsWith(`resume:${a.id}:`),
  );
  assert.ok(resumed);
  assert.match(resumed.prompt, /Continue task a, now attempt/);
  assert.match(resumed.prompt, /Conductor note: Check the shared schema/);
  assert.equal(resumed.prompt.includes("CONDUCTOR_JSON"), false);
  assert.equal(resumed.prompt.includes("--socket"), false);
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
    symphonyId: plan.id,
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
  assert.match(continued.prompt, /Report or block this attempt when done\./);
});

void test("a failed retry with a changed worker choice seeds a new agent with the failed report", async () => {
  const f = await fixture();
  const plan = await f.start();
  const symphony = await f.define(plan, [task("a", [], ["src"])]);
  const a = latestAttempt(symphony, "a");
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
    symphonyId: plan.id,
    retryTaskId: "a",
    provider: "pi",
    note: "Continue on a different provider",
  });
  const retry = latestAttempt(await f.read(plan.id), "a");
  assert.ok(retry && retry.id !== a.id);
  assert.notEqual(retry.agentId, a.agentId);
  const prompt = f.launches.get(retry.agentId)?.prompt ?? "";
  assert.match(prompt, /You are replacing the agent from the previous attempt/);
  assert.match(
    prompt,
    /- Suspected cause: shared\/schema\.ts exports the old shape/,
  );
  assert.match(prompt, /Conductor note: Continue on a different provider/);
});

void test("uncertain conductor creation retries preserve the planning symphony", async () => {
  const f = await fixture();
  f.loseAck();
  const first = await f.start();
  assert.equal(first.status, "blocked");
  assert.equal(first.execution.conducting?.conductorLaunch, "uncertain");
  const second = await f.start();
  assert.equal(second.id, first.id);
  assert.equal(second.source.agentId, first.source.agentId);
  assert.equal(second.status, "planning");
  assert.equal(f.launches.size, 1);
});

void test("reload resumes a pending saved launch without allocating another attempt", async () => {
  const f = await fixture();
  const plan = await f.start();
  let symphony = await f.define(plan, [task("a")]);
  const a = latestAttempt(symphony, "a");
  assert.ok(a);
  f.launches.delete(a.agentId);
  f.active.delete(a.agentId);
  symphony = await f.store.update(symphony.id, symphony.version, (current) => {
    const pending = latestAttempt(current, "a");
    assert.ok(pending?.launch);
    pending.launch.state = "pending";
    return current;
  });
  f.reload();
  await f.reconcile();
  assert.equal(latestAttempt(await f.read(symphony.id), "a")?.id, a.id);
  assert.ok(f.launches.has(a.agentId));
  assert.equal(f.launches.size, 2);
});

void test("definitively rejected creation releases reservation and supports a corrected profile retry", async () => {
  const f = await fixture();
  const plan = await f.start();
  f.rejectNext();
  let symphony = await f.define(plan, [task("a", [], ["src"])]);
  const a = latestAttempt(symphony, "a");
  assert.ok(a && plan.source.agentId);
  assert.equal(a.state, "failed");
  assert.equal(a.reportedBy, "launcher");
  assert.equal(a.launch?.settled, true);
  assert.equal(f.launches.size, 1);
  await f.send(plan.source.agentId, {
    kind: "dispatch",
    symphonyId: plan.id,
    retryTaskId: "a",
    profile: "Small",
  });
  symphony = await f.read(plan.id);
  assert.notEqual(latestAttempt(symphony, "a")?.id, a.id);
  assert.equal(latestAttempt(symphony, "a")?.state, "running");
  assert.equal(f.launches.size, 2);
});

void test("a report after manual resume requires a fresh settlement observation", async () => {
  const f = await fixture();
  const plan = await f.start();
  const symphony = await f.define(plan, [task("a"), task("join", ["a"])]);
  const a = latestAttempt(symphony, "a");
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

void test("busy conductor notifications do not starve another symphony", async () => {
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
  const symphony = await f.define(plan, [task("a")]);
  const a = latestAttempt(symphony, "a");
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
    symphonyId: plan.id,
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

void test("a requesting agent coordinates its own symphony without creating a Conductor agent", async () => {
  const f = await fixture();
  const first = await f.orchestrate("self");
  assert.ok("symphony" in first && "instructions" in first);
  const { symphony } = first;
  assert.equal(symphony.source.agentId, "requester");
  assert.equal(symphony.status, "planning");
  assert.equal(symphony.execution.conducting?.conductor, "self");
  assert.equal(symphony.execution.conducting?.conductorLaunch, "started");
  assert.equal(f.launches.size, 0);
  assert.match(String(first.instructions), /--agent 'requester'/);
  assert.match(String(first.instructions), /do not edit this checkout/);
  const replay = await f.orchestrate("self");
  assert.ok("symphony" in replay);
  assert.equal(replay.symphony.id, symphony.id);
  assert.equal(f.launches.size, 0);
  const running = await f.define(symphony, [task("a")]);
  const a = latestAttempt(running, "a");
  assert.ok(a);
  assert.equal(f.launches.get(a.agentId)?.parentAgentId, "requester");
  await f.report(symphony.id, "a");
  f.active.set(a.agentId, false);
  await f.reconcile();
  assert.deepEqual(f.wakes, [`requester:${symphony.id}:all-reported`]);
  await f.send("requester", {
    kind: "finish",
    symphonyId: symphony.id,
    summary: "Reviewed task agent reports",
  });
  assert.equal((await f.read(symphony.id)).status, "completed");
});

void test("a dedicated Conductor agent remains available and conductorProfile names one", async () => {
  const f = await fixture();
  await assert.rejects(
    f.orchestrate("profile", {
      conductorProfile: "Small",
      conductor: "self",
    }),
    /conductorProfile requires/,
  );
  const result = await f.orchestrate("profile", {
    conductorProfile: "Small",
  });
  assert.ok("symphony" in result);
  assert.equal("instructions" in result, false);
  assert.equal(result.symphony.execution.conducting?.conductor, "agent");
  assert.notEqual(result.symphony.source.agentId, "requester");
  assert.equal(f.launches.size, 1);
  // Changing how an existing key is coordinated is a different request.
  await assert.rejects(
    f.orchestrate("profile", { conductor: "agent" }),
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
  const symphony = await f.define(plan, [inlineTask("a")]);
  assert.deepEqual(symphony.revisions.at(-1)?.score.tasks[0]?.worker, {
    role: "implementation",
    provider: "pi",
    model: "pi-test",
    thinkingOptionId: "high",
    profile: "inherit",
  });
  const a = latestAttempt(symphony, "a");
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
      symphonyId: plan.id,
      retryTaskId: "a",
      profile: "Small",
      provider: "pi",
    }),
  );
  await f.send(plan.source.agentId, {
    kind: "dispatch",
    symphonyId: plan.id,
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
  const symphony = await f.define(plan, [
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
  const a = latestAttempt(symphony, "a");
  const b = latestAttempt(symphony, "b");
  assert.ok(a && b && plan.source.agentId);
  await f.report(plan.id, "a", "failed");
  f.active.set(a.agentId, false);
  await f.reconcile();
  // The running reader holds shared/schema.ts, so addWrites refuses it.
  await assert.rejects(
    f.send(plan.source.agentId, {
      kind: "dispatch",
      symphonyId: plan.id,
      retryTaskId: "a",
      addWrites: ["shared/schema.ts"],
    }),
    /addWrites refused/,
  );
  await f.send(plan.source.agentId, {
    kind: "dispatch",
    symphonyId: plan.id,
    retryTaskId: "a",
    addWrites: ["shared/helper.ts"],
    note: "Use the shared helper",
  });
  const grown = await f.read(plan.id);
  // The plan never changes: the addition lives on the retry attempt.
  assert.equal(grown.revisions.length, 1);
  const tasks = grown.revisions.at(-1)?.score.tasks ?? [];
  assert.deepEqual(tasks.find((t) => t.id === "a")?.writes, ["src/a"]);
  const retry = latestAttempt(grown, "a");
  assert.equal(retry?.agentId, a.agentId);
  assert.deepEqual(retry?.addedWrites, [
    {
      path: "shared/helper.ts",
      reason: "Use the shared helper",
      at: retry?.addedWrites?.[0]?.at,
    },
  ]);
  const continued = f.wakePrompts.find((w) =>
    w.key?.startsWith(`continue:${retry?.id}`),
  );
  assert.ok(continued);
  assert.match(continued.prompt, /shared\/helper\.ts/);
  assert.match(continued.prompt, /Use the shared helper/);
});

void test("Conductor-added writes last for the task and survive later retries", async () => {
  const f = await fixture();
  const plan = await f.start();
  const symphony = await f.define(plan, [task("a", [], ["src/a"])]);
  const first = latestAttempt(symphony, "a");
  assert.ok(first && plan.source.agentId);
  await f.report(plan.id, "a", "failed");
  f.active.set(first.agentId, false);
  await f.reconcile();
  await f.send(plan.source.agentId, {
    kind: "dispatch",
    symphonyId: plan.id,
    retryTaskId: "a",
    addWrites: ["shared/helper.ts"],
    note: "Needs the shared helper",
  });
  const second = latestAttempt(await f.read(plan.id), "a");
  assert.ok(second && second.id !== first.id);
  assert.deepEqual(
    second.addedWrites?.map((grant) => grant.path),
    ["shared/helper.ts"],
  );
  // The next retry needs no new addWrites: the effective scope already carries
  // the addition recorded on the earlier attempt.
  await f.report(plan.id, "a", "failed", {
    checks: [{ name: "typecheck", status: "failed", detail: "TS2345" }],
    diagnosis: {
      tried: ["Retried with the shared helper"],
      suspectedCause: "The helper still fails typecheck",
      need: "none",
    },
  });
  f.active.set(second.agentId, false);
  await f.reconcile();
  await f.send(plan.source.agentId, {
    kind: "dispatch",
    symphonyId: plan.id,
    retryTaskId: "a",
  });
  const final = await f.read(plan.id);
  assert.equal(final.revisions.length, 1);
  const continued = f.wakePrompts.find((w) =>
    w.key?.startsWith(`continue:${latestAttempt(final, "a")?.id}`),
  );
  assert.ok(continued);
  assert.match(continued.prompt, /shared\/helper\.ts/);
  const definition = final.revisions
    .at(-1)
    ?.score.tasks.find((t) => t.id === "a");
  assert.ok(definition);
  assert.deepEqual(definition.writes, ["src/a"]);
  assert.deepEqual(effectiveTask(final, definition).writes, [
    "src/a",
    "shared/helper.ts",
  ]);
});

void test("a retry prompt drops the failed attempt's temporary widen grants", async () => {
  const f = await fixture();
  const plan = await f.start();
  const symphony = await f.define(plan, [task("a", [], ["src/a"])]);
  const first = latestAttempt(symphony, "a");
  assert.ok(first && plan.source.agentId);
  // The task agent temporarily widens its first attempt beyond the plan.
  await f.send(first.agentId, {
    kind: "widen",
    symphonyId: plan.id,
    attemptId: first.id,
    paths: ["shared/old.ts"],
    reason: "Typecheck needs the shared type",
  });
  await f.report(plan.id, "a", "failed");
  f.active.set(first.agentId, false);
  await f.reconcile();
  // A same-agent continuation becomes the latest attempt, so the widen grant
  // expires and must not appear in the continuation prompt.
  await f.send(plan.source.agentId, {
    kind: "dispatch",
    symphonyId: plan.id,
    retryTaskId: "a",
    note: "Retry without the shared file",
  });
  const continued = latestAttempt(await f.read(plan.id), "a");
  assert.ok(continued && continued.id !== first.id);
  const continuation = f.wakePrompts.find((w) =>
    w.key?.startsWith(`continue:${continued.id}`),
  );
  assert.ok(continuation);
  assert.match(continuation.prompt, /src\/a/);
  assert.doesNotMatch(continuation.prompt, /shared\/old\.ts/);
  // The same rule holds for a reserve that creates a fresh agent.
  await f.send(continued.agentId, {
    kind: "widen",
    symphonyId: plan.id,
    attemptId: continued.id,
    paths: ["shared/new.ts"],
    reason: "The retry needs the new shared type",
  });
  await f.report(plan.id, "a", "failed");
  f.active.set(continued.agentId, false);
  await f.reconcile();
  await f.send(plan.source.agentId, {
    kind: "dispatch",
    symphonyId: plan.id,
    retryTaskId: "a",
    provider: "pi",
    note: "Retry on a new agent",
  });
  const reserved = latestAttempt(await f.read(plan.id), "a");
  assert.ok(reserved && reserved.id !== continued.id);
  const launchPrompt = f.launches.get(reserved.agentId)?.prompt ?? "";
  assert.match(launchPrompt, /src\/a/);
  assert.doesNotMatch(launchPrompt, /shared\/new\.ts/);
  const definition = (await f.read(plan.id)).revisions
    .at(-1)
    ?.score.tasks.find((t) => t.id === "a");
  assert.ok(definition);
  assert.deepEqual(effectiveTask(await f.read(plan.id), definition).writes, [
    "src/a",
  ]);
});

void test("a later launch validates the task's effective writes, not just the newest plan", async () => {
  const f = await fixture();
  const plan = await f.start();
  const symphony = await f.define(plan, [task("a", [], ["src/a"])]);
  const first = latestAttempt(symphony, "a");
  assert.ok(first && plan.source.agentId);
  await f.report(plan.id, "a", "failed");
  f.active.set(first.agentId, false);
  await f.reconcile();
  // The Conductor records a persistent addition on the retry attempt; it never
  // becomes a plan revision.
  await f.send(plan.source.agentId, {
    kind: "dispatch",
    symphonyId: plan.id,
    retryTaskId: "a",
    addWrites: ["shared/helper.ts"],
    note: "Needs the shared helper",
  });
  const added = latestAttempt(await f.read(plan.id), "a");
  assert.ok(added && added.id !== first.id);
  assert.deepEqual(
    added.addedWrites?.map((grant) => grant.path),
    ["shared/helper.ts"],
  );
  // A later launch re-validates the effective scope, so the rejection lands
  // even though the plan never contains the added path.
  f.setValidate((score) => {
    if (
      score.tasks.some((candidate) =>
        candidate.writes.includes("shared/helper.ts"),
      )
    ) {
      throw new SymphonyError("Task scopes cannot include symbolic links.");
    }
  });
  await f.report(plan.id, "a", "failed");
  f.active.set(added.agentId, false);
  await f.reconcile();
  await f.send(plan.source.agentId, {
    kind: "dispatch",
    symphonyId: plan.id,
    retryTaskId: "a",
    provider: "pi",
    note: "Retry on a new agent",
  });
  const rejected = latestAttempt(await f.read(plan.id), "a");
  assert.ok(rejected && rejected.id !== added.id);
  assert.equal(rejected.state, "failed");
  assert.equal(rejected.reportedBy, "launcher");
  assert.match(
    rejected.report?.summary ?? "",
    /Task scopes cannot include symbolic links/,
  );
  assert.equal(f.launches.has(rejected.agentId), false);
  assert.equal((await f.read(plan.id)).revisions.length, 1);
});

void test("addWrites promotes a path the latest attempt widened so it survives the next retry", async () => {
  const f = await fixture();
  const plan = await f.start();
  const symphony = await f.define(plan, [task("a", [], ["src/a"])]);
  const first = latestAttempt(symphony, "a");
  assert.ok(first && plan.source.agentId);
  await f.send(first.agentId, {
    kind: "widen",
    symphonyId: plan.id,
    attemptId: first.id,
    paths: ["shared/helper.ts"],
    reason: "Trying the shared helper",
  });
  await f.report(plan.id, "a", "failed");
  f.active.set(first.agentId, false);
  await f.reconcile();
  // The Conductor promotes the widened path so it lasts for the task.
  await f.send(plan.source.agentId, {
    kind: "dispatch",
    symphonyId: plan.id,
    retryTaskId: "a",
    addWrites: ["shared/helper.ts"],
    note: "Keep the shared helper",
  });
  const promoted = await f.read(plan.id);
  assert.equal(promoted.revisions.length, 1);
  const retry = latestAttempt(promoted, "a");
  assert.ok(retry && retry.id !== first.id);
  assert.deepEqual(
    promoted.revisions.at(-1)?.score.tasks.find((t) => t.id === "a")?.writes,
    ["src/a"],
  );
  assert.deepEqual(
    retry.addedWrites?.map((grant) => grant.path),
    ["shared/helper.ts"],
  );
  // The promotion now persists through a later retry without the grant.
  await f.report(plan.id, "a", "failed");
  f.active.set(retry.agentId, false);
  await f.reconcile();
  await f.send(plan.source.agentId, {
    kind: "dispatch",
    symphonyId: plan.id,
    retryTaskId: "a",
  });
  const final = await f.read(plan.id);
  const definition = final.revisions
    .at(-1)
    ?.score.tasks.find((t) => t.id === "a");
  assert.ok(definition);
  assert.deepEqual(effectiveTask(final, definition).writes, [
    "src/a",
    "shared/helper.ts",
  ]);
});

void test("the conductor notification carries a bounded per-task failure summary", async () => {
  const f = await fixture();
  const plan = await f.start();
  const symphony = await f.define(plan, [task("a")]);
  const a = latestAttempt(symphony, "a");
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
    attempt: number;
    attemptCount: number;
    kind: string;
    failedChecks: string[];
    message: string;
    diagnosis?: { need: string };
  }>;
  assert.equal(summary[0]?.taskId, "a");
  // The notification numbers attempts per task, like the History tab.
  assert.equal(summary[0]?.attempt, 1);
  assert.equal(summary[0]?.attemptCount, 1);
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
  const symphony = await f.define(plan, [task("a")]);
  const a = latestAttempt(symphony, "a");
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
  const symphony = await f.define(plan, [task("a")]);
  const a = latestAttempt(symphony, "a");
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
  const symphony = await f.define(plan, [task("a")]);
  const a = latestAttempt(symphony, "a");
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
    symphonyId: plan.id,
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
  // The task agent is inactive, so reconcile nudges it instead of skipping the
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
  const symphony = await f.define(plan, [
    task("a", [], ["src/a"]),
    task("b", [], ["src/b"]),
  ]);
  const a = latestAttempt(symphony, "a");
  assert.ok(a && plan.source.agentId);
  // b cannot launch while writer a holds its resources.
  assert.equal(latestAttempt(symphony, "b"), undefined);
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
      symphonyId: plan.id,
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
    symphonyId: plan.id,
    retryTaskId: "a",
  });
  const retry = latestAttempt(await f.read(plan.id), "a");
  assert.ok(retry && retry.id !== a.id);
  assert.equal(retry.agentId, a.agentId);
});

void test("dispatch addWrites validates the grown scope before it is stored", async () => {
  const f = await fixture();
  const plan = await f.start();
  const symphony = await f.define(plan, [task("a", [], ["src/a"])]);
  const a = latestAttempt(symphony, "a");
  assert.ok(a && plan.source.agentId);
  await f.report(plan.id, "a", "failed");
  f.active.set(a.agentId, false);
  await f.reconcile();
  f.setValidate((score) => {
    if (score.tasks.some((task) => task.writes.includes("link/file"))) {
      throw new Error("Task scopes cannot include symbolic links.");
    }
  });
  await assert.rejects(
    f.send(plan.source.agentId, {
      kind: "dispatch",
      symphonyId: plan.id,
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
  const symphony = await f.define(plan, [
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
  const reader = latestAttempt(symphony, "reader");
  const writer = latestAttempt(symphony, "writer");
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
      symphonyId: plan.id,
      retryTaskId: "reader",
      addWrites: ["shared/helper.ts"],
    }),
    /another writer holds resources/,
  );
  // With the writer done, the promotion is safe and records the addition on the
  // resumed attempt without changing the plan.
  await f.report(plan.id, "writer");
  f.active.set(writer.agentId, false);
  await f.reconcile();
  await f.send(plan.source.agentId, {
    kind: "dispatch",
    symphonyId: plan.id,
    retryTaskId: "reader",
    addWrites: ["shared/helper.ts"],
  });
  const grown = await f.read(plan.id);
  assert.equal(grown.revisions.length, 1);
  assert.deepEqual(
    grown.revisions.at(-1)?.score.tasks.find((t) => t.id === "reader")?.writes,
    [],
  );
  assert.equal(latestAttempt(grown, "reader")?.id, reader.id);
  assert.deepEqual(
    latestAttempt(grown, "reader")?.addedWrites?.map((grant) => grant.path),
    ["shared/helper.ts"],
  );
});

void test("a failed continuation replays its saved wake after a failed send", async () => {
  const f = await fixture();
  const plan = await f.start();
  const symphony = await f.define(plan, [task("a", [], ["src"])]);
  const a = latestAttempt(symphony, "a");
  assert.ok(a && plan.source.agentId);
  await f.report(plan.id, "a", "failed");
  f.active.set(a.agentId, false);
  await f.reconcile();
  // The wake fails before delivery; the continuation stays pending.
  f.busy.add(a.agentId);
  await f.send(plan.source.agentId, {
    kind: "dispatch",
    symphonyId: plan.id,
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
  // A reload with the task agent available replays the exact saved continuation.
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
  const symphony = await f.define(plan, [task("a")]);
  const a = latestAttempt(symphony, "a");
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
  // A reload with the task agent available delivers exactly one nudge.
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
  const symphony = await f.define(plan, [task("a", [], ["src"])]);
  const a = latestAttempt(symphony, "a");
  assert.ok(a && plan.source.agentId);
  await f.report(plan.id, "a", "failed");
  f.active.set(a.agentId, false);
  await f.reconcile();
  // Archived and closed agents inspect as existing but not deliverable.
  f.undeliverable.add(a.agentId);
  await f.send(plan.source.agentId, {
    kind: "dispatch",
    symphonyId: plan.id,
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
  const symphony = await f.define(plan, [task("a")]);
  const a = latestAttempt(symphony, "a");
  assert.ok(a && plan.source.agentId);
  f.active.set(a.agentId, false);
  await f.reconcile();
  f.active.set(a.agentId, false);
  await f.reconcile();
  assert.equal(latestAttempt(await f.read(plan.id), "a")?.state, "blocked");
  f.undeliverable.add(a.agentId);
  await f.send(plan.source.agentId, {
    kind: "dispatch",
    symphonyId: plan.id,
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
  const prompt = f.launches.get(resumed.agentId)?.prompt ?? "";
  assert.match(prompt, /Task a: a/);
  assert.match(prompt, /It stopped without reporting\./);
});

void test("a blocked retry with a changed worker choice rebinds to a new agent with a handoff", async () => {
  const f = await fixture();
  const plan = await f.start();
  const symphony = await f.define(plan, [task("a", [], ["src"])]);
  const a = latestAttempt(symphony, "a");
  assert.ok(a && plan.source.agentId);
  const workerMessage =
    "Need the user's decision on the pagination compatibility rule.";
  await f.send(a.agentId, {
    kind: "block",
    symphonyId: plan.id,
    attemptId: a.id,
    message: workerMessage,
  });
  f.active.set(a.agentId, false);
  await f.reconcile();
  const blocked = latestAttempt(await f.read(plan.id), "a");
  assert.equal(blocked?.state, "blocked");
  assert.equal(blocked?.blockedBy, "worker");
  // The unavailable observation stores no changed paths.
  assert.equal(blocked?.changedPaths, undefined);
  // The blocked agent is still deliverable, but the Conductor named a new
  // provider, so the attempt is rebound to a fresh agent instead of resumed.
  await f.send(plan.source.agentId, {
    kind: "dispatch",
    symphonyId: plan.id,
    retryTaskId: "a",
    provider: "pi",
    note: "Try a different provider",
  });
  const rebound = latestAttempt(await f.read(plan.id), "a");
  assert.equal(rebound?.id, a.id);
  assert.notEqual(rebound?.agentId, a.agentId);
  assert.equal(rebound?.state, "running");
  assert.equal(rebound?.launch?.provider, "pi");
  assert.equal(rebound?.launch?.profile, "inherit");
  assert.equal(
    f.wakePrompts.some((w) => w.key?.startsWith("resume:")),
    false,
    "a changed choice never resumes the old agent",
  );
  assert.ok(f.launches.has(rebound.agentId));
  const prompt = f.launches.get(rebound.agentId)?.prompt ?? "";
  // The replacement gets the full assignment, not a resume prompt.
  assert.match(prompt, /Task a: a/);
  assert.match(prompt, /Goal: Inspect API and UI independently/);
  assert.match(prompt, /Assignment: Inspect a/);
  assert.match(prompt, /Reads: none/);
  assert.match(prompt, /Writes: src/);
  assert.match(prompt, /Required checks: none/);
  assert.match(prompt, /up to 3 rounds/);
  assert.match(prompt, /\[Conductor agent commands\]/);
  // The handoff keeps the worker's block message, which is overwritten on the
  // attempt, and names the changed paths as unknown until fingerprinting lands.
  assert.match(prompt, /Attempt 1 of 1 for task a\./);
  assert.match(
    prompt,
    /It blocked with: `Need the user's decision on the pagination compatibility rule\.`/,
  );
  assert.match(prompt, /Conductor note: Try a different provider/);
  assert.match(prompt, /Changed files are unknown; review your write paths\./);
  assert.equal(prompt.includes("CONDUCTOR_JSON"), false);
  assert.equal(prompt.includes("--socket"), false);
  assert.equal(prompt.includes("--agent"), false);
});

void test("an attempt records the write paths it changed and passes them to a replacement", async () => {
  const f = await fixture();
  const plan = await f.start();
  const dirty = new Map<string, string>([["src/keep.ts", "keep"]]);
  f.setFingerprint(async () => ({
    paths: [...dirty].map(([path, hash]) => ({ path, hash })),
  }));
  const symphony = await f.define(plan, [task("a", [], ["src"])]);
  const a = latestAttempt(symphony, "a");
  assert.ok(a && plan.source.agentId);
  // A pre-existing dirty file already matches the launch baseline; only the
  // path changed during this attempt is recorded.
  dirty.set("src/added.ts", "added");
  await f.send(a.agentId, {
    kind: "block",
    symphonyId: plan.id,
    attemptId: a.id,
    message: "Need the pagination decision",
  });
  f.active.set(a.agentId, false);
  await f.reconcile();
  const blocked = latestAttempt(await f.read(plan.id), "a");
  assert.deepEqual(blocked?.changedPaths, ["src/added.ts"]);
  assert.equal(blocked?.changedPathsTruncated, false);
  // The replacement handoff lists the changed path instead of "unknown".
  await f.send(plan.source.agentId, {
    kind: "dispatch",
    symphonyId: plan.id,
    retryTaskId: "a",
    provider: "pi",
  });
  const rebound = latestAttempt(await f.read(plan.id), "a");
  assert.equal(rebound?.id, a.id);
  assert.notEqual(rebound?.agentId, a.agentId);
  const prompt = f.launches.get(rebound.agentId)?.prompt ?? "";
  assert.match(
    prompt,
    /Files in your write paths changed by earlier attempts:/,
  );
  assert.match(prompt, /- src\/added\.ts/);
  assert.equal(prompt.includes("Changed files are unknown"), false);
});

void test("changed paths are capped at the stored limit and mark truncation", async () => {
  const f = await fixture();
  const dirty = new Map<string, string>();
  f.setFingerprint(async () => ({
    paths: [...dirty].map(([path, hash]) => ({ path, hash })),
  }));
  const plan = await f.start();
  const symphony = await f.define(plan, [task("a", [], ["src"])]);
  const a = latestAttempt(symphony, "a");
  assert.ok(a && plan.source.agentId);
  for (let index = 0; index < 60; index += 1) {
    dirty.set(`src/file-${String(index).padStart(2, "0")}.ts`, `v${index}`);
  }
  await f.send(a.agentId, {
    kind: "block",
    symphonyId: plan.id,
    attemptId: a.id,
    message: "Blocked after many edits",
  });
  const blocked = latestAttempt(await f.read(plan.id), "a");
  assert.equal(blocked?.changedPaths?.length, 50);
  assert.equal(blocked?.changedPathsTruncated, true);
});

void test("a failed retry with a changed worker choice passes changed paths to the replacement", async () => {
  const f = await fixture();
  const plan = await f.start();
  const dirty = new Map<string, string>([["src/keep.ts", "keep"]]);
  f.setFingerprint(async () => ({
    paths: [...dirty].map(([path, hash]) => ({ path, hash })),
  }));
  const symphony = await f.define(plan, [task("a", [], ["src"])]);
  const a = latestAttempt(symphony, "a");
  assert.ok(a && plan.source.agentId);
  dirty.set("src/new.ts", "new");
  await f.report(plan.id, "a", "failed");
  const failed = latestAttempt(await f.read(plan.id), "a");
  assert.deepEqual(failed?.changedPaths, ["src/new.ts"]);
  f.active.set(a.agentId, false);
  await f.reconcile();
  await f.send(plan.source.agentId, {
    kind: "dispatch",
    symphonyId: plan.id,
    retryTaskId: "a",
    provider: "pi",
  });
  const retry = latestAttempt(await f.read(plan.id), "a");
  assert.ok(retry && retry.id !== a.id);
  const prompt = f.launches.get(retry.agentId)?.prompt ?? "";
  assert.match(prompt, /- src\/new\.ts/);
  assert.equal(prompt.includes("Changed files are unknown"), false);
});

void test("a blocked rebind with only a provider clears the old model and thinking option", async () => {
  const f = await fixture();
  const plan = await f.start();
  const symphony = await f.define(plan, [
    {
      id: "a",
      title: "a",
      description: "Inspect a",
      dependsOn: [],
      reads: [],
      writes: ["src"],
      checks: [],
      provider: "fake",
      model: "model",
      thinkingOptionId: "high",
    },
  ]);
  const a = latestAttempt(symphony, "a");
  assert.ok(a && plan.source.agentId);
  assert.equal(a.launch?.provider, "fake");
  assert.equal(a.launch?.model, "model");
  assert.equal(a.launch?.thinkingOptionId, "high");
  await f.send(a.agentId, {
    kind: "block",
    symphonyId: plan.id,
    attemptId: a.id,
    message: "Need another provider",
  });
  f.active.set(a.agentId, false);
  await f.reconcile();
  // A provider-only switch replaces the whole worker choice rather than
  // merging it over the old launch.
  await f.send(plan.source.agentId, {
    kind: "dispatch",
    symphonyId: plan.id,
    retryTaskId: "a",
    provider: "pi",
  });
  const rebound = latestAttempt(await f.read(plan.id), "a");
  assert.equal(rebound?.id, a.id);
  assert.notEqual(rebound?.agentId, a.agentId);
  assert.equal(rebound?.launch?.profile, "inherit");
  assert.equal(rebound?.launch?.provider, "pi");
  assert.equal(rebound?.launch?.model, undefined);
  assert.equal(rebound?.launch?.thinkingOptionId, undefined);
  assert.ok(f.launches.has(rebound.agentId));
  assert.equal(f.launches.get(rebound.agentId)?.model, undefined);
  assert.equal(f.launches.get(rebound.agentId)?.thinkingOptionId, undefined);
});

void test("a same-agent resume keeps its baseline so changed paths stay cumulative", async () => {
  const f = await fixture();
  const plan = await f.start();
  const dirty = new Map<string, string>([["src/keep.ts", "keep"]]);
  f.setFingerprint(async () => ({
    paths: [...dirty].map(([path, hash]) => ({ path, hash })),
  }));
  const symphony = await f.define(plan, [task("a", [], ["src"])]);
  const a = latestAttempt(symphony, "a");
  assert.ok(a && plan.source.agentId);
  dirty.set("src/a.ts", "a");
  await f.send(a.agentId, {
    kind: "block",
    symphonyId: plan.id,
    attemptId: a.id,
    message: "Blocked after editing A",
  });
  f.active.set(a.agentId, false);
  await f.reconcile();
  const first = latestAttempt(await f.read(plan.id), "a");
  assert.deepEqual(first?.changedPaths, ["src/a.ts"]);
  assert.ok(first?.writeFingerprint);
  // The same worker choice resumes the same agent on the same attempt, and the
  // original launch baseline survives so the list stays cumulative.
  await f.send(plan.source.agentId, {
    kind: "dispatch",
    symphonyId: plan.id,
    retryTaskId: "a",
  });
  const resumed = latestAttempt(await f.read(plan.id), "a");
  assert.equal(resumed?.id, a.id);
  assert.equal(resumed?.agentId, a.agentId);
  assert.deepEqual(resumed?.changedPaths, ["src/a.ts"]);
  assert.ok(resumed?.writeFingerprint);
  dirty.set("src/b.ts", "b");
  await f.send(a.agentId, {
    kind: "block",
    symphonyId: plan.id,
    attemptId: a.id,
    message: "Blocked after editing B",
  });
  f.active.set(a.agentId, false);
  await f.reconcile();
  const second = latestAttempt(await f.read(plan.id), "a");
  assert.deepEqual(second?.changedPaths, ["src/a.ts", "src/b.ts"]);
});

void test("a replacement handoff lists the union of every earlier attempt's changed paths", async () => {
  const f = await fixture();
  const plan = await f.start();
  const dirty = new Map<string, string>([["src/keep.ts", "keep"]]);
  f.setFingerprint(async () => ({
    paths: [...dirty].map(([path, hash]) => ({ path, hash })),
  }));
  const symphony = await f.define(plan, [task("a", [], ["src"])]);
  const first = latestAttempt(symphony, "a");
  assert.ok(first && plan.source.agentId);
  dirty.set("src/a.ts", "a");
  await f.report(plan.id, "a", "failed");
  assert.deepEqual(latestAttempt(await f.read(plan.id), "a")?.changedPaths, [
    "src/a.ts",
  ]);
  f.active.set(first.agentId, false);
  await f.reconcile();
  // A changed worker choice creates attempt 2, which edits B and blocks.
  await f.send(plan.source.agentId, {
    kind: "dispatch",
    symphonyId: plan.id,
    retryTaskId: "a",
    provider: "pi",
  });
  const second = latestAttempt(await f.read(plan.id), "a");
  assert.ok(second && second.id !== first.id);
  dirty.set("src/b.ts", "b");
  await f.send(second.agentId, {
    kind: "block",
    symphonyId: plan.id,
    attemptId: second.id,
    message: "Blocked after editing B",
  });
  f.active.set(second.agentId, false);
  await f.reconcile();
  await f.send(plan.source.agentId, {
    kind: "dispatch",
    symphonyId: plan.id,
    retryTaskId: "a",
    provider: "other",
  });
  const rebound = latestAttempt(await f.read(plan.id), "a");
  assert.equal(rebound?.id, second.id);
  const prompt = f.launches.get(rebound?.agentId ?? "")?.prompt ?? "";
  assert.match(prompt, /- src\/a\.ts/);
  assert.match(prompt, /- src\/b\.ts/);
  assert.equal(prompt.includes("Changed files are unknown"), false);
  assert.equal(prompt.includes("This list may be incomplete"), false);
});

void test("a handoff marks the union incomplete when an earlier attempt was unobservable", async () => {
  const f = await fixture();
  const plan = await f.start();
  // The first attempt launches with no fingerprint runtime, so it never has an
  // observation at all.
  const symphony = await f.define(plan, [task("a", [], ["src"])]);
  const first = latestAttempt(symphony, "a");
  assert.ok(first && plan.source.agentId);
  assert.equal(first.writeFingerprint, undefined);
  await f.report(plan.id, "a", "failed");
  f.active.set(first.agentId, false);
  await f.reconcile();
  const dirty = new Map<string, string>([["src/keep.ts", "keep"]]);
  f.setFingerprint(async () => ({
    paths: [...dirty].map(([path, hash]) => ({ path, hash })),
  }));
  await f.send(plan.source.agentId, {
    kind: "dispatch",
    symphonyId: plan.id,
    retryTaskId: "a",
    provider: "pi",
  });
  const second = latestAttempt(await f.read(plan.id), "a");
  assert.ok(second && second.id !== first.id);
  dirty.set("src/b.ts", "b");
  await f.send(second.agentId, {
    kind: "block",
    symphonyId: plan.id,
    attemptId: second.id,
    message: "Blocked after editing B",
  });
  f.active.set(second.agentId, false);
  await f.reconcile();
  await f.send(plan.source.agentId, {
    kind: "dispatch",
    symphonyId: plan.id,
    retryTaskId: "a",
    provider: "other",
  });
  const rebound = latestAttempt(await f.read(plan.id), "a");
  const prompt = f.launches.get(rebound?.agentId ?? "")?.prompt ?? "";
  assert.match(prompt, /- src\/b\.ts/);
  assert.match(
    prompt,
    /This list may be incomplete; review your write paths\./,
  );
});

void test("a terminal attempt drops its launch baseline", async () => {
  const f = await fixture();
  const plan = await f.start();
  f.setFingerprint(async () => ({
    paths: [{ path: "src/keep.ts", hash: "keep" }],
  }));
  const symphony = await f.define(plan, [task("a")]);
  const a = latestAttempt(symphony, "a");
  assert.ok(a && plan.source.agentId);
  assert.ok(a.writeFingerprint, "the launch records a baseline");
  await f.report(plan.id, "a");
  const completed = latestAttempt(await f.read(plan.id), "a");
  assert.equal(completed?.state, "completed");
  assert.equal(completed?.writeFingerprint, undefined);

  const failedRun = await fixture();
  const failedPlan = await failedRun.start("failed-baseline");
  failedRun.setFingerprint(async () => ({
    paths: [{ path: "src/keep.ts", hash: "keep" }],
  }));
  const failedSymphony = await failedRun.define(failedPlan, [task("a")]);
  const failedAttempt = latestAttempt(failedSymphony, "a");
  assert.ok(failedAttempt && failedPlan.source.agentId);
  assert.ok(failedAttempt.writeFingerprint);
  await failedRun.report(failedPlan.id, "a", "failed");
  const failed = latestAttempt(await failedRun.read(failedPlan.id), "a");
  assert.equal(failed?.state, "failed");
  assert.equal(failed?.writeFingerprint, undefined);
});

void test("a task agent block settles without a nudge and keeps its message", async () => {
  const f = await fixture();
  const plan = await f.start();
  const symphony = await f.define(plan, [task("a")]);
  const a = latestAttempt(symphony, "a");
  assert.ok(a && plan.source.agentId);
  const workerMessage =
    "Need the user's decision on the pagination compatibility rule.";
  await f.send(a.agentId, {
    kind: "block",
    symphonyId: plan.id,
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
    "a task agent block is never nudged",
  );
  const summary = notificationSummary(f, plan.id, plan.source.agentId);
  assert.equal(summary[0]?.kind, "blocked");
  assert.equal(summary[0]?.message, workerMessage);
  // A reload neither nudges again nor rewrites the task agent's message.
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

void test("a task agent block is classified as blocked before its turn ends", async () => {
  const f = await fixture();
  const plan = await f.start();
  const symphony = await f.define(plan, [task("a")]);
  const a = latestAttempt(symphony, "a");
  assert.ok(a && plan.source.agentId);
  const workerMessage = "Waiting on the user's decision.";
  await f.send(a.agentId, {
    kind: "block",
    symphonyId: plan.id,
    attemptId: a.id,
    message: workerMessage,
  });
  // The marker is stored atomically with the block, before reconcile settles
  // the launch, so the notification can classify the attempt immediately.
  const blocked = latestAttempt(await f.read(plan.id), "a");
  assert.equal(blocked?.state, "blocked");
  assert.equal(blocked?.blockedBy, "worker");
  assert.equal(blocked?.message, workerMessage);
  // The task agent is still active, so reconcile only notifies; it must not
  // label the task agent's block as a server no-report settlement.
  assert.equal(f.active.get(a.agentId), true);
  await f.reconcile();
  const first = notificationSummary(f, plan.id, plan.source.agentId);
  assert.equal(first[0]?.kind, "blocked");
  assert.equal(first[0]?.message, workerMessage);
  // Once the task agent stops, the settled classification stays blocked and the
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
  const serverSymphony = await server.define(serverPlan, [task("a")]);
  const serverAttempt = latestAttempt(serverSymphony, "a");
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
  const plainSymphony = await plain.define(plainPlan, [task("a")]);
  const plainAttempt = latestAttempt(plainSymphony, "a");
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
  const launcherSymphony = await launcher.define(launcherPlan, [task("a")]);
  const launcherAttempt = latestAttempt(launcherSymphony, "a");
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
  const symphony = await f.define(plan, [task("a")]);
  const a = latestAttempt(symphony, "a");
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
    conductor: "agent",
    concurrency: 1,
  });
  assert.ok("symphony" in limited);
  const symphony = await f.define(limited.symphony, [
    task("a", [], ["src/a"]),
    task("b", [], ["src/b"]),
  ]);
  const a = latestAttempt(symphony, "a");
  assert.ok(a && limited.symphony.source.agentId);
  assert.equal(latestAttempt(symphony, "b"), undefined);
  await f.report(limited.symphony.id, "a", "failed");
  f.active.set(a.agentId, false);
  await f.reconcile();
  // b now holds the only writer slot while a's retry cannot start.
  assert.ok(latestAttempt(await f.read(limited.symphony.id), "b"));
  await assert.rejects(
    f.send(limited.symphony.source.agentId, {
      kind: "dispatch",
      symphonyId: limited.symphony.id,
      retryTaskId: "a",
      addWrites: ["shared/helper.ts"],
    }),
    /Retry cannot start now: the symphony concurrency limit \(1\) is reached/,
  );
  const refused = await f.read(limited.symphony.id);
  assert.equal(
    refused.revisions.length,
    1,
    "a refused retry must not save its added writes",
  );
  assert.equal(latestAttempt(refused, "a")?.id, a.id);
});

void test("an unknown launch baseline is never recaptured by a rebind", async () => {
  const f = await fixture();
  const plan = await f.start();
  // The default fingerprint runtime reports an unavailable observation, as a
  // non-Git checkout would, so the attempt's first baseline is unknown.
  const current = await f.define(plan, [task("a", [], ["src"])]);
  const a = latestAttempt(current, "a");
  assert.ok(a && plan.source.agentId);
  assert.equal(a.writeFingerprint, undefined);
  assert.equal(a.writeFingerprintUnknown, true);
  await f.send(a.agentId, {
    kind: "block",
    symphonyId: plan.id,
    attemptId: a.id,
    message: "Edited while the baseline was unknown",
  });
  f.active.set(a.agentId, false);
  await f.reconcile();
  // A later observation becomes available. The same attempt must not capture
  // it: the observation already contains the earlier agent's edits, so a
  // capture now would report an empty change list as if nothing had happened.
  f.setFingerprint(async () => ({
    paths: [{ path: "src/earlier.ts", hash: "earlier-worker-edit" }],
  }));
  await f.send(plan.source.agentId, {
    kind: "dispatch",
    symphonyId: plan.id,
    retryTaskId: "a",
    provider: "pi",
  });
  const rebound = latestAttempt(await f.read(plan.id), "a");
  assert.equal(rebound?.id, a.id);
  assert.notEqual(rebound?.agentId, a.agentId);
  assert.equal(
    rebound?.writeFingerprint,
    undefined,
    "a rebind cannot acquire a late baseline",
  );
  assert.equal(rebound?.writeFingerprintUnknown, true);
  await f.report(plan.id, "a");
  const terminal = latestAttempt(await f.read(plan.id), "a");
  assert.equal(terminal?.state, "completed");
  assert.equal(
    terminal?.changedPaths,
    undefined,
    "an unknown baseline leaves changed paths absent",
  );
});

void test("a launched attempt stored before baselines stays unknown across a rebind", async () => {
  const f = await fixture();
  const plan = await f.start();
  const current = await f.define(plan, [task("a", [], ["src"])]);
  const a = latestAttempt(current, "a");
  assert.ok(a && plan.source.agentId);
  await f.send(a.agentId, {
    kind: "block",
    symphonyId: plan.id,
    attemptId: a.id,
    message: "Blocked before the upgrade",
  });
  f.active.set(a.agentId, false);
  await f.reconcile();
  // A record written before baselines existed has neither baseline field.
  const blocked = await f.read(plan.id);
  await f.store.update(blocked.id, blocked.version, (value) => {
    const attempt = latestAttempt(value, "a");
    if (attempt) {
      delete attempt.writeFingerprint;
      delete attempt.writeFingerprintUnknown;
    }
    return value;
  });
  // The checkout now holds the earlier agent's edits; a capture would hide them.
  f.setFingerprint(async () => ({
    paths: [{ path: "src/earlier.ts", hash: "earlier-worker-edit" }],
  }));
  await f.send(plan.source.agentId, {
    kind: "dispatch",
    symphonyId: plan.id,
    retryTaskId: "a",
    provider: "pi",
  });
  const rebound = latestAttempt(await f.read(plan.id), "a");
  assert.equal(rebound?.id, a.id);
  assert.notEqual(rebound?.agentId, a.agentId);
  assert.equal(
    rebound?.writeFingerprint,
    undefined,
    "a rebind of a launched legacy attempt cannot acquire a late baseline",
  );
  assert.equal(rebound?.writeFingerprintUnknown, true);
  await f.report(plan.id, "a");
  const terminal = latestAttempt(await f.read(plan.id), "a");
  assert.equal(terminal?.state, "completed");
  assert.equal(terminal?.changedPaths, undefined);
});

void test("a failed same-agent continuation keeps its unknown baseline across a rebind", async () => {
  const f = await fixture();
  const plan = await f.start("continued-unknown");
  // The first attempt launches with an observed baseline so only the
  // continuation's missing observation is under test.
  f.setFingerprint(async () => ({ paths: [] }));
  const launched = await f.define(plan, [task("a", [], ["src"])]);
  const first = latestAttempt(launched, "a");
  assert.ok(first && plan.source.agentId);
  await f.report(plan.id, "a", "failed");
  f.active.set(first.agentId, false);
  await f.reconcile();
  // The continuation's first observation is unavailable, as a non-Git checkout
  // or a failed Git call would report.
  f.setFingerprint(async () => null);
  await f.send(plan.source.agentId, {
    kind: "dispatch",
    symphonyId: plan.id,
    retryTaskId: "a",
  });
  const continued = latestAttempt(await f.read(plan.id), "a");
  assert.ok(continued && continued.id !== first.id);
  assert.equal(continued.agentId, first.agentId);
  assert.equal(continued.writeFingerprint, undefined);
  assert.equal(continued.writeFingerprintUnknown, true);
  await f.send(continued.agentId, {
    kind: "block",
    symphonyId: plan.id,
    attemptId: continued.id,
    message: "Edited while the continuation baseline was unknown",
  });
  f.active.set(continued.agentId, false);
  await f.reconcile();
  // The observation becomes available again. The rebind must not capture it:
  // it already contains this agent's edits, so a capture would hide them.
  f.setFingerprint(async () => ({
    paths: [{ path: "src/continued.ts", hash: "prior-edit" }],
  }));
  await f.send(plan.source.agentId, {
    kind: "dispatch",
    symphonyId: plan.id,
    retryTaskId: "a",
    provider: "pi",
  });
  const rebound = latestAttempt(await f.read(plan.id), "a");
  assert.equal(rebound?.id, continued.id);
  assert.notEqual(rebound?.agentId, continued.agentId);
  assert.equal(
    rebound?.writeFingerprint,
    undefined,
    "a continuation cannot acquire a late baseline",
  );
  assert.equal(rebound?.writeFingerprintUnknown, true);
  await f.report(plan.id, "a");
  const terminal = latestAttempt(await f.read(plan.id), "a");
  assert.equal(terminal?.state, "completed");
  assert.equal(
    terminal?.changedPaths,
    undefined,
    "an unknown baseline leaves changed paths absent",
  );
});

void test("a trailing-space file name produces no phantom changed paths", async () => {
  const directory = await repository();
  const changes = changesRuntime();
  await writeFile(join(directory, "src", "note.ts "), "export {};\n");
  const f = await fixture();
  f.setFingerprint(async (_checkout, writes) =>
    changes.fingerprint(directory, writes),
  );
  const plan = await f.start("real-spaces");
  const symphony = await f.define(plan, [task("a", [], ["src"])]);
  const a = latestAttempt(symphony, "a");
  assert.ok(a && plan.source.agentId);
  // The launch persisted the observed name, including its trailing space.
  assert.deepEqual(
    a.writeFingerprint?.map((entry) => entry.path),
    ["src/note.ts "],
  );
  await f.send(a.agentId, {
    kind: "block",
    symphonyId: plan.id,
    attemptId: a.id,
    message: "No edits since the baseline",
  });
  f.active.set(a.agentId, false);
  await f.reconcile();
  const blocked = latestAttempt(await f.read(plan.id), "a");
  assert.deepEqual(blocked?.changedPaths, []);
});

void test("a changed worker choice on an uncertain launch is refused before any mutation", async () => {
  const f = await fixture();
  const plan = await f.start();
  f.loseAck();
  const current = await f.define(plan, [task("a", [], ["src"])]);
  const a = latestAttempt(current, "a");
  assert.ok(a && plan.source.agentId);
  assert.equal(a.launch?.state, "uncertain");
  // The lost launch never appears, so the bounded re-check settles it blocked.
  f.launches.delete(a.agentId);
  f.active.set(a.agentId, false);
  await f.reconcile();
  const blocked = latestAttempt(await f.read(plan.id), "a");
  assert.equal(blocked?.state, "blocked");
  assert.equal(blocked?.launch?.state, "uncertain");
  assert.equal(blocked?.launch?.settled, true);
  const before = await f.read(plan.id);
  await assert.rejects(
    f.send(plan.source.agentId, {
      kind: "dispatch",
      symphonyId: plan.id,
      retryTaskId: "a",
      provider: "pi",
    }),
    (error: unknown) =>
      error instanceof SymphonyError &&
      /dispatch without a replacement worker choice/.test(error.message),
  );
  const after = await f.read(plan.id);
  assert.equal(
    after.version,
    before.version,
    "a refused dispatch mutates nothing",
  );
  const unchanged = latestAttempt(after, "a");
  assert.equal(unchanged?.agentId, a.agentId);
  assert.equal(unchanged?.state, "blocked");
  assert.equal(unchanged?.launch?.state, "uncertain");
  assert.equal(unchanged?.launch?.provider, a.launch?.provider);
  // Dispatching without a replacement still reconciles the saved identity.
  await f.send(plan.source.agentId, {
    kind: "dispatch",
    symphonyId: plan.id,
    retryTaskId: "a",
  });
  const reconciled = latestAttempt(await f.read(plan.id), "a");
  assert.equal(reconciled?.id, a.id);
  assert.equal(reconciled?.agentId, a.agentId);
  assert.equal(reconciled?.launch?.state, "started");
  assert.equal(reconciled?.state, "running");
});

void test("an uncertain launch reconciles when the same worker choice is dispatched", async () => {
  const f = await fixture();
  const plan = await f.start();
  f.loseAck();
  const current = await f.define(plan, [task("a", [], ["src"])]);
  const a = latestAttempt(current, "a");
  assert.ok(a && plan.source.agentId);
  f.launches.delete(a.agentId);
  f.active.set(a.agentId, false);
  await f.reconcile();
  assert.equal(
    latestAttempt(await f.read(plan.id), "a")?.launch?.settled,
    true,
  );
  await f.send(plan.source.agentId, {
    kind: "dispatch",
    symphonyId: plan.id,
    retryTaskId: "a",
    profile: "Small",
  });
  const reconciled = latestAttempt(await f.read(plan.id), "a");
  assert.equal(reconciled?.id, a.id);
  assert.equal(reconciled?.agentId, a.agentId);
  assert.equal(reconciled?.launch?.state, "started");
});
