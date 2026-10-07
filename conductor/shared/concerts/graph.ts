import { graphSchema, type RunGraph, type TaskDefinition } from "./models";

export function graphIssues(graph: RunGraph): string[] {
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

const overlap = (a: string, b: string) =>
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

/** A planning projection only: prerequisites and resource conflicts are distinct. */
export function projectGraph(graph: RunGraph) {
  return graph.tasks.map((task) => ({
    task,
    waitsFor: [...task.prerequisites],
    conflicts: graph.tasks.flatMap((other) => {
      const reason = other.id === task.id ? null : conflictReason(task, other);
      return reason ? [{ taskId: other.id, reason }] : [];
    }),
  }));
}
