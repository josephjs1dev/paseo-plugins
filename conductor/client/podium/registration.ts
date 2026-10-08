import type { ComponentType, FunctionComponent } from "react";
import type {
  PluginClientContext,
  PluginGlobalCommandContext,
  PluginScreenParams,
  PluginSidebarItemProps,
  PluginSurfaceProps,
} from "@getpaseo/plugin/client";

type PodiumNavigation = Pick<PluginGlobalCommandContext, "openSurface"> &
  Partial<Pick<PluginGlobalCommandContext, "openScreen">>;

type PodiumRegistration = Pick<
  PluginClientContext,
  "addSurface" | "addSidebarItem" | "addCommandCenterItem"
> &
  Partial<Pick<PluginClientContext, "addScreen" | "addSidebarHeaderItem">>;

/** 0.10 clients expose surfaces; 0.11 clients additionally expose screens. */
export function openPodium(
  context: PodiumNavigation,
  params?: PluginScreenParams,
): void {
  if (typeof context.openScreen === "function") {
    context.openScreen({ screenId: "podium", ...(params ? { params } : {}) });
  } else {
    context.openSurface("podium");
  }
}

export function registerPodiumNavigation(
  client: PodiumRegistration,
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
        id: "podium",
        title: "Conductor · Podium",
        Component: Surface,
      }),
      client.addSidebarHeaderItem({
        id: "podium",
        title: "Conductor",
        Component: Sidebar,
      }),
    );
  } else {
    removers.push(
      client.addSurface("podium", Surface),
      client.addSidebarItem({
        id: "podium",
        title: "Conductor",
        icon: "Workflow",
        surface: "podium",
      }),
    );
  }
  removers.push(
    client.addCommandCenterItem({
      id: "open-podium",
      title: "Open podium: all concerts",
      icon: "Workflow",
      keywords: ["waiting", "questions", "permissions", "agents"],
      context: "global",
      onSelect: openPodium,
    }),
  );
  return removers;
}
