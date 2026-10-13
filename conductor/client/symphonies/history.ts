/**
 * Render-only derivations for the loop-grouped History view. Pure data with no
 * React Native imports: the inspection view consumes these records directly.
 */
import {
  previousFindingCount,
  type Attempt,
  type LoopRecord,
  type Score,
  type StoredSymphony,
  type UnresolvedItem,
} from "../../shared/symphonies/models";
import {
  attemptLoop,
  currentLoop,
  loopVerdict,
} from "../../shared/symphonies/score";
import type { TaskStateKey } from "../../shared/symphonies/task-state";

/** What a finished loop reports at the top of its History section. */
export type HistoryLoopVerdict = "succeeded" | "needs-changes" | "attention";

/** One loop's History section: header facts plus that loop's attempts. */
export interface HistoryLoopGroup {
  readonly loop: number;
  readonly verdict: HistoryLoopVerdict;
  /** Blocking findings the loop's latest needs-changes reports collected. */
  readonly blocking: number;
  /** Why the Conductor started this loop; absent for loop 1. */
  readonly reason?: string;
  /** Recorded user answer when the Conductor looped past the budget. */
  readonly approval?: { loops: number; userAnswer: string };
  /** Every section the Conductor deferred when starting this loop. */
  readonly deferred: readonly HistoryDeferredItem[];
  /** The loop's attempts, oldest first, as stored. */
  readonly attempts: readonly Attempt[];
  /** True while any attempt in this loop is running or still settling. */
  readonly running: boolean;
}

export interface HistoryDeferredItem {
  readonly label: string;
  readonly reason: string;
}

/** The loops a symphony recorded, ascending. Empty when it ran once. */
export function historyLoops(
  symphony: StoredSymphony,
): readonly HistoryLoopGroup[] {
  const records = symphony.execution.conducting?.loops ?? [];
  const numbers = [
    ...new Set([
      ...symphony.execution.attempts.map(attemptLoop),
      ...records.map((record) => record.number),
    ]),
  ].sort((a, b) => a - b);
  return numbers.map((loop) => group(symphony, records, loop));
}

/** True when History must render loop group headers (more than one loop). */
export function hasLoopGroups(symphony: StoredSymphony): boolean {
  return historyLoops(symphony).length > 1;
}

function group(
  symphony: StoredSymphony,
  records: readonly LoopRecord[],
  loop: number,
): HistoryLoopGroup {
  const record = records.find((entry) => entry.number === loop);
  const attempts = symphony.execution.attempts.filter(
    (attempt) => attemptLoop(attempt) === loop,
  );
  const { running, verdict, blocking } =
    loop >= currentLoop(symphony)
      ? currentLoopFacts(symphony)
      : pastLoopFacts(attempts, records, loop);
  return {
    loop,
    running,
    blocking,
    verdict,
    ...(record?.reason ? { reason: record.reason } : {}),
    ...(record?.approval ? { approval: record.approval } : {}),
    deferred: (record?.deferred ?? []).map((item) => ({
      label: item.finding ?? item.taskId ?? "unresolved item",
      reason: item.reason,
    })),
    attempts,
  };
}

/**
 * The current loop speaks with the server's own verdict, including tasks the
 * loop scheduled that have not started yet, so History never calls a partial
 * loop finished or a failed task "needs changes".
 */
function currentLoopFacts(symphony: StoredSymphony) {
  const verdict = loopVerdict(symphony);
  return {
    running: !verdict.ended,
    verdict: verdict.verdict,
    blocking: verdict.findings.length,
  };
}

/**
 * A past loop always ended needing changes: `loop` starts the next one only
 * then. Its blocking count is the snapshot the next loop captured when it
 * started, or the loop's own latest reports for older records.
 */
function pastLoopFacts(
  attempts: readonly Attempt[],
  records: readonly LoopRecord[],
  loop: number,
) {
  const next = records.find((entry) => entry.number === loop + 1);
  const latest = new Map<string, Attempt>();
  for (const attempt of attempts) {
    latest.set(attempt.taskId, attempt);
  }
  const blocking =
    (next ? previousFindingCount(next) : undefined) ??
    [...latest.values()]
      .filter((attempt) => attempt.state === "needs-changes")
      .flatMap((attempt) => attempt.report?.findings ?? [])
      .filter((finding) => finding.severity === "blocking").length;
  return { running: false, verdict: "needs-changes" as const, blocking };
}

/**
 * A task's state inside one loop group: the group's own last attempt outcome,
 * with an unsettled launch reading as finishing. Unlike the current task state,
 * a historical loop always speaks for its own attempts.
 */
export function groupedTaskState(attempt: Attempt): TaskStateKey {
  if (
    attempt.state === "completed" &&
    attempt.launch !== undefined &&
    !attempt.launch.settled
  ) {
    return "finishing";
  }
  return attempt.state;
}

/**
 * The loop's verdict line: "in progress" while the work still runs, "needs
 * attention" while a failed or blocked task waits for recovery, else the
 * produced verdict with the blocking count when it needs changes.
 */
export function loopVerdictLabel(group: HistoryLoopGroup): string {
  if (group.running) {
    return "in progress";
  }
  if (group.verdict === "succeeded") {
    return "succeeded";
  }
  if (group.verdict === "attention") {
    return "needs attention";
  }
  return `needs changes${group.blocking ? ` (${group.blocking} blocking)` : ""}`;
}

/**
 * The symphony as it stood when `loop` ended: only attempts from that loop or
 * earlier, and only loop records up to it. A task that did not re-run in
 * `loop` keeps its earlier result, as the server's own verdict does. The
 * latest loop returns the symphony unchanged.
 */
export function symphonyAtLoop(
  symphony: StoredSymphony,
  loop: number,
): StoredSymphony {
  if (loop >= currentLoop(symphony)) {
    return symphony;
  }
  const conducting = symphony.execution.conducting;
  return {
    ...symphony,
    execution: {
      ...symphony.execution,
      attempts: symphony.execution.attempts.filter(
        (attempt) => attemptLoop(attempt) <= loop,
      ),
      ...(conducting
        ? {
            conducting: {
              ...conducting,
              loops: (conducting.loops ?? []).filter(
                (record) => record.number <= loop,
              ),
            },
          }
        : {}),
    },
  };
}

/** The score at `loop`: tasks a later loop appended are left out. */
export function scoreAtLoop(symphony: StoredSymphony, loop: number): Score {
  const score = symphony.revisions.at(-1)?.score ?? { tasks: [] };
  const later = new Set(
    (symphony.execution.conducting?.loops ?? [])
      .filter((record) => record.number > loop)
      .flatMap((record) => record.added),
  );
  return later.size
    ? { ...score, tasks: score.tasks.filter((task) => !later.has(task.id)) }
    : score;
}

/** The Conductor's record for starting `loop`; loop 1 has none. */
export function loopRecord(
  symphony: StoredSymphony,
  loop: number,
): LoopRecord | undefined {
  return symphony.execution.conducting?.loops?.find(
    (record) => record.number === loop,
  );
}

/**
 * Defers and unresolved items share one shape; label them identically so the
 * deferred History lines and the detail Unresolved panel read the same.
 */
export function unresolvedItemLabel(item: UnresolvedItem): string {
  return `${item.finding ?? item.taskId ?? "Open item"} — ${item.reason}`;
}
