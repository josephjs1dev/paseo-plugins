import type { PaseoAgent } from "@getpaseo/client";
import type { ArchiveResult } from "../shared/models";
import type { Runtime } from "./runtime";
import { digest } from "./identity";
import { pages } from "./directory";

export function archiveKey(agent: PaseoAgent): string | null {
  if (
    agent.archivedAt ||
    agent.activeTurn ||
    agent.pendingPermissions.length ||
    agent.attentionReason === "permission" ||
    !["idle", "closed"].includes(agent.status)
  ) {
    return null;
  }
  return digest([
    agent.id,
    agent.provider,
    agent.createdAt,
    agent.runtimeInfo?.sessionId ?? agent.persistence?.sessionId,
    agent.status,
    agent.updatedAt,
    agent.labels,
  ]);
}

/** Conductor adds an inactivity and child-cascade guard around Paseo's archive operation. */
export async function archiveInactive(
  runtime: Runtime,
  input: { agentId: string; key: string },
): Promise<ArchiveResult> {
  try {
    const directory = await pages((cursor) => runtime.agents(cursor));
    if (directory.incomplete) {
      return { status: "incomplete" };
    }
    if (
      directory.entries.some(
        (agent) =>
          !agent.archivedAt &&
          agent.labels["paseo.parent-agent-id"]?.trim() === input.agentId,
      )
    ) {
      return { status: "has_children" };
    }
    const agent = await runtime.inspect(input.agentId);
    if (agent?.archivedAt) {
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
