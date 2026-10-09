import { randomUUID } from "node:crypto";
import {
  agentCommandRequestSchema,
  commandTaskSchema,
  workerChoice,
  type SymphonyCommand,
} from "../../shared/symphonies/commands";
import {
  effectiveTask,
  scoreIssues,
  overlap,
  scopeConflictReason,
} from "../../shared/symphonies/score";
import {
  latestAttempt,
  SYMPHONY_LIMITS,
  type StoredSymphony,
  type TaskDefinition,
} from "../../shared/symphonies/models";
import { commandSymphonyId, type ExecutionRuntime } from "./identity";
import { SymphonyError } from "./errors";
import { contentHash, type SymphonyStore } from "./store";
import { orchestration } from "./orchestration";
import type { SymphonyCommandAccess } from "./command-access";
import { agentCommand } from "./prompts";
import type { WorkerRuntime } from "./workers";
import {
  executionStatus,
  requirePassingReport,
  attemptHoldsResources,
  widenCalls,
} from "./results";

export function symphonyExecution(
  store: SymphonyStore,
  getRuntime: () => ExecutionRuntime,
  getWorkers?: () => WorkerRuntime,
  getAccess?: () => SymphonyCommandAccess,
) {
  const conductor = orchestration(
    store,
    getRuntime,
    () => {
      if (!getWorkers) {
        throw new SymphonyError("Task agent runtime is unavailable.");
      }
      return getWorkers();
    },
    (agentId, verb) => agentCommand(getAccess?.(), agentId, verb),
  );
  // Serializes read/version/mutate in this controller; SymphonyStore fences other processes too.
  let queue = Promise.resolve();
  const serialize = <T>(action: () => Promise<T>): Promise<T> => {
    const pending = queue.then(action);
    queue = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  };
  const start = async (
    agentId: string,
    command: Extract<SymphonyCommand, { kind: "start" }>,
  ) => {
    const runtime = getRuntime();
    const source = await runtime.capture(await runtime.source(agentId));
    const definitions = command.tasks ?? [
      commandTaskSchema.parse({
        id: "work",
        title: command.title,
        description: command.goal.slice(0, 4000),
      }),
    ];
    const score = {
      tasks: definitions.map(
        (task): TaskDefinition => ({
          id: task.id,
          title: task.title,
          outcome: task.description,
          prerequisites: task.dependsOn,
          inputs: ["Symphony context"],
          reads: task.reads,
          writes: task.writes,
          resources: task.resources,
          worker: {
            role: task.writes.length ? "implementation" : "exploration",
            profile: "tracked",
          },
          criteria: ["Report the outcome, evidence and required checks."],
          checks: task.checks,
          stopWhen:
            "Report the assignment outcome without expanding the authorized scope.",
        }),
      ),
    };
    const issues = scoreIssues(score);
    if (issues.length) {
      throw new SymphonyError(issues.slice(0, 5).join(" "));
    }
    await runtime.validate(source, score);
    const context = {
      plan: command.goal,
      provenance: "Source agent command",
      decisions: [],
      constraints: [],
      expectedOutcome: command.goal.slice(0, 4000),
    };
    const now = Date.now();
    return store.create(
      {
        schemaVersion: 1,
        id: commandSymphonyId(agentId, command.key),
        version: 0,
        title: command.title,
        source,
        contextHash: contentHash(JSON.stringify(context)),
        requestHash: contentHash(JSON.stringify({ agentId, command })),
        createdAt: now,
        updatedAt: now,
        status: "ready",
        revisions: [
          {
            number: 1,
            parent: null,
            reason: "Source agent recorded the requested work.",
            acceptedAt: now,
            score,
          },
        ],
        execution: {
          origin: "tracked",
          attempts: [],
          summary: null,
          finishedAt: null,
          interruption: null,
        },
      },
      context,
    );
  };

  const requireCapacity = async (
    symphony: StoredSymphony,
    task: TaskDefinition,
  ) => {
    const list = await store.list();
    if (list.incomplete || list.unavailable) {
      throw new SymphonyError(
        "Symphony storage coverage is incomplete; resource ownership cannot be checked.",
      );
    }
    // The claim candidate's own effective scope includes Conductor additions
    // from its earlier attempts.
    const candidate = effectiveTask(symphony, task);
    for (const summary of list.symphonies) {
      if (summary.source.checkout !== symphony.source.checkout) {
        continue;
      }
      const other =
        summary.id === symphony.id
          ? symphony
          : (await store.read(summary.id)).symphony;
      for (const definition of other.revisions.at(-1)?.score.tasks ?? []) {
        if (other.id === symphony.id && definition.id === task.id) {
          continue;
        }
        const attempt = latestAttempt(other, definition.id);
        if (
          attemptHoldsResources(attempt) &&
          scopeConflictReason(candidate, effectiveTask(other, definition))
        ) {
          throw new SymphonyError(
            `Task resources are still owned by ${other.title} / ${definition.id}. Resume or report that work before claiming this task.`,
          );
        }
      }
    }
  };

  const mutate = async (
    agentId: string,
    command: Exclude<
      SymphonyCommand,
      {
        kind:
          | "start"
          | "list"
          | "get"
          | "orchestrate"
          | "define"
          | "dispatch"
          | "profiles"
          | "models"
          | "widen";
      }
    >,
  ) => {
    const runtime = getRuntime();
    const source = await runtime.source(agentId);
    const initial = (await store.read(command.symphonyId)).symphony;
    const reporting = command.kind === "block" || command.kind === "report";
    const assigned =
      reporting &&
      initial.execution.attempts.find((a) => a.id === command.attemptId)
        ?.agentId === agentId;
    const orchestrated = initial.execution.origin === "conducted";
    if (
      initial.source.concertId !== source.concertId ||
      (orchestrated && reporting
        ? !assigned
        : initial.source.agentId !== agentId)
    ) {
      throw new SymphonyError(
        "Only the assigned task agent can report; only the original source agent in this concert can control its symphony.",
      );
    }
    if (orchestrated && command.kind === "claim") {
      throw new SymphonyError(
        "Orchestrated tasks are dispatched to child agents, not claimed by the conductor.",
      );
    }
    const symphony = await store.update(
      initial.id,
      initial.version,
      async (current) => {
        const execution = current.execution;
        const score = current.revisions.at(-1)?.score;
        if (!score) {
          throw new SymphonyError("Symphony score is missing.");
        }
        if (command.kind === "finish") {
          if (execution.finishedAt !== null) {
            if (execution.summary !== command.summary) {
              throw new SymphonyError(
                "This symphony already has a different final report.",
              );
            }
            return current;
          }
          if (
            score.tasks.some(
              (task) =>
                latestAttempt(current, task.id)?.state !== "completed" ||
                (orchestrated &&
                  !latestAttempt(current, task.id)?.launch?.settled),
            )
          ) {
            throw new SymphonyError(
              "Finish requires a completed report for every task and settled task agents.",
            );
          }
          execution.summary = command.summary;
          execution.finishedAt = Date.now();
          execution.interruption = null;
        } else if (command.kind === "claim") {
          if (execution.finishedAt !== null) {
            throw new SymphonyError("This symphony is already complete.");
          }
          const task = score.tasks.find((entry) => entry.id === command.taskId);
          if (!task) {
            throw new SymphonyError("Unknown task.");
          }
          const previous = latestAttempt(current, task.id);
          if (previous?.state === "completed") {
            throw new SymphonyError(
              "This task already has a completed report.",
            );
          }
          if (previous?.state === "failed" && !command.retry) {
            throw new SymphonyError(
              "The last attempt failed. Explicitly set retry to create a new attempt.",
            );
          }
          if (
            task.prerequisites.some(
              (id) => latestAttempt(current, id)?.state !== "completed",
            )
          ) {
            throw new SymphonyError(
              "Task prerequisites do not have completed reports yet.",
            );
          }
          await runtime.validate(current.source, score);
          await requireCapacity(current, task);
          execution.interruption = null;
          if (
            previous &&
            (previous.state === "running" || previous.state === "blocked")
          ) {
            previous.state = "running";
            previous.message = null;
          } else {
            if (execution.attempts.length >= SYMPHONY_LIMITS.attempts) {
              throw new SymphonyError(
                "The symphony attempt limit has been reached.",
              );
            }
            execution.attempts.push({
              id: randomUUID(),
              taskId: task.id,
              agentId,
              state: "running",
              startedAt: Date.now(),
              endedAt: null,
              message: null,
              report: null,
              reportHash: null,
            });
          }
        } else {
          const attempt = execution.attempts.find(
            (entry) => entry.id === command.attemptId,
          );
          if (
            !attempt ||
            latestAttempt(current, attempt.taskId)?.id !== attempt.id
          ) {
            throw new SymphonyError(
              "The attempt is missing or has been superseded.",
            );
          }
          if (command.kind === "block") {
            if (attempt.report) {
              throw new SymphonyError("A reported attempt cannot be blocked.");
            }
            if (attempt.launch) {
              attempt.launch.state = "started";
              if (attempt.launch.settled) {
                attempt.launch.generation += 1;
              }
              attempt.launch.settled = false;
            }
            attempt.state = "blocked";
            attempt.message = command.message;
            // Record the classification atomically with the state. Reconcile
            // only settles the launch later, once the task agent stops; without
            // this marker the first Conductor notification would mislabel a
            // task agent block as a server no-report settlement.
            attempt.blockedBy = "worker";
          } else {
            const digest = contentHash(JSON.stringify(command.report));
            if (attempt.reportHash) {
              if (attempt.reportHash !== digest) {
                throw new SymphonyError(
                  "This attempt already has a different report.",
                );
              }
              return current;
            }
            const task = score.tasks.find(
              (entry) => entry.id === attempt.taskId,
            );
            if (!task) {
              throw new SymphonyError("Unknown task.");
            }
            requirePassingReport(task, command.report);
            if (attempt.launch) {
              attempt.launch.state = "started";
              if (attempt.launch.settled) {
                attempt.launch.generation += 1;
              }
              attempt.launch.settled = false;
            }
            if (attempt.launch) {
              attempt.reportedBy = "worker";
            }
            attempt.report = command.report;
            attempt.reportHash = digest;
            attempt.state = command.report.outcome;
            attempt.endedAt = Date.now();
            attempt.message = null;
            execution.interruption = null;
          }
        }
        current.status = executionStatus(current);
        return current;
      },
    );
    return {
      symphony,
      ...(command.kind === "claim"
        ? { attempt: latestAttempt(symphony, command.taskId) }
        : {}),
    };
  };

  const interrupt = (agentId: string | null, message: string) =>
    serialize(async () => {
      const list = await store.list();
      for (const summary of list.symphonies) {
        if (agentId && summary.source.agentId !== agentId) {
          continue;
        }
        const { symphony } = await store.read(summary.id);
        // Orchestrated child ownership survives conductor turns and plugin reloads.
        // The reconciler inspects each actual task agent before releasing its
        // claim.
        if (symphony.execution.conducting) {
          if (agentId && symphony.execution.conducting.phase === "planning") {
            await store.update(symphony.id, symphony.version, (value) => {
              value.execution.interruption =
                "Conductor agent stopped before defining tasks. Open the Conductor agent to continue.";
              value.status = executionStatus(value);
              return value;
            });
          }
          continue;
        }
        if (
          !symphony.execution.attempts.some(
            (attempt) => attempt.state === "running",
          )
        ) {
          continue;
        }
        await store.update(symphony.id, symphony.version, (value) => {
          value.execution.interruption = message;
          for (const attempt of value.execution.attempts) {
            if (attempt.state === "running") {
              attempt.state = "blocked";
              attempt.message = message;
            }
          }
          value.status = executionStatus(value);
          return value;
        });
      }
    });
  /**
   * A running task agent asks to grow its own attempt's write scope. The server
   * grants it only when no resource-holding attempt on this checkout overlaps
   * the paths, no unfinished task in the same score owns them, and the attempt
   * is within its widen limits. Refusals change nothing and name the task that
   * holds the path.
   */
  const widen = async (
    agentId: string,
    command: Extract<SymphonyCommand, { kind: "widen" }>,
  ) => {
    const runtime = getRuntime();
    const source = await runtime.source(agentId);
    const initial = (await store.read(command.symphonyId)).symphony;
    const assigned = initial.execution.attempts.find(
      (attempt) => attempt.id === command.attemptId,
    );
    if (
      initial.execution.origin !== "conducted" ||
      initial.source.concertId !== source.concertId ||
      assigned?.agentId !== agentId
    ) {
      throw new SymphonyError(
        "Only the assigned task agent can widen its attempt's write scope.",
      );
    }
    const symphony = await store.update(
      initial.id,
      initial.version,
      async (current) => {
        const execution = current.execution;
        const score = current.revisions.at(-1)?.score;
        if (!score) {
          throw new SymphonyError("Symphony score is missing.");
        }
        const attempt = execution.attempts.find(
          (entry) => entry.id === command.attemptId,
        );
        if (!attempt || attempt.agentId !== agentId) {
          throw new SymphonyError(
            "Only the assigned task agent can widen its attempt's write scope.",
          );
        }
        const task = score.tasks.find((entry) => entry.id === attempt.taskId);
        if (!task) {
          throw new SymphonyError("Unknown task.");
        }
        // A task with no effective writes is read-only; widening it would
        // silently turn an exploration into a writer. Conductor additions count
        // as effective writes, so such a task can widen further.
        const effective = effectiveTask(current, task);
        if (effective.writes.length === 0) {
          throw new SymphonyError(
            'Widen refused: read-only tasks cannot widen their write scope. Report need "scope" instead.',
          );
        }
        if (attempt.state !== "running") {
          throw new SymphonyError(
            "Only a running attempt can widen its write scope.",
          );
        }
        const granted = attempt.grantedWrites ?? [];
        if (widenCalls(granted) >= SYMPHONY_LIMITS.widenCallsPerAttempt) {
          throw new SymphonyError(
            `Widen refused: this attempt has used its ${SYMPHONY_LIMITS.widenCallsPerAttempt} widen calls.`,
          );
        }
        if (
          granted.length + command.paths.length >
          SYMPHONY_LIMITS.widenPathsPerCall *
            SYMPHONY_LIMITS.widenCallsPerAttempt
        ) {
          throw new SymphonyError(
            `Widen refused: an attempt may hold at most ${SYMPHONY_LIMITS.widenPathsPerCall * SYMPHONY_LIMITS.widenCallsPerAttempt} granted paths.`,
          );
        }
        for (const owner of score.tasks) {
          if (
            owner.id === task.id ||
            latestAttempt(current, owner.id)?.state === "completed"
          ) {
            continue;
          }
          const owned = owner.writes.find((path) =>
            command.paths.some((requested) => overlap(path, requested)),
          );
          if (owned) {
            throw new SymphonyError(
              `Widen refused: "${owned}" is owned by unfinished task "${owner.id}". Report need "scope" instead.`,
            );
          }
        }
        const requested: TaskDefinition = {
          ...effective,
          writes: [...new Set([...effective.writes, ...command.paths])],
        };
        // The grant is stored scope, so re-run the placement and symlink
        // validation the initial define/launch used before persisting it.
        await runtime.validate(current.source, {
          tasks: score.tasks.map((entry) =>
            entry.id === task.id ? requested : entry,
          ),
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
            const holding = latestAttempt(other, definition.id);
            if (
              !attemptHoldsResources(holding) ||
              (other.id === current.id && holding?.id === attempt.id)
            ) {
              continue;
            }
            const reason = scopeConflictReason(
              requested,
              effectiveTask(other, definition),
            );
            if (reason) {
              throw new SymphonyError(
                `Widen refused: ${command.paths.join(", ")} is held by task "${definition.id}" in ${other.title} (${reason}). Report need "scope" instead.`,
              );
            }
          }
        }
        const at = Math.max(
          Date.now(),
          ...granted.map((grant) => grant.at + 1),
        );
        attempt.grantedWrites = [
          ...granted,
          ...command.paths.map((path) => ({
            path,
            reason: command.reason,
            at,
          })),
        ];
        return current;
      },
    );
    return {
      acknowledged: true,
      symphonyId: symphony.id,
      attemptId: command.attemptId,
      granted: command.paths,
      grantedWrites:
        symphony.execution.attempts.find(
          (entry) => entry.id === command.attemptId,
        )?.grantedWrites ?? [],
    };
  };
  return {
    execute: (input: unknown) =>
      serialize(async () => {
        const { agentId, command } = agentCommandRequestSchema.parse(input);
        if (command.kind === "widen") {
          return widen(agentId, command);
        }
        if (command.kind === "orchestrate") {
          return conductor.start(agentId, command);
        }
        if (command.kind === "define") {
          return conductor.define(agentId, command);
        }
        if (command.kind === "dispatch") {
          return conductor.dispatch(
            agentId,
            command.symphonyId,
            command.retryTaskId,
            workerChoice(command),
            command.note,
            command.addWrites,
          );
        }
        if (command.kind === "profiles") {
          if (!getWorkers) {
            throw new SymphonyError("Task agent runtime is unavailable.");
          }
          return { profiles: await getWorkers().profiles() };
        }
        if (command.kind === "models") {
          if (!getWorkers) {
            throw new SymphonyError("Task agent runtime is unavailable.");
          }
          return { models: await getWorkers().models(agentId) };
        }
        if (command.kind === "start") {
          return { symphony: await start(agentId, command) };
        }
        if (command.kind === "list") {
          const list = await store.list();
          return {
            ...list,
            symphonies: list.symphonies.filter(
              (symphony) => symphony.source.agentId === agentId,
            ),
          };
        }
        if (command.kind === "get") {
          const data = await store.read(command.symphonyId);
          if (
            data.symphony.source.agentId !== agentId &&
            data.symphony.execution.conducting?.requestedBy !== agentId &&
            !data.symphony.execution.attempts.some((a) => a.agentId === agentId)
          ) {
            throw new SymphonyError(
              "This symphony belongs to another source agent.",
            );
          }
          return data;
        }
        return mutate(agentId, command);
      }),
    interrupt,
    reconcile: () => serialize(() => conductor.reconcile()),
    drain: () => queue,
  };
}
