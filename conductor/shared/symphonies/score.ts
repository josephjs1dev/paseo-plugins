import {
  scoreSchema,
  taskAttempts,
  type Attempt,
  type GrantedWrite,
  type Score,
  type StoredSymphony,
  type TaskDefinition,
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
    for (const dependency of tasks.get(id)?.prerequisites ?? []) {
      if (!visit(dependency)) {
        return false;
      }
    }
    visiting.delete(id);
    visited.add(id);
    return true;
  };
  if (score.tasks.some((task) => !visit(task.id))) {
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
