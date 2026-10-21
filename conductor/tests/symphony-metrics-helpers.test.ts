import assert from "node:assert/strict";
import test from "node:test";
import {
  SYMPHONY_LIMITS,
  attemptSchema,
  type Attempt,
  type AttemptUsage,
  type StoredSymphony,
} from "../shared/symphonies/models";
import {
  attemptMetrics,
  blockedMs,
  isLegacyAttempt,
  sumTokenField,
  sumTokens,
  symphonyMetrics,
  taskMetrics,
  tracksBlockedTime,
  wallMs,
  workMs,
} from "../shared/symphonies/metrics";
import { fixtureSymphonyId, storedSymphony } from "./symphony-fixtures";

function attempt(patch: Partial<Attempt> = {}): Attempt {
  return {
    id: fixtureSymphonyId,
    taskId: "api",
    agentId: "agent-1",
    state: "completed",
    startedAt: 1_000,
    endedAt: 61_000,
    message: null,
    report: null,
    reportHash: null,
    ...patch,
  };
}

function symphonyWith(
  attempts: Attempt[],
  options: { createdAt?: number; finishedAt?: number | null } = {},
): StoredSymphony {
  const base = storedSymphony();
  return {
    ...base,
    createdAt: options.createdAt ?? base.createdAt,
    execution: {
      ...base.execution,
      attempts,
      finishedAt: options.finishedAt ?? null,
    },
  };
}

void test("work time excludes closed and open blocked intervals", () => {
  const blockedAttempt = attempt({
    startedAt: 1_000,
    endedAt: 100_000,
    blocked: [
      { from: 10_000, to: 20_000 },
      { from: 50_000, to: null },
    ],
  });
  const now = 80_000;
  assert.equal(wallMs(blockedAttempt, now), 99_000);
  assert.equal(blockedMs(blockedAttempt, now), 40_000);
  assert.equal(workMs(blockedAttempt, now), 59_000);
  const metrics = attemptMetrics(blockedAttempt, now);
  assert.equal(metrics.wallMs, 99_000);
  assert.equal(metrics.workMs, 59_000);
  assert.equal(metrics.blockedMs, 40_000);
  assert.equal(metrics.legacy, false);
  assert.equal(metrics.tokens.input.coverage, "unknown");

  const empty = attempt({ blocked: [] });
  assert.equal(blockedMs(empty, now), 0);
  assert.equal(workMs(empty, now), 60_000);
});

void test("legacy attempts without blocked intervals use wall time", () => {
  const legacy = attempt();
  assert.equal(isLegacyAttempt(legacy), true);
  assert.equal(tracksBlockedTime(legacy), false);
  assert.equal(blockedMs(legacy, 70_000), 0);
  assert.equal(workMs(legacy, 70_000), 60_000);
  const metrics = attemptMetrics(legacy, 70_000);
  assert.equal(metrics.legacy, true);
  assert.equal(metrics.workMs, metrics.wallMs);

  const tracked = attempt({ blocked: [] });
  assert.equal(isLegacyAttempt(tracked), false);
  assert.equal(tracksBlockedTime(tracked), true);
});

void test("token sums report complete, partial, and unknown coverage", () => {
  const first = attempt({
    usage: { input: 10, cached: 4, output: 2, collectedAt: 100 },
  });
  const second = attempt({
    usage: { input: 5, output: 3, collectedAt: 100 },
  });
  const third = attempt({ usage: { input: 0, collectedAt: 100 } });
  const totals = sumTokens([first, second, third]);
  assert.deepEqual(totals.input, { coverage: "complete", total: 15 });
  assert.deepEqual(totals.cached, { coverage: "partial", total: 4 });
  assert.deepEqual(totals.output, { coverage: "partial", total: 5 });
  assert.deepEqual(sumTokenField([first], "cached"), {
    coverage: "complete",
    total: 4,
  });

  const unknown = { coverage: "unknown", total: null } as const;
  assert.deepEqual(sumTokens([]), {
    input: unknown,
    cached: unknown,
    output: unknown,
  });
  assert.deepEqual(sumTokens([attempt()]), {
    input: unknown,
    cached: unknown,
    output: unknown,
  });

  const readerUsage: AttemptUsage = { input: 7, cached: 2, output: 1 };
  assert.deepEqual(readerUsage, { input: 7, cached: 2, output: 1 });
});

void test("task totals sum work and span first start to last end", () => {
  const first = attempt({
    startedAt: 1_000,
    endedAt: 11_000,
    blocked: [{ from: 5_000, to: 7_000 }],
    usage: { input: 10, collectedAt: 100 },
  });
  const retry = attempt({
    startedAt: 20_000,
    endedAt: 35_000,
    usage: { input: 5, cached: 2, collectedAt: 200 },
  });
  const totals = taskMetrics([retry, first], 50_000);
  assert.equal(totals.workMs, 8_000 + 15_000);
  assert.equal(totals.blockedMs, 2_000);
  assert.equal(totals.elapsedMs, 34_000);
  assert.equal(totals.attemptCount, 2);
  assert.equal(totals.legacyAttempts, 1);
  assert.deepEqual(totals.tokens.input, { coverage: "complete", total: 15 });
  assert.deepEqual(totals.tokens.cached, { coverage: "partial", total: 2 });

  const open = attempt({ startedAt: 40_000, endedAt: null, blocked: [] });
  assert.equal(taskMetrics([open], 50_000).elapsedMs, 10_000);
  assert.equal(taskMetrics([], 50_000).elapsedMs, 0);
});

void test("symphony totals span creation to finish or now", () => {
  const first = attempt({
    startedAt: 15_000,
    endedAt: 25_000,
    blocked: [{ from: 18_000, to: 20_000 }],
    usage: { input: 10, output: 4, collectedAt: 300 },
  });
  const second = attempt({
    startedAt: 30_000,
    endedAt: 50_000,
    usage: { input: 6, collectedAt: 400 },
  });
  const finished = symphonyWith([first, second], {
    createdAt: 10_000,
    finishedAt: 70_000,
  });
  const totals = symphonyMetrics(finished, 999_999);
  assert.equal(totals.elapsedMs, 60_000);
  assert.equal(totals.workMs, 8_000 + 20_000);
  assert.equal(totals.blockedMs, 2_000);
  assert.equal(totals.attemptCount, 2);
  assert.equal(totals.legacyAttempts, 1);
  assert.deepEqual(totals.tokens.input, { coverage: "complete", total: 16 });
  assert.deepEqual(totals.tokens.output, { coverage: "partial", total: 4 });

  const running = symphonyWith([first], { createdAt: 10_000 });
  assert.equal(symphonyMetrics(running, 50_000).elapsedMs, 40_000);
});

void test("attempt schema keeps old records valid and bounds new metrics", () => {
  const legacy = attemptSchema.parse(attempt());
  assert.equal(legacy.blocked, undefined);
  assert.equal(legacy.sessions, undefined);
  assert.equal(legacy.usage, undefined);

  const extended = attempt({
    blocked: [{ from: 1_000, to: null }],
    sessions: [
      { provider: "codex", id: "session-1", from: 1_000, to: 5_000 },
      { provider: "claude", id: "session-2", from: 6_000, to: null },
    ],
    usage: { input: 1, cached: 2, output: 3, collectedAt: 4 },
  });
  assert.deepEqual(attemptSchema.parse(extended), extended);

  const limit = SYMPHONY_LIMITS.blockedIntervalsPerAttempt;
  const intervals = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      from: index,
      to: index + 1,
    }));
  assert.doesNotThrow(() =>
    attemptSchema.parse(attempt({ blocked: intervals(limit) })),
  );
  assert.throws(() =>
    attemptSchema.parse(attempt({ blocked: intervals(limit + 1) })),
  );
  const sessionLimit = SYMPHONY_LIMITS.sessionsPerAttempt;
  const segments = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      provider: "codex",
      id: `session-${index}`,
      from: index * 1_000,
      to: index === count - 1 ? null : (index + 1) * 1_000,
    }));
  assert.doesNotThrow(() =>
    attemptSchema.parse(attempt({ sessions: segments(sessionLimit) })),
  );
  assert.throws(() =>
    attemptSchema.parse(attempt({ sessions: segments(sessionLimit + 1) })),
  );
  assert.throws(() =>
    attemptSchema.parse(
      attempt({
        sessions: [
          { provider: "p".repeat(65), id: "session", from: 0, to: null },
        ],
      }),
    ),
  );
  assert.throws(() =>
    attemptSchema.parse(
      attempt({
        sessions: [
          { provider: "codex", id: "s".repeat(161), from: 0, to: null },
        ],
      }),
    ),
  );
  assert.throws(() =>
    attemptSchema.parse(
      attempt({
        sessions: [{ provider: "codex", id: "session", from: -1, to: null }],
      }),
    ),
  );
  assert.throws(() =>
    attemptSchema.parse(attempt({ usage: { input: -1, collectedAt: 1 } })),
  );
});
