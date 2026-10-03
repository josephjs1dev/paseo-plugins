import type {
  PluginButtonContentProps,
  PluginButtonRegistration,
  PluginClientContext,
  PluginWorkspacePanelProps,
} from "@getpaseo/plugin/client";

import {
  providerDefinitions,
  providerIds,
  type Provider,
} from "../shared/providers";
import { readUsage, usageLabel, type Usage } from "../shared/usage";
import { UsagePopover } from "./usage";
import { UsageHistoryPage } from "./history-page";
import { createHistoryNavigation } from "./history-navigation";
import { WorkspaceUsage } from "./workspace-usage";

interface WorkspaceUsageButton {
  registration: PluginButtonRegistration;
  workspaceRegistration: PluginButtonRegistration;
  provider: Provider;
}

export default function contribute(client: PluginClientContext) {
  const historyNavigation = createHistoryNavigation((workspaceId) =>
    client.openPanel("usage-history", { workspaceId, location: "workspace" }),
  );

  function HistoryPage(props: PluginWorkspacePanelProps) {
    return (
      <UsageHistoryPage {...props} historyNavigation={historyNavigation} />
    );
  }

  const removePanel = client.addWorkspacePanel({
    id: "usage-history",
    title: "Usage history",
    icon: "ChartNoAxesCombined",
    context: "workspace",
    locations: ["workspace"],
    Component: HistoryPage,
  });
  const buttons = new Map<string, WorkspaceUsageButton>();
  const latest = new Map<Provider, Usage>();
  const revisions = new Map<Provider, number>();
  let stopped = false;
  let busy = false;

  function updateLabel(workspaceId: string) {
    const entry = buttons.get(workspaceId);

    if (!entry) {
      return;
    }

    const usage = latest.get(entry.provider);
    const { name } = providerDefinitions[entry.provider];

    entry.registration.update({
      label: usage ? usageLabel(usage) : `${name} · …`,
    });
  }

  function add(workspaceId: string) {
    const initialProvider = providerIds[0];

    if (stopped || buttons.has(workspaceId) || !initialProvider) {
      return;
    }

    const fallbackProvider: Provider = initialProvider;

    function selectProvider(provider: Provider) {
      const entry = buttons.get(workspaceId);

      if (entry) {
        entry.provider = provider;
        updateLabel(workspaceId);
      }
    }

    function Content(props: PluginButtonContentProps) {
      const selected = buttons.get(workspaceId)?.provider ?? fallbackProvider;

      return (
        <UsagePopover
          {...props}
          initialProvider={selected}
          onProviderChange={selectProvider}
          onUsageChange={(usage) => {
            revisions.set(
              usage.provider,
              (revisions.get(usage.provider) ?? 0) + 1,
            );
            latest.set(usage.provider, usage);

            for (const [id, entry] of buttons) {
              if (entry.provider === usage.provider) {
                updateLabel(id);
              }
            }
          }}
          onOpenHistory={(provider) =>
            historyNavigation.open(workspaceId, provider, 7, "host")
          }
        />
      );
    }

    const registration = client.addHeaderButton({
      id: "usage",
      workspaceId,
      button: {
        title: "Provider usage",
        label: "Usage",
        icon: "Gauge",
        behavior: { kind: "popover", Content },
      },
    });

    function WorkspaceContent(props: PluginButtonContentProps) {
      return (
        <WorkspaceUsage
          {...props}
          initialProvider={
            buttons.get(workspaceId)?.provider ?? fallbackProvider
          }
          onOpenHistory={(provider, days) =>
            historyNavigation.open(workspaceId, provider, days)
          }
        />
      );
    }

    const workspaceRegistration = client.addHeaderButton({
      id: "workspace-usage",
      workspaceId,
      button: {
        title: "Workspace usage by session and model",
        label: "Workspace usage",
        icon: "ChartNoAxesCombined",
        behavior: {
          kind: "popover",
          Content: WorkspaceContent,
        },
      },
    });

    buttons.set(workspaceId, {
      registration,
      workspaceRegistration,
      provider: initialProvider,
    });
    updateLabel(workspaceId);
  }

  function remove(workspaceId: string) {
    buttons.get(workspaceId)?.registration.remove();
    buttons.get(workspaceId)?.workspaceRegistration.remove();
    buttons.delete(workspaceId);
    historyNavigation.forget(workspaceId);
  }

  const unsubscribe = client.paseo.workspaces.subscribe((update) => {
    if (update.kind === "upsert") {
      add(update.workspace.id);
    } else if (update.kind === "remove") {
      remove(update.id);
    }
  });

  async function refreshProvider(provider: Provider) {
    const revision = revisions.get(provider) ?? 0;
    let usage: Usage;

    try {
      usage = await client.rpc(readUsage, { provider });
    } catch {
      usage = {
        provider,
        status: "unavailable",
        windows: [],
        message: "Host unavailable",
        checkedAt: new Date().toISOString(),
      };
    }

    if (stopped || revision !== (revisions.get(provider) ?? 0)) {
      return;
    }

    latest.set(provider, usage);

    for (const [workspaceId, entry] of buttons) {
      if (entry.provider === provider) {
        updateLabel(workspaceId);
      }
    }
  }

  async function refresh() {
    if (busy || stopped) {
      return;
    }

    busy = true;

    try {
      let cursor: string | undefined;
      const active = new Set<string>();

      do {
        const page = await client.paseo.workspaces.list({
          page: { limit: 100, ...(cursor ? { cursor } : {}) },
        });

        if (stopped) {
          return;
        }

        for (const workspace of page.entries) {
          active.add(workspace.id);
          add(workspace.id);
        }

        cursor = page.pageInfo.nextCursor ?? undefined;
      } while (cursor);

      for (const workspaceId of buttons.keys()) {
        if (!active.has(workspaceId)) {
          remove(workspaceId);
        }
      }

      await Promise.all(providerIds.map(refreshProvider));
    } catch {
      if (!stopped) {
        for (const entry of buttons.values()) {
          entry.registration.update({ label: "Usage · —" });
        }
      }
    } finally {
      busy = false;
    }
  }

  client.addCommandCenterItem({
    id: "show-usage",
    title: "Show provider usage",
    icon: "Gauge",
    context: "workspace",
    onSelect({ workspace }) {
      add(workspace.id);

      return refresh();
    },
  });

  const removeHistoryCommand = client.addCommandCenterItem({
    id: "show-workspace-usage",
    title: "Show workspace usage history",
    icon: "ChartNoAxesCombined",
    context: "workspace",
    onSelect({ workspace }) {
      historyNavigation.open(
        workspace.id,
        buttons.get(workspace.id)?.provider ?? "codex",
      );
    },
  });

  const timer = setInterval(() => {
    void refresh();
  }, 60_000);
  void refresh();

  return () => {
    stopped = true;
    clearInterval(timer);
    unsubscribe();
    removeHistoryCommand();
    removePanel();

    for (const workspaceId of buttons.keys()) {
      remove(workspaceId);
    }
  };
}
