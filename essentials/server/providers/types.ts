import type { HistoryRow } from "../../shared/history";
import type { Quota } from "../../shared/usage";

export interface ProviderAdapter {
  readQuota(signal: AbortSignal): Promise<Quota>;
  readHistory(since: number, signal: AbortSignal): Promise<HistoryRow[]>;
  describeError(error: unknown): string;
}
