import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { symphonyExecution } from "../server/symphonies/execution";
import { launchChoice } from "../server/symphonies/orchestration";
import { fileSymphonyStore } from "../server/symphonies/store";
import {
  noSymphonyMetrics,
  symphonyMetrics,
  type SymphonyMetrics,
} from "../server/symphonies/metrics";
import {
  canonicalJson,
  type ProfilesCatalog,
  type ProfilesSource,
} from "../server/symphonies/profiles";
import type { ConductorProfile } from "../shared/symphonies/profiles";
import {
  isClassifiedRouting,
  type RoutingProfile,
} from "../shared/symphonies/routing";
import { executionStatus } from "../server/symphonies/results";
import {
  SymphonyError,
  LaunchRejectedError,
} from "../server/symphonies/errors";
import type {
  WorkerLaunch,
  WorkerProfile,
  WorkerRuntime,
} from "../server/symphonies/workers";
import type { ExecutionRuntime } from "../server/symphonies/identity";
import {
  changesRuntime,
  type SymphonyChangesRuntime,
} from "../server/symphonies/changes";
import {
  attemptSchema,
  latestAttempt,
  SYMPHONY_LIMITS,
  type Attempt,
  type StoredSymphony,
} from "../shared/symphonies/models";
import { currentLoop, effectiveTask } from "../shared/symphonies/score";
import { historyLoops } from "../client/symphonies/history";
import { placement } from "./symphony-fixtures";
import { testDirectory } from "./fixtures";

interface FixtureRouting {
  version?: number;
  mode?: "warn" | "strict";
  profiles: Record<string, Partial<RoutingProfile>>;
}

/** A fixture profile, optionally carrying Conductor instructions. */
type FixtureProfile = WorkerProfile & { instructions?: string };

/** An in-memory Conductor profile catalog for the routing scenarios. */
function fixtureCatalog(
  profiles: readonly FixtureProfile[],
  routing: FixtureRouting | undefined,
): ProfilesCatalog {
  const list: ConductorProfile[] = profiles.map((profile) => {
    const configured = routing?.profiles?.[profile.id];
    return {
      id: profile.id,
      name: profile.name,
      notes: profile.notes,
      provider: profile.provider,
      ...(profile.model ? { model: profile.model } : {}),
      ...(profile.modeId ? { modeId: profile.modeId } : {}),
      ...(profile.thinkingOptionId
        ? { thinkingOptionId: profile.thinkingOptionId }
        : {}),
      routing: configured
        ? {
            roles: configured.roles ?? ["implementation"],
            ...(configured.size !== undefined ? { size: configured.size } : {}),
          }
        : null,
      instructions: profile.instructions ?? "",
    };
  });
  const mode = routing?.mode ?? "warn";
  const revision = createHash("sha256")
    .update(canonicalJson({ version: 1, mode, profiles: list }))
    .digest("hex");
  return {
    state: "valid",
    mode,
    profiles: list,
    revision,
    catalogRevision: revision,
    diagnostics: list
      .filter((profile) => !isClassifiedRouting(profile.routing))
      .map((profile) => ({
        code: "unclassified-profile" as const,
        profileId: profile.id,
        message: `Profile "${profile.name}" has no routing classification.`,
      })),
  };
}

async function fixture(
  options: { routing?: FixtureRouting; profiles?: FixtureProfile[] } = {},
) {
  const directory = await testDirectory();
  let routingConfig = options.routing;
  const store = fileSymphonyStore(directory);
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
  const profileList: FixtureProfile[] = options.profiles ?? [
    {
      id: "small",
      name: "Small",
      notes: "Bounded read-only assignments",
      provider: "fake",
    },
  ];
  const profilesSource: ProfilesSource = {
    path: null,
    load: async () => fixtureCatalog(profileList, routingConfig),
    save: async () => {
      throw new Error("profile saves are not used by this fixture");
    },
    importFromPaseo: async () => {
      throw new Error("profile imports are not used by this fixture");
    },
    syncPreview: async () => {
      throw new Error("profile sync previews are not used by this fixture");
    },
    syncToPaseo: async () => {
      throw new Error("profile syncs are not used by this fixture");
    },
  };
  let validateScore: (score: {
    tasks: { writes: string[] }[];
  }) => void = () => {};
  const workers: WorkerRuntime = {
    prepare: async () => JSON.stringify({ provider: "fake/model" }),
    profiles: async () => profileList,
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
  let metricsRuntime: () => SymphonyMetrics = noSymphonyMetrics;
  let engine = symphonyExecution(
    store,
    () => runtime,
    () => workers,
    profilesSource,
    () => metricsRuntime(),
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
    directory,
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
        profilesSource,
        () => metricsRuntime(),
      );
    },
    setMetrics: (next: () => SymphonyMetrics) => {
      metricsRuntime = next;
    },
    busy,
    undeliverable,
    setRouting: (next: FixtureRouting) => {
      routingConfig = next;
    },
    setProfiles: (next: FixtureProfile[]) => {
      profileList.length = 0;
      profileList.push(...next);
    },
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

/** A read-only review task, which the server marks with the `review` role. */
const reviewTask = (id: string, dependsOn: string[] = []) => ({
  ...task(id, dependsOn),
  review: true,
});

/** The blocking finding the loop tests use. */
const blockingFinding = {
  id: "F1",
  severity: "blocking" as const,
  taskId: "api",
  paths: ["src/api.ts:41"],
  summary: "concertId is validated after its lookup.",
  suggestedFix: "Validate before the lookup.",
};

/** A `needs-changes` report with one blocking finding against `api`. */
const needsChangesReport = (finding = blockingFinding) => ({
  outcome: "needs-changes" as const,
  summary: "The work ran but is not acceptable yet.",
  evidence: ["Read the endpoint path"],
  checks: [],
  findings: [finding],
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
    diagnosis?: { need: string };
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

void test("a stopped task agent is nudged once, then failed as a harness failure, and each retry continues on the same agent", async () => {
  const f = await fixture();
  const plan = await f.start();
  const symphony = await f.define(plan, [task("a", [], ["src"])]);
  const a = latestAttempt(symphony, "a");
  assert.ok(a && plan.source.agentId);
  assert.deepEqual(a.blocked, [], "a new reservation tracks work time");
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
  // The second stop is a harness failure, not a worker blocker: the server
  // settles it failed with its own report and a harness diagnosis.
  f.active.set(a.agentId, false);
  await f.reconcile();
  const failed = latestAttempt(await f.read(plan.id), "a");
  assert.equal(failed?.state, "failed");
  assert.equal(failed?.reportedBy, "server");
  assert.equal(failed?.blockedBy, undefined);
  assert.equal(failed?.report?.diagnosis?.need, "harness");
  assert.equal((await f.read(plan.id)).status, "failed");
  // The retry continues on the same agent in a new attempt with the note.
  await f.send(plan.source.agentId, {
    kind: "dispatch",
    symphonyId: plan.id,
    retryTaskId: "a",
    note: "Check the shared schema",
  });
  const second = latestAttempt(await f.read(plan.id), "a");
  assert.ok(second && second.id !== a.id);
  assert.equal(second.agentId, a.agentId);
  assert.deepEqual(second.blocked, [], "a continuation tracks work time");
  assert.equal(f.launches.size, 2);
  const resumed = f.wakePrompts.find((w) =>
    w.key?.startsWith(`continue:${second.id}`),
  );
  assert.ok(resumed);
  assert.match(resumed.prompt, /Continue task a, now attempt .* \(2 of 2\)/);
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
  assert.ok(retry && retry.id !== a.id && retry.id !== second.id);
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

void test("a repeated harness failure after a retry wakes the conductor once per attempt", async () => {
  const f = await fixture();
  const plan = await f.start();
  const symphony = await f.define(plan, [task("a")]);
  const a = latestAttempt(symphony, "a");
  assert.ok(a && plan.source.agentId);
  // The first stop nudges; the second fails and wakes the conductor once.
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
  // The retry is a new attempt on the same agent with its own nudge.
  f.active.set(a.agentId, false);
  await f.reconcile();
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
  assert.match(String(first.instructions), /Call define with arguments/);
  for (const shell of ["node ", "--agent", "CONDUCTOR_JSON", "stdin"]) {
    assert.equal(String(first.instructions).includes(shell), false, shell);
  }
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
  assert.deepEqual(f.wakes, [`requester:${symphony.id}:loop-end:1`]);
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

void test("a launch snapshots the worker it resolved to", async () => {
  const profileId = "33333333-3333-4333-8333-333333333333";
  const f = await fixture({
    routing: {
      profiles: {
        [profileId]: { roles: ["implementation"], size: "small" },
      },
    },
    profiles: [
      {
        id: profileId,
        name: "Tuned",
        notes: "",
        provider: "claude",
        model: "opus",
        thinkingOptionId: "medium",
      },
    ],
  });
  const plan = await f.start("resolved-profile");
  const symphony = await f.define(plan, [
    { ...task("api", [], ["src/api"]), profile: profileId },
  ]);
  const api = latestAttempt(symphony, "api");
  assert.ok(api);
  // A profile launch keeps the inline fields empty and records the profile's
  // provider/model/thinking option as the resolved worker.
  assert.equal(api.launch?.provider, undefined);
  assert.deepEqual(api.launch?.resolved, {
    provider: "claude",
    model: "opus",
    thinkingOptionId: "medium",
  });
});

void test("an inline launch snapshots the worker it resolved to", async () => {
  const f = await fixture();
  const plan = await f.start("resolved-inline");
  const symphony = await f.define(plan, [inlineTask("a")]);
  const a = latestAttempt(symphony, "a");
  assert.ok(a);
  assert.deepEqual(a.launch?.resolved, {
    provider: "pi",
    model: "pi-test",
    thinkingOptionId: "high",
  });
});

void test("the attempt schema accepts a launch with and without a resolved worker", () => {
  const record = {
    id: "11111111-1111-4111-8111-111111111111",
    taskId: "api",
    agentId: "agent",
    state: "running",
    startedAt: 0,
    endedAt: null,
    message: null,
    report: null,
    reportHash: null,
    launch: {
      state: "pending",
      profile: "inherit",
      provider: "pi",
      generation: 0,
      prompt: "Carry out the task",
      settled: false,
    },
  };
  assert.equal(attemptSchema.safeParse(record).success, true);
  assert.equal(
    attemptSchema.safeParse({
      ...record,
      launch: { ...record.launch, resolved: { provider: "pi" } },
    }).success,
    true,
  );
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
  assert.deepEqual(
    retry.launch?.resolved,
    { provider: "pi" },
    "the replacement records the inline worker it resolved to",
  );
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

void test("an uncertain launch that never appears fails after the bounded re-checks", async () => {
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
  const failed = latestAttempt(await f.read(plan.id), "a");
  assert.equal(failed?.id, a.id);
  assert.equal(failed?.state, "failed");
  assert.equal(failed?.reportedBy, "server");
  assert.equal(failed?.report?.diagnosis?.need, "harness");
  assert.equal(failed?.launch?.settled, true);
});

void test("a retry of a failed uncertain launch replays the same identity and counts", async () => {
  const f = await fixture();
  const plan = await f.start();
  f.loseAck();
  const symphony = await f.define(plan, [task("a")]);
  const a = latestAttempt(symphony, "a");
  assert.ok(a && plan.source.agentId);
  // The acknowledgement was lost and the identity never appears, so the
  // bounded re-checks settle the attempt as a harness failure while the
  // launch is still uncertain and settled.
  f.workers.launchCheckDelaysMs = [0, 0];
  f.workers.inspect = async () => ({
    exists: false,
    active: false,
    deliverable: false,
  });
  await f.reconcile();
  await f.reconcile();
  await f.reconcile();
  const failed = latestAttempt(await f.read(plan.id), "a");
  assert.equal(failed?.state, "failed");
  assert.equal(failed?.launch?.state, "uncertain");
  assert.equal(failed?.launch?.settled, true);
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
  assert.equal(retried?.report, null);
  assert.equal(retried?.identityRetries, 1);
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
  assert.equal(settled?.state, "failed");
  assert.equal(settled?.reportedBy, "server");
  assert.equal(settled?.launch?.settled, true);
  // The original failure and the identity replay both count: one retry left.
  f.active.set(a.agentId, false);
  await f.send(plan.source.agentId, {
    kind: "dispatch",
    symphonyId: plan.id,
    retryTaskId: "a",
  });
  const third = latestAttempt(await f.read(plan.id), "a");
  assert.ok(third && third.id !== a.id);
  assert.equal(third.agentId, a.agentId);
  // The continuation stops twice without a report: nudge, then failure.
  f.active.set(a.agentId, false);
  await f.reconcile();
  f.active.set(a.agentId, false);
  await f.reconcile();
  assert.equal(latestAttempt(await f.read(plan.id), "a")?.state, "failed");
  await assert.rejects(
    f.send(plan.source.agentId, {
      kind: "dispatch",
      symphonyId: plan.id,
      retryTaskId: "a",
    }),
    /already used its 2 failed retries/,
  );
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
  await f.send(reader.agentId, {
    kind: "block",
    symphonyId: plan.id,
    attemptId: reader.id,
    message: "Need to edit the shared helper",
  });
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
  await f.send(a.agentId, {
    kind: "block",
    symphonyId: plan.id,
    attemptId: a.id,
    message: "Need the fixture path",
  });
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
  assert.match(prompt, /It blocked with: `Need the fixture path`/);
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
  assert.match(prompt, /If the Conductor tools are\nmissing, say so/);
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
  assert.deepEqual(
    rebound?.launch?.resolved,
    { provider: "pi" },
    "the rebind records the provider it resolved to",
  );
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
  assert.equal(settled?.state, "failed");
  assert.equal(settled?.reportedBy, "server");
  const serverSummary = notificationSummary(
    server,
    serverPlan.id,
    serverPlan.source.agentId,
  )[0];
  assert.equal(serverSummary?.kind, "no-report");
  assert.equal(serverSummary?.diagnosis?.need, "harness");

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
  // The lost launch never appears, so the bounded re-check settles it failed.
  f.launches.delete(a.agentId);
  f.active.set(a.agentId, false);
  await f.reconcile();
  const failed = latestAttempt(await f.read(plan.id), "a");
  assert.equal(failed?.state, "failed");
  assert.equal(failed?.launch?.state, "uncertain");
  assert.equal(failed?.launch?.settled, true);
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
  assert.equal(unchanged?.state, "failed");
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

// === Review loops ===

/** The latest Conductor message wake for one symphony. */
function conductorWake(
  f: OrchestrationFixture,
  symphonyId: string,
  conductorId: string,
) {
  return f.wakePrompts
    .filter(
      (entry) =>
        entry.agentId === conductorId &&
        entry.prompt.startsWith(`Conductor symphony ${symphonyId}:`),
    )
    .at(-1);
}

void test("loops reopen the owning task and re-run its review until the loop succeeds", async () => {
  const f = await fixture();
  const plan = await f.start("loop-flow");
  assert.ok(plan.source.agentId);
  let symphony = await f.define(plan, [
    task("api", [], ["src/api"]),
    reviewTask("review", ["api"]),
  ]);
  const api = latestAttempt(symphony, "api");
  assert.ok(api);

  // Loop 1: the writer completes and the review finds a blocking defect.
  await f.report(plan.id, "api");
  f.active.set(api.agentId, false);
  await f.reconcile();
  const review1 = latestAttempt(await f.read(plan.id), "review");
  assert.ok(review1);
  await f.send(review1.agentId, {
    kind: "report",
    symphonyId: plan.id,
    attemptId: review1.id,
    report: needsChangesReport(),
  });
  f.active.set(review1.agentId, false);
  await f.reconcile();
  assert.ok(f.wakes.includes(`${plan.source.agentId}:${plan.id}:loop-end:1`));
  assert.match(
    conductorWake(f, plan.id, plan.source.agentId)?.prompt ?? "",
    /Loop 1 needs changes: 1 blocking finding \[F1 \(api\)\]/,
  );

  // Loop 2: reopen the owner with the finding on its existing agent.
  await f.send(plan.source.agentId, {
    kind: "loop",
    symphonyId: plan.id,
    reason: "Fix F1",
    reopen: [
      { taskId: "api", findings: ["review#F1"], note: "Validate first" },
    ],
  });
  symphony = await f.read(plan.id);
  const api2 = latestAttempt(symphony, "api");
  assert.ok(api2);
  assert.equal(api2.loop, 2);
  assert.equal(api2.agentId, api.agentId);
  // The continuation keeps the effective launch config and records the
  // catalog revision it was validated at.
  assert.ok(api2.launch?.config);
  assert.match(api2.launch?.catalogRevision ?? "", /^[a-f0-9]{64}$/);
  assert.deepEqual(
    api2.reopen?.findings.map((entry) => entry.id),
    ["F1"],
  );
  const reopened = f.wakePrompts.find(
    (entry) => entry.key === `continue:${api2.id}`,
  );
  assert.ok(reopened);
  assert.match(reopened.prompt, /Findings to address:/);
  assert.match(reopened.prompt, /concertId is validated after its lookup/);
  assert.match(reopened.prompt, /Conductor note: Validate first/);
  // The review waits for the reopened owner.
  assert.equal(latestAttempt(symphony, "review")?.id, review1.id);

  await f.report(plan.id, "api");
  f.active.set(api2.agentId, false);
  await f.reconcile();
  const review2 = latestAttempt(await f.read(plan.id), "review");
  assert.ok(review2 && review2.id !== review1.id);
  assert.equal(review2.loop, 2);
  assert.equal(review2.recheck, true);
  const rechecked = f.wakePrompts.find(
    (entry) => entry.key === `continue:${review2.id}`,
  );
  assert.ok(rechecked);
  assert.match(rechecked.prompt, /Prerequisite api changed in loop 2/);
  assert.match(rechecked.prompt, /Previous loop findings to confirm fixed:/);

  // The review repeats the same finding, so the wake recommends asking the user.
  await f.send(review2.agentId, {
    kind: "report",
    symphonyId: plan.id,
    attemptId: review2.id,
    report: needsChangesReport(),
  });
  f.active.set(review2.agentId, false);
  await f.reconcile();
  assert.ok(f.wakes.includes(`${plan.source.agentId}:${plan.id}:loop-end:2`));
  assert.match(
    conductorWake(f, plan.id, plan.source.agentId)?.prompt ?? "",
    /repeat the previous loop/,
  );

  // Loop 3: reopen again and the review now completes.
  await f.send(plan.source.agentId, {
    kind: "loop",
    symphonyId: plan.id,
    reason: "Fix F1 again",
    reopen: [{ taskId: "api", findings: ["review#F1"] }],
  });
  symphony = await f.read(plan.id);
  const api3 = latestAttempt(symphony, "api");
  assert.ok(api3);
  assert.equal(api3.loop, 3);
  await f.report(plan.id, "api");
  f.active.set(api3.agentId, false);
  await f.reconcile();
  const review3 = latestAttempt(await f.read(plan.id), "review");
  assert.ok(review3 && review3.id !== review2.id);
  assert.equal(review3.loop, 3);
  await f.report(plan.id, "review", "completed", {
    summary: "No blocking findings",
  });
  f.active.set(review3.agentId, false);
  await f.reconcile();
  assert.ok(f.wakes.includes(`${plan.source.agentId}:${plan.id}:loop-end:3`));
  assert.match(
    conductorWake(f, plan.id, plan.source.agentId)?.prompt ?? "",
    /Loop 3 succeeded/,
  );
  await f.send(plan.source.agentId, {
    kind: "finish",
    symphonyId: plan.id,
    summary: "All loops succeeded",
  });
  assert.equal((await f.read(plan.id)).status, "completed");
});

void test("a reopened task re-runs its transitive dependents with a short re-check", async () => {
  const f = await fixture();
  const plan = await f.start("dependents");
  assert.ok(plan.source.agentId);
  await f.define(plan, [
    { ...task("api", [], ["src/api"]), reads: ["src"] },
    { ...task("collect", ["api"]), reads: ["src"], writes: [] },
    reviewTask("review", ["collect"]),
  ]);
  const api = latestAttempt(await f.read(plan.id), "api");
  assert.ok(api);
  await f.report(plan.id, "api");
  f.active.set(api.agentId, false);
  await f.reconcile();
  const collect1 = latestAttempt(await f.read(plan.id), "collect");
  assert.ok(collect1);
  await f.report(plan.id, "collect");
  f.active.set(collect1.agentId, false);
  await f.reconcile();
  const review1 = latestAttempt(await f.read(plan.id), "review");
  assert.ok(review1);
  await f.send(review1.agentId, {
    kind: "report",
    symphonyId: plan.id,
    attemptId: review1.id,
    report: needsChangesReport(),
  });
  f.active.set(review1.agentId, false);
  await f.reconcile();

  await f.send(plan.source.agentId, {
    kind: "loop",
    symphonyId: plan.id,
    reason: "Fix F1",
    reopen: [{ taskId: "api", findings: ["review#F1"] }],
  });
  const api2 = latestAttempt(await f.read(plan.id), "api");
  assert.ok(api2);
  assert.equal(api2.loop, 2);
  // collect still holds its loop-1 attempt until api settles.
  assert.equal(
    latestAttempt(await f.read(plan.id), "collect")?.id,
    collect1.id,
  );
  await f.report(plan.id, "api");
  f.active.set(api2.agentId, false);
  await f.reconcile();
  const collect2 = latestAttempt(await f.read(plan.id), "collect");
  assert.ok(collect2 && collect2.id !== collect1.id);
  assert.equal(collect2.loop, 2);
  assert.equal(collect2.recheck, true);
  const recheck = f.wakePrompts.find(
    (entry) => entry.key === `continue:${collect2.id}`,
  );
  assert.ok(recheck);
  assert.match(recheck.prompt, /Prerequisite api changed in loop 2/);
  // The review waits for collect and then re-checks with the previous findings.
  assert.equal(latestAttempt(await f.read(plan.id), "review")?.id, review1.id);
  await f.report(plan.id, "collect");
  f.active.set(collect2.agentId, false);
  await f.reconcile();
  const review2 = latestAttempt(await f.read(plan.id), "review");
  assert.ok(review2 && review2.id !== review1.id);
  assert.equal(review2.loop, 2);
  assert.equal(review2.recheck, true);
});

void test("loop is refused before a needs-changes loop ends and for uncovered items", async () => {
  const f = await fixture();
  const plan = await f.start("preconditions");
  assert.ok(plan.source.agentId);
  const symphony = await f.define(plan, [task("api", [], ["src/api"])]);
  await assert.rejects(
    f.send(plan.source.agentId, {
      kind: "loop",
      symphonyId: plan.id,
      reason: "Too soon",
      reopen: [],
    }),
    /only after the current loop ends/,
  );
  const api = latestAttempt(symphony, "api");
  assert.ok(api);
  await f.send(api.agentId, {
    kind: "report",
    symphonyId: plan.id,
    attemptId: api.id,
    report: needsChangesReport(),
  });
  f.active.set(api.agentId, false);
  await f.reconcile();
  await assert.rejects(
    f.send(plan.source.agentId, {
      kind: "loop",
      symphonyId: plan.id,
      reason: "Unknown task",
      reopen: [{ taskId: "missing" }],
    }),
    /Unknown task/,
  );
  await assert.rejects(
    f.send(plan.source.agentId, {
      kind: "loop",
      symphonyId: plan.id,
      reason: "Bad reference",
      reopen: [{ taskId: "api", findings: ["review#nope"] }],
    }),
    /Unknown finding/,
  );
  await assert.rejects(
    f.send(plan.source.agentId, {
      kind: "loop",
      symphonyId: plan.id,
      reason: "Uncovered",
      reopen: [],
    }),
    /must reopen or defer every open item: finding api#F1/,
  );
});

void test("loop past the budget needs a recorded user approval", async () => {
  const f = await fixture();
  const limited = await f.orchestrate("budget", {
    conductor: "agent",
    maxLoops: 1,
  });
  assert.ok("symphony" in limited);
  const plan = limited.symphony;
  assert.ok(plan.source.agentId);
  assert.equal(plan.execution.conducting?.maxLoops, 1);
  const symphony = await f.define(plan, [task("api", [], ["src/api"])]);
  const api = latestAttempt(symphony, "api");
  assert.ok(api);
  await f.send(api.agentId, {
    kind: "report",
    symphonyId: plan.id,
    attemptId: api.id,
    report: {
      outcome: "needs-changes",
      summary: "Checks still red.",
      evidence: ["Ran the checks"],
      checks: [{ name: "Regression", status: "failed", detail: "Still red." }],
    },
  });
  f.active.set(api.agentId, false);
  await f.reconcile();
  assert.match(
    conductorWake(f, plan.id, plan.source.agentId)?.prompt ?? "",
    /loop budget \(1\) is used/,
  );
  await assert.rejects(
    f.send(plan.source.agentId, {
      kind: "loop",
      symphonyId: plan.id,
      reason: "Fix the check",
      reopen: [{ taskId: "api" }],
    }),
    /exceeds the loop budget/,
  );
  await f.send(plan.source.agentId, {
    kind: "loop",
    symphonyId: plan.id,
    reason: "Fix the check",
    reopen: [{ taskId: "api" }],
    approval: { loops: 2, userAnswer: "Continue, we ship Friday." },
  });
  const looped = await f.read(plan.id);
  assert.equal(
    looped.execution.conducting?.loops?.[0]?.approval?.userAnswer,
    "Continue, we ship Friday.",
  );
  assert.equal(currentLoop(looped), 2);
  assert.equal(latestAttempt(looped, "api")?.loop, 2);
});

void test("a failed task is retried at most twice per loop, then asks the user", async () => {
  const f = await fixture();
  const plan = await f.start("retry-limit");
  assert.ok(plan.source.agentId);
  const symphony = await f.define(plan, [task("a", [], ["src/a"])]);
  const a = latestAttempt(symphony, "a");
  assert.ok(a);
  await f.report(plan.id, "a", "failed");
  f.active.set(a.agentId, false);
  await f.reconcile();
  for (let round = 0; round < 2; round += 1) {
    await f.send(plan.source.agentId, {
      kind: "dispatch",
      symphonyId: plan.id,
      retryTaskId: "a",
    });
    const retry = latestAttempt(await f.read(plan.id), "a");
    assert.ok(retry);
    await f.report(plan.id, "a", "failed");
    f.active.set(retry.agentId, false);
    await f.reconcile();
  }
  const attempts = (await f.read(plan.id)).execution.attempts.filter(
    (entry) => entry.state === "failed",
  );
  assert.equal(attempts.length, 3);
  await assert.rejects(
    f.send(plan.source.agentId, {
      kind: "dispatch",
      symphonyId: plan.id,
      retryTaskId: "a",
    }),
    /used its 2 failed retries/,
  );
});

void test("finish with unresolved covers the open work and ends the symphony failed", async () => {
  const f = await fixture();
  const limited = await f.orchestrate("stop", {
    conductor: "agent",
    maxLoops: 1,
  });
  assert.ok("symphony" in limited);
  const plan = limited.symphony;
  assert.ok(plan.source.agentId);
  const symphony = await f.define(plan, [task("api", [], ["src/api"])]);
  const api = latestAttempt(symphony, "api");
  assert.ok(api);
  await f.send(api.agentId, {
    kind: "report",
    symphonyId: plan.id,
    attemptId: api.id,
    report: needsChangesReport(),
  });
  f.active.set(api.agentId, false);
  await f.reconcile();
  await assert.rejects(
    f.send(plan.source.agentId, {
      kind: "finish",
      symphonyId: plan.id,
      summary: "Stop",
    }),
    /completed report for every task/,
  );
  await assert.rejects(
    f.send(plan.source.agentId, {
      kind: "finish",
      symphonyId: plan.id,
      summary: "Stop",
      unresolved: [{ taskId: "api", reason: "User stopped" }],
    }),
    /finding api#F1 is not listed/,
  );
  await f.send(plan.source.agentId, {
    kind: "finish",
    symphonyId: plan.id,
    summary: "Stopped by the user",
    unresolved: [
      { finding: "api#F1", reason: "User stopped" },
      { taskId: "api", reason: "User stopped" },
    ],
  });
  const stopped = await f.read(plan.id);
  assert.equal(stopped.status, "failed");
  assert.equal(stopped.execution.unresolved?.length, 2);
});

/** Sends a report for a task's latest attempt and lets its agent stop. */
async function reportAndSettle(
  f: OrchestrationFixture,
  symphonyId: string,
  taskId: string,
  report: Record<string, unknown>,
) {
  const attempt = latestAttempt(await f.read(symphonyId), taskId);
  assert.ok(attempt);
  await f.send(attempt.agentId, {
    kind: "report",
    symphonyId,
    attemptId: attempt.id,
    report: {
      summary: "Inspected assignment",
      evidence: ["Verified concrete fixture result"],
      checks: [],
      ...report,
    },
  });
  f.active.set(attempt.agentId, false);
  await f.reconcile();
  return attempt;
}

/** Runs api then a review that reports blocking finding F1 against api. */
async function firstLoopNeedsChanges(f: OrchestrationFixture, key: string) {
  const plan = await f.start(key);
  assert.ok(plan.source.agentId);
  await f.define(plan, [
    task("api", [], ["src/api"]),
    reviewTask("review", ["api"]),
  ]);
  await reportAndSettle(f, plan.id, "api", { outcome: "completed" });
  await reportAndSettle(f, plan.id, "review", needsChangesReport());
  return { plan, conductor: plan.source.agentId };
}

void test("a refused loop leaves the symphony unchanged and rejects loop cycles", async () => {
  const f = await fixture();
  const { plan, conductor } = await firstLoopNeedsChanges(f, "atomic");
  const before = await f.read(plan.id);
  f.setValidate((score) => {
    if (score.tasks.some((entry) => entry.writes.includes("link/file"))) {
      throw new SymphonyError("Symlink disallowed");
    }
  });
  await assert.rejects(
    f.send(conductor, {
      kind: "loop",
      symphonyId: plan.id,
      reason: "Fix F1",
      reopen: [
        { taskId: "api", findings: ["review#F1"], addWrites: ["link/file"] },
      ],
    }),
    /Symlink disallowed/,
  );
  // `after` edges join the loop graph: api after review, review after api.
  await assert.rejects(
    f.send(conductor, {
      kind: "loop",
      symphonyId: plan.id,
      reason: "Cycle",
      reopen: [{ taskId: "api", findings: ["review#F1"], after: ["review"] }],
    }),
    /must not contain a cycle/,
  );
  await assert.rejects(
    f.send(conductor, {
      kind: "loop",
      symphonyId: plan.id,
      reason: "Twice",
      reopen: [
        { taskId: "api", findings: ["review#F1"] },
        { taskId: "api", findings: [] },
      ],
    }),
    /reopened more than once/,
  );
  const after = await f.read(plan.id);
  assert.equal(after.version, before.version, "a refused loop mutates nothing");
  assert.equal(after.execution.conducting?.loops, undefined);
  // The same command without the refused scope is accepted afterwards.
  f.setValidate(() => {});
  await f.send(conductor, {
    kind: "loop",
    symphonyId: plan.id,
    reason: "Fix F1",
    reopen: [{ taskId: "api", findings: ["review#F1"] }],
  });
  assert.equal(latestAttempt(await f.read(plan.id), "api")?.loop, 2);
});

void test("a delayed reopen keeps its note and added writes until it starts", async () => {
  const f = await fixture();
  const { plan, conductor } = await firstLoopNeedsChanges(f, "delayed");
  const api1 = latestAttempt(await f.read(plan.id), "api");
  assert.ok(api1);
  await f.send(conductor, {
    kind: "loop",
    symphonyId: plan.id,
    reason: "Plan, then fix F1",
    tasks: [
      {
        id: "plan-2",
        title: "Plan the fix",
        description: "Decide where validation belongs",
        dependsOn: [],
        reads: ["src"],
        writes: [],
        checks: [],
        profile: "Small",
      },
    ],
    reopen: [
      {
        taskId: "api",
        findings: ["review#F1"],
        note: "DO THIS NOTE",
        addWrites: ["src/extra"],
        after: ["plan-2"],
      },
    ],
  });
  let symphony = await f.read(plan.id);
  // api waits for its loop-only prerequisite; plan-2 starts.
  assert.equal(latestAttempt(symphony, "api")?.id, api1.id);
  assert.ok(latestAttempt(symphony, "plan-2"));
  await reportAndSettle(f, plan.id, "plan-2", { outcome: "completed" });
  symphony = await f.read(plan.id);
  const api2 = latestAttempt(symphony, "api");
  assert.ok(api2 && api2.id !== api1.id);
  assert.equal(api2.loop, 2);
  assert.deepEqual(
    api2.addedWrites?.map((grant) => grant.path),
    ["src/extra"],
  );
  assert.deepEqual(
    api2.reopen?.findings.map((finding) => finding.summary),
    [blockingFinding.summary],
  );
  const prompt = f.wakePrompts.find(
    (entry) => entry.key === `continue:${api2.id}`,
  )?.prompt;
  assert.ok(prompt);
  assert.match(prompt, /Conductor note: DO THIS NOTE/);
  assert.match(prompt, /added: src\/extra/);
  assert.match(prompt, /concertId is validated after its lookup/);
});

void test("an unsettled needs-changes report keeps the loop open and the review waiting", async () => {
  const f = await fixture();
  const plan = await f.start("unsettled");
  assert.ok(plan.source.agentId);
  const symphony = await f.define(plan, [
    task("api", [], ["src/api"]),
    reviewTask("review", ["api"]),
  ]);
  const api = latestAttempt(symphony, "api");
  assert.ok(api);
  await f.send(api.agentId, {
    kind: "report",
    symphonyId: plan.id,
    attemptId: api.id,
    report: needsChangesReport({ ...blockingFinding, taskId: "api" }),
  });
  // The task agent is still running after its report.
  await f.reconcile();
  assert.equal(latestAttempt(await f.read(plan.id), "review"), undefined);
  await assert.rejects(
    f.send(plan.source.agentId, {
      kind: "loop",
      symphonyId: plan.id,
      reason: "Too soon",
      reopen: [{ taskId: "api", findings: ["api#F1"] }],
    }),
    /only after the current loop ends/,
  );
  f.active.set(api.agentId, false);
  await f.reconcile();
  assert.ok(latestAttempt(await f.read(plan.id), "review"));
});

void test("the re-running review receives an owner's own finding after the owner is reopened", async () => {
  const f = await fixture();
  const plan = await f.start("self-finding");
  assert.ok(plan.source.agentId);
  await f.define(plan, [
    task("api", [], ["src/api"]),
    reviewTask("review", ["api"]),
  ]);
  const selfFinding = {
    id: "F9",
    severity: "blocking" as const,
    paths: ["src/api.ts:9"],
    summary: "The api contract test still fails.",
  };
  await reportAndSettle(f, plan.id, "api", {
    outcome: "needs-changes",
    findings: [selfFinding],
  });
  await reportAndSettle(f, plan.id, "review", { outcome: "completed" });
  await f.send(plan.source.agentId, {
    kind: "loop",
    symphonyId: plan.id,
    reason: "Fix F9",
    reopen: [{ taskId: "api", findings: ["api#F9"] }],
  });
  await reportAndSettle(f, plan.id, "api", { outcome: "completed" });
  const review2 = latestAttempt(await f.read(plan.id), "review");
  assert.ok(review2 && review2.loop === 2);
  const prompt = f.wakePrompts.find(
    (entry) => entry.key === `continue:${review2.id}`,
  )?.prompt;
  assert.ok(prompt);
  assert.match(prompt, /Previous loop findings to confirm fixed:/);
  assert.match(prompt, /The api contract test still fails\./);
});

void test("findings from two reviewers with the same id resolve by reporter", async () => {
  const f = await fixture();
  const plan = await f.start("two-reviewers");
  assert.ok(plan.source.agentId);
  await f.define(plan, [
    task("api", [], ["src/api"]),
    reviewTask("r1", ["api"]),
    reviewTask("r2", ["api"]),
  ]);
  await reportAndSettle(f, plan.id, "api", { outcome: "completed" });
  await reportAndSettle(
    f,
    plan.id,
    "r1",
    needsChangesReport({ ...blockingFinding, summary: "First defect" }),
  );
  await reportAndSettle(
    f,
    plan.id,
    "r2",
    needsChangesReport({ ...blockingFinding, summary: "Second defect" }),
  );
  await assert.rejects(
    f.send(plan.source.agentId, {
      kind: "loop",
      symphonyId: plan.id,
      reason: "Ambiguous",
      reopen: [{ taskId: "api", findings: ["F1"] }],
    }),
    /ambiguous; name it as r1#F1 or r2#F1/,
  );
  await f.send(plan.source.agentId, {
    kind: "loop",
    symphonyId: plan.id,
    reason: "Fix both",
    reopen: [{ taskId: "api", findings: ["r1#F1", "r2#F1"] }],
  });
  const api2 = latestAttempt(await f.read(plan.id), "api");
  assert.deepEqual(
    api2?.reopen?.findings.map((finding) => finding.summary),
    ["First defect", "Second defect"],
  );
});

void test("a deferred finding is carried to later loops until it is reopened", async () => {
  const f = await fixture();
  const plan = await f.start("deferred");
  assert.ok(plan.source.agentId);
  await f.define(plan, [
    task("api", [], ["src/api"]),
    task("ui", [], ["src/ui"]),
  ]);
  const own = (id: string, summary: string) => ({
    outcome: "needs-changes",
    findings: [{ id, severity: "blocking", paths: ["src/x.ts:1"], summary }],
  });
  await reportAndSettle(f, plan.id, "api", own("F1", "api defect"));
  await reportAndSettle(f, plan.id, "ui", own("F2", "ui defect"));
  await f.send(plan.source.agentId, {
    kind: "loop",
    symphonyId: plan.id,
    reason: "Fix ui only",
    reopen: [{ taskId: "ui", findings: ["ui#F2"] }],
    deferred: [
      { finding: "api#F1", reason: "Needs a user decision" },
      { taskId: "api", reason: "Needs a user decision" },
    ],
  });
  await reportAndSettle(f, plan.id, "ui", { outcome: "completed" });
  // Loop 2 ends needing changes because the deferred finding is still open.
  assert.ok(f.wakes.includes(`${plan.source.agentId}:${plan.id}:loop-end:2`));
  assert.match(
    conductorWake(f, plan.id, plan.source.agentId)?.prompt ?? "",
    /Loop 2 needs changes: 1 blocking finding \[F1 \(api\)\]/,
  );
  await assert.rejects(
    f.send(plan.source.agentId, {
      kind: "loop",
      symphonyId: plan.id,
      reason: "Drop it",
      reopen: [],
    }),
    /must reopen or defer every open item: finding api#F1, task api/,
  );
  await f.send(plan.source.agentId, {
    kind: "loop",
    symphonyId: plan.id,
    reason: "Now fix api",
    reopen: [{ taskId: "api", findings: ["api#F1"] }],
  });
  const api3 = latestAttempt(await f.read(plan.id), "api");
  assert.equal(api3?.loop, 3);
  assert.deepEqual(
    api3?.reopen?.findings.map((finding) => finding.summary),
    ["api defect"],
  );
});

void test("finish with unresolved waits for agents to stop and then releases their scope", async () => {
  const f = await fixture();
  const plan = await f.start("stop");
  assert.ok(plan.source.agentId);
  const symphony = await f.define(plan, [task("api", [], ["src/api"])]);
  const api = latestAttempt(symphony, "api");
  assert.ok(api);
  const stop = {
    kind: "finish",
    symphonyId: plan.id,
    summary: "The user stopped the work.",
    unresolved: [{ taskId: "api", reason: "The user stopped." }],
  };
  await assert.rejects(
    f.send(plan.source.agentId, stop),
    /every task agent to stop and settle first; task "api"/,
  );
  await f.send(api.agentId, {
    kind: "block",
    symphonyId: plan.id,
    attemptId: api.id,
    message: "Waiting for the user",
  });
  f.active.set(api.agentId, false);
  await f.reconcile();
  await f.send(plan.source.agentId, stop);
  assert.equal((await f.read(plan.id)).status, "failed");
  // The stopped report-less attempt no longer owns src/api.
  const next = await f.start("after-stop");
  const started = await f.define(next, [task("api2", [], ["src/api"])]);
  assert.ok(latestAttempt(started, "api2"));
});

void test("a loop reopen keeps the worker choice a successful retry used", async () => {
  const f = await fixture();
  const plan = await f.start("choice");
  assert.ok(plan.source.agentId);
  await f.define(plan, [
    task("api", [], ["src/api"]),
    reviewTask("review", ["api"]),
  ]);
  await reportAndSettle(f, plan.id, "api", { outcome: "failed" });
  await f.send(plan.source.agentId, {
    kind: "dispatch",
    symphonyId: plan.id,
    retryTaskId: "api",
    provider: "fake",
    model: "other",
  });
  const retried = await reportAndSettle(f, plan.id, "api", {
    outcome: "completed",
  });
  assert.equal(retried.launch?.model, "other");
  await reportAndSettle(f, plan.id, "review", needsChangesReport());
  await f.send(plan.source.agentId, {
    kind: "loop",
    symphonyId: plan.id,
    reason: "Fix F1",
    reopen: [{ taskId: "api", findings: ["review#F1"] }],
  });
  const continued = latestAttempt(await f.read(plan.id), "api");
  assert.equal(continued?.loop, 2);
  assert.equal(continued?.agentId, retried.agentId);
  assert.equal(continued?.launch?.model, "other");
  // When that agent can no longer receive a message, the new agent keeps it.
  await reportAndSettle(f, plan.id, "api", { outcome: "completed" });
  await reportAndSettle(f, plan.id, "review", needsChangesReport());
  f.undeliverable.add(retried.agentId);
  await f.send(plan.source.agentId, {
    kind: "loop",
    symphonyId: plan.id,
    reason: "Fix F1 again",
    reopen: [{ taskId: "api", findings: ["review#F1"] }],
  });
  const replaced = latestAttempt(await f.read(plan.id), "api");
  assert.equal(replaced?.loop, 3);
  assert.notEqual(replaced?.agentId, retried.agentId);
  assert.equal(replaced?.launch?.model, "other");
});

void test("an unconfirmed launch keeps its fence after it fails until its agent appears", async () => {
  const f = await fixture();
  const plan = await f.start("uncertain-fence");
  assert.ok(plan.source.agentId);
  f.loseAck();
  const symphony = await f.define(plan, [
    task("api", [], ["src/api"]),
    task("ui", [], ["src/api"]),
  ]);
  const api = latestAttempt(symphony, "api");
  assert.ok(api);
  // The creation acknowledgement was lost and the identity checks run out.
  f.workers.launchCheckDelaysMs = [0];
  f.workers.inspect = async () => ({
    exists: false,
    active: false,
    deliverable: false,
  });
  await f.reconcile();
  await f.reconcile();
  await f.reconcile();
  let current = await f.read(plan.id);
  const failed = latestAttempt(current, "api");
  assert.equal(failed?.state, "failed");
  assert.equal(failed?.reportedBy, "server");
  assert.equal(failed?.launch?.state, "uncertain");
  assert.equal(failed?.launch?.settled, true);
  // The first creation may still land, so no second writer starts.
  assert.equal(latestAttempt(current, "ui"), undefined);
  await assert.rejects(
    f.send(plan.source.agentId, {
      kind: "finish",
      symphonyId: plan.id,
      summary: "Stop",
      unresolved: [
        { taskId: "api", reason: "Stopped" },
        { taskId: "ui", reason: "Stopped" },
      ],
    }),
    /task "api" has an unconfirmed launch/,
  );
  // The delayed agent appears: the attempt runs again on it, still fenced.
  f.workers.inspect = async (id) => ({
    exists: f.launches.has(id),
    active: f.active.get(id) ?? false,
    deliverable: f.launches.has(id),
  });
  await f.reconcile();
  current = await f.read(plan.id);
  const adopted = latestAttempt(current, "api");
  assert.equal(adopted?.id, api.id);
  assert.equal(adopted?.state, "running");
  assert.equal(adopted?.report, null);
  assert.equal(adopted?.reportedBy, undefined);
  assert.equal(adopted?.launch?.state, "started");
  assert.equal(adopted?.launch?.settled, false);
  assert.equal(latestAttempt(current, "ui"), undefined);
  // Only after the agent reports and stops does the other writer start.
  await f.report(plan.id, "api");
  f.active.set(api.agentId, false);
  await f.reconcile();
  current = await f.read(plan.id);
  assert.equal(latestAttempt(current, "api")?.state, "completed");
  assert.ok(latestAttempt(current, "ui"));
});

void test("every prior finding is captured per reporter beyond one report's limit", async () => {
  const f = await fixture();
  const plan = await f.start("many-findings");
  assert.ok(plan.source.agentId);
  await f.define(plan, [
    task("api", [], ["src/api"]),
    reviewTask("r1", ["api"]),
    reviewTask("r2", ["api"]),
  ]);
  await reportAndSettle(f, plan.id, "api", { outcome: "completed" });
  const finding = (id: string, line: number) => ({
    ...blockingFinding,
    id,
    paths: [`src/api.ts:${line}`],
    summary: `Defect ${id} in the api.`,
  });
  const many = Array.from({ length: 24 }, (_, index) =>
    finding(`F${index + 1}`, index + 1),
  );
  await reportAndSettle(f, plan.id, "r1", {
    ...needsChangesReport(),
    findings: many,
  });
  await reportAndSettle(
    f,
    plan.id,
    "r2",
    needsChangesReport(finding("G1", 99)),
  );
  await f.send(plan.source.agentId, {
    kind: "loop",
    symphonyId: plan.id,
    reason: "Fix every defect",
    reopen: [{ taskId: "api" }],
  });
  let symphony = await f.read(plan.id);
  const record = symphony.execution.conducting?.loops?.at(-1);
  assert.deepEqual(
    record?.previousReports?.map((entry) => [
      entry.reporterTaskId,
      entry.findings.length,
    ]),
    [
      ["r1", 24],
      ["r2", 1],
    ],
  );
  await reportAndSettle(f, plan.id, "api", { outcome: "completed" });
  symphony = await f.read(plan.id);
  const prompt = (taskId: string) => {
    const attempt = latestAttempt(symphony, taskId);
    assert.ok(attempt && attempt.loop === 2);
    const wake = f.wakePrompts.find(
      (entry) => entry.key === `continue:${attempt.id}`,
    )?.prompt;
    assert.ok(wake);
    return wake;
  };
  // Each review gets every finding it reported, with reporter-qualified ids.
  const r1 = prompt("r1");
  for (const entry of many) {
    assert.ok(r1.includes(`- r1#${entry.id} [blocking]`), entry.id);
  }
  assert.match(r1, /1 more previous finding from other reporters/);
  const r2 = prompt("r2");
  assert.match(r2, /- r2#G1 \[blocking\] task api/);
  assert.match(r2, /- r1#F1 \[blocking\]/);
  assert.match(
    r2,
    /1 more previous finding from other reporters is not listed/,
  );
  // History counts the whole snapshot, not one report's limit.
  assert.equal(historyLoops(symphony)[0]?.blocking, 25);
});

void test("same-agent continuations carry the current prerequisite results", async () => {
  const f = await fixture();
  const { plan, conductor } = await firstLoopNeedsChanges(f, "current-results");
  await f.send(conductor, {
    kind: "loop",
    symphonyId: plan.id,
    reason: "Fix F1",
    reopen: [{ taskId: "api", findings: ["review#F1"] }],
  });
  // The reopened owner finds a new defect of its own and a failing check.
  await reportAndSettle(f, plan.id, "api", {
    outcome: "needs-changes",
    summary: "F1 is fixed but the contract broke.",
    checks: [{ name: "contract", status: "failed", detail: "Schema mismatch" }],
    findings: [
      {
        id: "F2",
        severity: "blocking",
        paths: ["src/api.ts:7"],
        summary: "The response schema drifted.",
      },
    ],
  });
  const review = latestAttempt(await f.read(plan.id), "review");
  assert.ok(review && review.loop === 2);
  const prompt = f.wakePrompts.find(
    (entry) => entry.key === `continue:${review.id}`,
  )?.prompt;
  assert.ok(prompt);
  assert.match(prompt, /Prerequisite results:/);
  assert.match(prompt, /- api: needs-changes\. F1 is fixed but the contract/);
  assert.match(
    prompt,
    /F2 \[blocking\] at src\/api\.ts:7: The response schema/,
  );
  assert.match(prompt, /Failed checks: contract/);
});

void test("a reopened owner waiting on an after planner receives its result", async () => {
  const planner = {
    id: "plan-2",
    title: "Plan the fix",
    description: "Decide where validation belongs",
    dependsOn: [],
    reads: ["src"],
    writes: [],
    checks: [],
    profile: "Small",
  };
  for (const reuse of [true, false]) {
    const f = await fixture();
    const { plan, conductor } = await firstLoopNeedsChanges(
      f,
      reuse ? "after-continue" : "after-fallback",
    );
    const api1 = latestAttempt(await f.read(plan.id), "api");
    assert.ok(api1);
    if (!reuse) {
      f.undeliverable.add(api1.agentId);
    }
    await f.send(conductor, {
      kind: "loop",
      symphonyId: plan.id,
      reason: "Plan, then fix F1",
      tasks: [planner],
      reopen: [{ taskId: "api", findings: ["review#F1"], after: ["plan-2"] }],
    });
    await reportAndSettle(f, plan.id, "plan-2", {
      outcome: "completed",
      summary: "Validation belongs in the router.",
    });
    const api2 = latestAttempt(await f.read(plan.id), "api");
    assert.ok(api2 && api2.loop === 2);
    const prompt = reuse
      ? f.wakePrompts.find((entry) => entry.key === `continue:${api2.id}`)
          ?.prompt
      : f.launches.get(api2.agentId)?.prompt;
    assert.ok(prompt, reuse ? "continuation" : "fallback assignment");
    assert.equal(api2.agentId === api1.agentId, reuse);
    assert.match(
      prompt,
      /- plan-2: completed\. Validation belongs in the router\./,
    );
  }
});

void test("a finished symphony refuses late reports and blocks without reopening settlement", async () => {
  const f = await fixture();
  const plan = await f.start("late-after-finish");
  assert.ok(plan.source.agentId);
  const symphony = await f.define(plan, [
    task("api", [], ["src/api"]),
    task("ui"),
  ]);
  const api = latestAttempt(symphony, "api");
  assert.ok(api);
  // api blocks and stops; the read-only ui completes.
  await f.send(api.agentId, {
    kind: "block",
    symphonyId: plan.id,
    attemptId: api.id,
    message: "Waiting for the user",
  });
  f.active.set(api.agentId, false);
  await f.reconcile();
  const ui = await reportAndSettle(f, plan.id, "ui", { outcome: "completed" });
  assert.ok(ui);
  await f.send(plan.source.agentId, {
    kind: "finish",
    symphonyId: plan.id,
    summary: "The user stopped the work.",
    unresolved: [{ taskId: "api", reason: "The user stopped." }],
  });
  const finished = await f.read(plan.id);
  assert.equal(finished.status, "failed");
  // The same worker submits late: refused, and the launch stays settled.
  await assert.rejects(
    f.report(plan.id, "api"),
    /symphony is finished; the attempt no longer accepts/,
  );
  await assert.rejects(
    f.send(api.agentId, {
      kind: "block",
      symphonyId: plan.id,
      attemptId: api.id,
      message: "Still waiting",
    }),
    /symphony is finished/,
  );
  // An exact replay of a saved report is acknowledged without a change.
  await f.send(ui.agentId, {
    kind: "report",
    symphonyId: plan.id,
    attemptId: ui.id,
    report: {
      outcome: "completed",
      summary: "Inspected assignment",
      evidence: ["Verified concrete fixture result"],
      checks: [],
    },
  });
  const after = await f.read(plan.id);
  assert.equal(after.version, finished.version);
  assert.equal(latestAttempt(after, "api")?.launch?.settled, true);
  assert.equal(latestAttempt(after, "api")?.state, "blocked");
});

void test("a finished symphony refuses a late report replacing a server failure", async () => {
  const f = await fixture();
  const plan = await f.start("late-server-report");
  assert.ok(plan.source.agentId);
  const symphony = await f.define(plan, [task("api", [], ["src/api"])]);
  const api = latestAttempt(symphony, "api");
  assert.ok(api);
  // The agent stops twice without a report: nudge, then a server failure.
  f.active.set(api.agentId, false);
  await f.reconcile();
  f.active.set(api.agentId, false);
  await f.reconcile();
  const failed = latestAttempt(await f.read(plan.id), "api");
  assert.equal(failed?.reportedBy, "server");
  await f.send(plan.source.agentId, {
    kind: "finish",
    symphonyId: plan.id,
    summary: "The user stopped the work.",
    unresolved: [{ taskId: "api", reason: "The user stopped." }],
  });
  const finished = await f.read(plan.id);
  await assert.rejects(f.report(plan.id, "api"), /symphony is finished/);
  const after = await f.read(plan.id);
  assert.equal(after.version, finished.version);
  assert.equal(latestAttempt(after, "api")?.reportedBy, "server");
  assert.equal(latestAttempt(after, "api")?.launch?.settled, true);
});

void test("an explicitly reopened review still confirms its previous findings", async () => {
  for (const reuse of [true, false]) {
    const f = await fixture();
    const { plan, conductor } = await firstLoopNeedsChanges(
      f,
      reuse ? "explicit-review-continue" : "explicit-review-fallback",
    );
    const review1 = latestAttempt(await f.read(plan.id), "review");
    assert.ok(review1);
    if (!reuse) {
      f.undeliverable.add(review1.agentId);
    }
    await f.send(conductor, {
      kind: "loop",
      symphonyId: plan.id,
      reason: "Fix F1 and review again",
      reopen: [
        { taskId: "api", findings: ["review#F1"] },
        { taskId: "review", note: "Review the fix" },
      ],
    });
    await reportAndSettle(f, plan.id, "api", { outcome: "completed" });
    const review2 = latestAttempt(await f.read(plan.id), "review");
    assert.ok(review2 && review2.loop === 2);
    assert.equal(review2.agentId === review1.agentId, reuse);
    const prompt = reuse
      ? f.wakePrompts.find((entry) => entry.key === `continue:${review2.id}`)
          ?.prompt
      : f.launches.get(review2.agentId)?.prompt;
    assert.ok(prompt, reuse ? "continuation" : "fallback assignment");
    assert.match(prompt, /Reopened: Review the fix/);
    assert.match(
      prompt,
      /- review#F1 \[blocking\] task api at src\/api\.ts:41/,
    );
    assert.match(prompt, /Confirm each finding is fixed/);
  }
});

void test("a replacement for a re-running review keeps its previous findings", async () => {
  for (const settle of ["failed", "blocked"] as const) {
    const f = await fixture();
    const { plan, conductor } = await firstLoopNeedsChanges(
      f,
      `review-replacement-${settle}`,
    );
    await f.send(conductor, {
      kind: "loop",
      symphonyId: plan.id,
      reason: "Fix F1",
      reopen: [{ taskId: "api", findings: ["review#F1"] }],
    });
    await reportAndSettle(f, plan.id, "api", { outcome: "completed" });
    const review2 = latestAttempt(await f.read(plan.id), "review");
    assert.ok(review2 && review2.loop === 2);
    if (settle === "failed") {
      // Stops without reporting: one nudge, then a harness failure.
      f.active.set(review2.agentId, false);
      await f.reconcile();
      f.active.set(review2.agentId, false);
      await f.reconcile();
    } else {
      await f.send(review2.agentId, {
        kind: "block",
        symphonyId: plan.id,
        attemptId: review2.id,
        message: "Cannot read the api diff",
      });
      f.active.set(review2.agentId, false);
      await f.reconcile();
    }
    assert.equal(latestAttempt(await f.read(plan.id), "review")?.state, settle);
    f.undeliverable.add(review2.agentId);
    await f.send(conductor, {
      kind: "dispatch",
      symphonyId: plan.id,
      retryTaskId: "review",
    });
    const replaced = latestAttempt(await f.read(plan.id), "review");
    assert.ok(replaced && replaced.agentId !== review2.agentId);
    const prompt = f.launches.get(replaced.agentId)?.prompt;
    assert.ok(prompt);
    assert.match(
      prompt,
      /You are replacing the agent from the previous attempt/,
    );
    assert.match(prompt, /Prerequisite api changed in loop 2/);
    assert.match(
      prompt,
      /- review#F1 \[blocking\] task api at src\/api\.ts:41/,
    );
    assert.match(prompt, /Confirm each finding is fixed/);
  }
});

void test("long valid findings shorten the review prompt instead of stalling the loop", async () => {
  for (const reuse of [true, false]) {
    const f = await fixture();
    const plan = await f.start(reuse ? "long-continue" : "long-fallback");
    assert.ok(plan.source.agentId);
    await f.define(plan, [
      task("api", [], ["src/api"]),
      reviewTask("review", ["api"]),
    ]);
    await reportAndSettle(f, plan.id, "api", { outcome: "completed" });
    const long = (id: string) => ({
      id,
      severity: "blocking" as const,
      taskId: "api",
      paths: ["src/api.ts:1"],
      summary: `${id} ${"s".repeat(1990)}`,
      suggestedFix: "f".repeat(2000),
    });
    const ids = (prefix: string) =>
      Array.from({ length: 24 }, (_, index) => `${prefix}${index + 1}`);
    await reportAndSettle(f, plan.id, "review", {
      ...needsChangesReport(),
      findings: ids("R").map(long),
    });
    const review1 = latestAttempt(await f.read(plan.id), "review");
    assert.ok(review1);
    if (!reuse) {
      f.undeliverable.add(review1.agentId);
    }
    await f.send(plan.source.agentId, {
      kind: "loop",
      symphonyId: plan.id,
      reason: "Fix every defect",
      reopen: [{ taskId: "api", findings: ids("review#R") }],
    });
    // The owner finds 24 more long defects of its own.
    await reportAndSettle(f, plan.id, "api", {
      ...needsChangesReport(),
      findings: ids("A").map(long),
    });
    const symphony = await f.read(plan.id);
    assert.equal(symphony.execution.interruption, null);
    const review2 = latestAttempt(symphony, "review");
    assert.ok(review2 && review2.loop === 2, "the review started");
    const prompt = reuse
      ? f.wakePrompts.find((entry) => entry.key === `continue:${review2.id}`)
          ?.prompt
      : f.launches.get(review2.agentId)?.prompt;
    assert.ok(prompt);
    assert.ok(prompt.length <= SYMPHONY_LIMITS.promptChars);
    // Every old and current finding keeps its identity; details are saved.
    for (const id of [...ids("review#R"), ...ids("A")]) {
      assert.match(prompt, new RegExp(`- ${id} \\[blocking\\] task api`), id);
    }
    assert.match(
      prompt,
      /Findings and failed checks are shortened to fit the prompt/,
    );
    assert.equal(latestAttempt(symphony, "api")?.report?.findings?.length, 24);
  }
});

void test("long failed check names shorten the review prompt instead of stalling the loop", async () => {
  const f = await fixture();
  const plan = await f.start("long-checks");
  const owners = Array.from({ length: 9 }, (_, index) => `w${index + 1}`);
  await f.define(plan, [
    ...owners.map((id) => task(id, [], [`src/${id}`])),
    reviewTask("review", owners),
  ]);
  // Each owner leaves 16 distinct, legal 1000-character failed check names.
  for (const id of owners) {
    await reportAndSettle(f, plan.id, id, {
      outcome: "needs-changes",
      checks: Array.from({ length: 16 }, (_, index) => ({
        name: `${id}-c${index + 1} ${"n".repeat(990)}`,
        status: "failed",
        detail: "Still fails",
      })),
    });
  }
  const symphony = await f.read(plan.id);
  assert.equal(symphony.execution.interruption, null);
  const review = latestAttempt(symphony, "review");
  assert.ok(review, "the review started");
  const prompt = f.launches.get(review.agentId)?.prompt;
  assert.ok(prompt);
  assert.ok(prompt.length <= SYMPHONY_LIMITS.promptChars);
  // Each check keeps its identity; the full names stay in the saved reports.
  for (const id of owners) {
    assert.match(prompt, new RegExp(`${id}-c16 n`));
  }
  assert.match(
    prompt,
    /Findings and failed checks are shortened to fit the prompt/,
  );
});

void test("a task that cannot start wakes the Conductor once", async () => {
  const f = await fixture();
  const plan = await f.start("oversized-wake");
  assert.ok(plan.source.agentId);
  const symphony = await f.define(plan, [
    task("api", [], ["src/api"]),
    reviewTask("review", ["api"]),
  ]);
  // The fallback needs near-maximum input in nearly every field, so the test
  // stores the interruption that `reserve` records for such a prompt.
  const message = `Task "review" cannot start: its prompt exceeds ${SYMPHONY_LIMITS.promptChars} characters even with shortened findings and checks. Ask the user, then finish with \`unresolved\` covering this task.`;
  await f.store.update(symphony.id, symphony.version, (current) => {
    current.execution.interruption = message;
    current.status = executionStatus(current);
    return current;
  });
  await f.reconcile();
  await f.reconcile();
  const wakes = f.wakePrompts.filter(
    (entry) => entry.agentId === plan.source.agentId,
  );
  assert.equal(wakes.length, 1);
  assert.ok(wakes[0]?.key?.startsWith(`${plan.id}:interruption:`));
  assert.match(wakes[0]?.prompt ?? "", /A task cannot start\. Task "review"/);
});

// === Routing enforcement (warn/strict, explicit choices, catalog changes) ===

const routedProfiles: WorkerProfile[] = [
  { id: "small", name: "Small", notes: "Bounded work", provider: "fake" },
  {
    id: "escalate",
    name: "Escalate",
    notes: "Larger fallback",
    provider: "fake",
  },
  {
    id: "planner",
    name: "Planner",
    notes: "Open design decisions",
    provider: "fake",
  },
];

const routedConfig: FixtureRouting = {
  version: 1,
  mode: "warn",
  profiles: {
    small: {
      roles: ["implementation", "exploration", "review"],
      size: "small",
    },
    escalate: {
      roles: ["implementation"],
      size: "medium",
    },
    planner: { roles: ["planning"], size: "small" },
  },
};

const routedTask = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  title: `Implement ${id}`,
  description: `Implement ${id}`,
  dependsOn: [],
  reads: [],
  writes: ["src/api"],
  checks: [],
  role: "implementation",
  ...overrides,
});

void test("define auto-routes a worker-less task to the first eligible profile", async () => {
  const f = await fixture({
    routing: routedConfig,
    profiles: routedProfiles,
  });
  const plan = await f.start("route-auto");
  assert.ok(plan.source.agentId);
  const ack = (await f.send(plan.source.agentId, {
    kind: "define",
    symphonyId: plan.id,
    tasks: [
      routedTask("api", {
        routing: { reason: "Smallest eligible backend worker." },
      }),
    ],
  })) as {
    catalogRevision?: string;
    routingWarnings?: Array<{ taskId: string; code: string }>;
  };
  const stored = await f.read(plan.id);
  const definition = stored.revisions
    .at(-1)
    ?.score.tasks.find((entry) => entry.id === "api");
  assert.equal(definition?.worker.profile, "small");
  assert.equal(definition?.routing?.selectedBy, "route");
  assert.equal(
    definition?.routing?.reason,
    "Smallest eligible backend worker.",
  );
  assert.match(ack.catalogRevision ?? "", /^[a-f0-9]{64}$/);
  assert.equal(ack.routingWarnings, undefined);
});

void test("a worker-less task with no eligible profile is rejected in warn mode", async () => {
  const f = await fixture({
    routing: {
      version: 1,
      mode: "warn",
      profiles: { small: { roles: ["review"], size: "small" } },
    },
    profiles: routedProfiles,
  });
  const plan = await f.start("route-inherit");
  assert.ok(plan.source.agentId);
  await assert.rejects(
    f.send(plan.source.agentId, {
      kind: "define",
      symphonyId: plan.id,
      tasks: [routedTask("api")],
    }),
    /no eligible configured profile/,
  );
  // The refused define stored no score revision.
  assert.equal((await f.read(plan.id)).revisions.length, 0);
});

void test("strict routing rejects an omitted worker and a larger explicit profile", async () => {
  const none = await fixture({
    routing: {
      version: 1,
      mode: "strict",
      profiles: { small: { roles: ["review"], size: "small" } },
    },
    profiles: routedProfiles,
  });
  const plan = await none.start("strict-none");
  assert.ok(plan.source.agentId);
  await assert.rejects(
    none.send(plan.source.agentId, {
      kind: "define",
      symphonyId: plan.id,
      tasks: [routedTask("api")],
    }),
    /no eligible configured profile/,
  );

  const larger = await fixture({
    routing: {
      version: 1,
      mode: "strict",
      profiles: {
        small: {
          roles: ["implementation"],
          size: "small",
        },
        escalate: {
          roles: ["implementation"],
          size: "medium",
        },
      },
    },
    profiles: routedProfiles,
  });
  const plan2 = await larger.start("strict-larger");
  assert.ok(plan2.source.agentId);
  await assert.rejects(
    larger.send(plan2.source.agentId, {
      kind: "define",
      symphonyId: plan2.id,
      tasks: [
        routedTask("api", {
          profile: "escalate",
          routing: { reason: "Escalate after a named capability gap." },
        }),
      ],
    }),
    /larger than eligible/,
  );
});

void test("the route command previews the policy and validates an explicit choice", async () => {
  const f = await fixture({
    routing: routedConfig,
    profiles: routedProfiles,
  });
  const result = (await f.send("requester", {
    kind: "route",
    role: "implementation",
  })) as {
    revision: string;
    selected?: { profileId: string };
    alternatives: Array<{ profileId: string }>;
  };
  assert.equal(result.selected?.profileId, "small");
  assert.equal(result.alternatives[0]?.profileId, "escalate");
  assert.match(result.revision, /^[a-f0-9]{64}$/);

  const explicit = (await f.send("requester", {
    kind: "route",
    role: "implementation",
    profile: "escalate",
  })) as { explicit?: { warnings: Array<{ code: string }> } };
  assert.equal(explicit.explicit?.warnings[0]?.code, "larger-than-eligible");
});

void test("a loop reopen worker override starts a new agent and records routing", async () => {
  const f = await fixture({
    routing: routedConfig,
    profiles: routedProfiles,
  });
  const plan = await f.start("loop-override");
  assert.ok(plan.source.agentId);
  let symphony = await f.define(plan, [
    task("api", [], ["src/api"]),
    reviewTask("review", ["api"]),
  ]);
  const api = latestAttempt(symphony, "api");
  assert.ok(api);
  await f.report(plan.id, "api");
  f.active.set(api.agentId, false);
  await f.reconcile();
  const review1 = latestAttempt(await f.read(plan.id), "review");
  assert.ok(review1);
  await f.send(review1.agentId, {
    kind: "report",
    symphonyId: plan.id,
    attemptId: review1.id,
    report: needsChangesReport(),
  });
  f.active.set(review1.agentId, false);
  await f.reconcile();

  const before = f.launches.size;
  await f.send(plan.source.agentId, {
    kind: "loop",
    symphonyId: plan.id,
    reason: "Escalate after the review failed",
    reopen: [
      {
        taskId: "api",
        findings: ["review#F1"],
        profile: "escalate",
        routing: {
          reason: "The smaller worker missed the documented contract.",
          override: {
            category: "observed-limitation",
            evidence:
              "Two bounded corrective attempts failed the same contract check.",
          },
        },
      },
    ],
  });
  symphony = await f.read(plan.id);
  const api2 = latestAttempt(symphony, "api");
  assert.ok(api2);
  assert.notEqual(api2.agentId, api.agentId, "a new agent takes over");
  assert.equal(f.launches.size, before + 1);
  assert.equal(f.launches.get(api2.agentId)?.profile, "escalate");
  assert.equal(api2.launch?.routing?.selectedBy, "conductor");
  assert.match(api2.launch?.prompt ?? "", /Inspected assignment/);
  const reopened = symphony.execution.conducting?.loops?.at(-1)?.reopened[0];
  assert.equal(reopened?.worker?.profile, "escalate");
  assert.equal(reopened?.routing?.selectedBy, "conductor");
});

void test("a dispatch replacement records its routing on the new attempt", async () => {
  const f = await fixture({
    routing: routedConfig,
    profiles: routedProfiles,
  });
  const plan = await f.start("dispatch-routing");
  f.rejectNext();
  const symphony = await f.define(plan, [task("a", [], ["src/api"])]);
  const a = latestAttempt(symphony, "a");
  assert.ok(a && plan.source.agentId);
  assert.equal(a.state, "failed");
  await f.send(plan.source.agentId, {
    kind: "dispatch",
    symphonyId: plan.id,
    retryTaskId: "a",
    profile: "escalate",
    routing: {
      reason: "The launcher rejected the previous profile.",
      override: {
        category: "capability-gap",
        evidence:
          "The prior profile could not load the required project toolchain.",
      },
    },
  });
  const next = latestAttempt(await f.read(plan.id), "a");
  assert.ok(next);
  assert.notEqual(next.id, a.id);
  assert.equal(next.launch?.routing?.selectedBy, "conductor");
  assert.equal(next.launch?.routing?.override?.category, "capability-gap");
  assert.match(next.launch?.catalogRevision ?? "", /^[a-f0-9]{64}$/);
});

void test("a warning-free retry replacement drops the previous choice's warnings", async () => {
  const f = await fixture({
    routing: routedConfig,
    profiles: routedProfiles,
  });
  const plan = await f.start("retry-clean-warnings");
  assert.ok(plan.source.agentId);
  f.rejectNext();
  const symphony = await f.define(plan, [
    { ...task("a", [], ["src/api"]), profile: "deleted-profile" },
  ]);
  const a = latestAttempt(symphony, "a");
  assert.ok(a);
  assert.equal(a.state, "failed");
  assert.deepEqual(
    a.launch?.warnings?.map((warning) => warning.code),
    ["ineligible-profile", "missing-reason"],
    "the original choice records its problems",
  );
  const ack = (await f.send(plan.source.agentId, {
    kind: "dispatch",
    symphonyId: plan.id,
    retryTaskId: "a",
    profile: "small",
    routing: { reason: "The launcher rejected the previous profile." },
  })) as { routingWarnings?: Array<{ taskId: string; code: string }> };
  const next = latestAttempt(await f.read(plan.id), "a");
  assert.ok(next);
  assert.notEqual(next.id, a.id);
  assert.equal(next.launch?.routing?.selectedBy, "conductor");
  assert.equal(
    next.launch?.routing?.reason,
    "The launcher rejected the previous profile.",
  );
  assert.equal(
    next.launch?.warnings,
    undefined,
    "the validated replacement is warning-free",
  );
  assert.equal(
    ack.routingWarnings,
    undefined,
    "the acknowledgement reports no stale warnings",
  );
});

void test("a warning-free blocked rebind drops the previous choice's warnings", async () => {
  const f = await fixture({
    routing: routedConfig,
    profiles: routedProfiles,
  });
  const plan = await f.start("rebind-clean-warnings");
  assert.ok(plan.source.agentId);
  const symphony = await f.define(plan, [
    { ...task("a", [], ["src/api"]), profile: "deleted-profile" },
  ]);
  const a = latestAttempt(symphony, "a");
  assert.ok(a);
  assert.equal(a.launch?.warnings?.[0]?.code, "ineligible-profile");
  await f.send(a.agentId, {
    kind: "block",
    symphonyId: plan.id,
    attemptId: a.id,
    message: "Need the user's decision on the API shape.",
  });
  f.active.set(a.agentId, false);
  await f.reconcile();
  assert.equal(latestAttempt(await f.read(plan.id), "a")?.state, "blocked");
  const ack = (await f.send(plan.source.agentId, {
    kind: "dispatch",
    symphonyId: plan.id,
    retryTaskId: "a",
    profile: "small",
    routing: { reason: "Move the task to an eligible profile." },
  })) as { routingWarnings?: Array<{ taskId: string; code: string }> };
  const rebound = latestAttempt(await f.read(plan.id), "a");
  assert.ok(rebound);
  assert.equal(rebound.id, a.id);
  assert.notEqual(rebound.agentId, a.agentId, "a fresh agent takes over");
  assert.equal(
    rebound.launch?.warnings,
    undefined,
    "the validated replacement is warning-free",
  );
  assert.equal(
    ack.routingWarnings,
    undefined,
    "the acknowledgement reports no stale warnings",
  );
});

void test("a changed catalog revalidates at reserve and warns in warn mode", async () => {
  const f = await fixture({
    routing: routedConfig,
    profiles: routedProfiles,
  });
  const plan = await f.start("catalog-change");
  assert.ok(plan.source.agentId);
  await f.send(plan.source.agentId, {
    kind: "define",
    symphonyId: plan.id,
    tasks: [routedTask("api")],
  });
  // A profile edit changes the catalog revision, so the next reserve
  // revalidates and records a catalog-changed warning.
  const changed: FixtureRouting = {
    ...routedConfig,
    profiles: {
      ...routedConfig.profiles,
      small: { ...routedConfig.profiles.small, size: "large" },
    },
  };
  f.setRouting(changed);
  const ack = (await f.send(plan.source.agentId, {
    kind: "dispatch",
    symphonyId: plan.id,
  })) as {
    routingWarnings?: Array<{ taskId: string; code: string }>;
  };
  const attempt = latestAttempt(await f.read(plan.id), "api");
  assert.ok(attempt);
  assert.ok(
    attempt.launch?.warnings?.some(
      (warning) => warning.code === "catalog-changed",
    ),
  );
  assert.ok(
    ack.routingWarnings?.some(
      (warning) =>
        warning.taskId === "api" && warning.code === "catalog-changed",
    ),
    "the dispatch acknowledgement carries the revalidation warning",
  );
});

void test("a replayed define is idempotent through the recorded hash", async () => {
  const f = await fixture({
    routing: routedConfig,
    profiles: routedProfiles,
  });
  const plan = await f.start("define-replay");
  assert.ok(plan.source.agentId);
  const tasks = [routedTask("api")];
  const first = (await f.send(plan.source.agentId, {
    kind: "define",
    symphonyId: plan.id,
    tasks,
  })) as { catalogRevision?: string };
  const stored = await f.read(plan.id);
  assert.match(stored.execution.conducting?.defineHash ?? "", /^[a-f0-9]{64}$/);
  const replay = (await f.send(plan.source.agentId, {
    kind: "define",
    symphonyId: plan.id,
    tasks,
  })) as { catalogRevision?: string };
  assert.equal(replay.catalogRevision, first.catalogRevision);
  await assert.rejects(
    f.send(plan.source.agentId, {
      kind: "define",
      symphonyId: plan.id,
      tasks: [routedTask("different")],
    }),
    /already has a different score/,
  );
});

void test("strict routing accepts an explicit inherit covered by a no-eligible-profile override", async () => {
  const f = await fixture({
    routing: {
      version: 1,
      mode: "strict",
      profiles: { small: { roles: ["review"], size: "small" } },
    },
    profiles: routedProfiles,
  });
  const plan = await f.start("strict-override");
  assert.ok(plan.source.agentId);
  const ack = (await f.send(plan.source.agentId, {
    kind: "define",
    symphonyId: plan.id,
    tasks: [
      routedTask("api", {
        profile: "inherit",
        routing: {
          reason: "No configured worker serves this role.",
          override: {
            category: "no-eligible-profile",
            evidence:
              "The only configured profile is review-only and cannot implement this task.",
          },
        },
      }),
    ],
  })) as { catalogRevision?: string };
  const definition = (await f.read(plan.id)).revisions.at(-1)?.score.tasks[0];
  assert.equal(definition?.worker.profile, "inherit");
  assert.equal(definition?.routing?.selectedBy, "conductor");
  assert.equal(definition?.routing?.override?.category, "no-eligible-profile");
  assert.match(ack.catalogRevision ?? "", /^[a-f0-9]{64}$/);
});
void test("a loop continuation is revalidated against a changed strict catalog", async () => {
  const warnConfig: FixtureRouting = {
    version: 1,
    mode: "warn",
    profiles: {
      small: {
        roles: ["implementation", "review"],
        size: "small",
      },
      big: {
        roles: ["implementation"],
        size: "medium",
      },
    },
  };
  const profiles: WorkerProfile[] = [
    { id: "small", name: "Small", notes: "", provider: "fake" },
    { id: "big", name: "Big", notes: "", provider: "fake" },
  ];
  const f = await fixture({ routing: warnConfig, profiles });
  const plan = await f.start("continue-strict");
  assert.ok(plan.source.agentId);
  let symphony = await f.define(plan, [
    { ...task("api", [], ["src/api"]), profile: "big" },
    reviewTask("review", ["api"]),
  ]);
  const api = latestAttempt(symphony, "api");
  assert.ok(api);
  assert.equal(api.launch?.warnings?.[0]?.code, "larger-than-eligible");
  await f.report(plan.id, "api");
  f.active.set(api.agentId, false);
  await f.reconcile();
  const review1 = latestAttempt(await f.read(plan.id), "review");
  assert.ok(review1);
  await f.send(review1.agentId, {
    kind: "report",
    symphonyId: plan.id,
    attemptId: review1.id,
    report: needsChangesReport(),
  });
  f.active.set(review1.agentId, false);
  await f.reconcile();

  // The catalog flips to strict before the loop continuation starts.
  f.setRouting({ ...warnConfig, mode: "strict" });
  await f.send(plan.source.agentId, {
    kind: "loop",
    symphonyId: plan.id,
    reason: "Fix F1 without a worker override",
    reopen: [{ taskId: "api", findings: ["review#F1"] }],
  });
  symphony = await f.read(plan.id);
  assert.equal(
    latestAttempt(symphony, "api")?.id,
    api.id,
    "no continuation was created",
  );
  assert.match(symphony.execution.interruption ?? "", /larger than eligible/);
});

void test("define-time routing warnings persist to the first launch and the dispatch acknowledgement", async () => {
  const warnConfig: FixtureRouting = {
    version: 1,
    mode: "warn",
    profiles: {
      small: {
        roles: ["implementation"],
        size: "small",
      },
      big: {
        roles: ["implementation"],
        size: "medium",
      },
    },
  };
  const profiles: WorkerProfile[] = [
    { id: "small", name: "Small", notes: "", provider: "fake" },
    { id: "big", name: "Big", notes: "", provider: "fake" },
  ];
  const f = await fixture({ routing: warnConfig, profiles });
  const plan = await f.start("warn-audit");
  assert.ok(plan.source.agentId);
  const defineAck = (await f.send(plan.source.agentId, {
    kind: "define",
    symphonyId: plan.id,
    tasks: [{ ...task("api", [], ["src/api"]), profile: "big" }],
  })) as {
    routingWarnings?: Array<{ taskId: string; code: string; message: string }>;
  };
  assert.equal(defineAck.routingWarnings?.[0]?.taskId, "api");
  assert.equal(defineAck.routingWarnings?.[0]?.code, "larger-than-eligible");
  const dispatchAck = (await f.send(plan.source.agentId, {
    kind: "dispatch",
    symphonyId: plan.id,
  })) as {
    routingWarnings?: Array<{ taskId: string; code: string; message: string }>;
  };
  assert.ok(
    dispatchAck.routingWarnings?.some(
      (warning) =>
        warning.taskId === "api" && warning.code === "larger-than-eligible",
    ),
    "the dispatch acknowledgement carries the define-time warning",
  );
  const attempt = latestAttempt(await f.read(plan.id), "api");
  assert.equal(attempt?.launch?.warnings?.[0]?.code, "larger-than-eligible");
  assert.match(attempt?.launch?.catalogRevision ?? "", /^[a-f0-9]{64}$/);
});

void test("a multi-loop takeover keeps the previous routing and blocks a strict flip", async () => {
  const warnConfig: FixtureRouting = {
    version: 1,
    mode: "warn",
    profiles: {
      small: {
        roles: ["implementation", "review"],
        size: "small",
      },
      big: {
        roles: ["implementation"],
        size: "medium",
      },
    },
  };
  const profiles: WorkerProfile[] = [
    { id: "small", name: "Small", notes: "", provider: "fake" },
    { id: "big", name: "Big", notes: "", provider: "fake" },
  ];
  const f = await fixture({ routing: warnConfig, profiles });
  const plan = await f.start("takeover-strict");
  assert.ok(plan.source.agentId);
  let symphony = await f.define(plan, [
    {
      ...task("api", [], ["src/api"]),
      profile: "small",
      routing: {
        reason: "The user asked for the Small profile by name.",
        override: {
          category: "user-choice",
          evidence: "The user asked for the Small profile by name.",
        },
      },
    },
    reviewTask("review", ["api"]),
  ]);
  const api = latestAttempt(symphony, "api");
  assert.ok(api);

  // Loop 1: api completes and the review finds F1.
  await f.report(plan.id, "api");
  f.active.set(api.agentId, false);
  await f.reconcile();
  const review1 = latestAttempt(await f.read(plan.id), "review");
  assert.ok(review1);
  await f.send(review1.agentId, {
    kind: "report",
    symphonyId: plan.id,
    attemptId: review1.id,
    report: needsChangesReport(),
  });
  f.active.set(review1.agentId, false);
  await f.reconcile();

  // Loop 2 takes api over onto Big with no override.
  await f.send(plan.source.agentId, {
    kind: "loop",
    symphonyId: plan.id,
    reason: "Move api to Big",
    reopen: [
      {
        taskId: "api",
        findings: ["review#F1"],
        profile: "big",
        routing: { reason: "Big has capacity for this now." },
      },
    ],
  });
  symphony = await f.read(plan.id);
  const api2 = latestAttempt(symphony, "api");
  assert.ok(api2);
  assert.notEqual(api2.agentId, api.agentId);
  assert.equal(
    api2.launch?.routing?.override,
    undefined,
    "the takeover records no override",
  );

  // Loop 2 ends needs-changes again.
  await f.report(plan.id, "api");
  f.active.set(api2.agentId, false);
  await f.reconcile();
  const review2 = latestAttempt(await f.read(plan.id), "review");
  assert.ok(review2);
  await f.send(review2.agentId, {
    kind: "report",
    symphonyId: plan.id,
    attemptId: review2.id,
    report: needsChangesReport(),
  });
  f.active.set(review2.agentId, false);
  await f.reconcile();

  // Strict flip, then loop 3 without a worker override must not fall back to
  // the task's older Small user-choice override.
  f.setRouting({ ...warnConfig, mode: "strict" });
  await f.send(plan.source.agentId, {
    kind: "loop",
    symphonyId: plan.id,
    reason: "Fix F1 again",
    reopen: [{ taskId: "api", findings: ["review#F1"] }],
  });
  symphony = await f.read(plan.id);
  assert.equal(
    latestAttempt(symphony, "api")?.id,
    api2.id,
    "no bypass launch was created",
  );
  assert.equal(
    latestAttempt(symphony, "api")?.launch?.routing?.override,
    undefined,
  );
  assert.match(symphony.execution.interruption ?? "", /larger than eligible/);
});

void test("an undeliverable takeover agent keeps a valid previous override", async () => {
  const strictConfig: FixtureRouting = {
    version: 1,
    mode: "strict",
    profiles: {
      small: {
        roles: ["implementation", "review"],
        size: "small",
      },
      big: {
        roles: ["implementation"],
        size: "medium",
      },
    },
  };
  const profiles: WorkerProfile[] = [
    { id: "small", name: "Small", notes: "", provider: "fake" },
    { id: "big", name: "Big", notes: "", provider: "fake" },
  ];
  const f = await fixture({ routing: strictConfig, profiles });
  const plan = await f.start("undeliverable-override");
  assert.ok(plan.source.agentId);
  let symphony = await f.define(plan, [
    {
      ...task("api", [], ["src/api"]),
      profile: "small",
      routing: { reason: "Smallest eligible backend worker." },
    },
    {
      ...reviewTask("review", ["api"]),
      routing: { reason: "Independent review of the change." },
    },
  ]);
  const api = latestAttempt(symphony, "api");
  assert.ok(api);
  await f.report(plan.id, "api");
  f.active.set(api.agentId, false);
  await f.reconcile();
  const review1 = latestAttempt(await f.read(plan.id), "review");
  assert.ok(review1);
  await f.send(review1.agentId, {
    kind: "report",
    symphonyId: plan.id,
    attemptId: review1.id,
    report: needsChangesReport(),
  });
  f.active.set(review1.agentId, false);
  await f.reconcile();

  // Loop 2 takes api over onto Big with a valid user-choice override.
  await f.send(plan.source.agentId, {
    kind: "loop",
    symphonyId: plan.id,
    reason: "Move api to Big",
    reopen: [
      {
        taskId: "api",
        findings: ["review#F1"],
        profile: "big",
        routing: {
          reason: "The user named Big for this takeover.",
          override: {
            category: "user-choice",
            evidence: "The user asked for the Big profile by name.",
          },
        },
      },
    ],
  });
  symphony = await f.read(plan.id);
  const api2 = latestAttempt(symphony, "api");
  assert.ok(api2);
  assert.equal(api2.launch?.routing?.override?.category, "user-choice");

  // The Big agent can no longer receive a wake.
  f.undeliverable.add(api2.agentId);
  await f.report(plan.id, "api", "needs-changes", {
    findings: [blockingFinding],
  });
  f.active.set(api2.agentId, false);
  await f.reconcile();
  const review2 = latestAttempt(await f.read(plan.id), "review");
  assert.ok(review2);
  await f.send(review2.agentId, {
    kind: "report",
    symphonyId: plan.id,
    attemptId: review2.id,
    report: needsChangesReport(),
  });
  f.active.set(review2.agentId, false);
  await f.reconcile();

  // Loop 3 without a worker override must carry Big's valid override to the
  // fresh agent instead of falling back to the task's older routing.
  await f.send(plan.source.agentId, {
    kind: "loop",
    symphonyId: plan.id,
    reason: "Fix F1 again",
    reopen: [{ taskId: "api", findings: ["review#F1"] }],
  });
  symphony = await f.read(plan.id);
  const api3 = latestAttempt(symphony, "api");
  assert.ok(api3);
  assert.notEqual(api3.id, api2.id, "a fresh attempt takes over");
  assert.notEqual(api3.agentId, api2.agentId);
  assert.equal(api3.launch?.routing?.override?.category, "user-choice");
  assert.match(api3.launch?.catalogRevision ?? "", /^[a-f0-9]{64}$/);
});

void test("a profile's instructions reach the first launch and the name is snapshotted", async () => {
  const f = await fixture({
    routing: {
      profiles: {
        small: {
          roles: ["implementation"],
          size: "small",
        },
      },
    },
    profiles: [
      {
        id: "small",
        name: "Small",
        notes: "",
        provider: "fake",
        instructions: "Use the frontend-design skill for UI changes.",
      },
    ],
  });
  const plan = await f.start("profile-instructions");
  assert.ok(plan.source.agentId);
  const symphony = await f.define(plan, [
    { ...routedTask("api"), profile: "small" },
  ]);
  const api = latestAttempt(symphony, "api");
  assert.ok(api);
  const launch = f.launches.get(api.agentId);
  assert.ok(launch);
  assert.match(launch.prompt, /--- Profile instructions \(additional guidance/);
  assert.match(launch.prompt, /Use the frontend-design skill for UI changes\./);
  assert.match(launch.prompt, /--- End profile instructions ---/);
  assert.equal(api.launch?.profileName, "Small");
});

void test("launchChoice prefers the persisted profile id over the original reference", () => {
  const profileId = "11111111-1111-4111-8111-111111111111";
  const launch: NonNullable<Attempt["launch"]> = {
    state: "pending",
    profile: "Old name",
    profileId,
    profileName: "Old name",
    generation: 0,
    prompt: "Carry out the task",
    settled: false,
  };
  assert.deepEqual(launchChoice(launch), { profile: profileId });
  // A record stored before profileId falls back to its reference.
  assert.deepEqual(launchChoice({ ...launch, profileId: undefined }), {
    profile: "Old name",
  });
  // "inherit" is never sent as a profile reference.
  assert.deepEqual(
    launchChoice({ ...launch, profile: "inherit", profileId: undefined }),
    {},
  );
});

void test("define snapshots the resolved profile name on the task worker", async () => {
  const profileId = "11111111-1111-4111-8111-111111111111";
  const f = await fixture({
    routing: {
      profiles: {
        [profileId]: { roles: ["implementation"], size: "small" },
      },
    },
    profiles: [{ id: profileId, name: "Named", notes: "", provider: "fake" }],
  });
  const plan = await f.start("define-name-snapshot");
  assert.ok(plan.source.agentId);
  await f.send(plan.source.agentId, {
    kind: "define",
    symphonyId: plan.id,
    tasks: [routedTask("api")],
  });
  const definition = (await f.read(plan.id)).revisions.at(-1)?.score.tasks[0];
  assert.equal(definition?.worker.profile, profileId);
  assert.equal(definition?.worker.profileName, "Named");
});

void test("a same-agent continuation snapshots the profile name and id", async () => {
  const profileId = "11111111-1111-4111-8111-111111111111";
  const f = await fixture({
    routing: {
      profiles: {
        [profileId]: { roles: ["implementation"], size: "small" },
      },
    },
    profiles: [
      { id: profileId, name: "Original profile", notes: "", provider: "fake" },
    ],
  });
  const plan = await f.start("continuation-snapshot");
  assert.ok(plan.source.agentId);
  const symphony = await f.define(plan, [
    { ...routedTask("api"), profile: profileId },
  ]);
  const first = latestAttempt(symphony, "api");
  assert.ok(first);
  assert.equal(first.launch?.profileName, "Original profile");
  assert.equal(first.launch?.profileId, profileId);

  await f.report(plan.id, "api", "failed", {
    diagnosis: {
      tried: ["Ran the required check"],
      suspectedCause: "A transient fixture failure",
      need: "none",
    },
  });
  f.active.set(first.agentId, false);
  await f.reconcile();
  // Rename the profile before the retry: the continuation keeps the snapshot
  // its agent was actually launched with, so History still renders it.
  f.setProfiles([
    { id: profileId, name: "Renamed profile", notes: "", provider: "fake" },
  ]);
  await f.send(plan.source.agentId, {
    kind: "dispatch",
    symphonyId: plan.id,
    retryTaskId: "api",
  });
  const continuation = latestAttempt(await f.read(plan.id), "api");
  assert.ok(continuation);
  assert.equal(continuation.agentId, first.agentId, "the same agent continues");
  assert.equal(continuation.launch?.profileName, "Original profile");
  assert.equal(continuation.launch?.profileId, profileId);
});

void test("a same-agent continuation keeps the resolved worker across a profile edit", async () => {
  const profileId = "44444444-4444-4444-8444-444444444444";
  const f = await fixture({
    routing: {
      profiles: {
        [profileId]: { roles: ["implementation"], size: "small" },
      },
    },
    profiles: [
      {
        id: profileId,
        name: "Original profile",
        notes: "",
        provider: "claude",
        model: "opus",
        thinkingOptionId: "medium",
      },
    ],
  });
  const plan = await f.start("continuation-resolved");
  assert.ok(plan.source.agentId);
  const symphony = await f.define(plan, [
    { ...routedTask("api"), profile: profileId },
  ]);
  const first = latestAttempt(symphony, "api");
  assert.ok(first);
  assert.deepEqual(first.launch?.resolved, {
    provider: "claude",
    model: "opus",
    thinkingOptionId: "medium",
  });

  await f.report(plan.id, "api", "failed", {
    diagnosis: {
      tried: ["Ran the required check"],
      suspectedCause: "A transient fixture failure",
      need: "none",
    },
  });
  f.active.set(first.agentId, false);
  await f.reconcile();
  // Edit the profile after the agent launched: the same agent keeps the
  // provider/model/thinking it was launched with, so the continuation must
  // keep the original snapshot rather than adopt the edited profile.
  f.setProfiles([
    {
      id: profileId,
      name: "Original profile",
      notes: "",
      provider: "pi",
      model: "pi-other",
      thinkingOptionId: "high",
    },
  ]);
  await f.send(plan.source.agentId, {
    kind: "dispatch",
    symphonyId: plan.id,
    retryTaskId: "api",
  });
  const continuation = latestAttempt(await f.read(plan.id), "api");
  assert.ok(continuation);
  assert.equal(continuation.agentId, first.agentId, "the same agent continues");
  assert.deepEqual(continuation.launch?.resolved, {
    provider: "claude",
    model: "opus",
    thinkingOptionId: "medium",
  });
});

void test("a pending name-selected launch resumes by the persisted profile id across a rename", async () => {
  const profileId = "11111111-1111-4111-8111-111111111111";
  const decoyId = "22222222-2222-4222-8222-222222222222";
  const f = await fixture({
    routing: {
      profiles: {
        [profileId]: { roles: ["implementation"], size: "small" },
      },
    },
    profiles: [{ id: profileId, name: "Named", notes: "", provider: "fake" }],
  });
  const plan = await f.start("pending-rename");
  assert.ok(plan.source.agentId);
  const symphony = await f.define(plan, [
    { ...routedTask("api"), profile: "Named" },
  ]);
  const first = latestAttempt(symphony, "api");
  assert.ok(first);
  assert.equal(first.launch?.profileId, profileId);

  // Rename the original and let a decoy adopt the old name.
  f.setProfiles([
    { id: profileId, name: "Renamed", notes: "", provider: "fake" },
    { id: decoyId, name: "Named", notes: "", provider: "fake" },
  ]);
  // Restart with the attempt still pending.
  const current = await f.read(plan.id);
  await f.store.update(plan.id, current.version, (value) => {
    const attempt = value.execution.attempts.find(
      (entry) => entry.id === first.id,
    );
    if (attempt?.launch) {
      attempt.launch.state = "pending";
      attempt.launch.settled = false;
    }
    return value;
  });
  f.reload();
  await f.reconcile();

  assert.equal(f.launches.get(first.agentId)?.profile, profileId);
});

void test("a loop reopen override snapshots the replacement profile name", async () => {
  const f = await fixture({
    routing: {
      profiles: {
        small: {
          roles: ["implementation", "review"],
          size: "small",
        },
        big: {
          roles: ["implementation"],
          size: "medium",
        },
      },
    },
    profiles: [
      { id: "small", name: "Small", notes: "", provider: "fake" },
      { id: "big", name: "Big", notes: "", provider: "fake" },
    ],
  });
  const plan = await f.start("reopen-name-snapshot");
  assert.ok(plan.source.agentId);
  const symphony = await f.define(plan, [
    { ...task("api", [], ["src/api"]), profile: "small" },
    reviewTask("review", ["api"]),
  ]);
  const api = latestAttempt(symphony, "api");
  assert.ok(api);
  await f.report(plan.id, "api");
  f.active.set(api.agentId, false);
  await f.reconcile();
  const review1 = latestAttempt(await f.read(plan.id), "review");
  assert.ok(review1);
  await f.send(review1.agentId, {
    kind: "report",
    symphonyId: plan.id,
    attemptId: review1.id,
    report: needsChangesReport(),
  });
  f.active.set(review1.agentId, false);
  await f.reconcile();

  await f.send(plan.source.agentId, {
    kind: "loop",
    symphonyId: plan.id,
    reason: "Fix F1 with the larger worker",
    reopen: [
      {
        taskId: "api",
        findings: ["review#F1"],
        profile: "big",
        routing: { reason: "Escalate to the larger backend worker." },
      },
    ],
  });
  const loop = (await f.read(plan.id)).execution.conducting?.loops?.at(-1);
  assert.ok(loop);
  assert.equal(loop.reopened[0]?.worker?.profile, "big");
  assert.equal(loop.reopened[0]?.worker?.profileName, "Big");
});

void test("a strict retry preflight validates the persisted profile id after a rename", async () => {
  const originalId = "11111111-1111-4111-8111-111111111111";
  const decoyId = "22222222-2222-4222-8222-222222222222";
  const f = await fixture({
    routing: {
      version: 1,
      mode: "strict",
      profiles: {
        [originalId]: {
          roles: ["implementation"],
          size: "small",
        },
        [decoyId]: {
          roles: ["implementation"],
          size: "medium",
        },
      },
    },
    profiles: [
      { id: originalId, name: "Original name", notes: "", provider: "fake" },
      { id: decoyId, name: "Decoy", notes: "", provider: "fake" },
    ],
  });
  const plan = await f.start("strict-retry-identity");
  assert.ok(plan.source.agentId);
  const symphony = await f.define(plan, [
    {
      ...routedTask("api"),
      profile: "Original name",
      routing: { reason: "Chosen by name." },
    },
  ]);
  const first = latestAttempt(symphony, "api");
  assert.ok(first);
  assert.equal(first.launch?.profileId, originalId);

  await f.report(plan.id, "api", "failed", {
    diagnosis: {
      tried: ["Ran the required check"],
      suspectedCause: "A transient fixture failure",
      need: "none",
    },
  });
  f.active.set(first.agentId, false);
  await f.reconcile();

  // Rename the original and let the decoy take the old name. The stored task
  // still references the old name, but the persisted UUID must win.
  f.setProfiles([
    { id: originalId, name: "Renamed", notes: "", provider: "fake" },
    { id: decoyId, name: "Original name", notes: "", provider: "fake" },
  ]);
  await f.send(plan.source.agentId, {
    kind: "dispatch",
    symphonyId: plan.id,
    retryTaskId: "api",
  });
  const retried = latestAttempt(await f.read(plan.id), "api");
  assert.ok(retried);
  assert.notEqual(retried.id, first.id, "a retry attempt was created");
  assert.equal(retried.agentId, first.agentId, "the same agent continues");
  assert.equal(retried.launch?.profileId, originalId);
  assert.equal(retried.launch?.profileName, "Original name");
});

void test("reconcile records sessions and settlement schedules usage collection", async () => {
  const f = await fixture();
  const observed: string[] = [];
  const collected: string[] = [];
  f.setMetrics(() => ({
    async observe(_symphonyId, attemptId) {
      observed.push(attemptId);
    },
    collect(_symphonyId, attemptId) {
      collected.push(attemptId);
    },
    async close() {},
  }));
  const plan = await f.start("metrics");
  const symphony = await f.define(plan, [task("a")]);
  const a = latestAttempt(symphony, "a");
  assert.ok(a, "the task agent starts without a session snapshot");
  await f.reconcile();
  assert.ok(
    observed.includes(a.id),
    "reconciliation observes the agent snapshot for a session",
  );
  // The first stop nudges; the second settles the attempt as a server failure.
  f.active.set(a.agentId, false);
  await f.reconcile();
  assert.equal(collected.includes(a.id), false);
  f.active.set(a.agentId, false);
  await f.reconcile();
  const failed = latestAttempt(await f.read(plan.id), "a");
  assert.equal(failed?.state, "failed");
  assert.ok(
    collected.includes(a.id),
    "settlement schedules collection for the settled attempt",
  );
});

void test("a worker block resumes with its interval closed", async () => {
  const f = await fixture();
  const plan = await f.start("block-interval");
  const symphony = await f.define(plan, [task("a")]);
  const a = latestAttempt(symphony, "a");
  assert.ok(a && plan.source.agentId);
  await f.send(a.agentId, {
    kind: "block",
    symphonyId: plan.id,
    attemptId: a.id,
    message: "Need a decision before continuing",
  });
  const blocked = latestAttempt(await f.read(plan.id), "a");
  assert.equal(blocked?.state, "blocked");
  assert.equal(blocked?.blocked?.length, 1);
  assert.equal(blocked?.blocked?.[0]?.to, null);
  f.active.set(a.agentId, false);
  await f.reconcile();
  await f.send(plan.source.agentId, {
    kind: "dispatch",
    symphonyId: plan.id,
    retryTaskId: "a",
  });
  const resumed = latestAttempt(await f.read(plan.id), "a");
  assert.equal(resumed?.id, a.id);
  assert.equal(resumed?.state, "running");
  assert.equal(resumed?.endedAt, null);
  assert.ok(
    (resumed?.blocked?.[0]?.to ?? 0) >= (resumed?.blocked?.[0]?.from ?? 0),
  );
});

void test("a settled failure closes blocked time and reopening leaves it closed", async () => {
  const f = await fixture();
  const plan = await f.start("reopen-interval");
  assert.ok(plan.source.agentId);
  f.loseAck();
  let symphony = await f.define(plan, [task("a")]);
  const a = latestAttempt(symphony, "a");
  assert.ok(a);
  assert.equal(a.launch?.state, "uncertain");
  // Model an attempt that was blocked before its unconfirmed launch settled.
  symphony = await f.store.update(symphony.id, symphony.version, (current) => {
    const active = latestAttempt(current, "a");
    assert.ok(active);
    active.blocked = [{ from: active.startedAt, to: null }];
    return current;
  });
  f.workers.launchCheckDelaysMs = [];
  f.workers.inspect = async () => ({
    exists: false,
    active: false,
    deliverable: false,
  });
  await f.reconcile();
  await f.reconcile();
  const settled = latestAttempt(await f.read(plan.id), "a");
  assert.equal(settled?.state, "failed");
  assert.equal(settled?.blocked?.length, 1);
  assert.ok(
    (settled?.blocked?.[0]?.to ?? 0) >= (settled?.blocked?.[0]?.from ?? 0),
  );
  // A collection that finished before the reopen must not survive into the
  // next settlement window.
  const withUsage = await f.read(plan.id);
  await f.store.update(withUsage.id, withUsage.version, (current) => {
    const failed = latestAttempt(current, "a");
    assert.ok(failed);
    failed.usage = { input: 12, collectedAt: 1 };
    return current;
  });
  // The delayed agent appeared; retrying replays the same identity and reopens
  // the server failure without leaving an open interval across the gap.
  f.workers.inspect = async (id) => ({
    exists: f.launches.has(id),
    active: f.active.get(id) ?? false,
    deliverable: f.launches.has(id),
  });
  f.active.set(a.agentId, false);
  await f.send(plan.source.agentId, {
    kind: "dispatch",
    symphonyId: plan.id,
    retryTaskId: "a",
  });
  const reopened = latestAttempt(await f.read(plan.id), "a");
  assert.equal(reopened?.id, a.id);
  assert.equal(reopened?.state, "running");
  assert.equal(reopened?.endedAt, null);
  assert.equal(reopened?.usage, undefined);
  assert.deepEqual(
    reopened?.blocked?.map((interval) => interval.to === null),
    [false],
  );
});

void test("a blocked rebind closes the old session and records the new one", async () => {
  const f = await fixture();
  let firstAgent = "";
  const metrics = symphonyMetrics(f.store, {
    now: () => Date.now(),
    setTimer: () => 0,
    clearTimer: () => {},
    async sessionOf(agentId) {
      return agentId === firstAgent
        ? { provider: "codex", id: "session-old" }
        : { provider: "pi", id: `session-${agentId}` };
    },
    readerFor: () => undefined,
  });
  f.setMetrics(() => metrics);
  const plan = await f.start("segments");
  const symphony = await f.define(plan, [task("a", [], ["src"])]);
  const a = latestAttempt(symphony, "a");
  assert.ok(a && plan.source.agentId);
  firstAgent = a.agentId;
  await f.reconcile();
  const observed = latestAttempt(await f.read(plan.id), "a");
  assert.deepEqual(observed?.sessions, [
    {
      provider: "codex",
      id: "session-old",
      from: a.startedAt,
      to: null,
    },
  ]);
  await f.send(a.agentId, {
    kind: "block",
    symphonyId: plan.id,
    attemptId: a.id,
    message: "Need a different provider for this decision",
  });
  f.active.set(a.agentId, false);
  await f.reconcile();
  await f.send(plan.source.agentId, {
    kind: "dispatch",
    symphonyId: plan.id,
    retryTaskId: "a",
    provider: "pi",
  });
  const rebound = latestAttempt(await f.read(plan.id), "a");
  assert.ok(rebound);
  assert.notEqual(rebound.agentId, a.agentId);
  assert.equal(rebound.sessions?.length, 1);
  const closed = rebound.sessions?.[0];
  assert.ok(closed?.to !== null);
  await f.reconcile();
  const after = latestAttempt(await f.read(plan.id), "a");
  assert.deepEqual(after?.sessions, [
    closed,
    {
      provider: "pi",
      id: `session-${rebound.agentId}`,
      from: closed?.to,
      to: null,
    },
  ]);
  await metrics.close();
});

void test("a usage collection cannot reject a report waiting on its fingerprint", async () => {
  const f = await fixture();
  const scheduled: Array<() => void> = [];
  let markRead: () => void = () => {};
  const readStarted = new Promise<void>((resolve) => {
    markRead = resolve;
  });
  const metrics = symphonyMetrics(f.store, {
    now: () => Date.now(),
    setTimer: (callback) => {
      scheduled.push(callback);
      return scheduled.length;
    },
    clearTimer: () => {},
    async sessionOf(agentId) {
      return { provider: "codex", id: `session-${agentId}` };
    },
    readerFor: () => ({
      provider: "codex",
      async read() {
        markRead();
        return { input: 1 };
      },
    }),
    collectDelayMs: 0,
    retryDelaysMs: [],
  });
  f.setMetrics(() => metrics);
  f.setFingerprint(async () => ({ paths: [] }));
  const plan = await f.start("collection-race");
  const symphony = await f.define(plan, [task("a"), task("b")]);
  assert.ok(plan.source.agentId);
  await f.reconcile();
  const b = latestAttempt(symphony, "b");
  assert.ok(b);
  await f.report(plan.id, "b");
  assert.equal(scheduled.length, 1, "the settled attempt scheduled a read");

  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let markFingerprint: () => void = () => {};
  const fingerprintStarted = new Promise<void>((resolve) => {
    markFingerprint = resolve;
  });
  f.setFingerprint(async () => {
    markFingerprint();
    await gate;
    return { paths: [] };
  });
  const reportPromise = f.report(plan.id, "a");
  await fingerprintStarted;
  // Start the collection while the report holds the command queue.
  const timer = scheduled.shift();
  assert.ok(timer);
  timer();
  await readStarted;
  release();
  await reportPromise;
  const reported = latestAttempt(await f.read(plan.id), "a");
  assert.equal(reported?.state, "completed");

  let settled = latestAttempt(await f.read(plan.id), "b");
  for (let tries = 0; tries < 100 && !settled?.usage; tries += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    settled = latestAttempt(await f.read(plan.id), "b");
  }
  assert.equal(settled?.usage?.input, 1);
  await metrics.close();
});

void test("a late worker report clears usage from the server settlement window", async () => {
  const f = await fixture();
  const plan = await f.start("late-usage-reset");
  const symphony = await f.define(plan, [task("a")]);
  const a = latestAttempt(symphony, "a");
  assert.ok(a);
  f.active.set(a.agentId, false);
  await f.reconcile();
  f.active.set(a.agentId, false);
  await f.reconcile();
  const failed = latestAttempt(await f.read(plan.id), "a");
  assert.equal(failed?.reportedBy, "server");
  const before = await f.read(plan.id);
  await f.store.update(before.id, before.version, (current) => {
    const active = latestAttempt(current, "a");
    assert.ok(active);
    active.usage = { input: 99, collectedAt: 1 };
    return current;
  });
  await f.report(plan.id, "a");
  const completed = latestAttempt(await f.read(plan.id), "a");
  assert.equal(completed?.state, "completed");
  assert.equal(completed?.usage, undefined);
});
