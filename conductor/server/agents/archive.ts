import type { AgentSnapshot } from "../../shared/agents/agent";
import type { ArchiveResult } from "../../shared/agents/models";
import type { AgentsHost } from "./host";
import { digest } from "./identity";
import { pages } from "./directory";

export function archiveKey(agent: AgentSnapshot): string | null {
  if (
    agent.archived ||
    agent.activeTurn ||
    agent.pendingPermissions.length ||
    agent.awaitingPermission ||
    !["idle", "closed"].includes(agent.status)
  ) {
    return null;
  }
  return digest([
    agent.id,
    agent.provider,
    agent.createdAt,
    agent.sessionId,
    agent.status,
    agent.updatedAt,
    agent.parentAgentId,
  ]);
}

/** Conductor adds an inactivity and child-cascade guard around Paseo's archive operation. */
export async function archiveInactive(
  runtime: AgentsHost,
  input: { agentId: string; key: string },
): Promise<ArchiveResult> {
  try {
    const directory = await pages((cursor) => runtime.agents(cursor));
    if (directory.incomplete) {
      return { status: "incomplete" };
    }
    if (
      directory.entries.some(
        (agent) => !agent.archived && agent.parentAgentId === input.agentId,
      )
    ) {
      return { status: "has_children" };
    }
    const agent = await runtime.inspect(input.agentId);
    if (agent?.archived) {
      return { status: "archived" };
    }
    if (!agent || archiveKey(agent) !== input.key) {
      return { status: "stale" };
    }
    await runtime.archive(input.agentId);
    return { status: "archived" };
  } catch {
    // An acknowledgment can be lost after the host accepts an archive. Do not retry automatically.
    return { status: "unknown" };
  }
}
