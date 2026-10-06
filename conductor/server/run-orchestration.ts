import { reportInstructions, type CommandLine } from "./run-prompts";
import { runCoordinator } from "./run-coordinator";
import { randomUUID } from "node:crypto";
import { conflictReason } from "../shared/run-graph";
import {
  latestAttempt,
  RUN_LIMITS,
  type StoredRun,
  type TaskDefinition,
} from "../shared/run-models";
import { commandRunId, type ExecutionRuntime } from "./run-identity";
import { contentHash, type RunStore } from "./run-store";
import { RunError } from "./run-files";
import { executionStatus } from "./run-results";
import { LaunchRejectedError, type WorkerRuntime } from "./run-workers";

export function orchestration(
  store: RunStore,
  runtime: () => ExecutionRuntime,
  workers: () => WorkerRuntime,
  command: CommandLine,
) {
  const change = async (id: string, update: (run: StoredRun) => void) => {
    const { run } = await store.read(id);
    return store.update(id, run.version, (value) => {
      update(value);
      value.status = executionStatus(value);
      return value;
    });
  };
  const { owner, start, startWorkspace, define } = runCoordinator(
    store,
    runtime,
    workers,
    change,
    command,
  );
  const ownsResources = (attempt: ReturnType<typeof latestAttempt>) =>
    Boolean(
      attempt &&
        (!attempt.report || (attempt.launch && !attempt.launch.settled)),
    );
  const reserve = async (
    runId: string,
    task: TaskDefinition,
    retry = false,
    profile?: string,
  ) => {
    const { run } = await store.read(runId);
    let reserved = false;
    await store.update(runId, run.version, async (current) => {
      const execution = current.execution;
      if (!execution?.orchestration || execution.finishedAt !== null) {
        return current;
      }
      const previous = latestAttempt(current, task.id);
      if (
        previous &&
        !(retry && previous.state === "failed" && previous.launch?.settled)
      ) {
        return current;
      }
      if (
        task.prerequisites.some((id) => {
          const a = latestAttempt(current, id);
          return a?.state !== "completed" || !a.launch?.settled;
        })
      ) {
        return current;
      }
      if (
        execution.attempts.filter((a) => ownsResources(a)).length >=
        execution.orchestration.concurrency
      ) {
        return current;
      }
      const list = await store.list();
      if (list.incomplete || list.unavailable) {
        throw new RunError(
          "Run coverage is incomplete; worker ownership cannot be checked.",
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
          if (
            ownsResources(latestAttempt(other, definition.id)) &&
            ((task.writes.length && definition.writes.length) ||
              conflictReason(task, definition))
          ) {
            return current;
          }
        }
      }
      if (execution.attempts.length >= RUN_LIMITS.attempts) {
        throw new RunError("Run attempt limit reached.");
      }
      const attemptId = randomUUID();
      const workerId = commandRunId(current.id, attemptId);
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
      const prompt = `You are a task agent in Conductor run ${current.id}. Your assigned task is ${task.id}: ${task.title}.\nRun goal: ${context.plan}\nAssignment: ${task.outcome}\nRead scope: ${JSON.stringify(task.reads)}\nWrite scope: ${JSON.stringify(task.writes)}\nRequired checks: ${JSON.stringify(task.checks)}\nPrerequisite reports: ${JSON.stringify(prerequisiteReports)}\nWork in the provided workspace. Other agents may be reading it. Only edit the declared write scope; writes [] means read-only. Do not commit, push, reload plugins, launch extra agents, or expand this assignment. Respect repository instructions.\nYou are already assigned attempt ${attemptId}; do not start a new run or claim a source-agent task. ${reportInstructions(command, workerId, current.id, attemptId, task.checks)}\nFor failure, report outcome failed with accurate evidence. Your Conductor agent is ${current.source.agentId}.`;
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
          profile: profile ?? task.worker.profile,
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
  const launchAttempt = async (runId: string, task: TaskDefinition) => {
    const { run } = await store.read(runId);
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
        ...((attempt.launch.profile ?? task.worker.profile) !== "inherit"
          ? { profile: attempt.launch.profile ?? task.worker.profile }
          : {}),
      };
      const config = attempt.launch.config ?? (await workers().prepare(input));
      if (!attempt.launch.config) {
        await change(runId, (current) => {
          const a = latestAttempt(current, task.id);
          if (a?.launch && a.id === attempt.id) {
            a.launch.config = config;
          }
        });
      }
      creationStarted = true;
      await workers().launch({ ...input, config });
      await change(runId, (current) => {
        const active = latestAttempt(current, task.id);
        if (active?.launch && active.id === attempt.id) {
          active.launch.state = "started";
          active.state = "running";
          active.message = null;
        }
      });
    } catch (error) {
      const rejected = !creationStarted || error instanceof LaunchRejectedError;
      await change(runId, (current) => {
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
                error instanceof RunError
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
            active.state = "blocked";
            active.message =
              "Task agent launch could not be confirmed. Dispatch again to reconcile the same agent; no replacement has been created.";
          }
        }
      });
    }
  };
  const dispatch = async (
    agentId: string,
    runId: string,
    retryTaskId?: string,
    profile?: string,
  ) => {
    let run = await owner(agentId, runId);
    if (
      run.execution?.orchestration?.phase !== "working" ||
      run.execution.finishedAt !== null
    ) {
      throw new RunError("This run is not ready to dispatch.");
    }
    const tasks = run.revisions.at(-1)?.graph.tasks ?? [];
    if (retryTaskId) {
      const task = tasks.find((t) => t.id === retryTaskId);
      const attempt = latestAttempt(run, retryTaskId);
      if (
        !task ||
        !attempt?.launch?.settled ||
        (attempt.state !== "failed" && attempt.state !== "blocked")
      ) {
        throw new RunError(
          "Retry requires a settled failed or blocked task agent.",
        );
      }
      const status = await workers().inspect(attempt.agentId);
      if (status.active) {
        throw new RunError("The task agent is still active.");
      }
      if (attempt.state === "blocked" && attempt.launch.state === "started") {
        await change(runId, (current) => {
          const a = latestAttempt(current, retryTaskId);
          if (a?.launch) {
            a.state = "running";
            a.message = null;
            a.launch.settled = false;
            a.launch.generation = (a.launch.generation ?? 0) + 1;
          }
        });
        await workers().wake(
          attempt.agentId,
          `Resume task ${task.id} in run ${runId}, attempt ${attempt.id}. Resolve the blocker using the source conversation.
${reportInstructions(command, attempt.agentId, runId, attempt.id, task.checks)}`,
          `resume:${attempt.id}:${run.version}`,
        );
      } else if (attempt.state === "failed") {
        await reserve(runId, task, true, profile);
      }
    }
    for (const task of tasks) {
      await reserve(runId, task);
      await launchAttempt(runId, task);
    }
    run = (await store.read(runId)).run;
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
          if (
            !attempt.launch ||
            attempt.launch.settled ||
            attempt.launch.state !== "started"
          ) {
            continue;
          }
          const status = await workers().inspect(attempt.agentId);
          if (status.active) {
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
              a.message =
                "Task agent stopped without a report. Open its conversation and resume the existing assignment.";
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
          // Stable message identity makes uncertain notification retries harmless.
          await workers().wake(
            run.source.agentId,
            `Conductor run ${run.id}: ${allDone ? "All task agents reported completion and stopped. Inspect get, review evidence, then finish the run with a summary." : "Task agents need attention. Inspect get, open their conversations, resolve blockers or dispatch with retryTaskId after settlement."}`,
            `${run.id}:${notification}`,
          );
          await change(run.id, (current) => {
            if (current.execution?.orchestration) {
              current.execution.orchestration.notification = notification;
            }
          });
        }
      } catch (error) {
        // One busy/unreachable coordinator must not starve independent runs.
        // Ownership stays fenced while observation/notification is retried.
        if (
          error instanceof RunError &&
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
  return { start, startWorkspace, define, dispatch, reconcile };
}
