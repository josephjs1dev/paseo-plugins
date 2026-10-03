import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { HistoryScope } from "../shared/history";
import type { HistoryRow } from "../shared/history";
import { summarizeHistory } from "../shared/history-analysis";
import type { Provider } from "../shared/usage";
import { providerAdapters } from "./providers";
import { collectPi } from "./pi-history";
import { withCodexCreditEstimate } from "../shared/codex-credit-estimate";
import { createHistoryCache, type CollectHistory } from "./history-cache";

const SCAN_WARNING =
  "Could not refresh all local usage records. Showing available sources and previously stored data, if available.";

export function historyDirectory(): string {
  const paseoHome = process.env.PASEO_HOME ?? join(homedir(), ".paseo");

  return join(paseoHome, "storage", "provider-usage");
}

export function createHistoryStore(
  directory = historyDirectory(),
  collect: CollectHistory = createLocalHistoryCollector(),
  now: () => number = Date.now,
) {
  const cache = createHistoryCache(directory, collect, now);

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
        loaded.history.rows.map(withCodexCreditEstimate),
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

/** Scan Pi once per store refresh; failure of one harness cannot hide another. */
export function createLocalHistoryCollector(
  native = (
    provider: Provider,
    since: number,
    signal: AbortSignal,
    modifiedSince?: number,
  ) => providerAdapters[provider].readHistory(since, signal, modifiedSince),
  pi = (since: number, signal: AbortSignal, modifiedSince?: number) =>
    collectPi(since, signal, undefined, modifiedSince),
): CollectHistory {
  let piScan:
    | {
        since: number;
        modifiedSince: number | undefined;
        signal: AbortSignal;
        result: Promise<PromiseSettledResult<HistoryRow[]>>;
      }
    | undefined;

  return async (provider, since, signal, modifiedSince) => {
    if (
      !piScan ||
      piScan.since !== since ||
      piScan.modifiedSince !== modifiedSince ||
      piScan.signal !== signal
    ) {
      piScan = {
        since,
        modifiedSince,
        signal,
        result: Promise.resolve()
          .then(() => pi(since, signal, modifiedSince))
          .then(
            (value) => ({ status: "fulfilled" as const, value }),
            (reason: unknown) => ({ status: "rejected" as const, reason }),
          ),
      };
    }

    const piResultPromise = piScan.result;
    const [nativeResult] = await Promise.allSettled([
      Promise.resolve().then(() =>
        native(provider, since, signal, modifiedSince),
      ),
    ]);
    const piResult = await piResultPromise;
    const nativeCollection =
      nativeResult?.status === "fulfilled" ? nativeResult.value : undefined;

    return {
      rows: [
        ...(Array.isArray(nativeCollection)
          ? nativeCollection
          : (nativeCollection?.rows ?? [])),
        ...(piResult.status === "fulfilled"
          ? piResult.value.filter((row) => row.provider === provider)
          : []),
      ],
      incomplete:
        nativeResult?.status === "rejected" ||
        piResult.status === "rejected" ||
        (!Array.isArray(nativeCollection) &&
          (nativeCollection?.incomplete ?? false)),
    };
  };
}
