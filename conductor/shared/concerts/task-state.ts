import type { RunAttempt, StoredRun, TaskDefinition } from "./models";
import { latestAttempt } from "./models";

/**
 * Display states for a single task. These are render-only projections; they
 * never change scheduling or run storage.
 */
export type TaskStateKey =
  | "ready"
  | "waiting"
  | "running"
  | "blocked"
  | "finishing"
  | "completed"
  | "failed";

export interface TaskDisplayState {
  key: TaskStateKey;
  label: string;
  /** Prerequisite task IDs the task is still waiting on (empty unless waiting). */
  waitingFor: string[];
}

const LABELS: Record<TaskStateKey, string> = {
  ready: "Ready",
  waiting: "Waiting",
  running: "Running",
  blocked: "Blocked",
  finishing: "Finishing",
  completed: "Completed",
  failed: "Failed",
};

/**
 * True when the task's agent is still settling: a launch exists on the attempt
 * and has not been marked settled, so the work is not inertly done.
 */
function unsettled(attempt: RunAttempt | undefined): boolean {
  return Boolean(attempt?.launch && !attempt.launch.settled);
}

/**
 * Derive the display state of one task from a stored run. Latest-attempt
 * outcome wins for running/blocked/failed; a completed attempt whose agent
 * launch is still settling reads as "finishing"; legacy completed attempts
 * without launch metadata read as "completed". With no attempt, the task
 * waits on every prerequisite that lacks a completed report or still has an
 * unsettled launch, otherwise it is ready. Idle is never treated as completion.
 */
export function taskState(
  run: StoredRun,
  task: TaskDefinition,
): TaskDisplayState {
  const attempt = latestAttempt(run, task.id);
  if (attempt) {
    if (
      attempt.state === "running" ||
      attempt.state === "blocked" ||
      attempt.state === "failed"
    ) {
      return {
        key: attempt.state,
        label: LABELS[attempt.state],
        waitingFor: [],
      };
    }
    if (attempt.state === "completed") {
      return unsettled(attempt)
        ? { key: "finishing", label: LABELS.finishing, waitingFor: [] }
        : { key: "completed", label: LABELS.completed, waitingFor: [] };
    }
  }
  const waitingFor = task.prerequisites.filter((id) => {
    const prerequisite = latestAttempt(run, id);
    return prerequisite?.state !== "completed" || unsettled(prerequisite);
  });
  return waitingFor.length
    ? { key: "waiting", label: LABELS.waiting, waitingFor }
    : { key: "ready", label: LABELS.ready, waitingFor: [] };
}
