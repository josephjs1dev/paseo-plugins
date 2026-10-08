import assert from "node:assert/strict";
import test from "node:test";
import { symphonyExecution } from "../server/symphonies/execution";
import {
  commandSymphonyId,
  type ExecutionRuntime,
} from "../server/symphonies/identity";
import { contentHash, fileSymphonyStore } from "../server/symphonies/store";
import { placement, planContext, task } from "./symphony-fixtures";
import {
  latestAttempt,
  type Attempt,
  type StoredSymphony,
  type TaskDefinition,
  type TaskReport,
} from "../shared/symphonies/models";
import { testDirectory } from "./fixtures";

const runtime: ExecutionRuntime = {
  source: async (agentId) => ({ agentId, concertId: "ws-api" }),
  capture: async (source) => ({ ...placement, ...source }),
  validate: async () => {},
};
const report: TaskReport = {
  outcome: "completed",
  summary: "Implemented the requested behavior",
  evidence: ["Changed code and inspected the resulting behavior"],
  checks: [],
};
async function fixture(overrides: Partial<ExecutionRuntime> = {}) {
  const directory = await testDirectory();
  const store = fileSymphonyStore(directory);
  const activeRuntime: ExecutionRuntime = { ...runtime, ...overrides };
  const engine = symphonyExecution(store, () => activeRuntime);
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
    return commandSymphonyId("agent-1", key);
  };
  const read = async (symphonyId: string) =>
    (await store.read(symphonyId)).symphony;
  const claim = async (symphonyId: string, taskId = "work", retry = false) => {
    await send({ kind: "claim", symphonyId: symphonyId, taskId, retry });
    const attempt = latestAttempt(await read(symphonyId), taskId);
    assert.ok(attempt);
    return attempt;
  };
  return { directory, store, engine, send, start, read, claim };
}

void test("agent commands create, execute and report end to end", async () => {
  const f = await fixture();
  const id = await f.start("one");
  const initial = await f.read(id);
  assert.equal(initial.status, "ready");
  assert.equal(await f.start("one"), id);
  assert.equal((await f.store.list()).symphonies.length, 1);
  await assert.rejects(
    f.send({ kind: "start", key: "one", title: "Changed", goal: "Different" }),
    /another plan/,
  );
  const attempt = await f.claim(id);
  assert.equal((await f.claim(id)).id, attempt.id);
  assert.equal((await f.read(id)).version, 1);
  await assert.rejects(
    f.send({ kind: "finish", symphonyId: id, summary: "Premature" }),
    /every task/,
  );
  await f.send({
    kind: "report",
    symphonyId: id,
    attemptId: attempt.id,
    report,
  });
  const version = (await f.read(id)).version;
  await f.send({
    kind: "report",
    symphonyId: id,
    attemptId: attempt.id,
    report,
  });
  assert.equal((await f.read(id)).version, version);
  assert.equal(
    (await f.read(id)).status,
    "ready",
    "A task report is not the symphony summary",
  );
  await f.send({
    kind: "finish",
    symphonyId: id,
    summary: "Completed with check evidence",
  });
  const done = await f.read(id);
  assert.equal(done.status, "completed");
  assert.deepEqual(
    (await fileSymphonyStore(f.directory).read(id)).symphony,
    done,
  );
  await f.send({
    kind: "finish",
    symphonyId: id,
    summary: "Completed with check evidence",
  });
  assert.equal((await f.read(id)).version, done.version);
  await assert.rejects(
    f.send({ kind: "finish", symphonyId: id, summary: "Changed report" }),
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
    f.send({ kind: "report", symphonyId: id, attemptId: a.id, report }),
    /declared check/,
  );
  await f.send({
    kind: "report",
    symphonyId: id,
    attemptId: a.id,
    report: {
      ...report,
      checks: [
        { name: "focused tests", status: "passed", detail: "3 tests passed" },
      ],
    },
  });
  await assert.rejects(f.claim(id, "join"), /prerequisites/);
  await f.send({ kind: "report", symphonyId: id, attemptId: b.id, report });
  assert.equal((await f.claim(id, "join")).state, "running");
});

void test("same-checkout claims remain reserved through blockers and reload", async () => {
  const f = await fixture();
  const first = await f.start("first");
  const second = await f.start("second");
  const attempt = await f.claim(first);
  await f.send({
    kind: "block",
    symphonyId: first,
    attemptId: attempt.id,
    message: "Need the user's decision",
  });
  assert.equal((await f.read(first)).status, "blocked");
  await assert.rejects(f.claim(second), /still owned/);
  const fresh = symphonyExecution(
    fileSymphonyStore(f.directory),
    () => runtime,
  );
  await fresh.interrupt(null, "Reloaded");
  await assert.rejects(f.claim(second), /still owned/);
  assert.equal((await f.claim(first)).id, attempt.id);
  await f.send({
    kind: "report",
    symphonyId: first,
    attemptId: attempt.id,
    report,
  });
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
  await f.send({
    kind: "report",
    symphonyId: id,
    attemptId: attempt.id,
    report,
  });
  await f.engine.interrupt("agent-1", "Another turn ended");
  assert.equal((await f.read(id)).status, "ready");
});

void test("source and concert mismatches cannot take over an assignment", async () => {
  const f = await fixture();
  const id = await f.start("owner");
  const attempt = await f.claim(id);
  await assert.rejects(
    f.send(
      { kind: "report", symphonyId: id, attemptId: attempt.id, report },
      "agent-2",
    ),
    /original source/,
  );
  await assert.rejects(
    f.send({ kind: "get", symphonyId: id }, "agent-2"),
    /another source/,
  );
  const moved = symphonyExecution(f.store, () => ({
    ...runtime,
    source: async (agentId) => ({ agentId, concertId: "elsewhere" }),
  }));
  await assert.rejects(
    moved.execute({
      agentId: "agent-1",
      command: { kind: "claim", symphonyId: id, taskId: "work" },
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
    symphonyId: id,
    attemptId: first.id,
    report: { ...report, outcome: "failed", summary: "Check failed" },
  });
  await assert.rejects(f.claim(id), /Explicitly/);
  const next = await f.claim(id, "work", true);
  assert.notEqual(next.id, first.id);
  await assert.rejects(
    f.send({ kind: "report", symphonyId: id, attemptId: first.id, report }),
    /superseded/,
  );
  await f.send({
    kind: "report",
    symphonyId: id,
    attemptId: next.id,
    report,
  });
  await assert.rejects(
    f.send({
      kind: "report",
      symphonyId: id,
      attemptId: next.id,
      report: { ...report, summary: "Changed" },
    }),
    /different report/,
  );
  assert.equal((await f.read(id)).execution.attempts.length, 2);
});

void test("schema bounds and score rejection do not create symphonies", async () => {
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
  assert.equal((await f.store.list()).symphonies.length, 0);
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

// === Task agent widening (`widen`) ===
const attemptId = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function implementationTask(
  id: string,
  writes: string[],
  reads: string[] = [],
): TaskDefinition {
  return task(id, {
    reads,
    writes,
    worker: { role: "implementation", profile: "default" },
  });
}

function orchestratedAttempt(
  taskId: string,
  agentId: string,
  id: string,
  patch: Partial<Attempt> = {},
): Attempt {
  return {
    id,
    taskId,
    agentId,
    state: "running",
    startedAt: 1,
    endedAt: null,
    message: null,
    report: null,
    reportHash: null,
    launch: {
      state: "started",
      profile: "inherit",
      generation: 0,
      prompt: "Carry out the task",
      settled: true,
    },
    ...patch,
  };
}

function orchestratedSymphony(options: {
  id: string;
  title?: string;
  status?: StoredSymphony["status"];
  tasks: TaskDefinition[];
  attempts: Attempt[];
}): StoredSymphony {
  return {
    schemaVersion: 1,
    id: options.id,
    version: 0,
    title: options.title ?? "Widening",
    source: placement,
    contextHash: contentHash(JSON.stringify(planContext)),
    requestHash: "b".repeat(64),
    createdAt: 1,
    updatedAt: 1,
    status: options.status ?? "running",
    execution: {
      origin: "conducted",
      conducting: {
        phase: "working",
        concurrency: 4,
        requestedBy: "requester",
        conductor: "self",
        conductorLaunch: "started",
        prompt: "Split the work",
        notification: null,
      },
      attempts: options.attempts,
      summary: null,
      finishedAt: null,
      interruption: null,
    },
    revisions: [
      {
        number: 1,
        parent: null,
        reason: "Accepted decomposition",
        acceptedAt: 1,
        score: { tasks: options.tasks },
      },
    ],
  };
}

void test("widen grants a running task agent's request and claims respect the grant", async () => {
  const f = await fixture();
  const id = "11111111-1111-4111-8111-111111111111";
  await f.store.create(
    orchestratedSymphony({
      id,
      tasks: [implementationTask("writer", ["src/api"])],
      attempts: [orchestratedAttempt("writer", "worker-writer", attemptId(1))],
    }),
    planContext,
  );
  const reason = "My change breaks the exported schema that typecheck reads";
  const ack = (await f.send(
    {
      kind: "widen",
      symphonyId: id,
      attemptId: attemptId(1),
      paths: ["shared/schema.ts"],
      reason,
    },
    "worker-writer",
  )) as {
    acknowledged: boolean;
    granted: string[];
    grantedWrites: { path: string; reason: string; at: number }[];
  };
  assert.equal(ack.acknowledged, true);
  assert.deepEqual(ack.granted, ["shared/schema.ts"]);
  assert.equal(ack.grantedWrites.length, 1);
  assert.equal(ack.grantedWrites[0]?.path, "shared/schema.ts");
  assert.equal(ack.grantedWrites[0]?.reason, reason);
  assert.equal(typeof ack.grantedWrites[0]?.at, "number");
  assert.deepEqual(
    (await f.read(id)).execution.attempts[0]?.grantedWrites,
    ack.grantedWrites,
  );

  // A reader that wants the granted path is blocked while the writer holds it.
  const readerId = await f.start("grant-reader", [
    {
      id: "read",
      title: "Read",
      description: "Read the schema",
      reads: ["shared/schema.ts"],
      writes: [],
    },
  ]);
  await assert.rejects(f.claim(readerId, "read"), /still owned/);

  // The refusal is the grant, not a blanket block on disjoint readers.
  const safeId = await f.start("grant-safe", [
    {
      id: "safe",
      title: "Safe",
      description: "Read unrelated code",
      reads: ["unrelated"],
      writes: [],
    },
  ]);
  assert.equal((await f.claim(safeId, "safe")).state, "running");
});

void test("widen refuses a path held by a running reader and names the task", async () => {
  const f = await fixture();
  const writerId = "22222222-2222-4222-8222-222222222222";
  await f.store.create(
    orchestratedSymphony({
      id: writerId,
      title: "Writer symphony",
      tasks: [implementationTask("writer", ["src/api"])],
      attempts: [orchestratedAttempt("writer", "worker-writer", attemptId(2))],
    }),
    planContext,
  );
  const readerId = "33333333-3333-4333-8333-333333333333";
  await f.store.create(
    orchestratedSymphony({
      id: readerId,
      title: "Reader symphony",
      tasks: [task("reader", { reads: ["shared/schema.ts"], writes: [] })],
      attempts: [orchestratedAttempt("reader", "worker-reader", attemptId(3))],
    }),
    planContext,
  );
  await assert.rejects(
    f.send(
      {
        kind: "widen",
        symphonyId: writerId,
        attemptId: attemptId(2),
        paths: ["shared/schema.ts"],
        reason: "Typecheck reads the exported schema",
      },
      "worker-writer",
    ),
    /held by task "reader" in Reader symphony/,
  );
  assert.equal(
    (await f.read(writerId)).execution.attempts[0]?.grantedWrites,
    undefined,
    "A refused widen changes nothing",
  );
});

void test("widen refuses a read-only task and stores nothing", async () => {
  const f = await fixture();
  const id = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  await f.store.create(
    orchestratedSymphony({
      id,
      tasks: [task("reader", { reads: ["src/api"], writes: [] })],
      attempts: [orchestratedAttempt("reader", "worker-reader", attemptId(14))],
    }),
    planContext,
  );
  await assert.rejects(
    f.send(
      {
        kind: "widen",
        symphonyId: id,
        attemptId: attemptId(14),
        paths: ["shared/schema.ts"],
        reason: "Typecheck reads the exported schema",
      },
      "worker-reader",
    ),
    /read-only tasks cannot widen their write scope\. Report need "scope" instead\./,
  );
  assert.equal(
    (await f.read(id)).execution.attempts[0]?.grantedWrites,
    undefined,
    "a read-only task never gains granted writes",
  );
});

void test("widen refuses a path owned by an unfinished task in the score", async () => {
  const f = await fixture();
  const id = "44444444-4444-4444-8444-444444444444";
  await f.store.create(
    orchestratedSymphony({
      id,
      tasks: [
        implementationTask("writer", ["src/api"]),
        implementationTask("owner", ["shared/schema.ts"]),
      ],
      attempts: [orchestratedAttempt("writer", "worker-writer", attemptId(4))],
    }),
    planContext,
  );
  await assert.rejects(
    f.send(
      {
        kind: "widen",
        symphonyId: id,
        attemptId: attemptId(4),
        paths: ["shared/schema.ts"],
        reason: "Typecheck reads the exported schema",
      },
      "worker-writer",
    ),
    /owned by unfinished task "owner"/,
  );
});

void test("widen allows two calls per attempt and refuses a third", async () => {
  const f = await fixture();
  const id = "55555555-5555-4555-8555-555555555555";
  await f.store.create(
    orchestratedSymphony({
      id,
      tasks: [implementationTask("writer", ["src/api"])],
      attempts: [orchestratedAttempt("writer", "worker-writer", attemptId(5))],
    }),
    planContext,
  );
  const widen = (paths: string[]) =>
    f.send(
      {
        kind: "widen",
        symphonyId: id,
        attemptId: attemptId(5),
        paths,
        reason: "Needed to fix the failing check",
      },
      "worker-writer",
    ) as Promise<{ grantedWrites: unknown[] }>;
  assert.equal(
    (await widen(["a/1", "a/2", "a/3", "a/4", "a/5"])).grantedWrites.length,
    5,
  );
  assert.equal(
    (await widen(["b/1", "b/2", "b/3", "b/4", "b/5"])).grantedWrites.length,
    10,
  );
  await assert.rejects(widen(["c/1"]), /widen calls/);
  assert.equal(
    (await f.read(id)).execution.attempts[0]?.grantedWrites?.length,
    10,
  );
});

void test("widen checks agent identity, running state, and orchestration", async () => {
  const f = await fixture();
  const id = "66666666-6666-4666-8666-666666666666";
  await f.store.create(
    orchestratedSymphony({
      id,
      tasks: [implementationTask("writer", ["src/api"])],
      attempts: [orchestratedAttempt("writer", "worker-writer", attemptId(6))],
    }),
    planContext,
  );
  const widen = (agentId: string) =>
    f.send(
      {
        kind: "widen",
        symphonyId: id,
        attemptId: attemptId(6),
        paths: ["shared/schema.ts"],
        reason: "Typecheck reads the exported schema",
      },
      agentId,
    );
  await assert.rejects(widen("someone-else"), /assigned task agent/);

  const blockedId = "77777777-7777-4777-8777-777777777777";
  await f.store.create(
    orchestratedSymphony({
      id: blockedId,
      status: "blocked",
      tasks: [implementationTask("writer", ["src/api"])],
      attempts: [
        orchestratedAttempt("writer", "worker-writer", attemptId(7), {
          state: "blocked",
          message: "Waiting on a decision",
        }),
      ],
    }),
    planContext,
  );
  await assert.rejects(
    f.send(
      {
        kind: "widen",
        symphonyId: blockedId,
        attemptId: attemptId(7),
        paths: ["shared/schema.ts"],
        reason: "Typecheck reads the exported schema",
      },
      "worker-writer",
    ),
    /Only a running attempt/,
  );

  // Source-agent assignments never widen; the conductor owns their scope.
  const g = await fixture();
  const sourceId = await g.start("source-widen");
  const sourceAttempt = await g.claim(sourceId);
  await assert.rejects(
    g.send(
      {
        kind: "widen",
        symphonyId: sourceId,
        attemptId: sourceAttempt.id,
        paths: ["shared/schema.ts"],
        reason: "Typecheck reads the exported schema",
      },
      "agent-1",
    ),
    /assigned task agent/,
  );
});

void test("widen validates the grown scope against the captured placement", async () => {
  const f = await fixture({
    validate: async (_source, score) => {
      if (score.tasks.some((task) => task.writes.includes("link/file"))) {
        throw new Error("Task scopes cannot include symbolic links.");
      }
    },
  });
  const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  await f.store.create(
    orchestratedSymphony({
      id,
      tasks: [implementationTask("writer", ["src/api"])],
      attempts: [orchestratedAttempt("writer", "worker-writer", attemptId(11))],
    }),
    planContext,
  );
  await assert.rejects(
    f.send(
      {
        kind: "widen",
        symphonyId: id,
        attemptId: attemptId(11),
        paths: ["link/file"],
        reason: "The symlinked file breaks a required check",
      },
      "worker-writer",
    ),
    /symbolic links/,
  );
  assert.equal(
    (await f.read(id)).execution.attempts[0]?.grantedWrites,
    undefined,
    "a rejected scope is never granted",
  );
});

void test("widen refuses while another writer holds resources", async () => {
  const f = await fixture();
  const writerId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  await f.store.create(
    orchestratedSymphony({
      id: writerId,
      title: "Reader symphony",
      tasks: [implementationTask("reader", ["src/api"])],
      attempts: [orchestratedAttempt("reader", "worker-reader", attemptId(12))],
    }),
    planContext,
  );
  const otherId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  await f.store.create(
    orchestratedSymphony({
      id: otherId,
      title: "Other writer",
      tasks: [implementationTask("other", ["src/other"])],
      attempts: [orchestratedAttempt("other", "worker-other", attemptId(13))],
    }),
    planContext,
  );
  await assert.rejects(
    f.send(
      {
        kind: "widen",
        symphonyId: writerId,
        attemptId: attemptId(12),
        paths: ["docs/new"],
        reason: "My change breaks a document check",
      },
      "worker-reader",
    ),
    /another writer holds resources/,
  );
  assert.equal(
    (await f.read(writerId)).execution.attempts[0]?.grantedWrites,
    undefined,
  );
});

void test("stored grants must stay orchestrated and within the widen call limit", async () => {
  const f = await fixture();
  await assert.rejects(
    f.store.create(
      orchestratedSymphony({
        id: "88888888-8888-4888-8888-888888888888",
        tasks: [implementationTask("writer", ["src/api"])],
        attempts: [
          orchestratedAttempt("writer", "worker-writer", attemptId(8), {
            grantedWrites: [
              { path: "a", reason: "reason", at: 1 },
              { path: "b", reason: "reason", at: 2 },
              { path: "c", reason: "reason", at: 3 },
            ],
          }),
        ],
      }),
      planContext,
    ),
    /grants are inconsistent/,
  );
});

void test("a later attempt may reuse the previous failed agent", async () => {
  const f = await fixture();
  const id = "99999999-9999-4999-8999-999999999999";
  const failedReport: TaskReport = {
    outcome: "failed",
    summary: "Checks failed on the first attempt",
    evidence: ["Typecheck failed"],
    checks: [],
  };
  await f.store.create(
    orchestratedSymphony({
      id,
      tasks: [implementationTask("writer", ["src/api"])],
      attempts: [
        orchestratedAttempt("writer", "worker-writer", attemptId(9), {
          state: "failed",
          endedAt: 2,
          report: failedReport,
          reportHash: contentHash(JSON.stringify(failedReport)),
        }),
        orchestratedAttempt("writer", "worker-writer", attemptId(10)),
      ],
    }),
    planContext,
  );
  const stored = await f.read(id);
  assert.deepEqual(
    stored.execution.attempts.map((attempt) => attempt.agentId),
    ["worker-writer", "worker-writer"],
  );
  assert.equal(latestAttempt(stored, "writer")?.id, attemptId(10));
});
