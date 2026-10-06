import { providerIds, type Provider } from "../shared/providers";
import { mergeHistoryRows } from "../shared/history-analysis";
import { collectUsageHistory } from "./collectors";
import type { UsageCollector } from "./collectors/types";
import type { HistoryCollection } from "../shared/history";
import {
  readSavedHistory,
  writeSavedHistory,
  type SavedHistory,
  type CollectorState,
} from "./history-files";

const DAY_MS = 86_400_000;
const RETENTION_MS = 90 * DAY_MS;
const SCAN_INTERVAL_MS = 5 * 60_000;

export function createHistoryCache(
  directory: string,
  collectors: readonly UsageCollector[],
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
      const checkedAt = cache ? Date.parse(cache.scannedAt) : 0;
      // Migrated caches have no collector checkpoints and require a full scan.
      const hasCheckpoints = collectors.every(
        (collector) => cache?.collectors[collector.harness]?.updatedThrough,
      );
      nextScan =
        hasCheckpoints && checkedAt <= now() ? checkedAt + SCAN_INTERVAL_MS : 0;
    })();
    await hydration;
  }

  async function collectWindow(
    collector: UsageCollector,
    since: number,
    modifiedSince: number,
  ): Promise<HistoryCollection> {
    try {
      return await collectUsageHistory(collector, {
        since,
        modifiedSince,
        signal: controller.signal,
      });
    } catch {
      checkCancelled();

      return { rows: [], incomplete: true };
    }
  }

  async function scan(): Promise<SavedHistory> {
    checkCancelled();
    const startedAt = now();
    const scannedAt = new Date(startedAt).toISOString();
    const since = startedAt - RETENTION_MS;
    const results = await Promise.all(
      collectors.map(async (collector) => {
        const state: CollectorState = {
          ...cache?.collectors[collector.harness],
          incomplete: false,
        };
        const checkpoint =
          state.updatedThrough === undefined
            ? undefined
            : Date.parse(state.updatedThrough);
        const modifiedSince =
          checkpoint !== undefined && checkpoint <= startedAt
            ? Math.max(since, Math.min(checkpoint - 1000, startedAt - DAY_MS))
            : since;

        if (
          state.backfillWarningAt &&
          Date.parse(state.backfillWarningAt) < since
        ) {
          delete state.backfillWarningAt;
        }

        let result = await collectWindow(collector, since, modifiedSince);

        if (modifiedSince === since) {
          if (result.incomplete) {
            state.backfillWarningAt ??= scannedAt;
            // Only an incomplete bootstrap needs a second, recent-window scan.
            const recent = await collectWindow(
              collector,
              since,
              startedAt - DAY_MS,
            );
            result = {
              rows: mergeHistoryRows(result.rows, recent.rows, since),
              incomplete: recent.incomplete,
            };
          } else {
            delete state.backfillWarningAt;
          }
        }

        state.incomplete = result.incomplete;

        if (!result.incomplete) {
          state.updatedThrough = scannedAt;
        }

        return { collector, state, rows: result.rows };
      }),
    );
    checkCancelled();
    const next: SavedHistory = {
      version: 3,
      scannedAt,
      rows: [],
      collectors: {},
    };

    for (const { collector, state, rows } of results) {
      next.collectors[collector.harness] = state;
      next.rows.push(
        ...mergeHistoryRows(
          cache?.rows.filter((row) => row.harness === collector.harness) ?? [],
          rows,
          since,
        ),
      );
    }

    await writeSavedHistory(directory, next, controller.signal);
    checkCancelled();
    cache = next;
    warnings.clear();
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

      const warningProviders = new Set(warnings);

      for (const collector of collectors) {
        const state = cache.collectors[collector.harness];

        if (state?.incomplete || state?.backfillWarningAt) {
          for (const provider of collector.providers) {
            warningProviders.add(provider);
          }
        }
      }

      return {
        history: cache,
        refreshing: pending !== undefined,
        warningProviders,
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
