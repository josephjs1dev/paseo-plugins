import type { Provider, Usage, Quota } from "../shared/usage";
import { quotaCapability } from "./collectors";
import { quotaSchema } from "../shared/usage";

const CACHE_DURATION_MS = 60_000;

type FetchQuota = (provider: Provider, signal: AbortSignal) => Promise<Quota>;

interface CachedUsage {
  expires: number;
  value: Promise<Usage>;
  pending: boolean;
}

export function createUsageReader(
  fetchQuota: FetchQuota = (provider, signal) =>
    quotaCapability(provider).read(signal),
  now: () => number = Date.now,
) {
  const controller = new AbortController();
  const cache = new Map<Provider, CachedUsage>();

  async function fetchUsage(provider: Provider): Promise<Usage> {
    try {
      const quota = quotaSchema.parse(
        await fetchQuota(provider, controller.signal),
      );

      if (
        !quota.windows.length &&
        quota.resetCredits == null &&
        quota.credits == null
      ) {
        throw new Error("No quota windows");
      }

      return {
        provider,
        status: "ok",
        message: "",
        ...quota,
        checkedAt: new Date(now()).toISOString(),
      };
    } catch (error) {
      const capability = quotaCapability(provider);
      const issue = capability.describeIssue?.(error);

      return {
        provider,
        status: "unavailable",
        message: capability.describeError(error),
        ...(issue ? { issue } : {}),
        windows: [],
        checkedAt: new Date(now()).toISOString(),
      };
    }
  }

  return {
    read(provider: Provider, refresh = false): Promise<Usage> {
      const cached = cache.get(provider);

      if (cached && (cached.pending || (!refresh && cached.expires > now()))) {
        return cached.value;
      }

      const entry: CachedUsage = {
        expires: now() + CACHE_DURATION_MS,
        pending: true,
        value: fetchUsage(provider).finally(() => {
          entry.pending = false;
        }),
      };
      cache.set(provider, entry);

      return entry.value;
    },

    close() {
      controller.abort();
      cache.clear();
    },

    invalidate(provider: Provider) {
      cache.delete(provider);
    },
  };
}
