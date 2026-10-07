import { jsonCommand, type CommandLine } from "./prompts";
import {
  workerChoice,
  type RunAgentCommand,
} from "../../shared/concerts/commands";
import { graphIssues } from "../../shared/concerts/graph";
import type {
  RunSource,
  StoredRun,
  TaskDefinition,
} from "../../shared/concerts/models";
import { commandRunId, type ExecutionRuntime } from "./identity";
import { contentHash, type RunStore } from "./store";
import { RunError } from "./errors";
import type { WorkerRuntime } from "./workers";

type Start = Extract<RunAgentCommand, { kind: "orchestrate" }>;
type Define = Extract<RunAgentCommand, { kind: "define" }>;
export function runCoordinator(
  store: RunStore,
  runtime: () => ExecutionRuntime,
  workers: () => WorkerRuntime,
  change: (id: string, update: (run: StoredRun) => void) => Promise<StoredRun>,
  commandLine: CommandLine,
) {
  const owner = async (agentId: string, runId: string) => {
    const source = await runtime().source(agentId);
    const { run } = await store.read(runId);
    if (
      run.source.agentId !== agentId ||
      source.workspaceId !== run.source.workspaceId ||
      !run.execution?.orchestration
    ) {
      throw new RunError(
        "Only this concert's Conductor agent can define or dispatch its tasks.",
      );
    }
    return run;
  };
  const launchCoordinator = async (run: StoredRun) => {
    const meta = run.execution?.orchestration;
    if (!meta || !run.source.agentId || meta.coordinatorLaunch === "started") {
      return run;
    }
    try {
      const input = {
        agentId: run.source.agentId,
        parentAgentId: meta.requestedBy,
        workspaceId: run.source.workspaceId,
        title: `Conductor: ${run.title}`.slice(0, 160),
        prompt: meta.prompt,
        ...(meta.coordinatorProfile
          ? { profile: meta.coordinatorProfile }
          : {}),
      };
      const config = meta.coordinatorConfig ?? (await workers().prepare(input));
      if (!meta.coordinatorConfig) {
        await change(run.id, (current) => {
          if (current.execution?.orchestration) {
            current.execution.orchestration.coordinatorConfig = config;
          }
        });
      }
      await workers().launch({ ...input, config });
      return change(run.id, (current) => {
        if (current.execution?.orchestration) {
          current.execution.orchestration.coordinatorLaunch = "started";
          current.execution.interruption = null;
        }
      });
    } catch (error) {
      return change(run.id, (current) => {
        if (current.execution?.orchestration) {
          current.execution.orchestration.coordinatorLaunch = "uncertain";
          current.execution.interruption =
            error instanceof RunError
              ? error.message
              : "Conductor agent creation could not be confirmed. Retry the same orchestration command; its agent identity is preserved.";
        }
      });
    }
  };
  const startFrom = async (requestSource: RunSource, command: Start) => {
    const agentId = requestSource.agentId;
    // A requesting agent coordinates its own run unless it asks for a dedicated
    // Conductor agent; a profile can only apply to a newly created agent.
    const self =
      command.coordinator === "self" ||
      (command.coordinator === undefined &&
        agentId !== null &&
        !command.coordinatorProfile);
    if (self && !agentId) {
      throw new RunError("Self-coordination requires a requesting agent.");
    }
    if (self && command.coordinatorProfile) {
      throw new RunError(
        'coordinatorProfile requires coordinator "agent"; the requesting agent keeps its own settings.',
      );
    }
    const source = await runtime().capture(requestSource);
    const identity = agentId ?? `workspace:${requestSource.workspaceId}`;
    const id = commandRunId(identity, `orchestrate:${command.key}`);
    const conductorId =
      self && agentId ? agentId : commandRunId(id, "conductor");
    const profiles = await workers().profiles();
    const context = {
      plan: command.goal,
      provenance: "Conductor orchestration request",
      decisions: [],
      constraints: [],
      expectedOutcome: command.goal.slice(0, 4000),
    };
    const now = Date.now();
    const intro = self
      ? `You are now the Conductor agent for concert ${id}, coordinating it from this conversation. The user authorized this work:\n${command.goal}\n\nUse your existing conversation context to break this request into small bounded tasks with dependencies. Delegate implementation to separate agents; do not do all the work yourself. While task agents are working, do not edit this checkout yourself; route changes through tasks so writers stay serialized.`
      : `You are the Conductor agent for concert ${id}. The user authorized this work:\n${command.goal}\n\nInspect the workspace and break this request into small bounded tasks with dependencies. Delegate implementation to separate agents; do not do all the work yourself.`;
    const prompt = `${intro} No manual plan approval form. Use the existing concert, not start or orchestrate again.\nChoose a worker per task. Use a configured profile by name (choose based on their notes): ${JSON.stringify(profiles)}. Or set provider, model and optional thinkingOptionId directly; run ${commandLine(conductorId, "models")} to list choices. Never set both. Omit all to inherit your settings. Workers never get a broader permission mode than yours.\nRun ${commandLine(conductorId, "help")}. JSON command data must be sent on stdin, not a positional argument. Shell tool environments may lack CONDUCTOR variables; use these explicit paths and flags. Define the graph with this structure, replacing sample assignments and optionally adding a worker choice per task:\n${jsonCommand(commandLine(conductorId, "define"), { concertId: id, tasks: [{ id: "task-id", title: "Concrete assignment", description: "Assignment and acceptance criteria", dependsOn: [], reads: ["."], writes: [], checks: [] }] })}\n Use real literal checkout-relative scopes; writes [] is only for read-only work. Include at least two useful assignments for multi-part work and a final integration task where needed.\nThen dispatch using:\n${jsonCommand(commandLine(conductorId, "dispatch"), { concertId: id })}\n This spawns real child agents and follows dependencies automatically. Readers can run concurrently; writers in the same checkout are serialized. Let workers run and end your turn while waiting; you will receive their reports. Use ${commandLine(conductorId, "get")} with concertId JSON on stdin to inspect. Every successful command must return a JSON acknowledgement; empty output is not success. If a worker is blocked, help resolve it or ask the user; dispatch with retryTaskId resumes a settled blocked worker or retries a settled failed attempt. Never replace a still-active worker.\nAfter every task has explicitly reported completion and stopped, inspect the reports, then call ${commandLine(conductorId, "finish")} with concertId and an honest summary on stdin. Do not infer success from idle. Do not use the source-only claim workflow. Do not commit or push unless the user authorized it.`;
    const run = await store.create(
      {
        schemaVersion: 1,
        id,
        version: 0,
        title: command.title,
        source: { ...source, agentId: conductorId },
        contextHash: contentHash(JSON.stringify(context)),
        requestHash: contentHash(
          JSON.stringify(
            agentId
              ? { agentId, command }
              : { workspaceId: requestSource.workspaceId, command },
          ),
        ),
        createdAt: now,
        updatedAt: now,
        status: "planning",
        draft: null,
        revisions: [],
        execution: {
          origin: "orchestrator",
          attempts: [],
          summary: null,
          finishedAt: null,
          interruption: null,
          orchestration: {
            phase: "planning",
            concurrency: command.concurrency,
            requestedBy: agentId,
            coordinator: self ? "self" : "agent",
            // The requesting agent is already running; nothing is created.
            coordinatorLaunch: self ? "started" : "pending",
            prompt,
            notification: null,
            ...(command.coordinatorProfile
              ? { coordinatorProfile: command.coordinatorProfile }
              : {}),
          },
        },
      },
      context,
    );
    const meta = run.execution?.orchestration;
    if (meta?.coordinator === "self") {
      // A replayed key returns the stored instructions, never a second run.
      return { run, instructions: meta.prompt };
    }
    return { run: await launchCoordinator(run) };
  };
  const define = async (agentId: string, command: Define) => {
    const run = await owner(agentId, command.concertId);
    const graph = {
      tasks: command.tasks.map(
        (task): TaskDefinition => ({
          id: task.id,
          title: task.title,
          outcome: task.description,
          prerequisites: task.dependsOn,
          inputs: ["Run goal and prerequisite reports"],
          reads: task.reads,
          writes: task.writes,
          resources: task.resources,
          worker: {
            role: task.writes.length ? "implementation" : "exploration",
            ...workerChoice({
              provider: task.provider,
              model: task.model,
              thinkingOptionId: task.thinkingOptionId,
            }),
            profile: task.profile ?? "inherit",
          },
          criteria: ["Return evidence and required check results"],
          checks: task.checks,
          stopWhen:
            "Report this assignment, stop using tools, and end your turn. Do not expand scope.",
        }),
      ),
    };
    const issues = graphIssues(graph);
    if (issues.length) {
      throw new RunError(issues.slice(0, 5).join(" "));
    }
    if (run.execution?.orchestration?.phase !== "planning") {
      if (JSON.stringify(run.revisions[0]?.graph) === JSON.stringify(graph)) {
        return { run };
      }
      throw new RunError("This concert already has a different task graph.");
    }
    await runtime().validate(run.source, graph);
    return {
      run: await change(run.id, (current) => {
        if (!current.execution?.orchestration) {
          return;
        }
        current.revisions.push({
          number: 1,
          parent: null,
          reason: "Conductor agent decomposed the request",
          acceptedAt: Date.now(),
          authority: "agent",
          graph,
        });
        current.execution.orchestration.phase = "working";
        current.execution.interruption = null;
      }),
    };
  };
  return {
    owner,
    define,
    start: async (agentId: string, command: Start) =>
      startFrom(await runtime().source(agentId), command),
  };
}
