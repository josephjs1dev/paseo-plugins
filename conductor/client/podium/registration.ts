import type { ComponentType, FunctionComponent } from "react";
import type {
  PluginClientContext,
  PluginGlobalCommandContext,
  PluginScreenParams,
  PluginSidebarItemProps,
  PluginSurfaceProps,
} from "@getpaseo/plugin/client";

type InboxNavigation = Pick<PluginGlobalCommandContext, "openSurface"> &
  Partial<Pick<PluginGlobalCommandContext, "openScreen">>;

type InboxRegistration = Pick<
  PluginClientContext,
  "addSurface" | "addSidebarItem" | "addCommandCenterItem"
> &
  Partial<Pick<PluginClientContext, "addScreen" | "addSidebarHeaderItem">>;

/** 0.10 clients expose surfaces; 0.11 clients additionally expose screens. */
export function openInbox(
  context: InboxNavigation,
  params?: PluginScreenParams,
): void {
  if (typeof context.openScreen === "function") {
    context.openScreen({ screenId: "inbox", ...(params ? { params } : {}) });
  } else {
    context.openSurface("podium");
  }
}

export function registerInboxNavigation(
  client: InboxRegistration,
  Surface: FunctionComponent<PluginSurfaceProps>,
  Sidebar: ComponentType<PluginSidebarItemProps>,
) {
  const removers = [];
  if (
    typeof client.addScreen === "function" &&
    typeof client.addSidebarHeaderItem === "function"
  ) {
    removers.push(
      client.addScreen({
        id: "inbox",
        title: "Conductor · Podium",
        Component: Surface,
      }),
      client.addSidebarHeaderItem({
        id: "inbox",
        title: "Conductor",
        Component: Sidebar,
      }),
    );
  } else {
    removers.push(
      client.addSurface("podium", Surface),
      client.addSidebarItem({
        id: "inbox",
        title: "Conductor",
        icon: "Workflow",
        surface: "podium",
      }),
    );
  }
  removers.push(
    client.addCommandCenterItem({
      id: "open-inbox",
      title: "Open podium: all workspaces",
      icon: "Workflow",
      keywords: ["waiting", "questions", "permissions", "agents"],
      context: "global",
      onSelect: openInbox,
    }),
  );
  return removers;
}
