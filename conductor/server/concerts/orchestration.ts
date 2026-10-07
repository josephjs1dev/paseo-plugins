import {
  retryInstructions,
  workerInstructions,
  type CommandLine,
} from "./prompts";
import { concertCoordinator } from "./coordinator";
import { randomUUID } from "node:crypto";
import {
  effectiveTask,
  scopeConflictReason,
} from "../../shared/concerts/graph";
import {
  latestAttempt,
  CONCERT_LIMITS,
  type ConcertAttempt,
  type StoredConcert,
  type TaskDefinition,
  type TaskReport,
} from "../../shared/concerts/models";
import {
  workerChoice,
  type WorkerChoice,
} from "../../shared/concerts/commands";
import { commandConcertId, type ExecutionRuntime } from "./identity";
import { contentHash, type ConcertStore } from "./store";
import { ConcertError, LaunchRejectedError } from "./errors";
import { attemptHoldsResources, executionStatus } from "./results";
import { nextLaunchCheckDelay, type WorkerRuntime } from "./workers";

/** Truncates a field so a large concert cannot flood the Conductor. */
const clamp = (value: string, max: number) =>
  value.length > max ? value.slice(0, max) : value;

/** The bounded per-task failure kind shown to the Conductor. */
type FailureKind =
  | "no-report"
  | "launch"
  | "checks-failed"
  | "blocked"
  | "failed";

function failureKind(attempt: ConcertAttempt): FailureKind {
  if (attempt.reportedBy === "launcher") {
    return "launch";
  }
  const report = attempt.report;
  if (!report) {
    // A worker block and a server no-report settlement both leave a blocked,
    // report-less attempt; the persisted marker tells them apart.
    return attempt.blockedBy === "worker" ? "blocked" : "no-report";
  }
  return report.checks.some((check) => check.status === "failed")
    ? "checks-failed"
    : "failed";
}

/**
 * A short, bounded summary of one blocked or failed attempt for the Conductor
 * notification. The Conductor should be able to choose `need` without reading
 * the attempt or its conversation.
 */
function failureSummary(attempt: ConcertAttempt) {
  const report = attempt.report;
  const failedChecks = (report?.checks ?? [])
    .filter((check) => check.status === "failed")
    .map((check) => clamp(check.name, 120))
    .slice(0, 8);
  const kind = failureKind(attempt);
  const diagnosis = report?.diagnosis
    ? {
        tried: report.diagnosis.tried
          .slice(0, 4)
          .map((value) => clamp(value, 200)),
        suspectedCause: clamp(report.diagnosis.suspectedCause, 300),
        need: report.diagnosis.need,
        ...(report.diagnosis.requestedWrites
          ? { requestedWrites: report.diagnosis.requestedWrites.slice(0, 8) }
          : {}),
      }
    : undefined;
  return {
    taskId: attempt.taskId,
    kind,
    failedChecks,
    message: clamp(report?.summary ?? attempt.message ?? "", 400),
    ...(diagnosis ? { diagnosis } : {}),
  };
}

/** The worker a launch uses; "inherit" means no profile is passed. */
function launchChoice(
  launch: NonNullable<ConcertAttempt["launch"]>,
  task: TaskDefinition,
): WorkerChoice {
  const { profile, ...inline } =
    launch.profile === undefined
      ? workerChoice(task.worker)
      : workerChoice(launch);
  return {
    ...(profile && profile !== "inherit" ? { profile } : {}),
    ...inline,
  };
}

export function orchestration(
  store: ConcertStore,
  runtime: () => ExecutionRuntime,
  workers: () => WorkerRuntime,
  command: CommandLine,
) {
  const change = async (id: string, update: (run: StoredConcert) => void) => {
    const { run } = await store.read(id);
    return store.update(id, run.version, (value) => {
      update(value);
      value.status = executionStatus(value);
      return value;
    });
  };
  const { owner, start, define } = concertCoordinator(
    store,
    runtime,
    workers,
    change,
    command,
  );
  /**
   * The reason a task cannot start an attempt now, or null when it can. A task
   * may start only when its prerequisites are settled, its concurrency slot is
   * free, and no resource-holding attempt on this checkout conflicts under
   * effective writes. Naming the blocker lets `dispatch` refuse a retry before
   * mutating anything, including `addWrites`.
   */
  const reservationBlocker = async (
    current: StoredConcert,
    task: TaskDefinition,
  ): Promise<string | null> => {
    const execution = current.execution;
    if (!execution?.orchestration || execution.finishedAt !== null) {
      return "this concert is not ready to dispatch.";
    }
    const unmet = task.prerequisites.find((id) => {
      const a = latestAttempt(current, id);
      return a?.state !== "completed" || !a.launch?.settled;
    });
    if (unmet) {
      return `prerequisite task "${unmet}" has not completed and settled.`;
    }
    // A retry resumes or replaces the task's own latest attempt, so that
    // attempt never counts against the concurrency limit or conflicts with
    // itself. Any other resource-holding attempt still blocks the retry.
    const own = latestAttempt(current, task.id);
    const holders = execution.attempts.filter(
      (a) => attemptHoldsResources(a) && a.id !== own?.id,
    ).length;
    if (holders >= execution.orchestration.concurrency) {
      return `the concert concurrency limit (${execution.orchestration.concurrency}) is reached.`;
    }
    const list = await store.list();
    if (list.incomplete || list.unavailable) {
      throw new ConcertError(
        "Concert coverage is incomplete; worker ownership cannot be checked.",
      );
    }
    for (const summary of list.runs) {
      if (summary.source.checkout !== current.source.checkout) {
        continue;
      }
      const other =
        summary.id === current.id
          ? current
          : (await store.read(summary.id)).run;
      for (const definition of other.revisions.at(-1)?.graph.tasks ?? []) {
        if (other.id === current.id && definition.id === task.id) {
          continue;
        }
        const holding = latestAttempt(other, definition.id);
        // Effective writes include grants from the attempt that still holds
        // resources, so both conflict checks cannot drift apart.
        const effective = effectiveTask(definition, holding);
        if (
          attemptHoldsResources(holding) &&
          scopeConflictReason(task, effective)
        ) {
          return `task "${definition.id}" in "${other.title}" still holds its resources.`;
        }
      }
    }
    if (execution.attempts.length >= CONCERT_LIMITS.attempts) {
      throw new ConcertError("Concert attempt limit reached.");
    }
    return null;
  };
  /**
   * True when a task may start an attempt now. Shared by fresh reservations and
   * same-agent continuations so writers never overlap in time.
   */
  const canReserve = async (
    current: StoredConcert,
    task: TaskDefinition,
  ): Promise<boolean> => (await reservationBlocker(current, task)) === null;
  const reserve = async (
    concertId: string,
    task: TaskDefinition,
    options: {
      retry?: boolean;
      replacement?: WorkerChoice;
      prior?: { report: TaskReport | null; note?: string };
    } = {},
  ) => {
    const override = workerChoice(options.replacement ?? {});
    // An inline replacement must not fall back to the task's configured profile.
    const choice = Object.keys(override).length
      ? { profile: "inherit", ...override }
      : workerChoice(task.worker);
    const { run } = await store.read(concertId);
    let reserved = false;
    await store.update(concertId, run.version, async (current) => {
      const execution = current.execution;
      if (!execution?.orchestration || execution.finishedAt !== null) {
        return current;
      }
      const previous = latestAttempt(current, task.id);
      if (
        previous &&
        !(
          options.retry &&
          previous.state === "failed" &&
          previous.launch?.settled
        )
      ) {
        return current;
      }
      if (!(await canReserve(current, task))) {
        return current;
      }
      const attemptId = randomUUID();
      const workerId = commandConcertId(current.id, attemptId);
      const { context } = await store.read(current.id);
      const prerequisiteReports = task.prerequisites.map((id) => {
        const report = latestAttempt(current, id)?.report;
        return {
          taskId: id,
          outcome: report?.outcome,
          summary: report?.summary.slice(0, 1000),
          evidence: report?.evidence
            .slice(0, 2)
            .map((value) => value.slice(0, 300)),
          checks: report?.checks.map((check) => ({
            name: check.name.slice(0, 80),
            status: check.status,
          })),
        };
      });
      const priorText = options.prior
        ? `\n${retryInstructions(options.prior, false)}`
        : "";
      const prompt = `You are a task agent in Conductor concert ${current.id}. Your assigned task is ${task.id}: ${task.title}.\nConcert goal: ${context.plan}\nAssignment: ${task.outcome}\nRead scope: ${JSON.stringify(task.reads)}\nWrite scope: ${JSON.stringify(task.writes)}\nRequired checks: ${JSON.stringify(task.checks)}\nPrerequisite reports: ${JSON.stringify(prerequisiteReports)}${priorText}\nWork in the provided workspace. Other agents may be reading it. Only edit the declared write scope; writes [] means read-only. Do not commit, push, reload plugins, launch extra agents, or expand this assignment. Respect repository instructions.\nYou are already assigned attempt ${attemptId}; do not start a new concert or claim a source-agent task. ${workerInstructions(command, workerId, current.id, attemptId, task.checks)}\nYour Conductor agent is ${current.source.agentId}.`;
      execution.attempts.push({
        id: attemptId,
        taskId: task.id,
        agentId: workerId,
        state: "running",
        startedAt: Date.now(),
        endedAt: null,
        message: "Starting task agent…",
        report: null,
        reportHash: null,
        launch: {
          state: "pending",
          prompt,
          settled: false,
          ...choice,
          generation: 0,
        },
      });
      execution.interruption = null;
      current.status = executionStatus(current);
      reserved = true;
      return current;
    });
    return reserved;
  };
  const launchAttempt = async (concertId: string, task: TaskDefinition) => {
    const { run } = await store.read(concertId);
    const attempt = latestAttempt(run, task.id);
    if (
      !attempt?.launch ||
      attempt.launch.state === "started" ||
      attempt.launch.state === "failed" ||
      !run.source.agentId
    ) {
      return;
    }
    let creationStarted = false;
    try {
      await runtime().validate(
        run.source,
        run.revisions.at(-1)?.graph ?? { tasks: [] },
      );
      const input = {
        agentId: attempt.agentId,
        parentAgentId: run.source.agentId,
        workspaceId: run.source.workspaceId,
        title: task.title,
        prompt: attempt.launch.prompt,
        ...launchChoice(attempt.launch, task),
      };
      const config = attempt.launch.config ?? (await workers().prepare(input));
      if (!attempt.launch.config) {
        await change(concertId, (current) => {
          const a = latestAttempt(current, task.id);
          if (a?.launch && a.id === attempt.id) {
            a.launch.config = config;
          }
        });
      }
      creationStarted = true;
      await workers().launch({ ...input, config });
      await change(concertId, (current) => {
        const active = latestAttempt(current, task.id);
        if (active?.launch && active.id === attempt.id) {
          active.launch.state = "started";
          // A retry of a settled uncertain launch re-opens reconciliation.
          // Without clearing `settled` and the exhausted check schedule the
          // attempt stays settled and every later reconcile skips it, so no
          // nudge or no-report settlement is ever delivered.
          active.launch.settled = false;
          delete active.launch.checks;
          delete active.launch.nextCheckAt;
          active.state = "running";
          active.message = null;
        }
      });
    } catch (error) {
      const rejected = !creationStarted || error instanceof LaunchRejectedError;
      await change(concertId, (current) => {
        const active = latestAttempt(current, task.id);
        if (active?.launch && active.id === attempt.id) {
          if (rejected) {
            active.launch.state = "failed";
            active.launch.settled = true;
            active.state = "failed";
            active.reportedBy = "launcher";
            active.report = {
              outcome: "failed",
              summary:
                error instanceof ConcertError
                  ? error.message
                  : "Task validation failed before any agent was created.",
              evidence: [
                "The launcher rejected this assignment before agent creation.",
              ],
              checks: task.checks.map((name) => ({
                name,
                status: "not-run",
                detail: "Agent creation was rejected.",
              })),
            };
            active.reportHash = contentHash(JSON.stringify(active.report));
            active.endedAt = Date.now();
            active.message = null;
          } else {
            active.launch.state = "uncertain";
            active.state = "running";
            active.launch.settled = false;
            active.message =
              "Task agent launch could not be confirmed. The same agent identity is re-checked before it is treated as failed; no replacement has been created.";
          }
        }
      });
    }
  };
  /** True when a retry keeps the same resolved worker as the failed attempt. */
  const sameWorkerChoice = (
    task: TaskDefinition,
    attempt: ConcertAttempt,
    replacement?: WorkerChoice,
  ): boolean => {
    const override = workerChoice(replacement ?? {});
    const intended = Object.keys(override).length
      ? { profile: "inherit", ...override }
      : workerChoice(task.worker);
    const previous = workerChoice(attempt.launch ?? {});
    return (
      (intended.profile ?? null) === (previous.profile ?? null) &&
      (intended.provider ?? null) === (previous.provider ?? null) &&
      (intended.model ?? null) === (previous.model ?? null) &&
      (intended.thinkingOptionId ?? null) ===
        (previous.thinkingOptionId ?? null)
    );
  };
  /**
   * Grows only one task's declared writes after the same conflict check
   * `reserve` uses. `widen` grants are not revisions; this is, because the task
   * itself changes. Readers use the latest revision already.
   */
  const addTaskWrites = async (
    concertId: string,
    taskId: string,
    paths: string[],
  ) => {
    const initial = (await store.read(concertId)).run;
    await store.update(concertId, initial.version, async (current) => {
      const execution = current.execution;
      const graph = current.revisions.at(-1)?.graph;
      if (!execution?.orchestration || !graph) {
        throw new ConcertError("This concert is not ready to widen a task.");
      }
      const task = graph.tasks.find((entry) => entry.id === taskId);
      if (!task) {
        throw new ConcertError("Unknown task.");
      }
      const writes = [...new Set([...task.writes, ...paths])];
      if (writes.length === task.writes.length) {
        return current;
      }
      if (current.revisions.length >= CONCERT_LIMITS.revisions) {
        throw new ConcertError("Concert revision limit reached.");
      }
      // A read-only task that gains writes is no longer exploration.
      const grown: TaskDefinition = {
        ...task,
        writes,
        worker: {
          ...task.worker,
          role: writes.length ? "implementation" : task.worker.role,
        },
      };
      // The grown scope becomes task storage, so re-run the placement and
      // symlink validation the initial define/launch used before persisting it.
      await runtime().validate(current.source, {
        tasks: graph.tasks.map((entry) =>
          entry.id === task.id ? grown : entry,
        ),
      });
      const list = await store.list();
      if (list.incomplete || list.unavailable) {
        throw new ConcertError(
          "Concert coverage is incomplete; widen conflicts cannot be checked.",
        );
      }
      for (const summary of list.runs) {
        if (summary.source.checkout !== current.source.checkout) {
          continue;
        }
        const other =
          summary.id === current.id
            ? current
            : (await store.read(summary.id)).run;
        for (const definition of other.revisions.at(-1)?.graph.tasks ?? []) {
          if (other.id === current.id && definition.id === task.id) {
            continue;
          }
          const holding = latestAttempt(other, definition.id);
          if (!attemptHoldsResources(holding)) {
            continue;
          }
          const effective = effectiveTask(definition, holding);
          const reason = scopeConflictReason(grown, effective);
          if (reason) {
            throw new ConcertError(
              `addWrites refused: ${paths.join(", ")} overlaps task "${definition.id}" in ${other.title} (${reason}).`,
            );
          }
        }
      }
      current.revisions.push({
        number: current.revisions.length + 1,
        parent:
          current.revisions.length === 0 ? null : current.revisions.length,
        reason: clamp(`Conductor added write scope: ${paths.join(", ")}`, 2000),
        acceptedAt: Date.now(),
        authority: "agent",
        graph: {
          tasks: graph.tasks.map((entry) =>
            entry.id === task.id ? grown : entry,
          ),
        },
      });
      return current;
    });
  };
  /**
   * Sends an attempt's persisted `wake` and clears it only after the keyed send
   * succeeds. A failed or uncertain send leaves the wake in place so the next
   * reconciliation replays the exact same message and identity. Nudges record
   * `nudgedAt` at that point, so a failed send never consumes the one nudge.
   */
  const deliverPendingWake = async (concertId: string, attemptId: string) => {
    const { run } = await store.read(concertId);
    const attempt = run.execution?.attempts.find(
      (entry) => entry.id === attemptId,
    );
    const wake = attempt?.wake;
    if (!attempt || !wake) {
      return;
    }
    try {
      await workers().wake(attempt.agentId, wake.prompt, wake.key);
    } catch (error) {
      // A transiently busy or unavailable worker keeps the wake pending.
      if (error instanceof ConcertError) {
        return;
      }
      throw error;
    }
    await change(concertId, (current) => {
      const delivered = current.execution?.attempts.find(
        (entry) => entry.id === attemptId,
      );
      if (delivered?.wake?.key !== wake.key) {
        return;
      }
      delivered.wake = undefined;
      if (wake.key.startsWith("nudge:")) {
        delivered.nudgedAt = Date.now();
      }
    });
  };
  /** A resume/continuation prompt for waking an existing agent on an attempt. */
  const resumePrompt = (
    concertId: string,
    task: TaskDefinition,
    attempt: ConcertAttempt,
    prior: { report: TaskReport | null; note?: string },
  ) =>
    `Resume task ${task.id} in concert ${concertId}, attempt ${attempt.id}. Resolve the blocker using the source conversation. Write scope: ${JSON.stringify(task.writes)}.\n${retryInstructions(prior, true)}\n${workerInstructions(command, attempt.agentId, concertId, attempt.id, task.checks)}`;
  /**
   * A failed task continues on its previous agent: a new attempt records the
   * work but the worker keeps its conversation. The failed report stays as-is.
   */
  const continueFailedAttempt = async (
    concertId: string,
    task: TaskDefinition,
    previous: ConcertAttempt,
    prior: { report: TaskReport | null; note?: string },
  ) => {
    const attemptId = randomUUID();
    const prompt = `Continue task ${task.id} in concert ${concertId} on attempt ${attemptId}. Your previous attempt failed; the server kept your conversation context. Write scope: ${JSON.stringify(task.writes)}.\n${retryInstructions(prior, true)}\n${workerInstructions(command, previous.agentId, concertId, attemptId, task.checks)}`;
    let created = false;
    const initial = (await store.read(concertId)).run;
    await store.update(concertId, initial.version, async (current) => {
      const execution = current.execution;
      const latest = latestAttempt(current, task.id);
      if (
        !execution ||
        !latest ||
        latest.id !== previous.id ||
        latest.state !== "failed" ||
        !latest.launch?.settled
      ) {
        return current;
      }
      // Keep writers serialized even though the agent is reused.
      if (!(await canReserve(current, task))) {
        return current;
      }
      execution.attempts.push({
        id: attemptId,
        taskId: task.id,
        agentId: previous.agentId,
        state: "running",
        startedAt: Date.now(),
        endedAt: null,
        message: "Continuing the assignment on the same worker…",
        report: null,
        reportHash: null,
        wake: { key: `continue:${attemptId}`, prompt },
        launch: {
          state: "started",
          prompt,
          settled: false,
          generation: 0,
          ...(previous.launch ? workerChoice(previous.launch) : {}),
        },
      });
      execution.interruption = null;
      current.status = executionStatus(current);
      created = true;
      return current;
    });
    if (created) {
      await deliverPendingWake(concertId, attemptId);
    }
  };
  const dispatch = async (
    agentId: string,
    concertId: string,
    retryTaskId?: string,
    replacement?: WorkerChoice,
    note?: string,
    addWrites?: string[],
  ) => {
    let run = await owner(agentId, concertId);
    if (
      run.execution?.orchestration?.phase !== "working" ||
      run.execution.finishedAt !== null
    ) {
      throw new ConcertError("This concert is not ready to dispatch.");
    }
    if (retryTaskId) {
      const attempt = latestAttempt(run, retryTaskId);
      if (
        !attempt?.launch?.settled ||
        (attempt.state !== "failed" && attempt.state !== "blocked")
      ) {
        throw new ConcertError(
          "Retry requires a settled failed or blocked task agent.",
        );
      }
      const status = await workers().inspect(attempt.agentId);
      if (status.active) {
        throw new ConcertError("The task agent is still active.");
      }
      const currentTask = run.revisions
        .at(-1)
        ?.graph.tasks.find((entry) => entry.id === retryTaskId);
      if (!currentTask) {
        throw new ConcertError("Unknown task.");
      }
      // Decide before any mutation, including addWrites, whether the retry can
      // start now. Otherwise dispatch would report success while the retry
      // silently never started and any added writes stayed saved.
      const blocker = await reservationBlocker(run, currentTask);
      if (blocker) {
        throw new ConcertError(
          `Retry cannot start now: ${blocker} Dispatch again after it settles.`,
        );
      }
      if (addWrites?.length) {
        await addTaskWrites(concertId, retryTaskId, addWrites);
      }
      run = (await store.read(concertId)).run;
      const task = run.revisions
        .at(-1)
        ?.graph.tasks.find((entry) => entry.id === retryTaskId);
      if (!task) {
        throw new ConcertError("Unknown task.");
      }
      const prior: { report: TaskReport | null; note?: string } = {
        report: attempt.report,
        ...(note ? { note } : {}),
      };
      if (attempt.state === "blocked" && attempt.launch.state === "started") {
        const prompt = resumePrompt(concertId, task, attempt, prior);
        if (status.deliverable) {
          const wake = {
            key: `resume:${attempt.id}:${run.version}`,
            prompt,
          };
          await change(concertId, (current) => {
            const a = latestAttempt(current, retryTaskId);
            if (a?.launch) {
              a.state = "running";
              a.message = null;
              a.launch.settled = false;
              a.launch.generation = (a.launch.generation ?? 0) + 1;
              a.wake = wake;
            }
          });
          await deliverPendingWake(concertId, attempt.id);
        } else {
          // The blocked agent can no longer receive a wake (archived or closed),
          // so bind the same attempt to a fresh agent before resuming it.
          const agentId = commandConcertId(concertId, randomUUID());
          const choice = replacement
            ? { profile: "inherit", ...workerChoice(replacement) }
            : workerChoice(attempt.launch);
          await change(concertId, (current) => {
            const a = latestAttempt(current, retryTaskId);
            if (!a?.launch) {
              return;
            }
            a.agentId = agentId;
            a.state = "running";
            a.message = "Replacing an unavailable task agent…";
            a.wake = undefined;
            a.launch.state = "pending";
            a.launch.prompt = prompt;
            a.launch.settled = false;
            a.launch.generation = 0;
            delete a.launch.config;
            Object.assign(a.launch, choice);
          });
        }
      } else if (attempt.state === "failed") {
        if (
          sameWorkerChoice(task, attempt, replacement) &&
          status.deliverable
        ) {
          await continueFailedAttempt(concertId, task, attempt, prior);
        } else {
          await reserve(concertId, task, {
            retry: true,
            ...(replacement ? { replacement } : {}),
            prior,
          });
        }
      }
    }
    run = (await store.read(concertId)).run;
    const tasks = run.revisions.at(-1)?.graph.tasks ?? [];
    for (const task of tasks) {
      await reserve(concertId, task);
      await launchAttempt(concertId, task);
    }
    run = (await store.read(concertId)).run;
    return { run };
  };
  const reconcile = async () => {
    const list = await store.list();
    for (const summary of list.runs) {
      try {
        let { run } = await store.read(summary.id);
        const meta = run.execution?.orchestration;
        if (
          !meta ||
          run.execution?.finishedAt !== null ||
          !run.source.agentId
        ) {
          continue;
        }
        if (meta.phase === "planning") {
          if (
            meta.coordinatorLaunch === "started" &&
            !run.execution.interruption
          ) {
            const status = await workers().inspect(run.source.agentId);
            if (!status.active) {
              await change(run.id, (current) => {
                if (current.execution) {
                  current.execution.interruption =
                    "Conductor agent stopped before defining tasks. Open the Conductor agent to continue.";
                }
              });
            }
          }
          continue;
        }
        for (const attempt of run.execution.attempts) {
          if (!attempt.launch || attempt.launch.settled) {
            continue;
          }
          if (attempt.launch.state === "uncertain") {
            // The creation response was lost. Re-check the saved SDK identity on
            // a bounded schedule persisted on the launch. Reconcile never
            // sleeps: it performs one lookup per due tick, so a slow launch
            // cannot block the shared command queue. It never resends the
            // initial prompt or creates a replacement agent here.
            const now = Date.now();
            if (
              attempt.launch.nextCheckAt !== undefined &&
              now < attempt.launch.nextCheckAt
            ) {
              continue;
            }
            const completed = (attempt.launch.checks ?? 0) + 1;
            const status = await workers().inspect(attempt.agentId);
            run = await change(run.id, (current) => {
              const a = current.execution?.attempts.find(
                (value) => value.id === attempt.id,
              );
              if (
                !a?.launch ||
                a.launch.settled ||
                a.launch.state !== "uncertain"
              ) {
                return;
              }
              if (status.exists) {
                a.launch.state = "started";
                a.state = "running";
                a.message = null;
              } else {
                const delay = nextLaunchCheckDelay(
                  completed,
                  workers().launchCheckDelaysMs,
                );
                if (delay !== null) {
                  a.launch.checks = completed;
                  a.launch.nextCheckAt = Date.now() + delay;
                  return;
                }
                a.launch.settled = true;
                a.state = "blocked";
                a.blockedBy = "server";
                a.message =
                  "Task agent launch could not be confirmed after repeated identity checks. Dispatch again to reconcile the same agent; no replacement has been created.";
              }
            });
            continue;
          }
          if (attempt.launch.state !== "started") {
            continue;
          }
          const status = await workers().inspect(attempt.agentId);
          if (status.active) {
            continue;
          }
          if (attempt.state === "blocked") {
            // The worker blocked this attempt before its turn ended. Settle the
            // launch without nudging and keep the worker's message as the
            // record; a server settlement would overwrite it otherwise.
            run = await change(run.id, (current) => {
              const a = current.execution?.attempts.find(
                (value) => value.id === attempt.id,
              );
              if (!a?.launch || a.launch.settled) {
                return;
              }
              a.launch.settled = true;
              a.blockedBy = "worker";
              a.wake = undefined;
            });
            continue;
          }
          const pending = attempt.wake;
          if (!attempt.report && pending) {
            // A saved continuation or nudge whose delivery is unconfirmed.
            if (!status.exists || !status.deliverable) {
              run = await change(run.id, (current) => {
                const a = current.execution?.attempts.find(
                  (value) => value.id === attempt.id,
                );
                if (!a?.launch || a.launch.settled) {
                  return;
                }
                a.launch.settled = true;
                if (!a.report) {
                  a.state = "blocked";
                  a.blockedBy = "server";
                  a.message =
                    "Task agent became unavailable before its saved wake could be delivered. Dispatch again to reconcile or replace it.";
                }
              });
              continue;
            }
            await deliverPendingWake(run.id, attempt.id);
            continue;
          }
          if (!status.exists) {
            // A missing worker cannot be nudged; settle the attempt as blocked.
            run = await change(run.id, (current) => {
              const a = current.execution?.attempts.find(
                (value) => value.id === attempt.id,
              );
              if (!a?.launch || a.launch.settled) {
                return;
              }
              a.launch.settled = true;
              if (!a.report) {
                a.state = "blocked";
                a.blockedBy = "server";
                a.message =
                  "Task agent stopped or was removed without a report. Dispatch again to reconcile or replace it.";
              }
            });
            continue;
          }
          if (!attempt.report && !attempt.nudgedAt) {
            if (!status.deliverable) {
              run = await change(run.id, (current) => {
                const a = current.execution?.attempts.find(
                  (value) => value.id === attempt.id,
                );
                if (!a?.launch || a.launch.settled) {
                  return;
                }
                a.launch.settled = true;
                a.state = "blocked";
                a.blockedBy = "server";
                a.message =
                  "Task agent stopped but can no longer receive a nudge. Dispatch again to reconcile or replace it.";
              });
              continue;
            }
            // First stop with no report: persist and send one nudge. The wake is
            // cleared and `nudgedAt` set only after the keyed send succeeds, so a
            // failed send or reload replays the same message exactly once.
            const generation = attempt.launch.generation ?? 0;
            const checks =
              run.revisions
                .at(-1)
                ?.graph.tasks.find((task) => task.id === attempt.taskId)
                ?.checks ?? [];
            const wake = {
              key: `nudge:${attempt.id}:${generation}`,
              prompt: `Task agent for task ${attempt.taskId} stopped without a report. Report or block attempt ${attempt.id} now; do not end your turn without reporting.\n${workerInstructions(command, attempt.agentId, run.id, attempt.id, checks)}`,
            };
            run = await change(run.id, (current) => {
              const a = current.execution?.attempts.find(
                (value) => value.id === attempt.id,
              );
              if (
                !a?.launch ||
                a.launch.settled ||
                a.report ||
                a.nudgedAt ||
                a.wake
              ) {
                return;
              }
              a.wake = wake;
              a.message =
                "Task agent stopped without a report; asked once to report or block this attempt.";
            });
            await deliverPendingWake(run.id, attempt.id);
            continue;
          }
          run = await change(run.id, (current) => {
            const a = current.execution?.attempts.find(
              (value) => value.id === attempt.id,
            );
            if (!a?.launch) {
              return;
            }
            a.launch.settled = true;
            if (!a.report) {
              a.state = "blocked";
              a.blockedBy = "server";
              a.message =
                "Task agent stopped without a report after a nudge. Open its conversation and resume the existing assignment.";
            }
          });
        }
        const tasks = run.revisions.at(-1)?.graph.tasks ?? [];
        for (const task of tasks) {
          const reserved = await reserve(run.id, task);
          const latest = latestAttempt((await store.read(run.id)).run, task.id);
          if (reserved || latest?.launch?.state === "pending") {
            await launchAttempt(run.id, task);
          }
        }
        run = (await store.read(run.id)).run;
        const allDone = tasks.every((task) => {
          const a = latestAttempt(run, task.id);
          return a?.state === "completed" && a.launch?.settled;
        });
        const blocked = tasks
          .map((task) => latestAttempt(run, task.id))
          .filter((a) => a?.state === "blocked" || a?.state === "failed");
        let notification: string | null = null;
        if (allDone) {
          notification = "all-reported";
        } else if (blocked.length) {
          notification = contentHash(
            JSON.stringify(
              blocked.map((a) => [
                a?.id,
                a?.state,
                a?.blockedBy,
                a?.message,
                a?.reportHash,
                a?.launch?.generation ?? 0,
              ]),
            ),
          );
        }
        if (
          notification &&
          notification !== run.execution?.orchestration?.notification &&
          run.source.agentId
        ) {
          const detail = allDone
            ? ""
            : `\n${clamp(
                JSON.stringify(
                  blocked.map((attempt) =>
                    attempt ? failureSummary(attempt) : null,
                  ),
                ),
                3500,
              )}`;
          const instruction = allDone
            ? "All task agents reported completion and stopped. Review the evidence, then finish the concert with a summary."
            : "Task agents need attention. Act on each summary with dispatch (retryTaskId plus note/addWrites) or ask the user; open a conversation only when the summary is unclear.";
          // Stable message identity makes uncertain notification retries harmless.
          await workers().wake(
            run.source.agentId,
            `Conductor concert ${run.id}: ${instruction}${detail}`,
            `${run.id}:${notification}`,
          );
          await change(run.id, (current) => {
            if (current.execution?.orchestration) {
              current.execution.orchestration.notification = notification;
            }
          });
        }
      } catch (error) {
        // One busy/unreachable Conductor agent must not starve independent concerts.
        // Ownership stays fenced while observation/notification is retried.
        if (
          error instanceof ConcertError &&
          error.message.includes("unavailable")
        ) {
          await change(summary.id, (current) => {
            if (current.execution) {
              current.execution.interruption =
                "The Conductor agent is unavailable. Existing task agents and their reports remain visible.";
            }
          }).catch(() => {});
        }
      }
    }
  };
  return { start, define, dispatch, reconcile };
}
