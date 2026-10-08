import { jsonCommand, type CommandLine } from "./prompts";
import {
  workerChoice,
  type SymphonyCommand,
} from "../../shared/symphonies/commands";
import { scoreIssues } from "../../shared/symphonies/score";
import type {
  SymphonySource,
  StoredSymphony,
  TaskDefinition,
} from "../../shared/symphonies/models";
import { commandSymphonyId, type ExecutionRuntime } from "./identity";
import { contentHash, type SymphonyStore } from "./store";
import { SymphonyError } from "./errors";
import type { WorkerRuntime } from "./workers";

type Start = Extract<SymphonyCommand, { kind: "orchestrate" }>;
type Define = Extract<SymphonyCommand, { kind: "define" }>;
export function symphonyConductor(
  store: SymphonyStore,
  runtime: () => ExecutionRuntime,
  workers: () => WorkerRuntime,
  change: (
    id: string,
    update: (symphony: StoredSymphony) => void,
  ) => Promise<StoredSymphony>,
  commandLine: CommandLine,
) {
  const owner = async (agentId: string, symphonyId: string) => {
    const source = await runtime().source(agentId);
    const { symphony } = await store.read(symphonyId);
    if (
      symphony.source.agentId !== agentId ||
      source.concertId !== symphony.source.concertId ||
      !symphony.execution.conducting
    ) {
      throw new SymphonyError(
        "Only this symphony's Conductor agent can define or dispatch its tasks.",
      );
    }
    return symphony;
  };
  const launchConductor = async (symphony: StoredSymphony) => {
    const meta = symphony.execution.conducting;
    if (
      !meta ||
      !symphony.source.agentId ||
      meta.conductorLaunch === "started"
    ) {
      return symphony;
    }
    try {
      const input = {
        agentId: symphony.source.agentId,
        parentAgentId: meta.requestedBy,
        concertId: symphony.source.concertId,
        title: `Conductor: ${symphony.title}`.slice(0, 160),
        prompt: meta.prompt,
        ...(meta.conductorProfile ? { profile: meta.conductorProfile } : {}),
      };
      const config = meta.conductorConfig ?? (await workers().prepare(input));
      if (!meta.conductorConfig) {
        await change(symphony.id, (current) => {
          if (current.execution.conducting) {
            current.execution.conducting.conductorConfig = config;
          }
        });
      }
      await workers().launch({ ...input, config });
      return change(symphony.id, (current) => {
        if (current.execution.conducting) {
          current.execution.conducting.conductorLaunch = "started";
          current.execution.interruption = null;
        }
      });
    } catch (error) {
      return change(symphony.id, (current) => {
        if (current.execution.conducting) {
          current.execution.conducting.conductorLaunch = "uncertain";
          current.execution.interruption =
            error instanceof SymphonyError
              ? error.message
              : "Conductor agent creation could not be confirmed. Retry the same orchestration command; its agent identity is preserved.";
        }
      });
    }
  };
  const startFrom = async (requestSource: SymphonySource, command: Start) => {
    const agentId = requestSource.agentId;
    // A requesting agent coordinates its own symphony unless it asks for a dedicated
    // Conductor agent; a profile can only apply to a newly created agent.
    const self =
      command.conductor === "self" ||
      (command.conductor === undefined &&
        agentId !== null &&
        !command.conductorProfile);
    if (self && !agentId) {
      throw new SymphonyError("Self-coordination requires a requesting agent.");
    }
    if (self && command.conductorProfile) {
      throw new SymphonyError(
        'conductorProfile requires conductor "agent"; the requesting agent keeps its own settings.',
      );
    }
    const source = await runtime().capture(requestSource);
    const identity = agentId ?? `concert:${requestSource.concertId}`;
    const id = commandSymphonyId(identity, `orchestrate:${command.key}`);
    const conductorId =
      self && agentId ? agentId : commandSymphonyId(id, "conductor");
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
      ? `You are now the Conductor agent for symphony ${id}, coordinating it from this conversation. The user authorized this work:\n${command.goal}\n\nUse your existing conversation context to break this request into small bounded tasks with dependencies. Delegate implementation to separate agents; do not do all the work yourself. While task agents are working, do not edit this checkout yourself; route changes through tasks so writers stay serialized.`
      : `You are the Conductor agent for symphony ${id}. The user authorized this work:\n${command.goal}\n\nInspect the concert and break this request into small bounded tasks with dependencies. Delegate implementation to separate agents; do not do all the work yourself.`;
    const prompt = `${intro} Use the existing symphony, not start or orchestrate again.\nSplit by work and file ownership first, then choose a task agent for each task. Prefer the user's configured profiles: match the task role to each profile's notes, provider, model and thinking option, and set profile to its id: ${JSON.stringify(profiles)}. If no profile fits, set provider, model and optional thinkingOptionId directly; run ${commandLine(conductorId, "models")} to list choices. Never set both. Omit all only when nothing fits; the task agent then inherits your settings. Task agents never get a broader permission mode than yours. Always set writes; an omitted writes covers the whole checkout and runs that task alone.\nRun ${commandLine(conductorId, "help")}. JSON command data must be sent on stdin, not a positional argument. Shell tool environments may lack CONDUCTOR variables; use these explicit paths and flags. Define the score with this structure, replacing sample assignments and optionally adding a worker choice per task:\n${jsonCommand(commandLine(conductorId, "define"), { symphonyId: id, tasks: [{ id: "task-id", title: "Concrete assignment", description: "Assignment and acceptance criteria", dependsOn: [], reads: ["."], writes: [], checks: [] }] })}\n Use real literal checkout-relative scopes; writes [] is only for read-only work. Include at least two useful assignments for multi-part work and a final integration task where needed.\nThen dispatch using:\n${jsonCommand(commandLine(conductorId, "dispatch"), { symphonyId: id })}\n This spawns real child agents and follows dependencies automatically. Readers can run concurrently; writers in the same checkout are serialized. Let task agents run and end your turn while waiting; you will receive their reports. Use ${commandLine(conductorId, "get")} with symphonyId JSON on stdin to inspect. Every successful command must return a JSON acknowledgement; empty output is not success. If a task agent is blocked, help resolve it or ask the user; dispatch with retryTaskId resumes a settled blocked task agent or retries a settled failed attempt. Never replace a still-active task agent.\nAfter every task has explicitly reported completion and stopped, inspect the reports, then call ${commandLine(conductorId, "finish")} with symphonyId and an honest summary on stdin. Do not infer success from idle. Do not use the source-only claim workflow. Do not commit or push unless the user authorized it.`;
    const symphony = await store.create(
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
              : { concertId: requestSource.concertId, command },
          ),
        ),
        createdAt: now,
        updatedAt: now,
        status: "planning",
        revisions: [],
        execution: {
          origin: "conducted",
          attempts: [],
          summary: null,
          finishedAt: null,
          interruption: null,
          conducting: {
            phase: "planning",
            concurrency: command.concurrency,
            requestedBy: agentId,
            conductor: self ? "self" : "agent",
            // The requesting agent is already running; nothing is created.
            conductorLaunch: self ? "started" : "pending",
            prompt,
            notification: null,
            ...(command.conductorProfile
              ? { conductorProfile: command.conductorProfile }
              : {}),
          },
        },
      },
      context,
    );
    const meta = symphony.execution.conducting;
    if (meta?.conductor === "self") {
      // A replayed key returns the stored instructions, never a second symphony.
      return { symphony, instructions: meta.prompt };
    }
    return { symphony: await launchConductor(symphony) };
  };
  const define = async (agentId: string, command: Define) => {
    const symphony = await owner(agentId, command.symphonyId);
    const score = {
      tasks: command.tasks.map(
        (task): TaskDefinition => ({
          id: task.id,
          title: task.title,
          outcome: task.description,
          prerequisites: task.dependsOn,
          inputs: ["Symphony goal and prerequisite reports"],
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
    const issues = scoreIssues(score);
    if (issues.length) {
      throw new SymphonyError(issues.slice(0, 5).join(" "));
    }
    if (symphony.execution.conducting?.phase !== "planning") {
      if (
        JSON.stringify(symphony.revisions[0]?.score) === JSON.stringify(score)
      ) {
        return { symphony };
      }
      throw new SymphonyError("This symphony already has a different score.");
    }
    await runtime().validate(symphony.source, score);
    return {
      symphony: await change(symphony.id, (current) => {
        if (!current.execution.conducting) {
          return;
        }
        current.revisions.push({
          number: 1,
          parent: null,
          reason: "Conductor agent decomposed the request",
          acceptedAt: Date.now(),
          score,
        });
        current.execution.conducting.phase = "working";
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
