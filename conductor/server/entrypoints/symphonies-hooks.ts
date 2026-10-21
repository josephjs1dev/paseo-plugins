import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { PaseoApi } from "../paseo/types";
import type { SymphonyCommandAccess } from "../symphonies/command-access";
import {
  bindAgent,
  mcpArgs,
  newAgentBinding,
  unbindAgent,
} from "./commands/launcher";

function availableMcpName(servers: Record<string, unknown> = {}): string {
  let name = "conductor";
  for (let suffix = 2; Object.hasOwn(servers, name); suffix++) {
    name = `conductor_${suffix}`;
  }
  return name;
}

const guidance = (serverName: string) => `[Conductor agent commands]
Conductor commands are tools on the injected ${serverName} MCP server. This is the Paseo Conductor server; do not use another server with similarly named tools. Tool names may have a provider prefix, such as mcp__${serverName}__report; search for Conductor tools if they are not listed. Paseo binds your agent identity to the server. Never run Conductor commands or the MCP server through a shell.
When the user asks to orchestrate work, call orchestrate with a stable key, title and goal. You become the symphony's Conductor agent: the result includes instructions to split the work and dispatch separate task agents from this conversation. Add conductor "agent" (optionally with conductorProfile) only when the user wants a dedicated Conductor agent instead. Follow the conductor-orchestrate skill when it is installed. Do not substitute a source-only start symphony for orchestration. Do not ask the user to fill plan/task forms. Small edits need no symphony unless requested.
Inspect each tool result; an error result is not an acknowledgement. An assigned task agent uses report, block, get and widen for its existing symphony and attempt; never start another symphony or Conductor agent for that assignment. Only its Conductor agent defines, dispatches, loops and finishes the symphony. Report actual evidence and required checks, then stop tool work and end the turn. Never infer completion from idle. If the Conductor tools are missing, say so and end the turn. Preserve the user's permissions and authorized scope.`;

export function commandHooks(
  server: Pick<PluginServerContext, "before" | "on">,
  access: SymphonyCommandAccess,
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
      const serverName = availableMcpName(request.config.mcpServers);
      const binding = newAgentBinding(access.commandPath);
      return {
        ...request,
        // Session opening reads this path to write the agent ID into it.
        env: { ...request.env, CONDUCTOR_BINDING: binding },
        config: {
          ...request.config,
          // Provider adapters translate MCP configuration for each harness.
          mcpServers: {
            ...request.config.mcpServers,
            [serverName]: {
              type: "stdio",
              command: process.execPath,
              args: mcpArgs(access.commandPath, binding),
              // Paseo's Electron executable needs Node mode in the MCP child.
              env: { ELECTRON_RUN_AS_NODE: "1" },
              alwaysLoad: true,
            },
          },
          systemPrompt: [request.config.systemPrompt, guidance(serverName)]
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
      await bindAgent(
        { commandPath: access.commandPath, socketPath: access.socketPath },
        request.env.CONDUCTOR_BINDING,
        request.agentId,
      );
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
      try {
        await interrupt(
          event.agent.id,
          "The source agent was archived with unreported work. Its claims remain unresolved.",
        );
      } finally {
        // A reopened session writes the binding again before the MCP server starts.
        if (access.commandPath) {
          await unbindAgent(access.commandPath, event.agent.id);
        }
      }
    }),
  ];
  return () => {
    for (const remove of removers.reverse()) {
      remove();
    }
  };
}
