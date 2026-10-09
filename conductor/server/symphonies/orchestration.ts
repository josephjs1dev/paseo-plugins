import {
  retryInstructions,
  workerInstructions,
  type CommandLine,
} from "./prompts";
import { symphonyConductor } from "./conductor";
import { randomUUID } from "node:crypto";
import {
  effectiveTask,
  nextAttemptWrites,
  scopeConflictReason,
} from "../../shared/symphonies/score";
import {
  attemptNumber,
  latestAttempt,
  taskAttempts,
  SYMPHONY_LIMITS,
  type Attempt,
  type GrantedWrite,
  type StoredSymphony,
  type TaskDefinition,
  type TaskReport,
} from "../../shared/symphonies/models";
import {
  workerChoice,
  type WorkerChoice,
} from "../../shared/symphonies/commands";
import { commandSymphonyId, type ExecutionRuntime } from "./identity";
import { contentHash, type SymphonyStore } from "./store";
import { SymphonyError, LaunchRejectedError } from "./errors";
import { attemptHoldsResources, executionStatus } from "./results";
import { nextLaunchCheckDelay, type WorkerRuntime } from "./workers";

/** Truncates a field so a large symphony cannot flood the Conductor. */
const clamp = (value: string, max: number) =>
  value.length > max ? value.slice(0, max) : value;

/** The bounded per-task failure kind shown to the Conductor. */
type FailureKind =
  | "no-report"
  | "launch"
  | "checks-failed"
  | "blocked"
  | "failed";

function failureKind(attempt: Attempt): FailureKind {
  if (attempt.reportedBy === "launcher") {
    return "launch";
  }
  const report = attempt.report;
  if (!report) {
    // A task agent block and a server no-report settlement both leave a
    // blocked, report-less attempt; the persisted marker tells them apart.
    return attempt.blockedBy === "worker" ? "blocked" : "no-report";
  }
  return report.checks.some((check) => check.status === "failed")
    ? "checks-failed"
    : "failed";
}

/**
 * A short, bounded summary of one blocked or failed attempt for the Conductor
 * notification. The Conductor should be able to choose `need` without reading
 * the attempt or its conversation. The attempt number is per task, so it agrees
 * with the History tab.
 */
function failureSummary(symphony: StoredSymphony, attempt: Attempt) {
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
    attempt: attemptNumber(symphony, attempt),
    attemptCount: taskAttempts(symphony, attempt.taskId).length,
    kind,
    failedChecks,
    message: clamp(report?.summary ?? attempt.message ?? "", 400),
    ...(diagnosis ? { diagnosis } : {}),
  };
}

/** The worker choice a launch uses; "inherit" means no profile is passed. */
function launchChoice(launch: NonNullable<Attempt["launch"]>): WorkerChoice {
  const { profile, ...inline } = workerChoice(launch);
  return {
    ...(profile && profile !== "inherit" ? { profile } : {}),
    ...inline,
  };
}

export function orchestration(
  store: SymphonyStore,
  runtime: () => ExecutionRuntime,
  workers: () => WorkerRuntime,
  command: CommandLine,
) {
  const change = async (
    id: string,
    update: (symphony: StoredSymphony) => void,
  ) => {
    const { symphony } = await store.read(id);
    return store.update(id, symphony.version, (value) => {
      update(value);
      value.status = executionStatus(value);
      return value;
    });
  };
  const { owner, start, define } = symphonyConductor(
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
    current: StoredSymphony,
    task: TaskDefinition,
  ): Promise<string | null> => {
    const execution = current.execution;
    if (!execution.conducting || execution.finishedAt !== null) {
      return "this symphony is not ready to dispatch.";
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
    if (holders >= execution.conducting.concurrency) {
      return `the symphony concurrency limit (${execution.conducting.concurrency}) is reached.`;
    }
    const list = await store.list();
    if (list.incomplete || list.unavailable) {
      throw new SymphonyError(
        "Symphony coverage is incomplete; task agent ownership cannot be checked.",
      );
    }
    // The candidate's own effective scope includes Conductor additions from its
    // earlier attempts, so the retry conflict check cannot miss them.
    const candidate = effectiveTask(current, task);
    for (const summary of list.symphonies) {
      if (summary.source.checkout !== current.source.checkout) {
        continue;
      }
      const other =
        summary.id === current.id
          ? current
          : (await store.read(summary.id)).symphony;
      for (const definition of other.revisions.at(-1)?.score.tasks ?? []) {
        if (other.id === current.id && definition.id === task.id) {
          continue;
        }
        const holding = latestAttempt(other, definition.id);
        // Effective writes union the task's declared scope, every Conductor
        // addition, and the latest attempt's widen grants, so both conflict
        // checks cannot drift apart.
        const held = effectiveTask(other, definition);
        if (
          attemptHoldsResources(holding) &&
          scopeConflictReason(candidate, held)
        ) {
          return `task "${definition.id}" in "${other.title}" still holds its resources.`;
        }
      }
    }
    if (execution.attempts.length >= SYMPHONY_LIMITS.attempts) {
      throw new SymphonyError("Symphony attempt limit reached.");
    }
    return null;
  };
  /**
   * True when a task may start an attempt now. Shared by fresh reservations and
   * same-agent continuations so writers never overlap in time.
   */
  const canReserve = async (
    current: StoredSymphony,
    task: TaskDefinition,
  ): Promise<boolean> => (await reservationBlocker(current, task)) === null;
  /**
   * The write scope an attempt that reuses its existing attempt starts with:
   * the task's effective scope plus the Conductor additions this attempt is
   * about to record. A new attempt uses `nextAttemptWrites` instead, because
   * the previous attempt's temporary grants expire when it becomes latest.
   */
  const attemptWrites = (
    current: StoredSymphony,
    task: TaskDefinition,
    additions?: GrantedWrite[],
  ): string[] => [
    ...new Set([
      ...effectiveTask(current, task).writes,
      ...(additions?.map((grant) => grant.path) ?? []),
    ]),
  ];
  /** The bounded per-task position a newly created attempt will occupy. */
  const newAttemptPosition = (current: StoredSymphony, taskId: string) => {
    const total = taskAttempts(current, taskId).length + 1;
    return { taskId, number: total, total };
  };
  /**
   * Merges Conductor additions into an attempt's recorded scope, deduplicating
   * by path and refusing to exceed the per-attempt bound.
   */
  const mergeAddedWrites = (
    existing: GrantedWrite[] | undefined,
    additions: GrantedWrite[],
  ): GrantedWrite[] => {
    const merged = [...(existing ?? [])];
    for (const grant of additions) {
      if (!merged.some((entry) => entry.path === grant.path)) {
        merged.push(grant);
      }
    }
    if (merged.length > SYMPHONY_LIMITS.addedWritesPerAttempt) {
      throw new SymphonyError(
        `addWrites refused: this attempt may hold at most ${SYMPHONY_LIMITS.addedWritesPerAttempt} Conductor-added paths.`,
      );
    }
    return merged;
  };
  const reserve = async (
    symphonyId: string,
    task: TaskDefinition,
    options: {
      retry?: boolean;
      replacement?: WorkerChoice;
      prior?: { report: TaskReport | null; note?: string };
      additions?: GrantedWrite[];
    } = {},
  ) => {
    const override = workerChoice(options.replacement ?? {});
    // An inline replacement must not fall back to the task's configured profile.
    const choice = Object.keys(override).length
      ? { profile: "inherit", ...override }
      : { ...workerChoice(task.worker), profile: task.worker.profile };
    const { symphony } = await store.read(symphonyId);
    let reserved = false;
    await store.update(symphonyId, symphony.version, async (current) => {
      const execution = current.execution;
      if (!execution.conducting || execution.finishedAt !== null) {
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
      const workerId = commandSymphonyId(current.id, attemptId);
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
        ? `\n${retryInstructions(
            options.prior,
            false,
            newAttemptPosition(current, task.id),
          )}`
        : "";
      const writes = nextAttemptWrites(current, task, options.additions ?? []);
      const prompt = `You are a task agent in Conductor symphony ${current.id}. Your assigned task is ${task.id}: ${task.title}.\nSymphony goal: ${context.plan}\nAssignment: ${task.outcome}\nRead scope: ${JSON.stringify(task.reads)}\nWrite scope: ${JSON.stringify(writes)}\nRequired checks: ${JSON.stringify(task.checks)}\nPrerequisite reports: ${JSON.stringify(prerequisiteReports)}${priorText}\nWork in the provided concert. Other agents may be reading it. Only edit the declared write scope; writes [] means read-only. Do not commit, push, reload plugins, launch extra agents, or expand this assignment. Respect repository instructions.\nYou are already assigned attempt ${attemptId}; do not start a new symphony or claim another task. ${workerInstructions(command, workerId, current.id, attemptId, task.checks)}\nYour Conductor agent is ${current.source.agentId}.`;
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
        ...(options.additions?.length
          ? { addedWrites: options.additions }
          : {}),
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
  const launchAttempt = async (symphonyId: string, task: TaskDefinition) => {
    const { symphony } = await store.read(symphonyId);
    const attempt = latestAttempt(symphony, task.id);
    if (
      !attempt?.launch ||
      attempt.launch.state === "started" ||
      attempt.launch.state === "failed" ||
      !symphony.source.agentId
    ) {
      return;
    }
    let creationStarted = false;
    try {
      const score = symphony.revisions.at(-1)?.score;
      // Validate the scope this attempt can actually reach: the plan plus every
      // Conductor addition and temporary grant, not just the newest revision, so
      // persistent `addedWrites` still get placement and symlink validation at
      // every launch.
      await runtime().validate(symphony.source, {
        tasks: (score?.tasks ?? []).map((entry) =>
          effectiveTask(symphony, entry),
        ),
      });
      const input = {
        agentId: attempt.agentId,
        parentAgentId: symphony.source.agentId,
        concertId: symphony.source.concertId,
        title: task.title,
        prompt: attempt.launch.prompt,
        ...launchChoice(attempt.launch),
      };
      const config = attempt.launch.config ?? (await workers().prepare(input));
      if (!attempt.launch.config) {
        await change(symphonyId, (current) => {
          const a = latestAttempt(current, task.id);
          if (a?.launch && a.id === attempt.id) {
            a.launch.config = config;
          }
        });
      }
      creationStarted = true;
      await workers().launch({ ...input, config });
      await change(symphonyId, (current) => {
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
      await change(symphonyId, (current) => {
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
                error instanceof SymphonyError
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
  /** True when a retry keeps the failed attempt's resolved worker choice. */
  const sameWorkerChoice = (
    task: TaskDefinition,
    attempt: Attempt,
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
   * Validates a Conductor scope addition for a retry and returns the grants to
   * record on the attempt the retry creates or resumes. The plan never changes:
   * the additions live on the attempt and survive every later attempt of the
   * task. Returns undefined when every path is already in the task's effective
   * scope. Runs the same placement/symlink and conflict checks `reserve` uses.
   */
  const taskWriteAdditions = async (
    current: StoredSymphony,
    taskId: string,
    paths: string[],
    note: string,
  ): Promise<GrantedWrite[] | undefined> => {
    const execution = current.execution;
    const score = current.revisions.at(-1)?.score;
    if (!execution.conducting || !score) {
      throw new SymphonyError("This symphony is not ready to widen a task.");
    }
    const task = score.tasks.find((entry) => entry.id === taskId);
    if (!task) {
      throw new SymphonyError("Unknown task.");
    }
    const effective = effectiveTask(current, task);
    // Dedupe only against the task's persistent scope: its declared writes plus
    // the `addedWrites` of every attempt. The latest attempt's temporary
    // `widen` grants are not persistent, so promoting one of those paths must
    // still be recorded instead of dropped as already present.
    const persistent = [
      ...task.writes,
      ...taskAttempts(current, task.id).flatMap(
        (attempt) => attempt.addedWrites?.map((grant) => grant.path) ?? [],
      ),
    ];
    const additions = [...new Set(paths)].filter(
      (path) => !persistent.includes(path),
    );
    if (additions.length === 0) {
      return undefined;
    }
    const writes = [...new Set([...effective.writes, ...additions])];
    // A read-only task that gains writes is no longer exploration.
    const grown: TaskDefinition = { ...effective, writes };
    // The grown scope becomes task storage, so re-run the placement and symlink
    // validation the initial define/launch used before persisting it.
    await runtime().validate(current.source, {
      tasks: score.tasks.map((entry) => (entry.id === task.id ? grown : entry)),
    });
    const list = await store.list();
    if (list.incomplete || list.unavailable) {
      throw new SymphonyError(
        "Symphony coverage is incomplete; widen conflicts cannot be checked.",
      );
    }
    for (const summary of list.symphonies) {
      if (summary.source.checkout !== current.source.checkout) {
        continue;
      }
      const other =
        summary.id === current.id
          ? current
          : (await store.read(summary.id)).symphony;
      for (const definition of other.revisions.at(-1)?.score.tasks ?? []) {
        if (other.id === current.id && definition.id === task.id) {
          continue;
        }
        const holding = latestAttempt(other, definition.id);
        if (!attemptHoldsResources(holding)) {
          continue;
        }
        const reason = scopeConflictReason(
          grown,
          effectiveTask(other, definition),
        );
        if (reason) {
          throw new SymphonyError(
            `addWrites refused: ${paths.join(", ")} overlaps task "${definition.id}" in ${other.title} (${reason}).`,
          );
        }
      }
    }
    const at = Date.now();
    const reason = clamp(note, 2000);
    return additions.map((path) => ({ path, reason, at }));
  };
  /**
   * Sends an attempt's persisted `wake` and clears it only after the keyed send
   * succeeds. A failed or uncertain send leaves the wake in place so the next
   * reconciliation replays the exact same message and identity. Nudges record
   * `nudgedAt` at that point, so a failed send never consumes the one nudge.
   */
  const deliverPendingWake = async (symphonyId: string, attemptId: string) => {
    const { symphony } = await store.read(symphonyId);
    const attempt = symphony.execution.attempts.find(
      (entry) => entry.id === attemptId,
    );
    const wake = attempt?.wake;
    if (!attempt || !wake) {
      return;
    }
    try {
      await workers().wake(attempt.agentId, wake.prompt, wake.key);
    } catch (error) {
      // A transiently busy or unavailable task agent keeps the wake pending.
      if (error instanceof SymphonyError) {
        return;
      }
      throw error;
    }
    await change(symphonyId, (current) => {
      const delivered = current.execution.attempts.find(
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
    symphonyId: string,
    task: TaskDefinition,
    attempt: Attempt,
    writes: string[],
    position: { taskId: string; number: number; total: number },
    prior: { report: TaskReport | null; note?: string },
  ) =>
    `Resume task ${task.id} in symphony ${symphonyId}, attempt ${attempt.id}. Resolve the blocker using the source conversation. Write scope: ${JSON.stringify(writes)}.\n${retryInstructions(prior, true, position)}\n${workerInstructions(command, attempt.agentId, symphonyId, attempt.id, task.checks)}`;
  /**
   * A failed task continues on its previous agent: a new attempt records the
   * work but the task agent keeps its conversation. The failed report stays
   * as-is.
   */
  const continueFailedAttempt = async (
    symphonyId: string,
    task: TaskDefinition,
    previous: Attempt,
    launch: NonNullable<Attempt["launch"]>,
    prior: { report: TaskReport | null; note?: string },
    additions?: GrantedWrite[],
  ) => {
    const attemptId = randomUUID();
    // The continuation keeps the failed attempt's worker choice.
    const choice = workerChoice(launch);
    const initial = (await store.read(symphonyId)).symphony;
    const prompt = `Continue task ${task.id} in symphony ${symphonyId} on attempt ${attemptId}. Your previous attempt failed; the server kept your conversation context. Write scope: ${JSON.stringify(nextAttemptWrites(initial, task, additions ?? []))}.\n${retryInstructions(prior, true, newAttemptPosition(initial, task.id))}\n${workerInstructions(command, previous.agentId, symphonyId, attemptId, task.checks)}`;
    let created = false;
    await store.update(symphonyId, initial.version, async (current) => {
      const execution = current.execution;
      const latest = latestAttempt(current, task.id);
      if (
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
        message: "Continuing the assignment on the same task agent…",
        report: null,
        reportHash: null,
        ...(additions?.length ? { addedWrites: additions } : {}),
        wake: { key: `continue:${attemptId}`, prompt },
        launch: {
          state: "started",
          prompt,
          settled: false,
          generation: 0,
          ...choice,
          profile: launch.profile,
        },
      });
      execution.interruption = null;
      current.status = executionStatus(current);
      created = true;
      return current;
    });
    if (created) {
      await deliverPendingWake(symphonyId, attemptId);
    }
  };
  const dispatch = async (
    agentId: string,
    symphonyId: string,
    retryTaskId?: string,
    replacement?: WorkerChoice,
    note?: string,
    addWrites?: string[],
  ) => {
    let symphony = await owner(agentId, symphonyId);
    if (
      symphony.execution.conducting?.phase !== "working" ||
      symphony.execution.finishedAt !== null
    ) {
      throw new SymphonyError("This symphony is not ready to dispatch.");
    }
    if (retryTaskId) {
      const attempt = latestAttempt(symphony, retryTaskId);
      if (
        !attempt?.launch?.settled ||
        (attempt.state !== "failed" && attempt.state !== "blocked")
      ) {
        throw new SymphonyError(
          "Retry requires a settled failed or blocked task agent.",
        );
      }
      const status = await workers().inspect(attempt.agentId);
      if (status.active) {
        throw new SymphonyError("The task agent is still active.");
      }
      const currentTask = symphony.revisions
        .at(-1)
        ?.score.tasks.find((entry) => entry.id === retryTaskId);
      if (!currentTask) {
        throw new SymphonyError("Unknown task.");
      }
      // Decide before any mutation, including addWrites, whether the retry can
      // start now. Otherwise dispatch would report success while the retry
      // silently never started and any added writes stayed saved.
      const blocker = await reservationBlocker(symphony, currentTask);
      if (blocker) {
        throw new SymphonyError(
          `Retry cannot start now: ${blocker} Dispatch again after it settles.`,
        );
      }
      // Validate the additions here, but record them on the attempt the retry
      // creates or resumes rather than as a new plan revision.
      const additions = addWrites?.length
        ? await taskWriteAdditions(
            symphony,
            retryTaskId,
            addWrites,
            note ?? "Conductor added write scope",
          )
        : undefined;
      symphony = (await store.read(symphonyId)).symphony;
      const task = symphony.revisions
        .at(-1)
        ?.score.tasks.find((entry) => entry.id === retryTaskId);
      if (!task) {
        throw new SymphonyError("Unknown task.");
      }
      const prior: { report: TaskReport | null; note?: string } = {
        report: attempt.report,
        ...(note ? { note } : {}),
      };
      if (attempt.state === "blocked" && attempt.launch.state === "started") {
        const prompt = resumePrompt(
          symphonyId,
          task,
          attempt,
          attemptWrites(symphony, task, additions),
          {
            taskId: task.id,
            number: attemptNumber(symphony, attempt),
            total: taskAttempts(symphony, attempt.taskId).length,
          },
          prior,
        );
        if (status.deliverable) {
          const wake = {
            key: `resume:${attempt.id}:${symphony.version}`,
            prompt,
          };
          await change(symphonyId, (current) => {
            const a = latestAttempt(current, retryTaskId);
            if (a?.launch) {
              a.state = "running";
              a.message = null;
              a.launch.settled = false;
              a.launch.generation += 1;
              a.wake = wake;
              if (additions?.length) {
                a.addedWrites = mergeAddedWrites(a.addedWrites, additions);
              }
            }
          });
          await deliverPendingWake(symphonyId, attempt.id);
        } else {
          // The blocked agent can no longer receive a wake (archived or closed),
          // so bind the same attempt to a fresh agent before resuming it.
          const agentId = commandSymphonyId(symphonyId, randomUUID());
          const choice = replacement
            ? { profile: "inherit", ...workerChoice(replacement) }
            : workerChoice(attempt.launch);
          await change(symphonyId, (current) => {
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
            if (additions?.length) {
              a.addedWrites = mergeAddedWrites(a.addedWrites, additions);
            }
          });
        }
      } else if (attempt.state === "failed") {
        if (
          sameWorkerChoice(task, attempt, replacement) &&
          status.deliverable
        ) {
          await continueFailedAttempt(
            symphonyId,
            task,
            attempt,
            attempt.launch,
            prior,
            additions,
          );
        } else {
          await reserve(symphonyId, task, {
            retry: true,
            ...(replacement ? { replacement } : {}),
            prior,
            ...(additions ? { additions } : {}),
          });
        }
      }
    }
    symphony = (await store.read(symphonyId)).symphony;
    const tasks = symphony.revisions.at(-1)?.score.tasks ?? [];
    for (const task of tasks) {
      await reserve(symphonyId, task);
      await launchAttempt(symphonyId, task);
    }
    symphony = (await store.read(symphonyId)).symphony;
    return { symphony };
  };
  const reconcile = async () => {
    const list = await store.list();
    for (const summary of list.symphonies) {
      try {
        let { symphony } = await store.read(summary.id);
        const meta = symphony.execution.conducting;
        if (
          !meta ||
          symphony.execution.finishedAt !== null ||
          !symphony.source.agentId
        ) {
          continue;
        }
        if (meta.phase === "planning") {
          if (
            meta.conductorLaunch === "started" &&
            !symphony.execution.interruption
          ) {
            const status = await workers().inspect(symphony.source.agentId);
            if (!status.active) {
              await change(symphony.id, (current) => {
                current.execution.interruption =
                  "Conductor agent stopped before defining tasks. Open the Conductor agent to continue.";
              });
            }
          }
          continue;
        }
        for (const attempt of symphony.execution.attempts) {
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
            symphony = await change(symphony.id, (current) => {
              const a = current.execution.attempts.find(
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
            // The task agent blocked this attempt before its turn ended. Settle
            // the launch without nudging and keep the task agent's message as
            // the record; a server settlement would overwrite it otherwise.
            symphony = await change(symphony.id, (current) => {
              const a = current.execution.attempts.find(
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
              symphony = await change(symphony.id, (current) => {
                const a = current.execution.attempts.find(
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
            await deliverPendingWake(symphony.id, attempt.id);
            continue;
          }
          if (!status.exists) {
            // A missing task agent cannot be nudged; settle the attempt as
            // blocked.
            symphony = await change(symphony.id, (current) => {
              const a = current.execution.attempts.find(
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
              symphony = await change(symphony.id, (current) => {
                const a = current.execution.attempts.find(
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
            const generation = attempt.launch.generation;
            const checks =
              symphony.revisions
                .at(-1)
                ?.score.tasks.find((task) => task.id === attempt.taskId)
                ?.checks ?? [];
            const wake = {
              key: `nudge:${attempt.id}:${generation}`,
              prompt: `Task agent for task ${attempt.taskId} stopped without a report. Report or block attempt ${attempt.id} (attempt ${attemptNumber(symphony, attempt)} of ${taskAttempts(symphony, attempt.taskId).length}) now; do not end your turn without reporting.\n${workerInstructions(command, attempt.agentId, symphony.id, attempt.id, checks)}`,
            };
            symphony = await change(symphony.id, (current) => {
              const a = current.execution.attempts.find(
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
            await deliverPendingWake(symphony.id, attempt.id);
            continue;
          }
          symphony = await change(symphony.id, (current) => {
            const a = current.execution.attempts.find(
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
        const tasks = symphony.revisions.at(-1)?.score.tasks ?? [];
        for (const task of tasks) {
          const reserved = await reserve(symphony.id, task);
          const latest = latestAttempt(
            (await store.read(symphony.id)).symphony,
            task.id,
          );
          if (reserved || latest?.launch?.state === "pending") {
            await launchAttempt(symphony.id, task);
          }
        }
        symphony = (await store.read(symphony.id)).symphony;
        const allDone = tasks.every((task) => {
          const a = latestAttempt(symphony, task.id);
          return a?.state === "completed" && a.launch?.settled;
        });
        const blocked = tasks
          .map((task) => latestAttempt(symphony, task.id))
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
                a?.launch?.generation,
              ]),
            ),
          );
        }
        if (
          notification &&
          notification !== symphony.execution.conducting?.notification &&
          symphony.source.agentId
        ) {
          const detail = allDone
            ? ""
            : `\n${clamp(
                JSON.stringify(
                  blocked.map((attempt) =>
                    attempt ? failureSummary(symphony, attempt) : null,
                  ),
                ),
                3500,
              )}`;
          const instruction = allDone
            ? "All task agents reported completion and stopped. Review the evidence, then finish the symphony with a summary."
            : "Task agents need attention. Act on each summary with dispatch (retryTaskId plus note/addWrites) or ask the user; open a conversation only when the summary is unclear.";
          // Stable message identity makes uncertain notification retries harmless.
          await workers().wake(
            symphony.source.agentId,
            `Conductor symphony ${symphony.id}: ${instruction}${detail}`,
            `${symphony.id}:${notification}`,
          );
          await change(symphony.id, (current) => {
            if (current.execution.conducting) {
              current.execution.conducting.notification = notification;
            }
          });
        }
      } catch (error) {
        // One busy/unreachable Conductor agent must not starve independent symphonies.
        // Ownership stays fenced while observation/notification is retried.
        if (
          error instanceof SymphonyError &&
          error.message.includes("unavailable")
        ) {
          await change(summary.id, (current) => {
            current.execution.interruption =
              "The Conductor agent is unavailable. Existing task agents and their reports remain visible.";
          }).catch(() => {});
        }
      }
    }
  };
  return { start, define, dispatch, reconcile };
}
