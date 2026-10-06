import { randomUUID } from "node:crypto";
import {
  agentCommandRequestSchema,
  commandTaskSchema,
  type RunAgentCommand,
} from "../shared/run-commands";
import { conflictReason, graphIssues } from "../shared/run-graph";
import {
  latestAttempt,
  RUN_LIMITS,
  type StoredRun,
  type TaskDefinition,
} from "../shared/run-models";
import { commandRunId, type ExecutionRuntime } from "./run-identity";
import { RunError } from "./run-files";
import { contentHash, type RunStore } from "./run-store";
import { orchestration } from "./run-orchestration";
import type { RunCommandAccess } from "./run-command-server";
import { agentCommand } from "./run-prompts";
import type { WorkerRuntime } from "./run-workers";
import { executionStatus, requirePassingReport } from "./run-results";

export function runExecution(
  store: RunStore,
  getRuntime: () => ExecutionRuntime,
  getWorkers?: () => WorkerRuntime,
  getAccess?: () => RunCommandAccess,
) {
  const orchestrator = orchestration(
    store,
    getRuntime,
    () => {
      if (!getWorkers) {
        throw new RunError("Worker runtime is unavailable.");
      }
      return getWorkers();
    },
    (agentId, verb) => agentCommand(getAccess?.(), agentId, verb),
  );
  // Serializes read/version/mutate in this controller; RunStore fences other processes too.
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
    command: Extract<RunAgentCommand, { kind: "start" }>,
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
          inputs: ["Run context"],
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
      throw new RunError(issues.slice(0, 5).join(" "));
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
        id: commandRunId(agentId, command.key),
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

  const requireCapacity = async (run: StoredRun, task: TaskDefinition) => {
    const list = await store.list();
    if (list.incomplete || list.unavailable) {
      throw new RunError(
        "Run storage coverage is incomplete; resource ownership cannot be checked.",
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
        if (
          attempt &&
          (attempt.state === "running" ||
            attempt.state === "blocked" ||
            (attempt.launch && !attempt.launch.settled)) &&
          ((task.writes.length > 0 && definition.writes.length > 0) ||
            conflictReason(task, definition))
        ) {
          throw new RunError(
            `Task resources are still owned by ${other.title} / ${definition.id}. Resume or report that work before claiming this task.`,
          );
        }
      }
    }
  };

  const mutate = async (
    agentId: string,
    command: Exclude<
      RunAgentCommand,
      {
        kind:
          | "start"
          | "list"
          | "get"
          | "remove-legacy"
          | "orchestrate"
          | "define"
          | "dispatch"
          | "profiles";
      }
    >,
  ) => {
    const runtime = getRuntime();
    const source = await runtime.source(agentId);
    const initial = (await store.read(command.runId)).run;
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
      throw new RunError(
        "Only the assigned task agent can report; only the original source agent in this workspace can control its run.",
      );
    }
    if (orchestrated && command.kind === "claim") {
      throw new RunError(
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
          throw new RunError(
            "This is a legacy plan without an execution record.",
          );
        }
        if (command.kind === "finish") {
          if (execution.finishedAt !== null) {
            if (execution.summary !== command.summary) {
              throw new RunError(
                "This run already has a different final report.",
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
            throw new RunError(
              "Finish requires a completed report for every task and settled task agents.",
            );
          }
          execution.summary = command.summary;
          execution.finishedAt = Date.now();
          execution.interruption = null;
        } else if (command.kind === "claim") {
          if (execution.finishedAt !== null) {
            throw new RunError("This run is already complete.");
          }
          const task = graph.tasks.find((entry) => entry.id === command.taskId);
          if (!task) {
            throw new RunError("Unknown task.");
          }
          const previous = latestAttempt(current, task.id);
          if (previous?.state === "completed") {
            throw new RunError("This task already has a completed report.");
          }
          if (previous?.state === "failed" && !command.retry) {
            throw new RunError(
              "The last attempt failed. Explicitly set retry to create a new attempt.",
            );
          }
          if (
            task.prerequisites.some(
              (id) => latestAttempt(current, id)?.state !== "completed",
            )
          ) {
            throw new RunError(
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
            if (execution.attempts.length >= RUN_LIMITS.attempts) {
              throw new RunError("The run attempt limit has been reached.");
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
            throw new RunError(
              "The attempt is missing or has been superseded.",
            );
          }
          if (command.kind === "block") {
            if (attempt.report) {
              throw new RunError("A reported attempt cannot be blocked.");
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
          } else {
            const digest = contentHash(JSON.stringify(command.report));
            if (attempt.reportHash) {
              if (attempt.reportHash !== digest) {
                throw new RunError(
                  "This attempt already has a different report.",
                );
              }
              return current;
            }
            const task = graph.tasks.find(
              (entry) => entry.id === attempt.taskId,
            );
            if (!task) {
              throw new RunError("Unknown task.");
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
  return {
    execute: (input: unknown) =>
      serialize(async () => {
        const { agentId, command } = agentCommandRequestSchema.parse(input);
        if (command.kind === "orchestrate") {
          return orchestrator.start(agentId, command);
        }
        if (command.kind === "define") {
          return orchestrator.define(agentId, command);
        }
        if (command.kind === "dispatch") {
          return orchestrator.dispatch(
            agentId,
            command.runId,
            command.retryTaskId,
            command.profile,
          );
        }
        if (command.kind === "profiles") {
          if (!getWorkers) {
            throw new RunError("Worker runtime is unavailable.");
          }
          return { profiles: await getWorkers().profiles() };
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
          const data = await store.read(command.runId);
          if (
            data.run.source.agentId !== agentId &&
            data.run.execution?.orchestration?.requestedBy !== agentId &&
            !data.run.execution?.attempts.some((a) => a.agentId === agentId)
          ) {
            throw new RunError("This run belongs to another source agent.");
          }
          return data;
        }
        if (command.kind === "remove-legacy") {
          const source = await getRuntime().source(agentId);
          await store.removeLegacy(command.runId, command.expectedVersion, {
            agentId,
            workspaceId: source.workspaceId,
          });
          return { removed: command.runId };
        }
        return mutate(agentId, command);
      }),
    startWorkspace: (workspaceId: string, input: unknown) =>
      serialize(async () => {
        const command = agentCommandRequestSchema.shape.command.parse(input);
        if (command.kind !== "orchestrate") {
          throw new RunError("Expected an orchestration request.");
        }
        return orchestrator.startWorkspace(workspaceId, command);
      }),
    interrupt,
    reconcile: () => serialize(() => orchestrator.reconcile()),
    drain: () => queue,
  };
}
