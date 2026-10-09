import { resolve } from "node:path";
import { usageCollectors } from "../server/collectors";
import type { UsageCollector } from "../server/collectors/types";
import type { Harness } from "../shared/harnesses";
import type { HistoryCollection, HistoryRow } from "../shared/history";

/** Inject source I/O while exercising the real registry metadata and validation. */
export function fakeCollectors(
  collect: (
    harness: Harness,
    since: number,
    signal: AbortSignal,
    modifiedSince?: number,
  ) => Promise<HistoryCollection>,
): UsageCollector[] {
  return Object.values(usageCollectors).map((collector) => ({
    ...collector,
    collectHistory: ({ since, signal, modifiedSince }) =>
      collect(collector.harness, since, signal, modifiedSince),
  }));
}

/** Matches rows recorded in a directory, for tests that predate session attribution. */
export function inDirectory(directory: string) {
  const expected = resolve(directory);

  return (row: HistoryRow) => resolve(row.cwd) === expected;
}
