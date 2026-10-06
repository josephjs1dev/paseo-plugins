import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { HistoryScope } from "../shared/history";
import { summarizeHistory } from "../shared/history-analysis";
import type { Provider } from "../shared/usage";
import { usageCollectors } from "./collectors";
import type { UsageCollector } from "./collectors/types";
import { withCodexCostEstimate } from "../shared/codex-cost-estimate";
import { createHistoryCache } from "./history-cache";

const SCAN_WARNING =
  "Could not refresh all local usage records. Showing available sources and previously stored data, if available.";

export function historyDirectory(): string {
  const paseoHome = process.env.PASEO_HOME ?? join(homedir(), ".paseo");

  return join(paseoHome, "storage", "provider-usage");
}

export function createHistoryStore(
  directory = historyDirectory(),
  collectors: readonly UsageCollector[] = Object.values(usageCollectors),
  now: () => number = Date.now,
) {
  const cache = createHistoryCache(directory, collectors, now);

  return {
    async read(
      provider: Provider,
      cwd: string,
      days: 7 | 30 | 90,
      sessionOffset = 0,
      scope: HistoryScope = "workspace",
      forceRefresh = false,
    ) {
      const loaded = await cache.load(forceRefresh);
      const start = new Date(now());
      const periodEnd = start.toISOString().slice(0, 10);
      const workspaceDirectory = resolve(cwd);
      start.setUTCDate(start.getUTCDate() - days + 1);
      const summary = summarizeHistory(
        loaded.history.rows.map(withCodexCostEstimate),
        {
          provider,
          firstDay: start.toISOString().slice(0, 10),
          lastDay: periodEnd,
          sessionOffset,
          scope,
          matchesWorkspace: (directory) =>
            resolve(directory) === workspaceDirectory,
        },
      );

      return {
        scannedAt: loaded.history.scannedAt,
        periodEnd,
        refreshing: loaded.refreshing,
        warning: loaded.warningProviders.has(provider) ? SCAN_WARNING : "",
        ...summary,
      };
    },
    refresh: cache.refresh,
    close: cache.close,
  };
}
