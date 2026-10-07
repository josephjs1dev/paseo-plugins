import { createHash } from "node:crypto";
import {
  CONCERT_LIMITS,
  latestAttempt,
  type ConcertAttempt,
  type GrantedWrite,
  type StoredConcert,
  type TaskDefinition,
  type TaskReport,
} from "../../shared/concerts/models";
import { ConcertError } from "./errors";

/**
 * True while an attempt still owns its task's resources: it has not reported,
 * or its launch has not settled. Write grants and writer conflicts last only
 * while this holds, so the same predicate decides when a granted path stops
 * counting.
 */
export function attemptHoldsResources(
  attempt: ConcertAttempt | undefined,
): boolean {
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
    throw new ConcertError("A completed report cannot include a diagnosis.");
  }
  const names = report.checks.map((check) => check.name);
  if (new Set(names).size !== names.length) {
    throw new ConcertError("Report check names must be unique.");
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
    throw new ConcertError(
      "Completion requires passed evidence for every declared check. Report failure or a blocker otherwise.",
    );
  }
}

export function executionStatus(run: StoredConcert): StoredConcert["status"] {
  if (!run.execution) {
    return run.status;
  }
  if (run.execution.finishedAt !== null) {
    return "completed";
  }
  if (run.execution.orchestration?.phase === "planning") {
    return run.execution.interruption ? "blocked" : "planning";
  }
  const attempts =
    run.revisions
      .at(-1)
      ?.graph.tasks.map((task) => latestAttempt(run, task.id)) ?? [];
  if (
    run.execution.interruption ||
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

export function validateExecution(run: StoredConcert): void {
  if (!run.execution) {
    if (run.status !== "draft" && run.status !== "accepted") {
      throw new ConcertError("Concert execution is missing.");
    }
    return;
  }
  const graph = run.revisions.at(-1)?.graph;
  if (
    (!graph && run.execution.orchestration?.phase !== "planning") ||
    run.draft ||
    !run.source.agentId ||
    executionStatus(run) !== run.status
  ) {
    throw new ConcertError("Concert execution is inconsistent.");
  }
  if (
    (run.execution.summary !== null) !==
    (run.execution.finishedAt !== null)
  ) {
    throw new ConcertError(
      "Concert summary and completion must be recorded together.",
    );
  }
  if (run.execution.orchestration?.phase === "planning") {
    if (
      run.execution.origin !== "orchestrator" ||
      graph ||
      run.execution.attempts.length ||
      run.execution.finishedAt !== null
    ) {
      throw new ConcertError("Planning concert contains execution history.");
    }
    return;
  }
  if (
    !graph ||
    (run.execution.origin === "orchestrator") !==
      Boolean(run.execution.orchestration)
  ) {
    throw new ConcertError("Orchestration metadata is inconsistent.");
  }
  const ids = new Set<string>();
  for (const attempt of run.execution.attempts) {
    const task = graph.tasks.find((entry) => entry.id === attempt.taskId);
    const terminal =
      attempt.state === "completed" || attempt.state === "failed";
    if (
      !task ||
      ids.has(attempt.id) ||
      (run.execution.origin === "source-agent" &&
        (attempt.agentId !== run.source.agentId || attempt.launch)) ||
      (run.execution.origin === "orchestrator" &&
        (!attempt.launch || attempt.agentId === run.source.agentId)) ||
      terminal !==
        Boolean(
          attempt.report && attempt.reportHash && attempt.endedAt !== null,
        ) ||
      (!terminal &&
        (attempt.report || attempt.reportHash || attempt.endedAt !== null))
    ) {
      throw new ConcertError("Concert attempt records are inconsistent.");
    }
    // Several attempts may share one agent when a failed task continues on the
    // same worker, so only attempt ids must be unique.
    ids.add(attempt.id);
    if (attempt.grantedWrites?.length) {
      if (
        run.execution.origin !== "orchestrator" ||
        widenCalls(attempt.grantedWrites) > CONCERT_LIMITS.widenCallsPerAttempt
      ) {
        throw new ConcertError("Concert attempt grants are inconsistent.");
      }
    }
    if (!terminal && latestAttempt(run, attempt.taskId)?.id !== attempt.id) {
      throw new ConcertError("An unfinished attempt cannot be superseded.");
    }
    if (attempt.report) {
      if (
        createHash("sha256")
          .update(JSON.stringify(attempt.report))
          .digest("hex") !== attempt.reportHash
      ) {
        throw new ConcertError("Stored report integrity check failed.");
      }
      if (attempt.report.outcome !== attempt.state) {
        throw new ConcertError("Report outcome does not match its attempt.");
      }
      requirePassingReport(task, attempt.report);
    }
  }
  if (
    run.execution.finishedAt !== null &&
    (!run.execution.summary ||
      graph.tasks.some(
        (task) =>
          latestAttempt(run, task.id)?.state !== "completed" ||
          (run.execution?.origin === "orchestrator" &&
            !latestAttempt(run, task.id)?.launch?.settled),
      ))
  ) {
    throw new ConcertError("Concert completion lacks task reports.");
  }
}
