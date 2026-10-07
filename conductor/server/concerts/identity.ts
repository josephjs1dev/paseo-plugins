import { createHash } from "node:crypto";
import type { ConcertSource } from "../../shared/concerts/models";
import type { ConcertHost } from "./host";
import { concertPlacement, type ConcertPlacementRuntime } from "./placement";
import { ConcertError } from "./errors";

export interface ExecutionRuntime extends ConcertPlacementRuntime {
  source(agentId: string): Promise<ConcertSource>;
}
export function executionRuntime(host: ConcertHost): ExecutionRuntime {
  return {
    ...concertPlacement(host),
    async source(agentId) {
      const agent = await host.agent(agentId);
      if (
        !agent?.workspaceId ||
        agent.archivedAt ||
        agent.status === "closed"
      ) {
        throw new ConcertError(
          "The source agent is unavailable. Use an active agent in the intended workspace.",
        );
      }
      return { agentId, workspaceId: agent.workspaceId };
    },
  };
}
/** Stable RFC-9562 version-8 identity; this is an idempotency key, not a secret. */
export function commandConcertId(agentId: string, key: string): string {
  const bytes = createHash("sha256")
    .update(JSON.stringify(["conductor-run", agentId, key]))
    .digest()
    .subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x80;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
