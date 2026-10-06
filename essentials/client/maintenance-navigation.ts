import type { PluginClientContext } from "@getpaseo/plugin/client";
import { readMaintenanceHost } from "../shared/maintenance-host";

type NavigationClient = Pick<
  PluginClientContext,
  "rpc" | "addSidebarItem" | "addCommandCenterItem"
>;

export function registerMaintenanceNavigation(client: NavigationClient) {
  let stopped = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let removeSidebar: (() => void) | undefined;

  function addCommand(title: string) {
    return client.addCommandCenterItem({
      id: "open-cli-maintenance",
      title,
      icon: "RefreshCw",
      context: "global",
      keywords: [
        "host",
        "updates",
        "maintenance",
        "codex",
        "opencode",
        "pi",
        "claude",
        "models",
        "cli",
      ],
      onSelect({ openSurface }) {
        openSurface("cli-maintenance");
      },
    });
  }

  // Keep maintenance reachable if host metadata is temporarily unavailable.
  let removeCommand = addCommand("Harnesses");

  async function identifyHost() {
    try {
      const host = await client.rpc(readMaintenanceHost, {});

      if (stopped) {
        return;
      }

      // Paseo groups sidebar entries by contribution ID across hosts. Encode
      // the full daemon ID so distinct hosts never share a hostname label.
      const hostKey = host.id
        .split("")
        .map((char) => char.charCodeAt(0).toString(16).padStart(4, "0"))
        .join("");
      const title = `Harnesses (${host.name})`;
      removeSidebar?.();
      removeSidebar = client.addSidebarItem({
        id: `cli-maintenance-${hostKey}`,
        title,
        icon: "RefreshCw",
        surface: "cli-maintenance",
      });
      removeCommand();
      removeCommand = addCommand(title);
    } catch {
      if (!stopped) {
        retry = setTimeout(() => void identifyHost(), 30_000);
      }
    }
  }

  void identifyHost();

  return () => {
    stopped = true;
    clearTimeout(retry);
    removeSidebar?.();
    removeCommand();
  };
}
