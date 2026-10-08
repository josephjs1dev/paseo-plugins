import type { AgentsHost } from "../agents/host";
import { toAgentSnapshot, toConcertEntry } from "./mapping";
import type { PaseoApi } from "./types";

export function paseoAgentsHost(paseo: PaseoApi): AgentsHost {
  return {
    async agents(cursor) {
      const page = await paseo.agents.list({
        page: { limit: 200, ...(cursor ? { cursor } : {}) },
      });
      return {
        entries: page.entries.map((entry) => toAgentSnapshot(entry.agent)),
        next: page.pageInfo.hasMore ? (page.pageInfo.nextCursor ?? null) : null,
      };
    },
    async concerts(cursor) {
      const page = await paseo.workspaces.list({
        page: { limit: 200, ...(cursor ? { cursor } : {}) },
      });
      return {
        entries: page.entries.map(toConcertEntry),
        next: page.pageInfo.hasMore ? (page.pageInfo.nextCursor ?? null) : null,
      };
    },
    async inspect(agentId) {
      const value = (await paseo.agents.ref(agentId).refresh())?.agent ?? null;
      return value ? toAgentSnapshot(value) : null;
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
