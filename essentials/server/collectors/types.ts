import type { Harness } from "../../shared/harnesses";
import type { HistoryCollection } from "../../shared/history";
import type { Provider } from "../../shared/providers";
import type { Quota, Usage } from "../../shared/usage";

export interface HistoryScan {
  since: number;
  modifiedSince?: number;
  signal: AbortSignal;
}

export interface QuotaCapability {
  provider: Provider;
  read(signal: AbortSignal): Promise<Quota>;
  describeError(error: unknown): string;
  describeIssue?(error: unknown): Usage["issue"];
}

/** A harness owns source I/O; returned records identify their subscription. */
export interface UsageCollector {
  harness: Harness;
  providers: readonly Provider[];
  collectHistory(scan: HistoryScan): Promise<HistoryCollection>;
  quota?: QuotaCapability;
}
