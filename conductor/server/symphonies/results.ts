import { createHash } from "node:crypto";
import {
  SYMPHONY_LIMITS,
  isReviewTask,
  latestAttempt,
  type Attempt,
  type GrantedWrite,
  type StoredSymphony,
  type TaskDefinition,
  type TaskFinding,
  type TaskReport,
  type UnresolvedItem,
} from "../../shared/symphonies/models";
import { SymphonyError } from "./errors";

/**
 * True while an attempt's launch is unconfirmed: the creation request may still
 * land, so its agent may appear and start writing later. A server failure
 * report does not resolve this; only an observed agent or a definitive
 * rejection does.
 */
export function launchUncertain(attempt: Attempt | undefined): boolean {
  return attempt?.launch?.state === "uncertain";
}

/**
 * True while an attempt still owns its task's resources: it has not reported,
 * its launch has not settled, or its launch is still unconfirmed. Write grants
 * and writer conflicts last only while this holds, so the same predicate
 * decides when a granted path stops counting.
 */
export function attemptHoldsResources(attempt: Attempt | undefined): boolean {
  return Boolean(
    attempt &&
      (!attempt.report ||
        (attempt.launch && !attempt.launch.settled) ||
        launchUncertain(attempt)),
  );
}

/**
 * True while a symphony's attempts can still own resources. A finished
 * symphony never resumes any attempt, so a report-less attempt left by a
 * `finish` with `unresolved` releases its scope instead of holding it forever.
 */
export function symphonyHoldsResources(symphony: StoredSymphony): boolean {
  return symphony.execution.finishedAt === null;
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
      "Completion requires passed evidence for every declared check. Report needs-changes, failure or a blocker otherwise.",
    );
  }
  // Only a review task may point a finding at another task's code. A finding
  // about the reporting task's own work omits `taskId` or names itself.
  if (!isReviewTask(task)) {
    const foreign = report.findings?.find(
      (finding) => finding.taskId !== undefined && finding.taskId !== task.id,
    );
    if (foreign) {
      throw new SymphonyError(
        "Only a review task may report findings against another task.",
      );
    }
  }
}

/** A blocking finding with the task whose latest report produced it. */
export interface OpenFinding {
  /** `reporterTaskId#findingId`, the reference `loop` and `finish` use. */
  key: string;
  reporterTaskId: string;
  finding: TaskFinding;
}

/**
 * The open work `finish`'s `unresolved` list must cover: every task whose
 * latest attempt is not completed and every blocking finding a latest report
 * still carries. Derived only from latest attempts, so a superseded loop's
 * findings never count.
 */
export function openWork(symphony: StoredSymphony): {
  tasks: TaskDefinition[];
  findings: OpenFinding[];
} {
  const tasks = symphony.revisions.at(-1)?.score.tasks ?? [];
  const openTasks: TaskDefinition[] = [];
  const findings: OpenFinding[] = [];
  for (const task of tasks) {
    const attempt = latestAttempt(symphony, task.id);
    if (attempt?.state !== "completed") {
      openTasks.push(task);
    }
    for (const finding of attempt?.report?.findings ?? []) {
      if (finding.severity === "blocking") {
        findings.push({
          key: `${task.id}#${finding.id}`,
          reporterTaskId: task.id,
          finding,
        });
      }
    }
  }
  return { tasks: openTasks, findings };
}

/**
 * The reasons a `loop.deferred` or `finish.unresolved` list does not cover the
 * open work, or an empty list when it covers everything. Covers by task id and
 * by finding reference (`reporter#id` or a bare finding id).
 */
export function unresolvedIssues(
  symphony: StoredSymphony,
  unresolved: readonly UnresolvedItem[],
): string[] {
  const open = openWork(symphony);
  const issues: string[] = [];
  for (const finding of open.findings) {
    const covered = unresolved.some(
      (item) =>
        item.finding === finding.key || item.finding === finding.finding.id,
    );
    if (!covered) {
      issues.push(`finding ${finding.key} is not listed.`);
    }
  }
  for (const task of open.tasks) {
    if (!unresolved.some((item) => item.taskId === task.id)) {
      issues.push(`task ${task.id} has no completed report and is not listed.`);
    }
  }
  return issues;
}

export function executionStatus(
  symphony: StoredSymphony,
): StoredSymphony["status"] {
  if (symphony.execution.finishedAt !== null) {
    // A symphony the user stopped with open work ends failed, not complete.
    return symphony.execution.unresolved?.length ? "failed" : "completed";
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
      attempt.state === "completed" ||
      attempt.state === "failed" ||
      attempt.state === "needs-changes";
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
    // Conductor-added scope lives on the attempt but lasts for the task. Only a
    // conducted symphony has one; a tracked attempt never records it.
    if (
      attempt.addedWrites?.length &&
      symphony.execution.origin !== "conducted"
    ) {
      throw new SymphonyError("Symphony attempt writes are inconsistent.");
    }
    // Changed paths and launch fingerprints are conducted-only observations.
    if (
      (attempt.changedPaths !== undefined ||
        attempt.changedPathsTruncated !== undefined ||
        attempt.writeFingerprint !== undefined ||
        attempt.writeFingerprintUnknown !== undefined) &&
      symphony.execution.origin !== "conducted"
    ) {
      throw new SymphonyError("Symphony changed paths are inconsistent.");
    }
    // A baseline is either observed or known to be unavailable, never both.
    if (
      attempt.writeFingerprint !== undefined &&
      attempt.writeFingerprintUnknown !== undefined
    ) {
      throw new SymphonyError("Symphony changed paths are inconsistent.");
    }
    // Changed paths are recorded when the attempt settles, but a blocked
    // attempt that resumes or is rebound keeps them (they are cumulative for
    // the whole attempt), so a running attempt may carry them only when it was
    // previously blocked.
    if (
      attempt.state === "running" &&
      (attempt.changedPaths !== undefined || attempt.changedPathsTruncated) &&
      attempt.blockedBy === undefined
    ) {
      throw new SymphonyError(
        "A running attempt cannot record changed paths yet.",
      );
    }
    if (
      attempt.changedPathsTruncated &&
      (attempt.changedPaths?.length ?? 0) < SYMPHONY_LIMITS.changedPaths
    ) {
      throw new SymphonyError("Changed path truncation is inconsistent.");
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
  if (symphony.execution.finishedAt === null) {
    if (symphony.execution.unresolved?.length) {
      throw new SymphonyError(
        "Unresolved items are only recorded when a symphony finishes.",
      );
    }
    return;
  }
  if (!symphony.execution.summary) {
    throw new SymphonyError("Symphony completion lacks task reports.");
  }
  if (symphony.execution.unresolved?.length) {
    const issues = unresolvedIssues(symphony, symphony.execution.unresolved);
    if (issues.length) {
      throw new SymphonyError(
        `Symphony unresolved items are inconsistent: ${issues.join(" ")}`,
      );
    }
    return;
  }
  if (
    score.tasks.some(
      (task) =>
        latestAttempt(symphony, task.id)?.state !== "completed" ||
        (symphony.execution.origin === "conducted" &&
          !latestAttempt(symphony, task.id)?.launch?.settled),
    )
  ) {
    throw new SymphonyError("Symphony completion lacks task reports.");
  }
}
