import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { HistoryRow, HistoryScope } from "../shared/history";
import { mergeHistoryRows, summarizeHistory } from "../shared/history-analysis";
import type { Provider } from "../shared/usage";
import { providerIds } from "../shared/providers";
import {
  readSavedHistory,
  writeSavedHistory,
  type SavedHistory,
} from "./history-files";
import { providerAdapters } from "./providers";
import { collectPi } from "./pi-history";

const DAY_MS = 86_400_000;
const RETENTION_DAYS = 90;
const SCAN_INTERVAL_MS = 5 * 60_000;
const SCAN_WARNING =
  "Could not scan some local usage records. Showing available sources and previously stored data, if available. Check this host's usage-data paths.";

interface CollectionResult {
  rows: HistoryRow[];
  incomplete: boolean;
}

type CollectHistory = (
  provider: Provider,
  since: number,
  signal: AbortSignal,
) => Promise<HistoryRow[] | CollectionResult>;

export function historyDirectory(): string {
  const paseoHome = process.env.PASEO_HOME ?? join(homedir(), ".paseo");

  return join(paseoHome, "storage", "provider-usage");
}

export function createHistoryStore(
  directory = historyDirectory(),
  collect: CollectHistory = createLocalHistoryCollector(),
) {
  const controller = new AbortController();
  const warnings = new Map<Provider, string>();
  let pending: Promise<SavedHistory> | undefined;
  let cache: SavedHistory | undefined;
  let nextScan = 0;

  async function scan(): Promise<SavedHistory> {
    cache ??= await readSavedHistory(directory);

    const since = Date.now() - RETENTION_DAYS * DAY_MS;
    const rows: HistoryRow[] = [];

    for (const provider of providerIds) {
      const previous =
        cache?.rows.filter((row) => row.provider === provider) ?? [];

      try {
        const result = await collect(provider, since, controller.signal);
        const fresh = Array.isArray(result) ? result : result.rows;
        rows.push(...mergeHistoryRows(previous, fresh, since));

        if (!Array.isArray(result) && result.incomplete) {
          warnings.set(provider, SCAN_WARNING);
        } else {
          warnings.delete(provider);
        }
      } catch {
        rows.push(...mergeHistoryRows(previous, [], since));
        warnings.set(provider, SCAN_WARNING);
      }
    }

    if (controller.signal.aborted) {
      throw new Error("Cancelled");
    }

    const next: SavedHistory = {
      version: 1,
      scannedAt: new Date().toISOString(),
      rows,
    };
    await writeSavedHistory(directory, next);

    cache = next;
    nextScan = Date.now() + SCAN_INTERVAL_MS;

    return next;
  }

  async function load(): Promise<SavedHistory> {
    if (cache && Date.now() < nextScan) {
      return cache;
    }

    // All clients share the same in-flight scan.
    pending ??= scan();

    try {
      return await pending;
    } finally {
      pending = undefined;
    }
  }

  return {
    async read(
      provider: Provider,
      cwd: string,
      days: 7 | 30 | 90,
      sessionOffset = 0,
      scope: HistoryScope = "workspace",
    ) {
      const saved = await load();
      const start = new Date();
      const periodEnd = start.toISOString().slice(0, 10);
      const workspaceDirectory = resolve(cwd);
      start.setUTCDate(start.getUTCDate() - days + 1);

      const summary = summarizeHistory(saved.rows, {
        provider,
        firstDay: start.toISOString().slice(0, 10),
        lastDay: periodEnd,
        sessionOffset,
        scope,
        matchesWorkspace: (directory) =>
          resolve(directory) === workspaceDirectory,
      });

      return {
        scannedAt: saved.scannedAt,
        periodEnd,
        warning: warnings.get(provider) ?? "",
        ...summary,
      };
    },

    close() {
      controller.abort();
    },
  };
}

/** Scan Pi once per store refresh; failure of one harness cannot hide another. */
export function createLocalHistoryCollector(
  native = (provider: Provider, since: number, signal: AbortSignal) =>
    providerAdapters[provider].readHistory(since, signal),
  pi = collectPi,
): CollectHistory {
  let piScan:
    | {
        since: number;
        signal: AbortSignal;
        result: Promise<PromiseSettledResult<HistoryRow[]>>;
      }
    | undefined;

  return async (provider, since, signal) => {
    if (!piScan || piScan.since !== since || piScan.signal !== signal) {
      piScan = {
        since,
        signal,
        result: Promise.resolve()
          .then(() => pi(since, signal))
          .then(
            (value) => ({ status: "fulfilled" as const, value }),
            (reason: unknown) => ({ status: "rejected" as const, reason }),
          ),
      };
    }

    const piResultPromise = piScan.result;
    const [nativeResult] = await Promise.allSettled([
      Promise.resolve().then(() => native(provider, since, signal)),
    ]);
    const piResult = await piResultPromise;

    return {
      rows: [
        ...(nativeResult?.status === "fulfilled" ? nativeResult.value : []),
        ...(piResult.status === "fulfilled"
          ? piResult.value.filter((row) => row.provider === provider)
          : []),
      ],
      incomplete:
        nativeResult?.status === "rejected" || piResult.status === "rejected",
    };
  };
}
