import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  contentHash,
  fileSymphonyStore,
  type SymphonyStore,
} from "../server/symphonies/store";
import { validateSymphonyScopes } from "../server/symphonies/placement";
import { SymphonyError } from "../server/symphonies/errors";
import {
  SYMPHONY_LIMITS,
  attemptNumber,
  type Attempt,
  type StoredSymphony,
} from "../shared/symphonies/models";
import { effectiveTask } from "../shared/symphonies/score";
import {
  score,
  placement,
  planContext,
  fixtureSymphonyId,
  task,
} from "./symphony-fixtures";
import { testDirectory } from "./fixtures";

/** A store-valid ready symphony whose context digest matches `planContext`. */
function plannedSymphony(id = randomUUID()): StoredSymphony {
  return {
    schemaVersion: 1,
    id,
    version: 0,
    title: "Investigate pagination",
    source: placement,
    contextHash: contentHash(JSON.stringify(planContext)),
    requestHash: contentHash(JSON.stringify(id)),
    createdAt: 1791201600000,
    updatedAt: 1791201600000,
    status: "ready",
    execution: {
      origin: "tracked",
      attempts: [],
      summary: null,
      finishedAt: null,
      interruption: null,
    },
    revisions: [
      {
        number: 1,
        parent: null,
        reason: "Source agent recorded the requested work",
        acceptedAt: 1791201600000,
        score: score(),
      },
    ],
  };
}

void test("durable creates, conditional edits, and lost-create acknowledgement", async () => {
  const directory = await testDirectory();
  const store = fileSymphonyStore(directory);
  const symphony = plannedSymphony();
  await store.create(symphony, planContext);
  assert.deepEqual(
    (await fileSymphonyStore(directory).read(symphony.id)).context,
    planContext,
  );
  assert.equal((await store.create(symphony, planContext)).id, symphony.id);
  assert.equal((await store.list()).symphonies.length, 1);
  await assert.rejects(
    store.create(
      {
        ...symphony,
        title: "Changed request",
        requestHash: contentHash("other"),
      },
      planContext,
    ),
    /belongs to another/,
  );
  await assert.rejects(
    store.update(symphony.id, 1, (value) => value),
    /elsewhere/,
  );
  await assert.rejects(
    store.update(symphony.id, 0, (current) => ({ ...current, revisions: [] })),
    /cannot be rewritten/,
  );
  assert.equal((await store.read(symphony.id)).symphony.version, 0);
});

void test("two independent store instances cannot both commit the same version", async () => {
  const directory = await testDirectory();
  const first = fileSymphonyStore(directory);
  const second = fileSymphonyStore(directory);
  const symphony = plannedSymphony();
  await first.create(symphony, planContext);
  const results = await Promise.allSettled([
    first.update(symphony.id, 0, (current) => ({
      ...current,
      updatedAt: Date.now(),
      title: "First revision",
    })),
    second.update(symphony.id, 0, (current) => ({
      ...current,
      updatedAt: Date.now(),
      title: "First revision",
    })),
  ]);
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal(
    (await fileSymphonyStore(directory).read(symphony.id)).symphony.version,
    1,
  );
});

void test("orphan write locks fence mutations while reads and native metadata remain accessible", async () => {
  const directory = await testDirectory();
  const store = fileSymphonyStore(directory);
  const symphony = plannedSymphony();
  await store.create(symphony, planContext);
  await mkdir(join(directory, "symphony-write-lock"));
  await assert.rejects(
    store.update(symphony.id, 0, (current) => ({
      ...current,
      title: "Changed",
    })),
    /locked/,
  );
  assert.equal((await store.read(symphony.id)).symphony.version, 0);
  assert.equal((await store.list()).symphonies.length, 1);
});

void test("corrupt, oversized, missing-context and symlink records are isolated", async () => {
  const directory = await testDirectory();
  const store = fileSymphonyStore(directory);
  const healthy = plannedSymphony();
  await store.create(healthy, planContext);
  await writeFile(
    join(directory, "symphonies", `${randomUUID()}.json`),
    "{incomplete",
  );
  await writeFile(
    join(directory, "symphonies", `${randomUUID()}.json`),
    "x".repeat(SYMPHONY_LIMITS.snapshotBytes + 1),
  );
  await symlink(
    join(directory, "symphonies", `${healthy.id}.json`),
    join(directory, "symphonies", `${fixtureSymphonyId}.json`),
  );
  const missingContext = {
    ...healthy,
    id: randomUUID(),
    contextHash: "c".repeat(64),
  };
  await writeFile(
    join(directory, "symphonies", `${missingContext.id}.json`),
    JSON.stringify(missingContext),
  );
  const list = await store.list();
  assert.equal(list.symphonies.length, 1);
  assert.equal(list.unavailable, 4);
  await assert.rejects(store.read(missingContext.id));
  const artifact = join(directory, "artifacts", `${healthy.contextHash}.json`);
  await writeFile(
    artifact,
    JSON.stringify({ ...planContext, plan: "Tampered" }),
  );
  await assert.rejects(store.read(healthy.id), /integrity/);
});

void test("failed changes leave the previous version intact and release the lock", async () => {
  const directory = await testDirectory();
  const store = fileSymphonyStore(directory);
  const symphony = plannedSymphony();
  await store.create(symphony, planContext);
  const before = await readFile(
    join(directory, "symphonies", `${symphony.id}.json`),
    "utf8",
  );
  await assert.rejects(
    store.update(symphony.id, 0, async () => {
      throw new Error("Concert moved");
    }),
    /moved/,
  );
  assert.equal(
    await readFile(
      join(directory, "symphonies", `${symphony.id}.json`),
      "utf8",
    ),
    before,
  );
  assert.equal(
    (
      await store.update(symphony.id, 0, (current) => ({
        ...current,
        title: "Revised title",
      }))
    ).version,
    1,
  );
});

void test("scope admission rejects symlink parents and permits new descendants inside the checkout", async () => {
  const directory = await testDirectory();
  const outside = await testDirectory();
  await symlink(outside, join(directory, "linked"));
  await assert.rejects(
    validateSymphonyScopes(directory, {
      tasks: [task("a", { reads: ["linked/new-file"] })],
    }),
    /symbolic/,
  );
  await validateSymphonyScopes(directory, {
    tasks: [task("a", { reads: ["src/new-file"] })],
  });
});

void test("symphony bounds refuse new records without pruning earlier data", async () => {
  const directory = await testDirectory();
  const store = fileSymphonyStore(directory);
  await store.create(plannedSymphony(), planContext);
  for (let index = 1; index < SYMPHONY_LIMITS.symphonies; index++) {
    await writeFile(
      join(directory, "symphonies", `${randomUUID()}.json`),
      "corrupt",
    );
  }
  await assert.rejects(store.create(plannedSymphony(), planContext), /full/);
});

void test(
  "a crashed process leaves ownership fenced and the previous snapshot readable",
  { timeout: 15000 },
  async (t) => {
    const directory = await testDirectory();
    const store = fileSymphonyStore(directory);
    const symphony = plannedSymphony();
    await store.create(symphony, planContext);
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `
    import { fileSymphonyStore } from './server/symphonies/store.ts';
    await fileSymphonyStore(process.argv[1]).update(process.argv[2], 0, async (symphony) => {
      process.stdout.write('locked');
      await new Promise((resolve) => process.stdin.once('data', resolve));
      return symphony;
    });
  `,
        directory,
        symphony.id,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    t.after(() => {
      child.kill("SIGKILL");
    });
    await once(child.stdout, "data");
    const change = () =>
      store.update(symphony.id, 0, (current) => ({
        ...current,
        title: "Changed",
      }));
    await assert.rejects(change(), /locked/);
    const exit = once(child, "exit");
    child.kill("SIGKILL");
    await exit;
    await assert.rejects(change(), /locked/);
    assert.equal(
      (await fileSymphonyStore(directory).read(symphony.id)).symphony.version,
      0,
    );
  },
);

void test("a repeated create cannot overwrite a damaged existing symphony", async () => {
  const directory = await testDirectory();
  const store = fileSymphonyStore(directory);
  const symphony = plannedSymphony();
  await store.create(symphony, planContext);
  await unlink(join(directory, "artifacts", `${symphony.contextHash}.json`));
  const before = await readFile(
    join(directory, "symphonies", `${symphony.id}.json`),
    "utf8",
  );
  await assert.rejects(store.create(symphony, planContext));
  assert.equal(
    await readFile(
      join(directory, "symphonies", `${symphony.id}.json`),
      "utf8",
    ),
    before,
  );
});

// === Explicit symphony deletion ===

const executionStart = 1791201600000;
const executionContextHash = contentHash(JSON.stringify(planContext));

function completedReport(taskId: string) {
  return {
    outcome: "completed" as const,
    summary: `Completed ${taskId}.`,
    evidence: ["Observed the documented behavior."],
    checks: [],
  };
}

function attemptBase(taskId: string): Omit<Attempt, "state"> {
  return {
    id: randomUUID(),
    taskId,
    agentId: `worker-${taskId}`,
    startedAt: executionStart,
    endedAt: executionStart + 60_000,
    message: null,
    report: null,
    reportHash: null,
  };
}

function settledAttempt(taskId: string): Attempt {
  const report = completedReport(taskId);
  return {
    ...attemptBase(taskId),
    state: "completed",
    report,
    reportHash: contentHash(JSON.stringify(report)),
    launch: {
      state: "started",
      profile: "inherit",
      generation: 0,
      prompt: "Carry out the task",
      settled: true,
    },
  };
}

function runningAttempt(taskId: string): Attempt {
  return {
    ...attemptBase(taskId),
    state: "running",
    endedAt: null,
    launch: {
      state: "started",
      profile: "inherit",
      generation: 0,
      prompt: "Carry out the task",
      settled: true,
    },
  };
}

function blockedAttempt(taskId: string): Attempt {
  return {
    ...runningAttempt(taskId),
    state: "blocked",
    message: "Confirm the compatibility requirement with the source agent.",
  };
}

function failedUnsettledAttempt(taskId: string): Attempt {
  const report = {
    outcome: "failed" as const,
    summary: "The task failed.",
    evidence: ["Recorded the failure detail."],
    checks: [],
  };
  return {
    ...attemptBase(taskId),
    state: "failed",
    report,
    reportHash: contentHash(JSON.stringify(report)),
    launch: {
      state: "uncertain",
      profile: "inherit",
      generation: 0,
      prompt: "Carry out the task",
      settled: false,
    },
  };
}

function executionSymphony(
  id: string,
  status: StoredSymphony["status"],
  attempts: Attempt[],
): StoredSymphony {
  return {
    schemaVersion: 1,
    id,
    version: 0,
    title: "Finished symphony",
    source: placement,
    contextHash: executionContextHash,
    requestHash: contentHash(JSON.stringify(id)),
    createdAt: executionStart,
    updatedAt: executionStart,
    status,
    execution: {
      origin: "conducted",
      conducting: {
        phase: "working",
        concurrency: 2,
        requestedBy: null,
        conductor: "self",
        conductorLaunch: "started",
        prompt: "Carry out the shared plan",
        notification: null,
      },
      attempts,
      summary: status === "completed" ? "The symphony finished." : null,
      finishedAt: status === "completed" ? executionStart + 90_000 : null,
      interruption: null,
    },
    revisions: [
      {
        number: 1,
        parent: null,
        reason: "Accepted the shared plan",
        acceptedAt: executionStart,
        score: { tasks: [task("work")] },
      },
    ],
  };
}

async function createSymphony(
  store: SymphonyStore,
  symphony: StoredSymphony,
): Promise<void> {
  await store.create(symphony, planContext);
}

void test("deleting a finished symphony removes its snapshot and unreferenced context", async () => {
  const directory = await testDirectory();
  const store = fileSymphonyStore(directory);
  const symphony = executionSymphony(randomUUID(), "completed", [
    settledAttempt("work"),
  ]);
  await createSymphony(store, symphony);
  const artifact = join(directory, "artifacts", `${symphony.contextHash}.json`);
  assert.equal((await store.list()).symphonies.length, 1);
  await store.remove(symphony.id, symphony.version);
  assert.deepEqual((await store.list()).symphonies, []);
  await assert.rejects(store.read(symphony.id));
  await assert.rejects(readFile(artifact), /ENOENT/);
});

void test("deleting one symphony keeps context another symphony still references", async () => {
  const directory = await testDirectory();
  const store = fileSymphonyStore(directory);
  const first = executionSymphony(randomUUID(), "completed", [
    settledAttempt("work"),
  ]);
  const second = executionSymphony(randomUUID(), "completed", [
    settledAttempt("work"),
  ]);
  await createSymphony(store, first);
  await createSymphony(store, second);
  const artifact = join(directory, "artifacts", `${first.contextHash}.json`);
  await store.remove(first.id, first.version);
  assert.equal((await store.list()).symphonies.length, 1);
  assert.equal((await store.read(second.id)).symphony.id, second.id);
  assert.equal(Buffer.byteLength(await readFile(artifact, "utf8")) > 0, true);
});

void test("deleting a symphony keeps context while another record is unreadable", async () => {
  const directory = await testDirectory();
  const store = fileSymphonyStore(directory);
  const first = executionSymphony(randomUUID(), "completed", [
    settledAttempt("work"),
  ]);
  const damaged = executionSymphony(randomUUID(), "completed", [
    settledAttempt("work"),
  ]);
  await createSymphony(store, first);
  await createSymphony(store, damaged);
  await writeFile(
    join(directory, "symphonies", `${damaged.id}.json`),
    "{incomplete",
  );
  const artifact = join(directory, "artifacts", `${first.contextHash}.json`);
  await store.remove(first.id, first.version);
  assert.equal(
    await readFile(artifact, "utf8").then(
      () => true,
      () => false,
    ),
    true,
  );
  assert.equal((await store.list()).unavailable, 1);
});

void test("deletion refuses active, blocked, unsettled, and stale symphonies intact", async () => {
  const directory = await testDirectory();
  const store = fileSymphonyStore(directory);
  const running = executionSymphony(randomUUID(), "running", [
    runningAttempt("work"),
  ]);
  const blocked = executionSymphony(randomUUID(), "blocked", [
    blockedAttempt("work"),
  ]);
  const unsettled = executionSymphony(randomUUID(), "failed", [
    failedUnsettledAttempt("work"),
  ]);
  const completed = executionSymphony(randomUUID(), "completed", [
    settledAttempt("work"),
  ]);
  for (const symphony of [running, blocked, unsettled, completed]) {
    await createSymphony(store, symphony);
  }
  await assert.rejects(
    store.remove(running.id, running.version),
    SymphonyError,
  );
  await assert.rejects(
    store.remove(blocked.id, blocked.version),
    SymphonyError,
  );
  await assert.rejects(
    store.remove(unsettled.id, unsettled.version),
    SymphonyError,
  );
  await assert.rejects(
    store.remove(completed.id, completed.version + 1),
    /changed/,
  );
  assert.equal((await store.list()).symphonies.length, 4);
  for (const symphony of [running, blocked, unsettled]) {
    assert.equal((await store.read(symphony.id)).symphony.id, symphony.id);
  }
  assert.equal(
    (await store.read(completed.id)).symphony.version,
    completed.version,
  );
});

void test("deleting a missing symphony reports the documented error", async () => {
  const directory = await testDirectory();
  const store = fileSymphonyStore(directory);
  await assert.rejects(
    store.remove(randomUUID(), 0),
    /This symphony no longer exists\. Refresh the symphony list\./,
  );
});

void test("attempts and reports stored before the recovery fields remain readable", async () => {
  const directory = await testDirectory();
  const store = fileSymphonyStore(directory);
  const symphony = executionSymphony(randomUUID(), "failed", [
    failedUnsettledAttempt("work"),
  ]);
  await createSymphony(store, symphony);
  const attempt = (await store.read(symphony.id)).symphony.execution
    ?.attempts[0];
  assert.equal(attempt?.report?.diagnosis, undefined);
  assert.equal(attempt?.grantedWrites, undefined);
  assert.equal(attempt?.nudgedAt, undefined);
  assert.equal(attempt?.blockedBy, undefined);
  assert.equal(attempt?.launch?.checks, undefined);
  assert.equal(attempt?.launch?.nextCheckAt, undefined);
  // Reading does not rewrite the record with the new optional fields.
  const raw = JSON.parse(
    await readFile(
      join(directory, "symphonies", `${symphony.id}.json`),
      "utf8",
    ),
  ) as {
    execution: {
      attempts: {
        report: Record<string, unknown>;
        grantedWrites?: unknown;
        blockedBy?: unknown;
        launch?: { checks?: unknown; nextCheckAt?: unknown };
      }[];
    };
  };
  assert.equal(raw.execution.attempts[0]?.report.diagnosis, undefined);
  assert.equal(raw.execution.attempts[0]?.grantedWrites, undefined);
  assert.equal(raw.execution.attempts[0]?.blockedBy, undefined);
  assert.equal(raw.execution.attempts[0]?.launch?.checks, undefined);
  assert.equal(raw.execution.attempts[0]?.launch?.nextCheckAt, undefined);
});

void test("attempts with the recovery fields load and keep their values", async () => {
  const directory = await testDirectory();
  const store = fileSymphonyStore(directory);
  const attempt: Attempt = {
    ...blockedAttempt("work"),
    blockedBy: "worker",
    launch: {
      state: "started",
      profile: "inherit",
      generation: 0,
      prompt: "Carry out the task",
      settled: true,
      checks: 1,
      nextCheckAt: executionStart + 5_000,
    },
  };
  const symphony = executionSymphony(randomUUID(), "blocked", [attempt]);
  await createSymphony(store, symphony);
  const stored = (await store.read(symphony.id)).symphony.execution
    ?.attempts[0];
  assert.equal(stored?.blockedBy, "worker");
  assert.equal(stored?.launch?.checks, 1);
  assert.equal(stored?.launch?.nextCheckAt, executionStart + 5_000);
});

void test("an older addWrites revision and attempt additions still load and work", async () => {
  const directory = await testDirectory();
  const store = fileSymphonyStore(directory);
  const id = randomUUID();
  const planned = task("work");
  const grown = task("work", {
    writes: ["src/api"],
    worker: { role: "implementation", profile: "default" },
  });
  const base = executionSymphony(id, "blocked", [
    {
      ...blockedAttempt("work"),
      addedWrites: [
        {
          path: "src/later",
          reason: "Conductor added write scope",
          at: executionStart + 5_000,
        },
      ],
    },
  ]);
  // A record written before this change already carries a second revision from
  // addWrites; it must load and its paths must stay effective.
  const symphony: StoredSymphony = {
    ...base,
    revisions: [
      {
        number: 1,
        parent: null,
        reason: "Accepted the shared plan",
        acceptedAt: executionStart,
        score: { tasks: [planned] },
      },
      {
        number: 2,
        parent: 1,
        reason: "Conductor added write scope: src/api",
        acceptedAt: executionStart + 1_000,
        score: { tasks: [grown] },
      },
    ],
  };
  await createSymphony(store, symphony);
  const stored = (await store.read(id)).symphony;
  assert.equal(stored.revisions.length, 2);
  assert.deepEqual(stored.revisions.at(-1)?.score.tasks[0]?.writes, [
    "src/api",
  ]);
  assert.deepEqual(effectiveTask(stored, grown).writes, [
    "src/api",
    "src/later",
  ]);
  const attempt = stored.execution.attempts[0];
  assert.ok(attempt);
  assert.equal(attemptNumber(stored, attempt), 1);
});
