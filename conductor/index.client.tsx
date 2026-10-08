import type {
  PluginClientContext,
  PluginSurfaceProps,
  PluginWorkspacePanelProps,
} from "@getpaseo/plugin/client";
import {
  PodiumSurface,
  PodiumSidebar,
  Sessions,
} from "./client/podium/surfaces";
import { registerSkillCommands } from "./client/skills";
import { registerPodiumNavigation } from "./client/podium/registration";

export default function contribute(client: PluginClientContext) {
  const sessions = new Sessions();
  const removers = [
    ...registerSkillCommands(client),
    ...registerPodiumNavigation(
      client,
      (props: PluginSurfaceProps) => (
        <PodiumSurface {...props} sessions={sessions} />
      ),
      PodiumSidebar,
    ),
    client.addWorkspacePanel({
      id: "podium",
      title: "Conductor",
      icon: "Workflow",
      context: "workspace",
      locations: ["explorer", "workspace"],
      Component: (props: PluginWorkspacePanelProps) => (
        <PodiumSurface {...props} sessions={sessions} />
      ),
    }),
    client.addCommandCenterItem({
      id: "open-concert-podium",
      title: "Open podium: this concert",
      icon: "Workflow",
      context: "workspace",
      onSelect: (context) => context.openPanel("podium"),
    }),
  ];
  return async () => {
    for (const remove of removers.reverse()) {
      await remove();
    }
    sessions.clear();
  };
}
