import type { Attempt, StoredSymphony } from "./models";

/** Token fields the harness readers can report, one sum per field. */
export const TOKEN_FIELDS = ["input", "cached", "output"] as const;
export type TokenField = (typeof TOKEN_FIELDS)[number];

/**
 * How many attempts accounted for a token field. `partial` means at least one
 * attempt is missing it, so the sum is a lower bound; `unknown` means none has
 * it.
 */
export type TokenCoverage = "unknown" | "partial" | "complete";

export type TokenSum =
  | { readonly coverage: "unknown"; readonly total: null }
  | { readonly coverage: "partial" | "complete"; readonly total: number };

export interface TokenTotals {
  readonly input: TokenSum;
  readonly cached: TokenSum;
  readonly output: TokenSum;
}

export interface AttemptMetrics {
  /** Wall time from `startedAt` to `endedAt`, or to `now` while open. */
  readonly wallMs: number;
  /** Wall time minus recorded blocked time, never negative. */
  readonly workMs: number;
  /** Sum of closed intervals plus open intervals up to `now`. */
  readonly blockedMs: number;
  /** True for a record without `blocked`; its work time equals wall time. */
  readonly legacy: boolean;
  readonly tokens: TokenTotals;
}

export interface DurationTotals {
  /** Summed work time over the included attempts. */
  readonly workMs: number;
  /** Summed blocked time over the included attempts. */
  readonly blockedMs: number;
  /** First attempt start to last attempt end (or `now` while open). */
  readonly elapsedMs: number;
  readonly attemptCount: number;
  /** Attempts without `blocked`; their work time is wall time, not measured. */
  readonly legacyAttempts: number;
}

export interface TaskMetrics extends DurationTotals {
  readonly tokens: TokenTotals;
}

export interface SymphonyMetrics extends DurationTotals {
  readonly tokens: TokenTotals;
}

function intervalEnd(interval: { to: number | null }, now: number): number {
  return interval.to ?? now;
}

/** True when an attempt records blocked intervals. Legacy records omit them. */
export function tracksBlockedTime(attempt: Attempt): boolean {
  return attempt.blocked !== undefined;
}

/** True when an attempt predates blocked-time tracking. */
export function isLegacyAttempt(attempt: Attempt): boolean {
  return attempt.blocked === undefined;
}

export function wallMs(attempt: Attempt, now: number): number {
  return Math.max(0, (attempt.endedAt ?? now) - attempt.startedAt);
}

/** Sums blocked intervals, counting an open interval up to `now`. */
export function blockedMs(attempt: Attempt, now: number): number {
  let total = 0;
  for (const interval of attempt.blocked ?? []) {
    total += Math.max(0, intervalEnd(interval, now) - interval.from);
  }
  return total;
}

/**
 * Wall time minus blocked time. A legacy attempt has no blocked intervals, so
 * its work time is its wall time.
 */
export function workMs(attempt: Attempt, now: number): number {
  return Math.max(0, wallMs(attempt, now) - blockedMs(attempt, now));
}

export function attemptMetrics(attempt: Attempt, now: number): AttemptMetrics {
  const wall = wallMs(attempt, now);
  const blocked = blockedMs(attempt, now);
  return {
    wallMs: wall,
    workMs: Math.max(0, wall - blocked),
    blockedMs: blocked,
    legacy: isLegacyAttempt(attempt),
    tokens: sumTokens([attempt]),
  };
}

/**
 * Sums one token field over attempts. Fields are optional and absent means
 * unknown, so a sum over only some attempts is marked `partial`.
 */
export function sumTokenField(
  attempts: readonly Attempt[],
  field: TokenField,
): TokenSum {
  let total = 0;
  let known = 0;
  for (const attempt of attempts) {
    const value = attempt.usage?.[field];
    if (value !== undefined) {
      total += value;
      known += 1;
    }
  }
  if (known === 0) {
    return { coverage: "unknown", total: null };
  }
  return {
    coverage: known === attempts.length ? "complete" : "partial",
    total,
  };
}

export function sumTokens(attempts: readonly Attempt[]): TokenTotals {
  return {
    input: sumTokenField(attempts, "input"),
    cached: sumTokenField(attempts, "cached"),
    output: sumTokenField(attempts, "output"),
  };
}

function sumAttemptDurations(
  attempts: readonly Attempt[],
  now: number,
): Omit<DurationTotals, "elapsedMs"> {
  let work = 0;
  let blocked = 0;
  let legacyAttempts = 0;
  for (const attempt of attempts) {
    // Inline the attempt totals so wall time is not computed twice per record.
    const wall = wallMs(attempt, now);
    const waiting = blockedMs(attempt, now);
    work += Math.max(0, wall - waiting);
    blocked += waiting;
    if (isLegacyAttempt(attempt)) {
      legacyAttempts += 1;
    }
  }
  return {
    workMs: work,
    blockedMs: blocked,
    attemptCount: attempts.length,
    legacyAttempts,
  };
}

function attemptSpan(attempts: readonly Attempt[], now: number): number {
  let firstStart = Number.POSITIVE_INFINITY;
  let lastEnd = Number.NEGATIVE_INFINITY;
  for (const attempt of attempts) {
    firstStart = Math.min(firstStart, attempt.startedAt);
    lastEnd = Math.max(lastEnd, attempt.endedAt ?? now);
  }
  return attempts.length === 0 ? 0 : Math.max(0, lastEnd - firstStart);
}

/** Totals for one task, from all of its attempts (in any order). */
export function taskMetrics(
  attempts: readonly Attempt[],
  now: number,
): TaskMetrics {
  return {
    ...sumAttemptDurations(attempts, now),
    elapsedMs: attemptSpan(attempts, now),
    tokens: sumTokens(attempts),
  };
}

/** Totals for a symphony: creation to finish (or `now`), plus all attempts. */
export function symphonyMetrics(
  symphony: StoredSymphony,
  now: number,
): SymphonyMetrics {
  return {
    ...sumAttemptDurations(symphony.execution.attempts, now),
    elapsedMs: Math.max(
      0,
      (symphony.execution.finishedAt ?? now) - symphony.createdAt,
    ),
    tokens: sumTokens(symphony.execution.attempts),
  };
}

/** Aliases matching the totals wording used by callers and History. */
export const taskTotals = taskMetrics;
export const symphonyTotals = symphonyMetrics;
export const tokenTotals = sumTokens;
