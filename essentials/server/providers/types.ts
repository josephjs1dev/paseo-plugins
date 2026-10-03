import type { HistoryRow } from "../../shared/history";
import type { Quota } from "../../shared/usage";
import type { HistoryCollection } from "../history-sources";

export interface ProviderAdapter {
  readQuota(signal: AbortSignal): Promise<Quota>;
  readHistory(
    since: number,
    signal: AbortSignal,
    modifiedSince?: number,
  ): Promise<HistoryRow[] | HistoryCollection>;
  describeError(error: unknown): string;
}
