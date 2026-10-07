import type { AgentsHost } from "../agents/host";
import type { PaseoApi } from "./types";

export function paseoAgentsHost(paseo: PaseoApi): AgentsHost {
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
