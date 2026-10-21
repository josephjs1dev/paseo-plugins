import assert from "node:assert/strict";
import test from "node:test";
import {
  SYMPHONY_LIMITS,
  type Attempt,
  type StoredSymphony,
} from "../shared/symphonies/models";
import {
  closeBlockedInterval,
  closeSessionSegments,
  openBlockedInterval,
  symphonyMetrics,
} from "../server/symphonies/metrics";
import type { SymphonyStore } from "../server/symphonies/store";
import type { UsageReader } from "../server/engine/harnesses/usage";
import { planContext, storedSymphony } from "./symphony-fixtures";

const FIRST_ATTEMPT_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_ATTEMPT_ID = "22222222-2222-4222-8222-222222222222";

function attempt(patch: Partial<Attempt> = {}): Attempt {
  return {
    id: FIRST_ATTEMPT_ID,
    taskId: "api",
    agentId: "agent-1",
    state: "completed",
    startedAt: 1_000,
    endedAt: 11_000,
    message: null,
    report: null,
    reportHash: null,
    ...patch,
  };
}

function symphonyWith(attempts: Attempt[]): StoredSymphony {
  return {
    ...storedSymphony(),
    execution: {
      origin: "tracked",
      attempts,
      summary: null,
      finishedAt: null,
      interruption: null,
    },
  };
}

/** An in-memory store: collection only reads and updates one symphony. */
function memoryStore(initial: StoredSymphony): SymphonyStore {
  let current = structuredClone(initial);
  return {
    async list() {
      return { symphonies: [], unavailable: 0, incomplete: false };
    },
    async read(id) {
      assert.equal(id, current.id);
      return { symphony: structuredClone(current), context: planContext };
    },
    async create() {
      throw new Error("not used");
    },
    async remove() {
      throw new Error("not used");
    },
    async update(id, version, change) {
      assert.equal(id, current.id);
      if (version !== current.version) {
        throw new Error("version conflict");
      }
      const next = await change(structuredClone(current));
      next.version = current.version + 1;
      current = next;
      return structuredClone(next);
    },
  };
}

function fakeScheduler() {
  let clock = 20_000;
  let nextHandle = 1;
  let queue: Array<{ handle: number; runAt: number; callback: () => void }> =
    [];
  return {
    now: () => clock,
    setTimer: (callback: () => void, delayMs: number) => {
      const handle = nextHandle++;
      queue.push({ handle, runAt: clock + delayMs, callback });
      return handle;
    },
    clearTimer: (handle: unknown) => {
      queue = queue.filter((entry) => entry.handle !== handle);
    },
    pending: () => queue.length,
    runAll: async () => {
      for (let guard = 0; guard < 200 && queue.length; guard += 1) {
        const next = queue
          .slice()
          .sort((left, right) => left.runAt - right.runAt)[0];
        assert.ok(next);
        queue = queue.filter((entry) => entry.handle !== next.handle);
        clock = Math.max(clock, next.runAt);
        next.callback();
        // Let the asynchronous read/store chain schedule its next timer.
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      assert.equal(queue.length, 0, "scheduler did not settle");
    },
  };
}

void test("blocked intervals open once, close, and respect the bound", () => {
  const record = attempt({ blocked: [] });
  openBlockedInterval(record, 2_000);
  openBlockedInterval(record, 3_000);
  assert.deepEqual(record.blocked, [{ from: 2_000, to: null }]);
  closeBlockedInterval(record, 5_000);
  assert.deepEqual(record.blocked, [{ from: 2_000, to: 5_000 }]);
  closeBlockedInterval(record, 9_000);
  assert.deepEqual(record.blocked, [{ from: 2_000, to: 5_000 }]);

  const legacy = attempt();
  closeBlockedInterval(legacy, 5_000);
  assert.equal(legacy.blocked, undefined);

  const full = attempt({
    blocked: Array.from(
      { length: SYMPHONY_LIMITS.blockedIntervalsPerAttempt },
      (_, index) => ({ from: index * 10, to: index * 10 + 5 }),
    ),
  });
  openBlockedInterval(full, 999);
  assert.equal(
    full.blocked?.length,
    SYMPHONY_LIMITS.blockedIntervalsPerAttempt,
  );
  assert.deepEqual(full.blocked?.at(-1), { from: 999, to: null });
  assert.deepEqual(full.blocked?.[0], { from: 10, to: 15 });
});

void test("observe records the provider session once and never overwrites it", async () => {
  const store = memoryStore(symphonyWith([attempt({ endedAt: null })]));
  const scheduler = fakeScheduler();
  let sessionCalls = 0;
  const metrics = symphonyMetrics(store, {
    now: scheduler.now,
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer,
    readerFor: () => undefined,
    async sessionOf() {
      sessionCalls += 1;
      return { provider: "codex", id: "session-1" };
    },
  });
  await metrics.observe(
    (await store.read(storedSymphony().id)).symphony.id,
    FIRST_ATTEMPT_ID,
  );
  let stored = (await store.read(storedSymphony().id)).symphony;
  assert.deepEqual(stored.execution.attempts[0]?.sessions, [
    { provider: "codex", id: "session-1", from: 1_000, to: null },
  ]);
  await metrics.observe(stored.id, FIRST_ATTEMPT_ID);
  stored = (await store.read(stored.id)).symphony;
  assert.equal(sessionCalls, 1);
  assert.deepEqual(stored.execution.attempts[0]?.sessions, [
    { provider: "codex", id: "session-1", from: 1_000, to: null },
  ]);
  await metrics.close();
});

void test("collection reads the settled window and stores partial usage", async () => {
  const store = memoryStore(
    symphonyWith([
      attempt({
        endedAt: 11_000,
        sessions: [
          { provider: "codex", id: "session-1", from: 1_000, to: null },
        ],
      }),
    ]),
  );
  const windows: Array<[string, number, number]> = [];
  const reader: UsageReader = {
    provider: "codex",
    async read(sessionId, from, to) {
      windows.push([sessionId, from, to]);
      return { input: 120, cached: 80, output: 30 };
    },
  };
  const scheduler = fakeScheduler();
  const metrics = symphonyMetrics(store, {
    now: scheduler.now,
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer,
    async sessionOf() {
      return null;
    },
    readerFor: () => reader,
    collectDelayMs: 5_000,
    retryDelaysMs: [],
  });
  const id = (await store.read(storedSymphony().id)).symphony.id;
  metrics.collect(id, FIRST_ATTEMPT_ID);
  await scheduler.runAll();
  const stored = (await store.read(id)).symphony;
  assert.deepEqual(windows, [["session-1", 1_000, 11_000]]);
  assert.deepEqual(stored.execution.attempts[0]?.usage, {
    input: 120,
    cached: 80,
    output: 30,
    collectedAt: 25_000,
  });
  await metrics.close();
});

void test("collection is skipped without a session or a settled attempt", async () => {
  const store = memoryStore(
    symphonyWith([
      attempt({ endedAt: 11_000 }),
      attempt({
        id: SECOND_ATTEMPT_ID,
        taskId: "ui",
        agentId: "agent-2",
        endedAt: null,
        sessions: [
          { provider: "codex", id: "session-2", from: 1_000, to: null },
        ],
      }),
    ]),
  );
  let reads = 0;
  let sessionCalls = 0;
  const scheduler = fakeScheduler();
  const metrics = symphonyMetrics(store, {
    now: scheduler.now,
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer,
    async sessionOf() {
      sessionCalls += 1;
      return null;
    },
    readerFor: () => ({
      provider: "codex",
      async read() {
        reads += 1;
        return { input: 1 };
      },
    }),
  });
  const id = (await store.read(storedSymphony().id)).symphony.id;
  metrics.collect(id, FIRST_ATTEMPT_ID);
  metrics.collect(id, SECOND_ATTEMPT_ID);
  await scheduler.runAll();
  assert.equal(reads, 0, "no session means no log read");
  assert.equal(sessionCalls, 4, "the settled attempt retries its session");
  await metrics.close();
});

void test("collection retries a missing log and gives up after three retries", async () => {
  const store = memoryStore(
    symphonyWith([
      attempt({
        sessions: [
          { provider: "codex", id: "session-1", from: 1_000, to: null },
        ],
      }),
    ]),
  );
  const calls: number[] = [];
  const reader: UsageReader = {
    provider: "codex",
    async read() {
      calls.push(calls.length + 1);
      return calls.length >= 3 ? { input: 7, output: 2 } : null;
    },
  };
  const scheduler = fakeScheduler();
  const metrics = symphonyMetrics(store, {
    now: scheduler.now,
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer,
    async sessionOf() {
      return null;
    },
    readerFor: () => reader,
  });
  const id = (await store.read(storedSymphony().id)).symphony.id;
  metrics.collect(id, FIRST_ATTEMPT_ID);
  await scheduler.runAll();
  assert.equal(calls.length, 3);
  assert.deepEqual(
    (await store.read(id)).symphony.execution.attempts[0]?.usage,
    {
      input: 7,
      output: 2,
      collectedAt: 40_000,
    },
  );
  await metrics.close();

  const missingStore = memoryStore(
    symphonyWith([
      attempt({
        sessions: [
          { provider: "codex", id: "session-missing", from: 1_000, to: null },
        ],
      }),
    ]),
  );
  let missingCalls = 0;
  const missingScheduler = fakeScheduler();
  const missing = symphonyMetrics(missingStore, {
    now: missingScheduler.now,
    setTimer: missingScheduler.setTimer,
    clearTimer: missingScheduler.clearTimer,
    async sessionOf() {
      return null;
    },
    readerFor: () => ({
      provider: "codex",
      async read() {
        missingCalls += 1;
        return null;
      },
    }),
  });
  missing.collect(id, FIRST_ATTEMPT_ID);
  await missingScheduler.runAll();
  assert.equal(missingCalls, 4, "one read plus three retries");
  assert.equal(
    (await missingStore.read(id)).symphony.execution.attempts[0]?.usage,
    undefined,
  );
  await missing.close();
});

void test("attempts sharing an agent collect disjoint windows", async () => {
  const store = memoryStore(
    symphonyWith([
      attempt({
        startedAt: 1_000,
        endedAt: 2_000,
        sessions: [
          { provider: "pi", id: "shared-session", from: 1_000, to: null },
        ],
      }),
      attempt({
        id: SECOND_ATTEMPT_ID,
        taskId: "ui",
        agentId: "agent-1",
        startedAt: 3_000,
        endedAt: 4_000,
        sessions: [
          { provider: "pi", id: "shared-session", from: 3_000, to: null },
        ],
      }),
    ]),
  );
  const windows: Array<[number, number]> = [];
  const reader: UsageReader = {
    provider: "pi",
    async read(_sessionId, from, to) {
      windows.push([from, to]);
      return { input: to - from };
    },
  };
  const scheduler = fakeScheduler();
  const metrics = symphonyMetrics(store, {
    now: scheduler.now,
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer,
    async sessionOf() {
      return null;
    },
    readerFor: () => reader,
  });
  const id = (await store.read(storedSymphony().id)).symphony.id;
  metrics.collect(id, FIRST_ATTEMPT_ID);
  metrics.collect(id, SECOND_ATTEMPT_ID);
  await scheduler.runAll();
  const stored = (await store.read(id)).symphony;
  assert.deepEqual(
    windows.sort((left, right) => left[0] - right[0]),
    [
      [1_000, 2_000],
      [3_000, 4_000],
    ],
  );
  assert.deepEqual(
    stored.execution.attempts.map((entry) => entry.usage?.input),
    [1_000, 1_000],
  );
  await metrics.close();
});

void test("session segments close before a rebind and open from the old end", async () => {
  const store = memoryStore(
    symphonyWith([
      attempt({
        endedAt: null,
        sessions: [
          { provider: "codex", id: "session-1", from: 1_000, to: null },
        ],
      }),
    ]),
  );
  const scheduler = fakeScheduler();
  const id = (await store.read(storedSymphony().id)).symphony.id;
  let stored = (await store.read(id)).symphony;
  const record = stored.execution.attempts[0];
  assert.ok(record);
  closeSessionSegments(record, 3_000);
  assert.deepEqual(record.sessions, [
    { provider: "codex", id: "session-1", from: 1_000, to: 3_000 },
  ]);
  stored = await store.update(id, stored.version, (value) => {
    const active = value.execution.attempts[0];
    assert.ok(active);
    closeSessionSegments(active, 3_000);
    return value;
  });

  const metrics = symphonyMetrics(store, {
    now: scheduler.now,
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer,
    readerFor: () => undefined,
    async sessionOf() {
      return { provider: "claude", id: "session-2" };
    },
  });
  await metrics.observe(id, FIRST_ATTEMPT_ID);
  stored = (await store.read(id)).symphony;
  assert.deepEqual(stored.execution.attempts[0]?.sessions, [
    { provider: "codex", id: "session-1", from: 1_000, to: 3_000 },
    { provider: "claude", id: "session-2", from: 3_000, to: null },
  ]);
  await metrics.close();
});

void test("collection sums every session segment over its own window", async () => {
  const store = memoryStore(
    symphonyWith([
      attempt({
        startedAt: 1_000,
        endedAt: 5_000,
        sessions: [
          { provider: "codex", id: "first", from: 500, to: 2_000 },
          { provider: "claude", id: "second", from: 2_000, to: null },
        ],
      }),
    ]),
  );
  const calls: Array<[string, string, number, number]> = [];
  const readers: Record<string, UsageReader> = {
    codex: {
      provider: "codex",
      async read(id, from, to) {
        calls.push(["codex", id, from, to]);
        return { input: 10, cached: 5, output: 1 };
      },
    },
    claude: {
      provider: "claude",
      async read(id, from, to) {
        calls.push(["claude", id, from, to]);
        return { input: 20, output: 2 };
      },
    },
  };
  const scheduler = fakeScheduler();
  const metrics = symphonyMetrics(store, {
    now: scheduler.now,
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer,
    async sessionOf() {
      return null;
    },
    readerFor: (provider) => readers[provider],
  });
  const id = (await store.read(storedSymphony().id)).symphony.id;
  metrics.collect(id, FIRST_ATTEMPT_ID);
  await scheduler.runAll();
  assert.deepEqual(calls, [
    ["codex", "first", 1_000, 2_000],
    ["claude", "second", 2_000, 5_000],
  ]);
  // Claude did not report cache reads, so the summed cache field stays unknown.
  assert.deepEqual(
    (await store.read(id)).symphony.execution.attempts[0]?.usage,
    {
      input: 30,
      output: 3,
      collectedAt: 25_000,
    },
  );
  await metrics.close();
});

void test("an in-flight read cannot store usage for a replaced settlement window", async () => {
  const store = memoryStore(
    symphonyWith([
      attempt({
        startedAt: 1_000,
        endedAt: 2_000,
        sessions: [
          { provider: "codex", id: "session-1", from: 1_000, to: null },
        ],
      }),
    ]),
  );
  const scheduler = fakeScheduler();
  let reads = 0;
  const state: { collectNewest?: (symphonyId: string) => void } = {};
  const reader: UsageReader = {
    provider: "codex",
    async read(_id, _from, to) {
      reads += 1;
      if (reads === 1) {
        const current = await store.read(storedSymphony().id);
        await store.update(
          current.symphony.id,
          current.symphony.version,
          (value) => {
            const active = value.execution.attempts[0];
            assert.ok(active);
            active.endedAt = 4_000;
            delete active.usage;
            return value;
          },
        );
        // The newer settlement arrives while the first read is in flight.
        state.collectNewest?.(current.symphony.id);
        return { input: 1 };
      }
      return { input: to };
    },
  };
  const metrics = symphonyMetrics(store, {
    now: scheduler.now,
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer,
    async sessionOf() {
      return null;
    },
    readerFor: () => reader,
  });
  state.collectNewest = (symphonyId) =>
    metrics.collect(symphonyId, FIRST_ATTEMPT_ID);
  const id = (await store.read(storedSymphony().id)).symphony.id;
  metrics.collect(id, FIRST_ATTEMPT_ID);
  await scheduler.runAll();
  const stored = (await store.read(id)).symphony;
  assert.equal(reads, 2);
  assert.equal(stored.execution.attempts[0]?.usage?.input, 4_000);
  await metrics.close();
});

void test("close during a missing-log read leaves no retry timer", async () => {
  const store = memoryStore(
    symphonyWith([
      attempt({
        endedAt: 11_000,
        sessions: [
          { provider: "codex", id: "session-1", from: 1_000, to: null },
        ],
      }),
    ]),
  );
  const scheduler = fakeScheduler();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started: () => void = () => {};
  const reading = new Promise<void>((resolve) => {
    started = resolve;
  });
  let reads = 0;
  const metrics = symphonyMetrics(store, {
    now: scheduler.now,
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer,
    async sessionOf() {
      return null;
    },
    readerFor: () => ({
      provider: "codex",
      async read() {
        reads += 1;
        started();
        await gate;
        return null;
      },
    }),
  });
  const id = (await store.read(storedSymphony().id)).symphony.id;
  metrics.collect(id, FIRST_ATTEMPT_ID);
  await scheduler.runAll();
  await reading;
  const closing = metrics.close();
  release();
  await closing;
  metrics.collect(id, FIRST_ATTEMPT_ID);
  assert.equal(reads, 1);
  assert.equal(scheduler.pending(), 0);
  assert.equal(
    (await store.read(id)).symphony.execution.attempts[0]?.usage,
    undefined,
  );
});
