import type {
  PluginHandlerContext,
  PluginLifecycleEvents,
} from "@getpaseo/plugin/server";

// Derive host types through the plugin SDK so a clean install needs no local SDK peers.
export type PaseoApi = PluginHandlerContext["paseo"];
export type PaseoAgent = NonNullable<
  Awaited<ReturnType<ReturnType<PaseoApi["agents"]["ref"]>["refresh"]>>
>["agent"];
export type PaseoWorkspace = Awaited<
  ReturnType<PaseoApi["workspaces"]["list"]>
>["entries"][number];
export type AgentPermissionRequest =
  PluginLifecycleEvents["agent.permission_requested"]["request"];
export type AgentPermissionResponse =
  PluginLifecycleEvents["agent.permission_resolved"]["resolution"];

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
