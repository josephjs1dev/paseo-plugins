import { createHash } from "node:crypto";
import type { PaseoAgent } from "@getpaseo/client";
import type { AgentPermissionRequest } from "@getpaseo/protocol/agent-types";

export function digest(value: unknown): string {
  return createHash("sha256")
    .update(
      JSON.stringify(value, (_key, entry: unknown) => {
        if (
          entry !== null &&
          typeof entry === "object" &&
          !Array.isArray(entry)
        ) {
          return Object.fromEntries(
            Object.entries(entry).sort(([a], [b]) => a.localeCompare(b)),
          );
        }
        return entry;
      }),
    )
    .digest("hex");
}
export function requestKey(
  agent: PaseoAgent,
  request: AgentPermissionRequest,
): string {
  return digest([
    agent.id,
    agent.provider,
    agent.createdAt,
    agent.runtimeInfo?.sessionId ?? agent.persistence,
    request,
  ]);
}
export function agentKey(agentId: string): string {
  return digest(["agent", agentId]);
}
