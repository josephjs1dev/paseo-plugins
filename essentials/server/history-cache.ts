import { providerIds, type Provider } from "../shared/providers";
import type { HistoryRow } from "../shared/history";
import { mergeHistoryRows } from "../shared/history-analysis";
import {
  readSavedHistory,
  writeSavedHistory,
  type SavedHistory,
} from "./history-files";
import type { HistoryCollection } from "./history-sources";

const DAY_MS = 86_400_000;
const RETENTION_MS = 90 * DAY_MS;
const SCAN_INTERVAL_MS = 5 * 60_000;

export type CollectHistory = (
  provider: Provider,
  since: number,
  signal: AbortSignal,
  modifiedSince?: number,
) => Promise<HistoryRow[] | HistoryCollection>;

export function createHistoryCache(
  directory: string,
  collect: CollectHistory,
  now: () => number = Date.now,
) {
  const controller = new AbortController();
  let cache: SavedHistory | undefined;
  let hydration: Promise<void> | undefined;
  let pending: Promise<SavedHistory> | undefined;
  let nextScan = 0;
  let warnings = new Set<Provider>();

  function checkCancelled() {
    if (controller.signal.aborted) {
      throw new Error("Cancelled");
    }
  }

  async function hydrate() {
    hydration ??= (async () => {
      cache = await readSavedHistory(directory);
      checkCancelled();
      warnings = new Set(cache?.warningProviders ?? []);
      const checkedAt = cache ? Date.parse(cache.scannedAt) : 0;
      nextScan = checkedAt <= now() ? checkedAt + SCAN_INTERVAL_MS : 0;
    })();
    await hydration;
  }

  function initialCheckpoint(
    saved: SavedHistory | undefined,
  ): number | undefined {
    if (!saved) {
      return;
    }

    if (saved.updatedThrough) {
      return Date.parse(saved.updatedThrough);
    }

    // Legacy caches recorded scan attempts even after a source failed. Use the
    // oldest provider's latest actual record to avoid skipping that failure gap.
    const observed = providerIds.flatMap((provider) => {
      const latest = saved.rows.reduce(
        (previous, row) =>
          row.provider === provider
            ? Math.max(previous, Date.parse(row.lastAt))
            : previous,
        -Infinity,
      );

      return Number.isFinite(latest) ? [latest] : [];
    });

    return observed.length
      ? Math.min(Date.parse(saved.scannedAt), ...observed)
      : undefined;
  }

  async function collectWindow(since: number, modifiedSince: number) {
    return Promise.all(
      providerIds.map(async (provider) => {
        try {
          const result = await collect(
            provider,
            since,
            controller.signal,
            modifiedSince,
          );

          return {
            provider,
            rows: Array.isArray(result) ? result : result.rows,
            incomplete: !Array.isArray(result) && result.incomplete,
          };
        } catch {
          checkCancelled();

          return { provider, rows: [], incomplete: true };
        }
      }),
    );
  }

  async function scan(): Promise<SavedHistory> {
    checkCancelled();
    const startedAt = now();
    const since = startedAt - RETENTION_MS;
    const checkpoint = initialCheckpoint(cache);
    const modifiedSince =
      checkpoint !== undefined && checkpoint <= startedAt
        ? Math.max(since, Math.min(checkpoint - 1000, startedAt - DAY_MS))
        : since;
    let results = await collectWindow(since, modifiedSince);
    const backfillWarnings = { ...cache?.backfillWarnings };

    for (const provider of providerIds) {
      if (
        backfillWarnings[provider] &&
        Date.parse(backfillWarnings[provider]) < since
      ) {
        delete backfillWarnings[provider];
      }
    }

    // A bounded first scan can import recent records without finishing the old
    // backlog. Validate the recent window separately so future refreshes are
    // incremental while the old backlog remains explicitly marked incomplete.
    if (
      modifiedSince === since &&
      results.some((result) => result.incomplete)
    ) {
      for (const result of results) {
        if (result.incomplete) {
          backfillWarnings[result.provider] = new Date(startedAt).toISOString();
        }
      }

      const recent = await collectWindow(since, startedAt - DAY_MS);
      results = results.map((result, index) => {
        const update = recent[index];

        return update
          ? {
              ...update,
              rows: mergeHistoryRows(result.rows, update.rows, since),
            }
          : result;
      });
    } else if (modifiedSince === since) {
      for (const provider of providerIds) {
        delete backfillWarnings[provider];
      }
    }

    checkCancelled();
    const complete = results.every((result) => !result.incomplete);
    const updatedThrough = complete ? startedAt : checkpoint;
    const warningProviders = results
      .filter((result) => result.incomplete)
      .map((result) => result.provider);
    const rows = results.flatMap((result) =>
      mergeHistoryRows(
        cache?.rows.filter((row) => row.provider === result.provider) ?? [],
        result.rows,
        since,
      ),
    );
    const next: SavedHistory = {
      version: 1,
      scannedAt: new Date(startedAt).toISOString(),
      rows,
      warningProviders,
      backfillWarnings,
      ...(updatedThrough !== undefined
        ? { updatedThrough: new Date(updatedThrough).toISOString() }
        : {}),
    };
    await writeSavedHistory(directory, next, controller.signal);
    checkCancelled();
    cache = next;
    warnings = new Set(warningProviders);
    nextScan = now() + SCAN_INTERVAL_MS;

    return next;
  }

  function startRefresh() {
    if (!pending) {
      const request = scan();
      pending = request;
      // Background failures remain visible without rejecting cached reads.
      void request.then(
        () => {
          if (pending === request) {
            pending = undefined;
          }
        },
        () => {
          warnings = new Set(providerIds);
          nextScan = now() + SCAN_INTERVAL_MS;

          if (pending === request) {
            pending = undefined;
          }
        },
      );
    }

    return pending;
  }

  return {
    async load(forceRefresh = false) {
      await hydrate();
      checkCancelled();

      if (!cache) {
        await startRefresh();
      } else if (forceRefresh || now() >= nextScan) {
        startRefresh();
      }

      if (!cache) {
        throw new Error("History unavailable");
      }

      return {
        history: cache,
        refreshing: pending !== undefined,
        warningProviders: new Set([
          ...warnings,
          ...Object.keys(cache.backfillWarnings ?? {}),
        ]),
      };
    },
    async refresh() {
      await hydrate();
      checkCancelled();

      return startRefresh();
    },
    async close() {
      controller.abort();
      await pending?.catch(() => undefined);
      await hydration?.catch(() => undefined);
    },
  };
}
