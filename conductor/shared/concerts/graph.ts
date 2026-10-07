import {
  graphSchema,
  type ConcertAttempt,
  type ConcertGraph,
  type TaskDefinition,
} from "./models";

export function graphIssues(graph: ConcertGraph): string[] {
  const parsed = graphSchema.safeParse(graph);
  if (!parsed.success) {
    return parsed.error.issues.map(
      (issue) => `${issue.path.join(".")}: ${issue.message}`,
    );
  }
  const issues: string[] = [];
  const tasks = new Map(graph.tasks.map((task) => [task.id, task]));
  if (tasks.size !== graph.tasks.length) {
    issues.push("Task IDs must be unique.");
  }
  for (const task of graph.tasks) {
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
  if (graph.tasks.some((task) => !visit(task.id))) {
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

/**
 * A task's effective definition for conflict checks: its declared writes plus
 * every path granted to the given attempt. Pure; returns the task unchanged
 * when the attempt has no grants. Callers pass the resource-holding attempt
 * (for example the latest attempt that still owns resources) so a grant blocks
 * readers and other writers exactly like a declared write.
 */
export function effectiveTask(
  task: TaskDefinition,
  attempt?: ConcertAttempt,
): TaskDefinition {
  const granted = attempt?.grantedWrites?.map((grant) => grant.path) ?? [];
  if (granted.length === 0) {
    return task;
  }
  return { ...task, writes: [...new Set([...task.writes, ...granted])] };
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
export function projectGraph(graph: ConcertGraph) {
  return graph.tasks.map((task) => ({
    task,
    waitsFor: [...task.prerequisites],
    conflicts: graph.tasks.flatMap((other) => {
      const reason = other.id === task.id ? null : conflictReason(task, other);
      return reason ? [{ taskId: other.id, reason }] : [];
    }),
  }));
}
