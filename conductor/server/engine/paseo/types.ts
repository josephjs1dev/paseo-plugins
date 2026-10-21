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
export type PaseoProfile = NonNullable<
  Awaited<ReturnType<PaseoApi["config"]["get"]>>["config"]["agentProfiles"]
>[number];
export type AgentPermissionRequest =
  PluginLifecycleEvents["agent.permission_requested"]["request"];
export type AgentPermissionResponse =
  PluginLifecycleEvents["agent.permission_resolved"]["resolution"];
