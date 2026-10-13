import {
  isReviewTask,
  latestAttempt,
  scoreSchema,
  taskAttempts,
  type Attempt,
  type CheckReport,
  type GrantedWrite,
  type LoopRecord,
  type LoopReopen,
  type Score,
  type StoredSymphony,
  type TaskDefinition,
  type TaskFinding,
} from "./models";

export function scoreIssues(score: Score): string[] {
  const parsed = scoreSchema.safeParse(score);
  if (!parsed.success) {
    return parsed.error.issues.map(
      (issue) => `${issue.path.join(".")}: ${issue.message}`,
    );
  }
  const issues: string[] = [];
  const tasks = new Map(score.tasks.map((task) => [task.id, task]));
  if (tasks.size !== score.tasks.length) {
    issues.push("Task IDs must be unique.");
  }
  for (const task of score.tasks) {
    if (new Set(task.prerequisites).size !== task.prerequisites.length) {
      issues.push(`${task.id}: prerequisites must be unique.`);
    }
    for (const dependency of task.prerequisites) {
      if (!tasks.has(dependency)) {
        issues.push(`${task.id}: missing prerequisite ${dependency}.`);
      }
    }
    if (task.worker.role === "exploration" && task.writes.length) {
      issues.push(`${task.id}: exploration cannot declare writes.`);
    }
  }
  if (prerequisiteCycle(score.tasks)) {
    issues.push("Prerequisites must not contain a cycle.");
  }
  return issues;
}

/**
 * Whether two repository scopes share any path. "." is the repository root and
 * therefore overlaps every scope; otherwise a scope overlaps itself, its
 * descendants, and its ancestors. Shared with widen so the growth check uses
 * the same path rule as conflict detection.
 */
export const overlap = (a: string, b: string) =>
  a === "." ||
  b === "." ||
  a === b ||
  a.startsWith(`${b}/`) ||
  b.startsWith(`${a}/`);

export function conflictReason(
  a: TaskDefinition,
  b: TaskDefinition,
): string | null {
  if (a.resources.some((resource) => b.resources.includes(resource))) {
    return "shared exclusive resource";
  }
  if (
    a.writes.some((path) =>
      [...b.reads, ...b.writes].some((other) => overlap(path, other)),
    ) ||
    b.writes.some((path) => a.reads.some((other) => overlap(path, other)))
  ) {
    return "overlapping read/write scope";
  }
  return null;
}

/** The attempt fields that contribute to an effective write scope. */
type AttemptScope = Pick<Attempt, "addedWrites" | "grantedWrites">;

/**
 * The write paths a task covers across these attempts: its declared writes,
 * every Conductor addition from any attempt, and the latest attempt's `widen`
 * grants. Order follows first appearance.
 */
function writesAcrossAttempts(
  task: TaskDefinition,
  attempts: readonly AttemptScope[],
): string[] {
  const added = attempts.flatMap(
    (attempt) => attempt.addedWrites?.map((grant) => grant.path) ?? [],
  );
  const granted =
    attempts.at(-1)?.grantedWrites?.map((grant) => grant.path) ?? [];
  return [...new Set([...task.writes, ...added, ...granted])];
}

/**
 * A task's effective definition for conflict checks: its declared writes plus
 * every path the Conductor added to one of its attempts (`addedWrites`, which
 * lasts for the task) plus the latest attempt's `widen` grants (which last for
 * that attempt). Pure; returns the task unchanged when nothing widens it. A
 * read-only task that gains writes is an implementation, so the role follows
 * the effective writes.
 */
export function effectiveTask(
  symphony: StoredSymphony,
  task: TaskDefinition,
): TaskDefinition {
  const writes = writesAcrossAttempts(task, taskAttempts(symphony, task.id));
  if (writes.length === task.writes.length) {
    return task;
  }
  return {
    ...task,
    writes,
    worker: {
      ...task.worker,
      role: writes.length ? "implementation" : task.worker.role,
    },
  };
}

/**
 * The write paths a task's next attempt starts with. The new attempt becomes
 * the latest one, so the previous attempt's temporary `widen` grants expire;
 * only the declared writes, every Conductor `addedWrites`, and this attempt's
 * own pending additions count. A blocked task that resumes its existing
 * attempt keeps its grants and uses `effectiveTask` instead.
 */
export function nextAttemptWrites(
  symphony: StoredSymphony,
  task: TaskDefinition,
  additions: readonly GrantedWrite[] = [],
): string[] {
  const attempts: AttemptScope[] = [
    ...taskAttempts(symphony, task.id),
    // The prospective attempt is always appended, even with no additions, so it
    // becomes the latest attempt and the previous attempt's grants expire.
    additions.length ? { addedWrites: [...additions] } : {},
  ];
  return writesAcrossAttempts(task, attempts);
}

/**
 * The conflict reason for two effective tasks that may start or grow: the
 * shared writer fence (two writers never overlap in time on one checkout) plus
 * `conflictReason`. `reserve`, claims, `widen`, and `addWrites` all use this so
 * the scheduling and growth checks cannot drift apart. Callers pass effective
 * tasks, so a granted path counts exactly like a declared write.
 */
export function scopeConflictReason(
  a: TaskDefinition,
  b: TaskDefinition,
): string | null {
  if (a.writes.length > 0 && b.writes.length > 0) {
    return "another writer holds resources";
  }
  return conflictReason(a, b);
}

/** A planning projection only: prerequisites and resource conflicts are distinct. */
export function projectScore(score: Score) {
  return score.tasks.map((task) => ({
    task,
    waitsFor: [...task.prerequisites],
    conflicts: score.tasks.flatMap((other) => {
      const reason = other.id === task.id ? null : conflictReason(task, other);
      return reason ? [{ taskId: other.id, reason }] : [];
    }),
  }));
}

// === Review loops ===

/** The loop an attempt ran in. Records stored before loops are loop 1. */
export function attemptLoop(attempt: Attempt): number {
  return attempt.loop ?? 1;
}

/**
 * The symphony's current loop: the highest loop any attempt ran in or any
 * `loop` command recorded, and at least 1 before the first attempt.
 */
export function currentLoop(symphony: StoredSymphony): number {
  const recorded = symphony.execution.conducting?.loops?.map(
    (loop) => loop.number,
  );
  return Math.max(
    1,
    ...symphony.execution.attempts.map(attemptLoop),
    ...(recorded ?? []),
  );
}

/**
 * The tasks that transitively depend on any task in `taskIds`, in score order.
 * The roots themselves are excluded, so the result is stable and easy to feed
 * back into `loop.reopen`.
 */
export function transitiveDependents(
  score: Score,
  taskIds: readonly string[],
): string[] {
  const roots = new Set(taskIds);
  const dependents = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const task of score.tasks) {
      if (roots.has(task.id) || dependents.has(task.id)) {
        continue;
      }
      if (
        task.prerequisites.some((id) => roots.has(id) || dependents.has(id))
      ) {
        dependents.add(task.id);
        changed = true;
      }
    }
  }
  return score.tasks
    .filter((task) => dependents.has(task.id))
    .map((task) => task.id);
}

/** A blocking finding with the task whose report produced it. */
export interface LoopFinding {
  reporterTaskId: string;
  /** The loop of the attempt whose report carries the finding. */
  loop: number;
  finding: TaskFinding;
}

/** A failed check with the task whose report produced it. */
export interface LoopFailedCheck {
  reporterTaskId: string;
  check: CheckReport;
}

export interface LoopVerdict {
  loop: number;
  /** True when no attempt is running and nothing more can start. */
  ended: boolean;
  verdict: "succeeded" | "needs-changes" | "attention";
  /**
   * Blocking findings still open: carried by the latest report of each task,
   * whichever loop produced it, so a deferred finding stays open.
   */
  findings: LoopFinding[];
  /** Failed checks of every latest needs-changes report. */
  failedChecks: LoopFailedCheck[];
}

/**
 * True while an attempt still occupies its task: running, or launched and not
 * yet settled. An unsettled launch may still be running whatever it reported.
 */
export function attemptActive(attempt: Attempt): boolean {
  return (
    attempt.state === "running" ||
    (attempt.launch !== undefined && !attempt.launch.settled)
  );
}

/**
 * Whether a prerequisite's attempt lets a dependent start. A review task may
 * start once a prerequisite settled as completed or needs-changes; any other
 * task waits for completed. An active or failed attempt never counts.
 */
export function prerequisiteSettles(
  attempt: Attempt | undefined,
  review: boolean,
): boolean {
  if (!attempt || attemptActive(attempt)) {
    return false;
  }
  if (attempt.state === "completed") {
    return true;
  }
  return review && attempt.state === "needs-changes";
}

/** The record of the symphony's current loop; loop 1 has none. */
export function currentLoopRecord(
  symphony: StoredSymphony,
): LoopRecord | undefined {
  const loop = currentLoop(symphony);
  return symphony.execution.conducting?.loops?.find(
    (entry) => entry.number === loop,
  );
}

/** Why a task runs in a loop: an explicit reopen or a prerequisite change. */
export interface LoopScheduleEntry {
  /** The `loop` reopen entry, absent for a transitive dependent. */
  reopen?: LoopReopen;
  /** Reopened tasks this dependent transitively depends on. */
  changed: string[];
}

/**
 * The tasks a loop record schedules: each explicit reopen plus every
 * transitive dependent of a reopened task, in score order.
 */
export function loopSchedule(
  score: Score,
  record: LoopRecord,
): Map<string, LoopScheduleEntry> {
  const schedule = new Map<string, LoopScheduleEntry>();
  const roots = record.reopened.map((entry) => entry.taskId);
  const dependents = new Set(transitiveDependents(score, roots));
  for (const task of score.tasks) {
    const reopen = record.reopened.find((entry) => entry.taskId === task.id);
    if (reopen) {
      schedule.set(task.id, { reopen, changed: [] });
    } else if (dependents.has(task.id)) {
      schedule.set(task.id, {
        changed: roots.filter((root) =>
          transitiveDependents(score, [root]).includes(task.id),
        ),
      });
    }
  }
  return schedule;
}

/**
 * The current loop's schedule entry for a task that has not run in this loop
 * yet, or null when the task is not waiting for a loop attempt.
 */
export function pendingLoopEntry(
  symphony: StoredSymphony,
  taskId: string,
): LoopScheduleEntry | null {
  const record = currentLoopRecord(symphony);
  const score = symphony.revisions.at(-1)?.score;
  if (!record || !score) {
    return null;
  }
  const latest = latestAttempt(symphony, taskId);
  if (latest && attemptLoop(latest) >= record.number) {
    return null;
  }
  return loopSchedule(score, record).get(taskId) ?? null;
}

/**
 * A task's prerequisites in the current loop: its declared prerequisites plus
 * the loop-only `after` prerequisites of its reopen entry.
 */
export function loopPrerequisites(
  symphony: StoredSymphony,
  task: TaskDefinition,
): string[] {
  const after =
    currentLoopRecord(symphony)?.reopened.find(
      (entry) => entry.taskId === task.id,
    )?.after ?? [];
  return [...new Set([...task.prerequisites, ...after])];
}

/**
 * Whether prerequisite `id` lets a dependent start in the current loop. A
 * prerequisite scheduled to run again in this loop is not settled until its
 * new attempt settles, even though it settled in an earlier loop.
 */
export function prerequisiteReady(
  symphony: StoredSymphony,
  id: string,
  review: boolean,
): boolean {
  return (
    pendingLoopEntry(symphony, id) === null &&
    prerequisiteSettles(latestAttempt(symphony, id), review)
  );
}

/**
 * True when the prerequisite graph, given as task ids and their
 * prerequisites, contains a cycle. Unknown prerequisites are ignored.
 */
export function prerequisiteCycle(
  tasks: readonly { id: string; prerequisites: readonly string[] }[],
): boolean {
  const graph = new Map(tasks.map((task) => [task.id, task.prerequisites]));
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) {
      return false;
    }
    if (visited.has(id)) {
      return true;
    }
    visiting.add(id);
    for (const dependency of graph.get(id) ?? []) {
      if (!visit(dependency)) {
        return false;
      }
    }
    visiting.delete(id);
    visited.add(id);
    return true;
  };
  return tasks.some((task) => !visit(task.id));
}

/**
 * The blocking findings and failed checks still open: those carried by the
 * latest needs-changes report of each task, whichever loop produced it. A
 * deferred item therefore stays open until a later attempt of its reporter
 * supersedes it.
 */
export function openLoopItems(symphony: StoredSymphony): {
  findings: LoopFinding[];
  failedChecks: LoopFailedCheck[];
} {
  const findings: LoopFinding[] = [];
  const failedChecks: LoopFailedCheck[] = [];
  for (const task of symphony.revisions.at(-1)?.score.tasks ?? []) {
    const attempt = latestAttempt(symphony, task.id);
    if (attempt?.state !== "needs-changes" || !attempt.report) {
      continue;
    }
    for (const finding of attempt.report.findings ?? []) {
      if (finding.severity === "blocking") {
        findings.push({
          reporterTaskId: task.id,
          loop: attemptLoop(attempt),
          finding,
        });
      }
    }
    for (const check of attempt.report.checks) {
      if (check.status === "failed") {
        failedChecks.push({ reporterTaskId: task.id, check });
      }
    }
  }
  return { findings, failedChecks };
}

/**
 * The loop end and its verdict, derived only from the score, the current loop
 * record and attempts.
 *
 * A task scheduled by the current loop that has not run in it yet counts as
 * pending, like a task with no attempt. `ended` is true when no attempt is
 * active and no pending task can start: each prerequisite (including loop-only
 * `after` prerequisites) is pending itself or not settled as completed (or, for
 * a review, completed or needs-changes). The verdict is `succeeded` when every
 * task's latest attempt completed and nothing is pending, `needs-changes` when
 * the loop ended with open work, and `attention` while the loop is unfinished
 * or a task is failed/blocked (the Conductor's existing recovery runs first).
 */
export function loopVerdict(symphony: StoredSymphony): LoopVerdict {
  const loop = currentLoop(symphony);
  const tasks = symphony.revisions.at(-1)?.score.tasks ?? [];
  let canStart = false;
  let failedOrBlocked = false;
  let allCompleted = true;
  for (const task of tasks) {
    const attempt = latestAttempt(symphony, task.id);
    if (!attempt || pendingLoopEntry(symphony, task.id)) {
      allCompleted = false;
      const review = isReviewTask(task);
      if (
        loopPrerequisites(symphony, task).every((id) =>
          prerequisiteReady(symphony, id, review),
        )
      ) {
        canStart = true;
      }
      continue;
    }
    if (attemptActive(attempt)) {
      canStart = true;
      allCompleted = false;
      continue;
    }
    if (attempt.state === "failed" || attempt.state === "blocked") {
      failedOrBlocked = true;
      allCompleted = false;
      continue;
    }
    if (attempt.state !== "completed") {
      allCompleted = false;
    }
  }
  const ended = !canStart;
  let verdict: LoopVerdict["verdict"];
  if (failedOrBlocked || !ended) {
    verdict = "attention";
  } else if (allCompleted) {
    verdict = "succeeded";
  } else {
    verdict = "needs-changes";
  }
  return { loop, ended, verdict, ...openLoopItems(symphony) };
}
