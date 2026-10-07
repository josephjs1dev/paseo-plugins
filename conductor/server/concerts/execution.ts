import { randomUUID } from "node:crypto";
import {
  commandTaskSchema,
  widenedAgentCommandRequestSchema,
  workerChoice,
  type ConcertCommand,
  type WidenCommand,
} from "../../shared/concerts/commands";
import {
  effectiveTask,
  graphIssues,
  overlap,
  scopeConflictReason,
} from "../../shared/concerts/graph";
import {
  latestAttempt,
  CONCERT_LIMITS,
  type StoredConcert,
  type TaskDefinition,
} from "../../shared/concerts/models";
import { commandConcertId, type ExecutionRuntime } from "./identity";
import { ConcertError } from "./errors";
import { contentHash, type ConcertStore } from "./store";
import { orchestration } from "./orchestration";
import type { ConcertCommandAccess } from "./commands/server";
import { agentCommand } from "./prompts";
import type { WorkerRuntime } from "./workers";
import {
  executionStatus,
  requirePassingReport,
  attemptHoldsResources,
  widenCalls,
} from "./results";

export function concertExecution(
  store: ConcertStore,
  getRuntime: () => ExecutionRuntime,
  getWorkers?: () => WorkerRuntime,
  getAccess?: () => ConcertCommandAccess,
) {
  const orchestrator = orchestration(
    store,
    getRuntime,
    () => {
      if (!getWorkers) {
        throw new ConcertError("Worker runtime is unavailable.");
      }
      return getWorkers();
    },
    (agentId, verb) => agentCommand(getAccess?.(), agentId, verb),
  );
  // Serializes read/version/mutate in this controller; ConcertStore fences other processes too.
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
    command: Extract<ConcertCommand, { kind: "start" }>,
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
    const graph = {
      tasks: definitions.map(
        (task): TaskDefinition => ({
          id: task.id,
          title: task.title,
          outcome: task.description,
          prerequisites: task.dependsOn,
          inputs: ["Concert context"],
          reads: task.reads,
          writes: task.writes,
          resources: task.resources,
          worker: {
            role: task.writes.length ? "implementation" : "exploration",
            profile: "source-agent",
          },
          criteria: ["Report the outcome, evidence and required checks."],
          checks: task.checks,
          stopWhen:
            "Report the assignment outcome without expanding the authorized scope.",
        }),
      ),
    };
    const issues = graphIssues(graph);
    if (issues.length) {
      throw new ConcertError(issues.slice(0, 5).join(" "));
    }
    await runtime.validate(source, graph);
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
        id: commandConcertId(agentId, command.key),
        version: 0,
        title: command.title,
        source,
        contextHash: contentHash(JSON.stringify(context)),
        requestHash: contentHash(JSON.stringify({ agentId, command })),
        createdAt: now,
        updatedAt: now,
        status: "ready",
        draft: null,
        revisions: [
          {
            number: 1,
            parent: null,
            reason: "Source agent recorded the requested work.",
            acceptedAt: now,
            authority: "agent",
            graph,
          },
        ],
        execution: {
          origin: "source-agent",
          attempts: [],
          summary: null,
          finishedAt: null,
          interruption: null,
        },
      },
      context,
    );
  };

  const requireCapacity = async (run: StoredConcert, task: TaskDefinition) => {
    const list = await store.list();
    if (list.incomplete || list.unavailable) {
      throw new ConcertError(
        "Concert storage coverage is incomplete; resource ownership cannot be checked.",
      );
    }
    for (const summary of list.runs) {
      if (summary.source.checkout !== run.source.checkout) {
        continue;
      }
      const other =
        summary.id === run.id ? run : (await store.read(summary.id)).run;
      for (const definition of other.revisions.at(-1)?.graph.tasks ?? []) {
        if (other.id === run.id && definition.id === task.id) {
          continue;
        }
        const attempt = latestAttempt(other, definition.id);
        const effective = effectiveTask(definition, attempt);
        if (
          attemptHoldsResources(attempt) &&
          scopeConflictReason(task, effective)
        ) {
          throw new ConcertError(
            `Task resources are still owned by ${other.title} / ${definition.id}. Resume or report that work before claiming this task.`,
          );
        }
      }
    }
  };

  const mutate = async (
    agentId: string,
    command: Exclude<
      ConcertCommand,
      {
        kind:
          | "start"
          | "list"
          | "get"
          | "remove-legacy"
          | "orchestrate"
          | "define"
          | "dispatch"
          | "profiles"
          | "models";
      }
    >,
  ) => {
    const runtime = getRuntime();
    const source = await runtime.source(agentId);
    const initial = (await store.read(command.concertId)).run;
    const reporting = command.kind === "block" || command.kind === "report";
    const assigned =
      reporting &&
      initial.execution?.attempts.find((a) => a.id === command.attemptId)
        ?.agentId === agentId;
    const orchestrated = initial.execution?.origin === "orchestrator";
    if (
      !initial.execution ||
      initial.source.workspaceId !== source.workspaceId ||
      (orchestrated && reporting
        ? !assigned
        : initial.source.agentId !== agentId)
    ) {
      throw new ConcertError(
        "Only the assigned task agent can report; only the original source agent in this workspace can control its concert.",
      );
    }
    if (orchestrated && command.kind === "claim") {
      throw new ConcertError(
        "Orchestrated tasks are dispatched to child agents, not claimed by the conductor.",
      );
    }
    const run = await store.update(
      initial.id,
      initial.version,
      async (current) => {
        const execution = current.execution;
        const graph = current.revisions.at(-1)?.graph;
        if (!execution || !graph) {
          throw new ConcertError(
            "This is a legacy plan without an execution record.",
          );
        }
        if (command.kind === "finish") {
          if (execution.finishedAt !== null) {
            if (execution.summary !== command.summary) {
              throw new ConcertError(
                "This concert already has a different final report.",
              );
            }
            return current;
          }
          if (
            graph.tasks.some(
              (task) =>
                latestAttempt(current, task.id)?.state !== "completed" ||
                (orchestrated &&
                  !latestAttempt(current, task.id)?.launch?.settled),
            )
          ) {
            throw new ConcertError(
              "Finish requires a completed report for every task and settled task agents.",
            );
          }
          execution.summary = command.summary;
          execution.finishedAt = Date.now();
          execution.interruption = null;
        } else if (command.kind === "claim") {
          if (execution.finishedAt !== null) {
            throw new ConcertError("This concert is already complete.");
          }
          const task = graph.tasks.find((entry) => entry.id === command.taskId);
          if (!task) {
            throw new ConcertError("Unknown task.");
          }
          const previous = latestAttempt(current, task.id);
          if (previous?.state === "completed") {
            throw new ConcertError("This task already has a completed report.");
          }
          if (previous?.state === "failed" && !command.retry) {
            throw new ConcertError(
              "The last attempt failed. Explicitly set retry to create a new attempt.",
            );
          }
          if (
            task.prerequisites.some(
              (id) => latestAttempt(current, id)?.state !== "completed",
            )
          ) {
            throw new ConcertError(
              "Task prerequisites do not have completed reports yet.",
            );
          }
          await runtime.validate(current.source, graph);
          await requireCapacity(current, task);
          execution.interruption = null;
          if (
            previous &&
            (previous.state === "running" || previous.state === "blocked")
          ) {
            previous.state = "running";
            previous.message = null;
          } else {
            if (execution.attempts.length >= CONCERT_LIMITS.attempts) {
              throw new ConcertError(
                "The concert attempt limit has been reached.",
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
            throw new ConcertError(
              "The attempt is missing or has been superseded.",
            );
          }
          if (command.kind === "block") {
            if (attempt.report) {
              throw new ConcertError("A reported attempt cannot be blocked.");
            }
            if (attempt.launch) {
              attempt.launch.state = "started";
              if (attempt.launch.settled) {
                attempt.launch.generation =
                  (attempt.launch.generation ?? 0) + 1;
              }
              attempt.launch.settled = false;
            }
            attempt.state = "blocked";
            attempt.message = command.message;
            // Record the classification atomically with the state. Reconcile
            // only settles the launch later, once the worker stops; without
            // this marker the first Conductor notification would mislabel a
            // worker block as a server no-report settlement.
            attempt.blockedBy = "worker";
          } else {
            const digest = contentHash(JSON.stringify(command.report));
            if (attempt.reportHash) {
              if (attempt.reportHash !== digest) {
                throw new ConcertError(
                  "This attempt already has a different report.",
                );
              }
              return current;
            }
            const task = graph.tasks.find(
              (entry) => entry.id === attempt.taskId,
            );
            if (!task) {
              throw new ConcertError("Unknown task.");
            }
            requirePassingReport(task, command.report);
            if (attempt.launch) {
              attempt.launch.state = "started";
              if (attempt.launch.settled) {
                attempt.launch.generation =
                  (attempt.launch.generation ?? 0) + 1;
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
      run,
      ...(command.kind === "claim"
        ? { attempt: latestAttempt(run, command.taskId) }
        : {}),
    };
  };

  const interrupt = (agentId: string | null, message: string) =>
    serialize(async () => {
      const list = await store.list();
      for (const summary of list.runs) {
        if (agentId && summary.source.agentId !== agentId) {
          continue;
        }
        const { run } = await store.read(summary.id);
        // Orchestrated child ownership survives conductor turns and plugin reloads.
        // The reconciler inspects each actual worker before releasing its claim.
        if (run.execution?.orchestration) {
          if (agentId && run.execution.orchestration.phase === "planning") {
            await store.update(run.id, run.version, (value) => {
              if (value.execution) {
                value.execution.interruption =
                  "Conductor agent stopped before defining tasks. Open the Conductor agent to continue.";
              }
              value.status = executionStatus(value);
              return value;
            });
          }
          continue;
        }
        if (
          !run.execution?.attempts.some(
            (attempt) => attempt.state === "running",
          )
        ) {
          continue;
        }
        await store.update(run.id, run.version, (value) => {
          if (!value.execution) {
            return value;
          }
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
   * A running worker asks to grow its own attempt's write scope. The server
   * grants it only when no resource-holding attempt on this checkout overlaps
   * the paths, no unfinished task in the same graph owns them, and the attempt
   * is within its widen limits. Refusals change nothing and name the task that
   * holds the path.
   */
  const widen = async (agentId: string, command: WidenCommand) => {
    const runtime = getRuntime();
    const source = await runtime.source(agentId);
    const initial = (await store.read(command.concertId)).run;
    const assigned = initial.execution?.attempts.find(
      (attempt) => attempt.id === command.attemptId,
    );
    if (
      !initial.execution ||
      initial.execution.origin !== "orchestrator" ||
      initial.source.workspaceId !== source.workspaceId ||
      assigned?.agentId !== agentId
    ) {
      throw new ConcertError(
        "Only the assigned task agent can widen its attempt's write scope.",
      );
    }
    const run = await store.update(
      initial.id,
      initial.version,
      async (current) => {
        const execution = current.execution;
        const graph = current.revisions.at(-1)?.graph;
        if (!execution || !graph) {
          throw new ConcertError(
            "This is a legacy plan without an execution record.",
          );
        }
        const attempt = execution.attempts.find(
          (entry) => entry.id === command.attemptId,
        );
        if (!attempt || attempt.agentId !== agentId) {
          throw new ConcertError(
            "Only the assigned task agent can widen its attempt's write scope.",
          );
        }
        const task = graph.tasks.find((entry) => entry.id === attempt.taskId);
        if (!task) {
          throw new ConcertError("Unknown task.");
        }
        // A task the Conductor defined without writes is read-only; widening it
        // would silently turn an exploration into a writer.
        if (task.writes.length === 0) {
          throw new ConcertError(
            'Widen refused: read-only tasks cannot widen their write scope. Report need "scope" instead.',
          );
        }
        if (attempt.state !== "running") {
          throw new ConcertError(
            "Only a running attempt can widen its write scope.",
          );
        }
        const granted = attempt.grantedWrites ?? [];
        if (widenCalls(granted) >= CONCERT_LIMITS.widenCallsPerAttempt) {
          throw new ConcertError(
            `Widen refused: this attempt has used its ${CONCERT_LIMITS.widenCallsPerAttempt} widen calls.`,
          );
        }
        if (
          granted.length + command.paths.length >
          CONCERT_LIMITS.widenPathsPerCall * CONCERT_LIMITS.widenCallsPerAttempt
        ) {
          throw new ConcertError(
            `Widen refused: an attempt may hold at most ${CONCERT_LIMITS.widenPathsPerCall * CONCERT_LIMITS.widenCallsPerAttempt} granted paths.`,
          );
        }
        for (const owner of graph.tasks) {
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
            throw new ConcertError(
              `Widen refused: "${owned}" is owned by unfinished task "${owner.id}". Report need "scope" instead.`,
            );
          }
        }
        const effective = effectiveTask(task, attempt);
        const requested: TaskDefinition = {
          ...effective,
          writes: [...new Set([...effective.writes, ...command.paths])],
        };
        // The grant is stored scope, so re-run the placement and symlink
        // validation the initial define/launch used before persisting it.
        await runtime.validate(current.source, {
          tasks: graph.tasks.map((entry) =>
            entry.id === task.id ? requested : entry,
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
          if (!other.execution) {
            continue;
          }
          for (const definition of other.revisions.at(-1)?.graph.tasks ?? []) {
            const holding = latestAttempt(other, definition.id);
            if (
              !attemptHoldsResources(holding) ||
              (other.id === current.id && holding?.id === attempt.id)
            ) {
              continue;
            }
            const reason = scopeConflictReason(
              requested,
              effectiveTask(definition, holding),
            );
            if (reason) {
              throw new ConcertError(
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
      concertId: run.id,
      attemptId: command.attemptId,
      granted: command.paths,
      grantedWrites:
        run.execution?.attempts.find((entry) => entry.id === command.attemptId)
          ?.grantedWrites ?? [],
    };
  };
  return {
    execute: (input: unknown) =>
      serialize(async () => {
        const { agentId, command } =
          widenedAgentCommandRequestSchema.parse(input);
        if (command.kind === "widen") {
          return widen(agentId, command);
        }
        if (command.kind === "orchestrate") {
          return orchestrator.start(agentId, command);
        }
        if (command.kind === "define") {
          return orchestrator.define(agentId, command);
        }
        if (command.kind === "dispatch") {
          return orchestrator.dispatch(
            agentId,
            command.concertId,
            command.retryTaskId,
            workerChoice(command),
            command.note,
            command.addWrites,
          );
        }
        if (command.kind === "profiles") {
          if (!getWorkers) {
            throw new ConcertError("Worker runtime is unavailable.");
          }
          return { profiles: await getWorkers().profiles() };
        }
        if (command.kind === "models") {
          if (!getWorkers) {
            throw new ConcertError("Worker runtime is unavailable.");
          }
          return { models: await getWorkers().models(agentId) };
        }
        if (command.kind === "start") {
          return { run: await start(agentId, command) };
        }
        if (command.kind === "list") {
          const list = await store.list();
          return {
            ...list,
            runs: list.runs.filter((run) => run.source.agentId === agentId),
          };
        }
        if (command.kind === "get") {
          const data = await store.read(command.concertId);
          if (
            data.run.source.agentId !== agentId &&
            data.run.execution?.orchestration?.requestedBy !== agentId &&
            !data.run.execution?.attempts.some((a) => a.agentId === agentId)
          ) {
            throw new ConcertError(
              "This concert belongs to another source agent.",
            );
          }
          return data;
        }
        if (command.kind === "remove-legacy") {
          const source = await getRuntime().source(agentId);
          await store.removeLegacy(command.concertId, command.expectedVersion, {
            agentId,
            workspaceId: source.workspaceId,
          });
          return { removed: command.concertId };
        }
        return mutate(agentId, command);
      }),
    interrupt,
    reconcile: () => serialize(() => orchestrator.reconcile()),
    drain: () => queue,
  };
}
