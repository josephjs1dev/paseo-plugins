import type { PaseoAgent, PaseoApi, PaseoWorkspace } from "@getpaseo/client";
import type { AgentPermissionResponse } from "@getpaseo/protocol/agent-types";

export interface Directory<T> {
  entries: T[];
  next: string | null;
}
export interface Runtime {
  agents(cursor?: string): Promise<Directory<PaseoAgent>>;
  workspaces(cursor?: string): Promise<Directory<PaseoWorkspace>>;
  inspect(agentId: string): Promise<PaseoAgent | null>;
  archive(agentId: string): Promise<void>;
  answer(
    agentId: string,
    requestId: string,
    response: AgentPermissionResponse,
  ): Promise<void>;
}
export function paseoRuntime(paseo: PaseoApi): Runtime {
  return {
    async agents(cursor) {
      const page = await paseo.agents.list({
        page: { limit: 200, ...(cursor ? { cursor } : {}) },
      });
      return {
        entries: page.entries.map((entry) => entry.agent),
        next: page.pageInfo.hasMore ? (page.pageInfo.nextCursor ?? null) : null,
      };
    },
    async workspaces(cursor) {
      const page = await paseo.workspaces.list({
        page: { limit: 200, ...(cursor ? { cursor } : {}) },
      });
      return {
        entries: page.entries,
        next: page.pageInfo.hasMore ? (page.pageInfo.nextCursor ?? null) : null,
      };
    },
    async inspect(agentId) {
      return (await paseo.agents.ref(agentId).refresh())?.agent ?? null;
    },
    async archive(agentId) {
      await paseo.agents.ref(agentId).archive();
    },
    async answer(agentId, requestId, response) {
      await paseo.agents
        .ref(agentId)
        .respondToPermission({ requestId, response });
    },
  };
}
