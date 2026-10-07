import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { PaseoApi } from "./runtime";
import type { RunCommandAccess } from "./run-command-server";
import { bindAgentCommand, newAgentCommand } from "./run-launcher";
import { launcherCommand } from "./run-prompts";

const guidance = (command: string) => `[Conductor agent commands]
When the user asks to orchestrate work, use ${launcherCommand(command, "orchestrate")} with a stable key, title and goal as JSON on stdin. You become the run's Conductor agent: the acknowledgement includes instructions to split the work and dispatch separate task agents from this conversation. Add "coordinator":"agent" (optionally with coordinatorProfile) only when the user wants a dedicated Conductor agent instead. Do not substitute a source-only tracking run for orchestration. Do not ask the user to fill plan/task forms. Small edits need no run unless requested.
Run ${launcherCommand(command, "help")} for JSON commands. This explicit helper already supplies your agent identity and daemon socket; it works without CONDUCTOR environment variables in shell tools. Inspect the returned JSON acknowledgement; empty output is not success. An assigned task agent must report/block its existing run and attempt; never start another run or orchestrator for that assignment. Only its Conductor agent defines/dispatches/finishes the run. Report actual evidence and required checks, then stop tool work and end the turn. Never infer completion from idle. Existing start/claim commands track the current agent only and do not delegate. Preserve the user's permissions and authorized scope.`;

export function commandHooks(
  server: Pick<PluginServerContext, "before" | "on">,
  access: RunCommandAccess,
  remember: (paseo: PaseoApi) => void,
  interrupt: (agentId: string, message: string) => Promise<void>,
  ready: Promise<void> = Promise.resolve(),
) {
  if (typeof server.before !== "function") {
    return () => {};
  }
  const removers = [
    server.before("agent.create", async ({ request }, { paseo }) => {
      remember(paseo);
      await ready;
      if (
        !access.available ||
        !access.commandPath ||
        !access.socketPath ||
        request.config.internal ||
        request.config.systemPrompt?.includes("[Conductor agent commands]")
      ) {
        return;
      }
      const command = newAgentCommand(access.commandPath);
      return {
        ...request,
        env: {
          ...request.env,
          CONDUCTOR_COMMAND: command,
          CONDUCTOR_SOCKET: access.socketPath,
        },
        config: {
          ...request.config,
          systemPrompt: [request.config.systemPrompt, guidance(command)]
            .filter(Boolean)
            .join("\n\n"),
        },
      };
    }),
    server.before("agent.session_open", async ({ request }, { paseo }) => {
      remember(paseo);
      await ready;
      if (
        !access.available ||
        !access.commandPath ||
        !access.socketPath ||
        request.purpose !== "interactive"
      ) {
        return;
      }
      const command = await bindAgentCommand(
        {
          ...access,
          commandPath: access.commandPath,
          socketPath: access.socketPath,
        },
        request.env.CONDUCTOR_COMMAND,
        request.agentId,
      );
      return {
        ...request,
        env: {
          ...request.env,
          CONDUCTOR_COMMAND: command,
          CONDUCTOR_SOCKET: access.socketPath,
          CONDUCTOR_AGENT_ID: request.agentId,
        },
      };
    }),
    server.on("agent.turn_started", (_event, { paseo }) => {
      remember(paseo);
    }),
    server.on("agent.turn_ended", async (event, { paseo }) => {
      remember(paseo);
      await ready;
      if (!access.available) {
        return;
      }
      await interrupt(
        event.agent.id,
        `Source agent turn ${event.outcome.kind} before its task report. Resume in the source conversation; claims remain held.`,
      );
    }),
    server.on("agent.archived", async (event, { paseo }) => {
      remember(paseo);
      await ready;
      if (!access.available) {
        return;
      }
      await interrupt(
        event.agent.id,
        "The source agent was archived with unreported work. Its claims remain unresolved.",
      );
    }),
  ];
  return () => {
    for (const remove of removers.reverse()) {
      remove();
    }
  };
}
