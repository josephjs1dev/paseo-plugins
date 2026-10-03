import {
  historyCollectionSchema,
  type HistoryCollection,
} from "../../shared/history";
import type { Harness } from "../../shared/harnesses";
import type { Provider } from "../../shared/providers";
import { codexCollector } from "./codex";
import { piCollector } from "./pi";
import { opencodeCollector } from "./opencode";
import type { HistoryScan, QuotaCapability, UsageCollector } from "./types";

export const usageCollectors: Record<Harness, UsageCollector> = {
  codex: codexCollector,
  pi: piCollector,
  opencode: opencodeCollector,
};

export function quotaCapability(provider: Provider): QuotaCapability {
  const capabilities = Object.values(usageCollectors).flatMap((entry) =>
    entry.quota?.provider === provider ? [entry.quota] : [],
  );
  const [capability] = capabilities;

  if (!capability || capabilities.length !== 1) {
    throw new Error("Quota unavailable");
  }

  return capability;
}

/** Validate source output before it enters the normalized cache. */
export async function collectUsageHistory(
  collector: UsageCollector,
  scan: HistoryScan,
): Promise<HistoryCollection> {
  const result = historyCollectionSchema.parse(
    await collector.collectHistory(scan),
  );

  if (
    result.rows.some(
      (row) =>
        row.harness !== collector.harness ||
        !collector.providers.includes(row.provider),
    )
  ) {
    throw new Error("Invalid collector attribution");
  }

  return result;
}
