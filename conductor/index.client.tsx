import type {
  PluginClientContext,
  PluginSurfaceProps,
  PluginWorkspacePanelProps,
} from "@getpaseo/plugin/client";
import { InboxSurface, InboxSidebar, Sessions } from "./client/surfaces";
import { registerOrchestrate } from "./client/orchestrate";
import { registerInboxNavigation } from "./client/registration";

export default function contribute(client: PluginClientContext) {
  const sessions = new Sessions();
  const removers = [
    registerOrchestrate(client),
    ...registerInboxNavigation(
      client,
      (props: PluginSurfaceProps) => (
        <InboxSurface {...props} sessions={sessions} />
      ),
      InboxSidebar,
    ),
    client.addWorkspacePanel({
      id: "inbox",
      title: "Conductor",
      icon: "Workflow",
      context: "workspace",
      locations: ["explorer", "workspace"],
      Component: (props: PluginWorkspacePanelProps) => (
        <InboxSurface {...props} sessions={sessions} />
      ),
    }),
    client.addCommandCenterItem({
      id: "open-workspace-inbox",
      title: "Open workspace inbox",
      icon: "Workflow",
      context: "workspace",
      onSelect: (context) => context.openPanel("inbox"),
    }),
  ];
  return async () => {
    for (const remove of removers.reverse()) {
      await remove();
    }
    sessions.clear();
  };
}
