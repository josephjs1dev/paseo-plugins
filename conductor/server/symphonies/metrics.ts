import {
  SYMPHONY_LIMITS,
  type Attempt,
  type AttemptSessionSegment,
  type AttemptUsage,
} from "../../shared/symphonies/models";
import type { UsageReader } from "../engine/harnesses/usage";
import type { SymphonyStore } from "./store";

/** Delay after settlement before the first harness log read. */
export const USAGE_COLLECTION_DELAY_MS = 5_000;
/** Backoff between reads while a harness log has not appeared yet. */
export const USAGE_COLLECTION_RETRY_DELAYS_MS = [5_000, 10_000, 20_000];

/** Runs a metric mutation beside commands; the default is a direct call. */
export type MetricsMutation = <T>(action: () => Promise<T>) => Promise<T>;

type SessionIdentity = Pick<AttemptSessionSegment, "provider" | "id">;

/** Host capabilities collection needs; tests inject fakes for all of them. */
export interface SymphonyMetricsRuntime {
  now(): number;
  /** The agent's current provider session, or null when it is not known. */
  sessionOf(agentId: string): Promise<SessionIdentity | null>;
  /** The reader for a Paseo provider id, or undefined when unsupported. */
  readerFor(provider: string): UsageReader | undefined;
  setTimer(callback: () => void, delayMs: number): unknown;
  clearTimer(handle: unknown): void;
  /** Override the first delay; tests use 0. */
  collectDelayMs?: number;
  /** Override the retry schedule; tests use 0. */
  retryDelaysMs?: readonly number[];
}

/** What orchestration needs from collection; all failures stay contained. */
export interface SymphonyMetrics {
  /** Records the attempt's current session; call inside the command queue. */
  observe(symphonyId: string, attemptId: string): Promise<void>;
  /** Records sessions for running attempts, including tracked claims. */
  observeAll?(): Promise<void>;
  /** Schedules a usage read for a settled attempt; a no-op otherwise. */
  collect(symphonyId: string, attemptId: string): void;
  /** Serializes metric writes with commands when the host provides a queue. */
  setMutation?(mutate: MetricsMutation): void;
  /** Clears pending reads and waits for the ones already running. */
  close(): Promise<void>;
}

/** The settlement window a usage read must still match before it is stored. */
interface SettlementWindow {
  startedAt: number;
  endedAt: number;
  sessions: AttemptSessionSegment[];
}

interface UsageRead {
  usage: AttemptUsage | null;
  retry: boolean;
  unsupported: boolean;
}

function copySessions(
  sessions: readonly AttemptSessionSegment[] | undefined,
): AttemptSessionSegment[] {
  return (sessions ?? []).map((session) => ({ ...session }));
}

function sameSessions(
  left: readonly AttemptSessionSegment[],
  right: readonly AttemptSessionSegment[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((session, index) => {
    const other = right[index];
    return (
      other !== undefined &&
      session.provider === other.provider &&
      session.id === other.id &&
      session.from === other.from &&
      session.to === other.to
    );
  });
}

function captureWindow(attempt: Attempt): SettlementWindow | null {
  if (attempt.endedAt === null) {
    return null;
  }
  return {
    startedAt: attempt.startedAt,
    endedAt: attempt.endedAt,
    sessions: copySessions(attempt.sessions),
  };
}

function sameWindow(attempt: Attempt, window: SettlementWindow): boolean {
  return (
    attempt.endedAt === window.endedAt &&
    attempt.startedAt === window.startedAt &&
    sameSessions(attempt.sessions ?? [], window.sessions)
  );
}

/**
 * Appends an open blocked interval. Replaying a block keeps the single open
 * interval. At the per-attempt bound the oldest interval is dropped so the
 * current block stays measurable.
 */
export function openBlockedInterval(attempt: Attempt, now: number): void {
  const intervals = [...(attempt.blocked ?? [])];
  if (intervals.some((interval) => interval.to === null)) {
    return;
  }
  if (intervals.length >= SYMPHONY_LIMITS.blockedIntervalsPerAttempt) {
    intervals.shift();
  }
  intervals.push({ from: now, to: null });
  attempt.blocked = intervals;
}

/** Closes every open blocked interval at `now`, leaving closed ones untouched. */
export function closeBlockedInterval(attempt: Attempt, now: number): void {
  if (!attempt.blocked) {
    return;
  }
  for (const interval of attempt.blocked) {
    if (interval.to === null) {
      interval.to = Math.max(interval.from, now);
    }
  }
}

/** Closes the current session segment before an attempt moves to another agent. */
export function closeSessionSegments(attempt: Attempt, now: number): void {
  if (!attempt.sessions) {
    return;
  }
  for (const session of attempt.sessions) {
    if (session.to === null) {
      session.to = Math.max(session.from, now);
    }
  }
}

/** Appends the current agent's session, starting where the previous one ended. */
function appendSessionSegment(
  attempt: Attempt,
  session: SessionIdentity,
): AttemptSessionSegment {
  const sessions = [...(attempt.sessions ?? [])];
  const latest = sessions.at(-1);
  const from = latest
    ? Math.max(latest.to ?? attempt.startedAt, attempt.startedAt)
    : attempt.startedAt;
  const segment: AttemptSessionSegment = {
    provider: session.provider,
    id: session.id,
    from,
    to: null,
  };
  sessions.push(segment);
  if (sessions.length > SYMPHONY_LIMITS.sessionsPerAttempt) {
    sessions.shift();
  }
  attempt.sessions = sessions;
  return segment;
}

const noopMetrics: SymphonyMetrics = {
  observe: () => Promise.resolve(),
  collect: () => undefined,
  close: () => Promise.resolve(),
};

/** A metrics implementation for callers that do not collect usage. */
export function noSymphonyMetrics(): SymphonyMetrics {
  return noopMetrics;
}

/**
 * Collects token usage from harness session logs after an attempt settles.
 * Harness reads run outside the command queue; only the resulting writes are
 * serialized with commands. Every failure leaves `usage` absent instead of
 * throwing.
 */
export function symphonyMetrics(
  store: SymphonyStore,
  runtime: SymphonyMetricsRuntime,
): SymphonyMetrics {
  const pending = new Map<string, { dirty: boolean }>();
  const timers = new Set<unknown>();
  const inFlight = new Set<Promise<void>>();
  const firstDelay = runtime.collectDelayMs ?? USAGE_COLLECTION_DELAY_MS;
  const retryDelays = runtime.retryDelaysMs ?? USAGE_COLLECTION_RETRY_DELAYS_MS;
  let closed = false;
  let mutate: MetricsMutation = (action) => action();

  const findAttempt = async (symphonyId: string, attemptId: string) => {
    const { symphony } = await store.read(symphonyId);
    const attempt = symphony.execution.attempts.find(
      (entry) => entry.id === attemptId,
    );
    return attempt ? { symphony, attempt } : null;
  };

  /** Appends a session directly; callers already hold the serialized queue. */
  const appendSession = async (
    found: NonNullable<Awaited<ReturnType<typeof findAttempt>>>,
    session: SessionIdentity,
  ): Promise<AttemptSessionSegment | null> => {
    if (closed) {
      return null;
    }
    const { symphony, attempt } = found;
    const latest = attempt.sessions?.at(-1);
    if (latest?.to === null) {
      return latest;
    }
    const snapshot = copySessions(attempt.sessions);
    const agentId = attempt.agentId;
    try {
      const updated = await store.update(
        symphony.id,
        symphony.version,
        (current) => {
          if (closed) {
            return current;
          }
          const active = current.execution.attempts.find(
            (entry) => entry.id === attempt.id,
          );
          if (!active || active.agentId !== agentId) {
            return current;
          }
          const open = active.sessions?.at(-1);
          if (open?.to === null) {
            return current;
          }
          if (!sameSessions(active.sessions ?? [], snapshot)) {
            return current;
          }
          appendSessionSegment(active, session);
          return current;
        },
      );
      const open = updated.execution.attempts
        .find((entry) => entry.id === attempt.id)
        ?.sessions?.at(-1);
      return open?.to === null ? { ...open } : null;
    } catch {
      // A concurrent command changed the record; the next observation retries.
      return null;
    }
  };

  /** Appends a session through the command queue, for background collection. */
  const appendSessionQueued = async (
    symphonyId: string,
    attemptId: string,
    agentId: string,
    snapshot: readonly AttemptSessionSegment[],
    session: SessionIdentity,
  ): Promise<AttemptSessionSegment | null> => {
    return mutate(async () => {
      if (closed) {
        return null;
      }
      let found: Awaited<ReturnType<typeof findAttempt>>;
      try {
        found = await findAttempt(symphonyId, attemptId);
      } catch {
        return null;
      }
      if (!found || found.attempt.agentId !== agentId) {
        return null;
      }
      const open = found.attempt.sessions?.at(-1);
      if (open?.to === null) {
        return { ...open };
      }
      if (!sameSessions(found.attempt.sessions ?? [], snapshot)) {
        return null;
      }
      return appendSession(found, session);
    });
  };

  const readWindow = async (window: SettlementWindow): Promise<UsageRead> => {
    const totals = { input: 0, cached: 0, output: 0 };
    const known = { input: true, cached: true, output: true };
    let results = 0;
    let missing = false;
    let eligible = 0;
    for (const session of window.sessions) {
      const from = Math.max(window.startedAt, session.from);
      const to = Math.min(window.endedAt, session.to ?? window.endedAt);
      if (from > to) {
        continue;
      }
      eligible += 1;
      const reader = runtime.readerFor(session.provider);
      if (!reader) {
        return { usage: null, retry: false, unsupported: true };
      }
      let usage: AttemptUsage | null = null;
      try {
        usage = await reader.read(session.id, from, to);
      } catch {
        usage = null;
      }
      if (!usage) {
        missing = true;
        continue;
      }
      results += 1;
      for (const field of ["input", "cached", "output"] as const) {
        const value = usage[field];
        if (value === undefined) {
          known[field] = false;
        } else {
          totals[field] += value;
        }
      }
    }
    if (eligible === 0) {
      return { usage: null, retry: false, unsupported: false };
    }
    if (results === 0) {
      return { usage: null, retry: missing, unsupported: false };
    }
    if (missing) {
      // A segment log is not readable yet; retry rather than claim a complete
      // total from only part of the attempt.
      return { usage: null, retry: true, unsupported: false };
    }
    const usage: AttemptUsage = {};
    for (const field of ["input", "cached", "output"] as const) {
      if (known[field]) {
        usage[field] = totals[field];
      }
    }
    return {
      usage: Object.keys(usage).length ? usage : null,
      retry: false,
      unsupported: false,
    };
  };

  /** Stores reader totals only while the exact settlement window still holds. */
  const storeUsage = async (
    symphonyId: string,
    attemptId: string,
    window: SettlementWindow,
    usage: AttemptUsage,
  ): Promise<void> => {
    await mutate(async () => {
      for (let round = 0; round < 3; round += 1) {
        if (closed) {
          return;
        }
        let found: Awaited<ReturnType<typeof findAttempt>>;
        try {
          found = await findAttempt(symphonyId, attemptId);
        } catch {
          return;
        }
        if (
          closed ||
          !found ||
          found.attempt.usage ||
          !sameWindow(found.attempt, window)
        ) {
          return;
        }
        const { symphony } = found;
        const collectedAt = runtime.now();
        try {
          await store.update(symphony.id, symphony.version, (current) => {
            if (closed) {
              return current;
            }
            const attempt = current.execution.attempts.find(
              (entry) => entry.id === attemptId,
            );
            if (!attempt || attempt.usage || !sameWindow(attempt, window)) {
              return current;
            }
            attempt.usage = { ...usage, collectedAt };
            return current;
          });
          return;
        } catch {
          // An external writer won the version race; re-read and try again.
        }
      }
    });
  };

  const finish = (key: string): void => {
    const entry = pending.get(key);
    if (!entry) {
      return;
    }
    if (closed) {
      pending.delete(key);
      return;
    }
    if (entry.dirty) {
      entry.dirty = false;
      enqueue(key, 0);
    } else {
      pending.delete(key);
    }
  };

  const collectOnce = async (key: string, retry: number): Promise<void> => {
    const entry = pending.get(key);
    if (!entry || closed) {
      return;
    }
    // A fresh read below covers any settlement that arrived before this run.
    entry.dirty = false;
    const [symphonyId, attemptId] = key.split(":") as [string, string];
    let found: Awaited<ReturnType<typeof findAttempt>>;
    try {
      found = await findAttempt(symphonyId, attemptId);
    } catch {
      finish(key);
      return;
    }
    if (!found || found.attempt.usage || found.attempt.endedAt === null) {
      finish(key);
      return;
    }
    if (!found.attempt.sessions?.some((session) => session.to === null)) {
      const agentId = found.attempt.agentId;
      const snapshot = copySessions(found.attempt.sessions);
      let session: SessionIdentity | null;
      try {
        session = await runtime.sessionOf(agentId);
      } catch {
        session = null;
      }
      if (session) {
        await appendSessionQueued(
          symphonyId,
          attemptId,
          agentId,
          snapshot,
          session,
        );
      }
      try {
        found = await findAttempt(symphonyId, attemptId);
      } catch {
        finish(key);
        return;
      }
    }
    if (
      closed ||
      !found ||
      found.attempt.usage ||
      found.attempt.endedAt === null
    ) {
      finish(key);
      return;
    }
    if (!found.attempt.sessions?.length) {
      if (retry < retryDelays.length) {
        enqueue(key, retry + 1);
      } else {
        finish(key);
      }
      return;
    }
    const window = captureWindow(found.attempt);
    if (!window) {
      finish(key);
      return;
    }
    const read = await readWindow(window);
    if (closed) {
      finish(key);
      return;
    }
    if (read.usage) {
      await storeUsage(symphonyId, attemptId, window, read.usage);
      finish(key);
      return;
    }
    if (read.retry && retry < retryDelays.length) {
      enqueue(key, retry + 1);
    } else {
      finish(key);
    }
  };

  const enqueue = (key: string, retry: number): void => {
    if (closed) {
      return;
    }
    const delay = retry === 0 ? firstDelay : (retryDelays[retry - 1] ?? 0);
    const timer: { handle: unknown } = { handle: undefined };
    timer.handle = runtime.setTimer(() => {
      timers.delete(timer.handle);
      if (closed) {
        return;
      }
      const work = collectOnce(key, retry);
      inFlight.add(work);
      void work.then(
        () => inFlight.delete(work),
        () => inFlight.delete(work),
      );
    }, delay);
    timers.add(timer.handle);
  };

  return {
    async observe(symphonyId, attemptId) {
      if (closed) {
        return;
      }
      try {
        const found = await findAttempt(symphonyId, attemptId);
        if (!found || found.attempt.sessions?.at(-1)?.to === null) {
          return;
        }
        let session: SessionIdentity | null;
        try {
          session = await runtime.sessionOf(found.attempt.agentId);
        } catch {
          return;
        }
        if (session) {
          await appendSession(found, session);
        }
      } catch {
        // Observation is best effort; usage stays absent when it fails.
      }
    },
    async observeAll() {
      if (closed) {
        return;
      }
      let list: Awaited<ReturnType<typeof store.list>>;
      try {
        list = await store.list();
      } catch {
        return;
      }
      for (const summary of list.symphonies) {
        if (closed) {
          return;
        }
        if (summary.status === "completed" || summary.status === "failed") {
          continue;
        }
        let symphony: Awaited<ReturnType<typeof store.read>>;
        try {
          symphony = await store.read(summary.id);
        } catch {
          continue;
        }
        for (const attempt of symphony.symphony.execution.attempts) {
          if (closed) {
            return;
          }
          if (
            attempt.endedAt !== null ||
            attempt.sessions?.at(-1)?.to === null
          ) {
            continue;
          }
          await this.observe(symphony.symphony.id, attempt.id);
        }
      }
    },
    collect(symphonyId, attemptId) {
      if (closed) {
        return;
      }
      const key = `${symphonyId}:${attemptId}`;
      const existing = pending.get(key);
      if (existing) {
        // A newer settlement must not be hidden by an in-flight read.
        existing.dirty = true;
        return;
      }
      pending.set(key, { dirty: false });
      try {
        enqueue(key, 0);
      } catch {
        pending.delete(key);
      }
    },
    setMutation(next) {
      mutate = next;
    },
    async close() {
      closed = true;
      for (const handle of timers) {
        runtime.clearTimer(handle);
      }
      timers.clear();
      pending.clear();
      await Promise.allSettled([...inFlight]);
    },
  };
}
