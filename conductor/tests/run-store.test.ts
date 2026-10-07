import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { contentHash, fileRunStore, type RunStore } from "../server/run-store";
import { legacyRunService } from "./legacy-run-service";
import {
  validateRunScopes,
  type RunPlacementRuntime,
} from "../server/run-placement";
import { RunError } from "../server/run-files";
import {
  RUN_LIMITS,
  type RunAttempt,
  type StoredRun,
} from "../shared/run-models";
import { graph, placement, planContext, runId, task } from "./run-fixtures";
import { testDirectory } from "./fixtures";

const runtime: RunPlacementRuntime = {
  capture: async (source) => ({ ...placement, ...source }),
  validate: async () => {},
};
const input = () => ({
  id: randomUUID(),
  title: "Investigate pagination",
  source: { workspaceId: "workspace-1", agentId: "agent-1" },
  context: structuredClone(planContext),
  graph: graph(),
});

void test("durable plans, conditional edits, accepted history, and lost-create acknowledgement", async () => {
  const directory = await testDirectory();
  const store = fileRunStore(directory);
  const service = legacyRunService(store, runtime);
  const request = input();
  let run = await service.prepare(request);
  assert.deepEqual(
    (await fileRunStore(directory).read(run.id)).context,
    request.context,
  );
  assert.equal((await service.prepare(request)).id, run.id);
  assert.equal((await store.list()).runs.length, 1);
  await assert.rejects(
    service.prepare({ ...request, title: "Changed request" }),
    /belongs to another/,
  );
  run = await service.change({
    id: run.id,
    expectedVersion: 0,
    command: {
      kind: "accept",
      reason: "The outcomes and boundaries are correct",
    },
  });
  const accepted = structuredClone(run.revisions[0]);
  await assert.rejects(
    service.change({
      id: run.id,
      expectedVersion: 0,
      command: { kind: "save-draft", graph: graph() },
    }),
    /changed elsewhere/,
  );
  run = await service.change({
    id: run.id,
    expectedVersion: 1,
    command: { kind: "save-draft", graph: { tasks: [task("followup")] } },
  });
  assert.deepEqual(run.revisions[0], accepted);
  assert.equal(run.status, "accepted");
  run = await service.change({
    id: run.id,
    expectedVersion: 2,
    command: { kind: "accept", reason: "Narrow the followup" },
  });
  assert.equal(run.revisions[1]?.parent, 1);
  assert.deepEqual((await fileRunStore(directory).read(run.id)).run, run);
  // A retry of the original create returns this same run, even after revisions.
  assert.equal((await service.prepare(request)).version, 3);
});

void test("two independent store instances cannot both commit the same version", async () => {
  const directory = await testDirectory();
  const first = legacyRunService(fileRunStore(directory), runtime);
  const second = legacyRunService(fileRunStore(directory), runtime);
  const run = await first.prepare(input());
  const command = {
    id: run.id,
    expectedVersion: 0,
    command: { kind: "accept" as const, reason: "Reviewed" },
  };
  const results = await Promise.allSettled([
    first.change(command),
    second.change(command),
  ]);
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal((await fileRunStore(directory).read(run.id)).run.version, 1);
});

void test("orphan write locks fence mutations while reads and native metadata remain accessible", async () => {
  const directory = await testDirectory();
  const store = fileRunStore(directory);
  const service = legacyRunService(store, runtime);
  const run = await service.prepare(input());
  await mkdir(join(directory, "run-write-lock"));
  await assert.rejects(
    service.change({
      id: run.id,
      expectedVersion: 0,
      command: { kind: "accept", reason: "Reviewed" },
    }),
    /locked/,
  );
  assert.equal((await store.read(run.id)).run.version, 0);
  assert.equal((await store.list()).runs.length, 1);
});

void test("corrupt, oversized, missing-context and symlink records are isolated", async () => {
  const directory = await testDirectory();
  const store = fileRunStore(directory);
  const service = legacyRunService(store, runtime);
  const healthy = await service.prepare(input());
  await writeFile(
    join(directory, "runs", `${randomUUID()}.json`),
    "{incomplete",
  );
  await writeFile(
    join(directory, "runs", `${randomUUID()}.json`),
    "x".repeat(RUN_LIMITS.snapshotBytes + 1),
  );
  await symlink(
    join(directory, "runs", `${healthy.id}.json`),
    join(directory, "runs", `${runId}.json`),
  );
  const missingContext = {
    ...healthy,
    id: randomUUID(),
    contextHash: "c".repeat(64),
  };
  await writeFile(
    join(directory, "runs", `${missingContext.id}.json`),
    JSON.stringify(missingContext),
  );
  const list = await store.list();
  assert.equal(list.runs.length, 1);
  assert.equal(list.unavailable, 4);
  await assert.rejects(store.read(missingContext.id));
  const artifact = join(directory, "artifacts", `${healthy.contextHash}.json`);
  await writeFile(
    artifact,
    JSON.stringify({ ...planContext, plan: "Tampered" }),
  );
  await assert.rejects(store.read(healthy.id), /integrity/);
});

void test("invalid admissions and placement failure leave the previous version intact and release the lock", async () => {
  const directory = await testDirectory();
  const store = fileRunStore(directory);
  const service = legacyRunService(store, runtime);
  const run = await service.prepare(input());
  const before = await readFile(
    join(directory, "runs", `${run.id}.json`),
    "utf8",
  );
  await assert.rejects(
    service.change({
      id: run.id,
      expectedVersion: 0,
      command: {
        kind: "save-draft",
        graph: { tasks: [task("a", { prerequisites: ["missing"] })] },
      },
    }),
    /missing/,
  );
  const unavailable = legacyRunService(store, {
    ...runtime,
    validate: async () => {
      throw new Error("Workspace moved");
    },
  });
  await assert.rejects(
    unavailable.change({
      id: run.id,
      expectedVersion: 0,
      command: { kind: "accept", reason: "Reviewed" },
    }),
    /moved/,
  );
  assert.equal(
    await readFile(join(directory, "runs", `${run.id}.json`), "utf8"),
    before,
  );
  assert.equal(
    (
      await service.change({
        id: run.id,
        expectedVersion: 0,
        command: { kind: "accept", reason: "Reviewed" },
      })
    ).version,
    1,
  );
});

void test("scope admission rejects symlink parents and permits new descendants inside the checkout", async () => {
  const directory = await testDirectory();
  const outside = await testDirectory();
  await symlink(outside, join(directory, "linked"));
  await assert.rejects(
    validateRunScopes(directory, {
      tasks: [task("a", { reads: ["linked/new-file"] })],
    }),
    /symbolic/,
  );
  await validateRunScopes(directory, {
    tasks: [task("a", { reads: ["src/new-file"] })],
  });
});

void test("run and revision bounds refuse new history without pruning earlier acceptance", async () => {
  const directory = await testDirectory();
  const store = fileRunStore(directory);
  const service = legacyRunService(store, runtime);
  let run = await service.prepare(input());
  for (let index = 0; index < RUN_LIMITS.revisions; index++) {
    if (index) {
      run = await service.change({
        id: run.id,
        expectedVersion: run.version,
        command: { kind: "save-draft", graph: graph() },
      });
    }
    run = await service.change({
      id: run.id,
      expectedVersion: run.version,
      command: { kind: "accept", reason: `Revision ${index}` },
    });
  }
  run = await service.change({
    id: run.id,
    expectedVersion: run.version,
    command: { kind: "save-draft", graph: graph() },
  });
  await assert.rejects(
    service.change({
      id: run.id,
      expectedVersion: run.version,
      command: { kind: "accept", reason: "Too many" },
    }),
    /limit/,
  );
  assert.equal(
    (await store.read(run.id)).run.revisions.length,
    RUN_LIMITS.revisions,
  );
  for (let index = 1; index < RUN_LIMITS.runs; index++) {
    await writeFile(join(directory, "runs", `${randomUUID()}.json`), "corrupt");
  }
  await assert.rejects(service.prepare(input()), /full/);
});

void test(
  "a crashed process leaves ownership fenced and the previous snapshot readable",
  { timeout: 15000 },
  async (t) => {
    const directory = await testDirectory();
    const store = fileRunStore(directory);
    const service = legacyRunService(store, runtime);
    const run = await service.prepare(input());
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `
    import { fileRunStore } from './server/run-store.ts';
    await fileRunStore(process.argv[1]).update(process.argv[2], 0, async (run) => {
      process.stdout.write('locked');
      await new Promise((resolve) => process.stdin.once('data', resolve));
      return run;
    });
  `,
        directory,
        run.id,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    t.after(() => {
      child.kill("SIGKILL");
    });
    await once(child.stdout, "data");
    const change = () =>
      service.change({
        id: run.id,
        expectedVersion: 0,
        command: { kind: "accept", reason: "Reviewed" },
      });
    await assert.rejects(change(), /locked/);
    const exit = once(child, "exit");
    child.kill("SIGKILL");
    await exit;
    await assert.rejects(change(), /locked/);
    assert.equal((await fileRunStore(directory).read(run.id)).run.version, 0);
  },
);

void test("a repeated create cannot overwrite a damaged existing run", async () => {
  const directory = await testDirectory();
  const service = legacyRunService(fileRunStore(directory), runtime);
  const request = input();
  const run = await service.prepare(request);
  await unlink(join(directory, "artifacts", `${run.contextHash}.json`));
  const before = await readFile(
    join(directory, "runs", `${run.id}.json`),
    "utf8",
  );
  await assert.rejects(service.prepare(request));
  assert.equal(
    await readFile(join(directory, "runs", `${run.id}.json`), "utf8"),
    before,
  );
});

void test("pre-execution schema-v1 envelopes remain readable without rewriting legacy history", async () => {
  const directory = await testDirectory();
  const store = fileRunStore(directory);
  const service = legacyRunService(store, runtime);
  const run = await service.prepare(input());
  const file = join(directory, "runs", `${run.id}.json`);
  const old = JSON.parse(await readFile(file, "utf8")) as Record<
    string,
    unknown
  >;
  delete old.execution;
  const content = JSON.stringify(old);
  await writeFile(file, content);
  assert.equal((await store.read(run.id)).run.execution, null);
  assert.equal(await readFile(file, "utf8"), content);
});

// === Explicit run deletion ===

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

function attemptBase(taskId: string): Omit<RunAttempt, "state"> {
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

function settledAttempt(taskId: string): RunAttempt {
  const report = completedReport(taskId);
  return {
    ...attemptBase(taskId),
    state: "completed",
    report,
    reportHash: contentHash(JSON.stringify(report)),
    launch: { state: "started", prompt: "Carry out the task", settled: true },
  };
}

function runningAttempt(taskId: string): RunAttempt {
  return {
    ...attemptBase(taskId),
    state: "running",
    endedAt: null,
    launch: { state: "started", prompt: "Carry out the task", settled: true },
  };
}

function blockedAttempt(taskId: string): RunAttempt {
  return {
    ...runningAttempt(taskId),
    state: "blocked",
    message: "Confirm the compatibility requirement with the source agent.",
  };
}

function failedUnsettledAttempt(taskId: string): RunAttempt {
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
      prompt: "Carry out the task",
      settled: false,
    },
  };
}

function executionRun(
  id: string,
  status: StoredRun["status"],
  attempts: RunAttempt[],
): StoredRun {
  return {
    schemaVersion: 1,
    id,
    version: 0,
    title: "Finished run",
    source: placement,
    contextHash: executionContextHash,
    requestHash: contentHash(JSON.stringify(id)),
    createdAt: executionStart,
    updatedAt: executionStart,
    status,
    execution: {
      origin: "orchestrator",
      orchestration: {
        phase: "working",
        concurrency: 2,
        requestedBy: null,
        coordinatorLaunch: "started",
        prompt: "Carry out the shared plan",
        notification: null,
      },
      attempts,
      summary: status === "completed" ? "The run finished." : null,
      finishedAt: status === "completed" ? executionStart + 90_000 : null,
      interruption: null,
    },
    draft: null,
    revisions: [
      {
        number: 1,
        parent: null,
        reason: "Accepted the shared plan",
        acceptedAt: executionStart,
        authority: "operator",
        graph: { tasks: [task("work")] },
      },
    ],
  };
}

async function createRun(store: RunStore, run: StoredRun): Promise<void> {
  await store.create(run, planContext);
}

void test("deleting a finished run removes its snapshot and unreferenced context", async () => {
  const directory = await testDirectory();
  const store = fileRunStore(directory);
  const run = executionRun(randomUUID(), "completed", [settledAttempt("work")]);
  await createRun(store, run);
  const artifact = join(directory, "artifacts", `${run.contextHash}.json`);
  assert.equal((await store.list()).runs.length, 1);
  await store.remove(run.id, run.version);
  assert.deepEqual((await store.list()).runs, []);
  await assert.rejects(store.read(run.id));
  await assert.rejects(readFile(artifact), /ENOENT/);
});

void test("deleting one run keeps context another run still references", async () => {
  const directory = await testDirectory();
  const store = fileRunStore(directory);
  const first = executionRun(randomUUID(), "completed", [
    settledAttempt("work"),
  ]);
  const second = executionRun(randomUUID(), "completed", [
    settledAttempt("work"),
  ]);
  await createRun(store, first);
  await createRun(store, second);
  const artifact = join(directory, "artifacts", `${first.contextHash}.json`);
  await store.remove(first.id, first.version);
  assert.equal((await store.list()).runs.length, 1);
  assert.equal((await store.read(second.id)).run.id, second.id);
  assert.equal(Buffer.byteLength(await readFile(artifact, "utf8")) > 0, true);
});

void test("deleting a run keeps context while another record is unreadable", async () => {
  const directory = await testDirectory();
  const store = fileRunStore(directory);
  const first = executionRun(randomUUID(), "completed", [
    settledAttempt("work"),
  ]);
  const damaged = executionRun(randomUUID(), "completed", [
    settledAttempt("work"),
  ]);
  await createRun(store, first);
  await createRun(store, damaged);
  await writeFile(join(directory, "runs", `${damaged.id}.json`), "{incomplete");
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

void test("deletion refuses active, blocked, unsettled, and stale runs intact", async () => {
  const directory = await testDirectory();
  const store = fileRunStore(directory);
  const running = executionRun(randomUUID(), "running", [
    runningAttempt("work"),
  ]);
  const blocked = executionRun(randomUUID(), "blocked", [
    blockedAttempt("work"),
  ]);
  const unsettled = executionRun(randomUUID(), "failed", [
    failedUnsettledAttempt("work"),
  ]);
  const completed = executionRun(randomUUID(), "completed", [
    settledAttempt("work"),
  ]);
  for (const run of [running, blocked, unsettled, completed]) {
    await createRun(store, run);
  }
  await assert.rejects(store.remove(running.id, running.version), RunError);
  await assert.rejects(store.remove(blocked.id, blocked.version), RunError);
  await assert.rejects(store.remove(unsettled.id, unsettled.version), RunError);
  await assert.rejects(
    store.remove(completed.id, completed.version + 1),
    /changed/,
  );
  assert.equal((await store.list()).runs.length, 4);
  for (const run of [running, blocked, unsettled]) {
    assert.equal((await store.read(run.id)).run.id, run.id);
  }
  assert.equal((await store.read(completed.id)).run.version, completed.version);
});

void test("deleting a missing run reports the documented error", async () => {
  const directory = await testDirectory();
  const store = fileRunStore(directory);
  await assert.rejects(
    store.remove(randomUUID(), 0),
    /This performance no longer exists\. Refresh the performance list\./,
  );
});
