import { createHash } from "node:crypto";
import {
  SYMPHONY_LIMITS,
  latestAttempt,
  type Attempt,
  type GrantedWrite,
  type StoredSymphony,
  type TaskDefinition,
  type TaskReport,
} from "../../shared/symphonies/models";
import { SymphonyError } from "./errors";

/**
 * True while an attempt still owns its task's resources: it has not reported,
 * or its launch has not settled. Write grants and writer conflicts last only
 * while this holds, so the same predicate decides when a granted path stops
 * counting.
 */
export function attemptHoldsResources(attempt: Attempt | undefined): boolean {
  return Boolean(
    attempt && (!attempt.report || (attempt.launch && !attempt.launch.settled)),
  );
}

/**
 * Counts `widen` calls from stored grants. Every path granted by one call shares
 * that call's timestamp, and grants use strictly increasing timestamps, so the
 * number of distinct values equals the number of calls.
 */
export function widenCalls(granted: readonly GrantedWrite[]): number {
  return new Set(granted.map((grant) => grant.at)).size;
}

export function requirePassingReport(
  task: TaskDefinition,
  report: TaskReport,
): void {
  if (report.outcome === "completed" && report.diagnosis) {
    throw new SymphonyError("A completed report cannot include a diagnosis.");
  }
  const names = report.checks.map((check) => check.name);
  if (new Set(names).size !== names.length) {
    throw new SymphonyError("Report check names must be unique.");
  }
  if (
    report.outcome === "completed" &&
    (report.checks.some((check) => check.status !== "passed") ||
      task.checks.some(
        (name) =>
          !report.checks.some(
            (check) => check.name === name && check.status === "passed",
          ),
      ))
  ) {
    throw new SymphonyError(
      "Completion requires passed evidence for every declared check. Report failure or a blocker otherwise.",
    );
  }
}

export function executionStatus(
  symphony: StoredSymphony,
): StoredSymphony["status"] {
  if (symphony.execution.finishedAt !== null) {
    return "completed";
  }
  if (symphony.execution.conducting?.phase === "planning") {
    return symphony.execution.interruption ? "blocked" : "planning";
  }
  const attempts =
    symphony.revisions
      .at(-1)
      ?.score.tasks.map((task) => latestAttempt(symphony, task.id)) ?? [];
  if (
    symphony.execution.interruption ||
    attempts.some((attempt) => attempt?.state === "blocked")
  ) {
    return "blocked";
  }
  if (attempts.some((attempt) => attempt?.state === "failed")) {
    return "failed";
  }
  if (attempts.some((attempt) => attempt?.state === "running")) {
    return "running";
  }
  return "ready";
}

export function validateExecution(symphony: StoredSymphony): void {
  const execution = symphony.execution;
  const score = symphony.revisions.at(-1)?.score;
  if (
    (!score && execution.conducting?.phase !== "planning") ||
    !symphony.source.agentId ||
    executionStatus(symphony) !== symphony.status
  ) {
    throw new SymphonyError("Symphony execution is inconsistent.");
  }
  if (
    (symphony.execution.summary !== null) !==
    (symphony.execution.finishedAt !== null)
  ) {
    throw new SymphonyError(
      "Symphony summary and completion must be recorded together.",
    );
  }
  if (symphony.execution.conducting?.phase === "planning") {
    if (
      symphony.execution.origin !== "conducted" ||
      score ||
      symphony.execution.attempts.length ||
      symphony.execution.finishedAt !== null
    ) {
      throw new SymphonyError("Planning symphony contains execution history.");
    }
    return;
  }
  if (
    !score ||
    (symphony.execution.origin === "conducted") !==
      Boolean(symphony.execution.conducting)
  ) {
    throw new SymphonyError("Orchestration metadata is inconsistent.");
  }
  const ids = new Set<string>();
  for (const attempt of symphony.execution.attempts) {
    const task = score.tasks.find((entry) => entry.id === attempt.taskId);
    const terminal =
      attempt.state === "completed" || attempt.state === "failed";
    if (
      !task ||
      ids.has(attempt.id) ||
      (symphony.execution.origin === "tracked" &&
        (attempt.agentId !== symphony.source.agentId || attempt.launch)) ||
      (symphony.execution.origin === "conducted" &&
        (!attempt.launch || attempt.agentId === symphony.source.agentId)) ||
      terminal !==
        Boolean(
          attempt.report && attempt.reportHash && attempt.endedAt !== null,
        ) ||
      (!terminal &&
        (attempt.report || attempt.reportHash || attempt.endedAt !== null))
    ) {
      throw new SymphonyError("Symphony attempt records are inconsistent.");
    }
    // Several attempts may share one agent when a failed task continues on the
    // same task agent, so only attempt ids must be unique.
    ids.add(attempt.id);
    if (attempt.grantedWrites?.length) {
      if (
        symphony.execution.origin !== "conducted" ||
        widenCalls(attempt.grantedWrites) > SYMPHONY_LIMITS.widenCallsPerAttempt
      ) {
        throw new SymphonyError("Symphony attempt grants are inconsistent.");
      }
    }
    if (
      !terminal &&
      latestAttempt(symphony, attempt.taskId)?.id !== attempt.id
    ) {
      throw new SymphonyError("An unfinished attempt cannot be superseded.");
    }
    if (attempt.report) {
      if (
        createHash("sha256")
          .update(JSON.stringify(attempt.report))
          .digest("hex") !== attempt.reportHash
      ) {
        throw new SymphonyError("Stored report integrity check failed.");
      }
      if (attempt.report.outcome !== attempt.state) {
        throw new SymphonyError("Report outcome does not match its attempt.");
      }
      requirePassingReport(task, attempt.report);
    }
  }
  if (
    symphony.execution.finishedAt !== null &&
    (!symphony.execution.summary ||
      score.tasks.some(
        (task) =>
          latestAttempt(symphony, task.id)?.state !== "completed" ||
          (symphony.execution.origin === "conducted" &&
            !latestAttempt(symphony, task.id)?.launch?.settled),
      ))
  ) {
    throw new SymphonyError("Symphony completion lacks task reports.");
  }
}
