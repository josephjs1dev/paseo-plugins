import { createHash } from "node:crypto";
import type { SymphonySource } from "../../shared/symphonies/models";
import type { SymphonyHost } from "./host";
import { symphonyPlacement, type SymphonyPlacementRuntime } from "./placement";
import { SymphonyError } from "./errors";

export interface ExecutionRuntime extends SymphonyPlacementRuntime {
  source(agentId: string): Promise<SymphonySource>;
}
export function executionRuntime(host: SymphonyHost): ExecutionRuntime {
  return {
    ...symphonyPlacement(host),
    async source(agentId) {
      const agent = await host.agent(agentId);
      if (!agent?.concertId || agent.archived || agent.status === "closed") {
        throw new SymphonyError(
          "The source agent is unavailable. Use an active agent in the intended concert.",
        );
      }
      return { agentId, concertId: agent.concertId };
    },
  };
}
/** Stable RFC-9562 version-8 identity; this is an idempotency key, not a secret. */
export function commandSymphonyId(agentId: string, key: string): string {
  const bytes = createHash("sha256")
    .update(JSON.stringify(["conductor-symphony", agentId, key]))
    .digest()
    .subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x80;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
