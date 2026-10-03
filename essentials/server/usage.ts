import type { Provider, Usage, Quota } from "../shared/usage";
import { providerAdapters } from "./providers";

const CACHE_DURATION_MS = 60_000;

type FetchQuota = (provider: Provider, signal: AbortSignal) => Promise<Quota>;

interface CachedUsage {
  expires: number;
  value: Promise<Usage>;
}

export function createUsageReader(
  fetchQuota: FetchQuota = (provider, signal) =>
    providerAdapters[provider].readQuota(signal),
  now: () => number = Date.now,
) {
  const controller = new AbortController();
  const cache = new Map<Provider, CachedUsage>();

  async function fetchUsage(provider: Provider): Promise<Usage> {
    try {
      const quota = await fetchQuota(provider, controller.signal);

      if (!quota.windows.length && quota.resetCredits == null) {
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
      return {
        provider,
        status: "unavailable",
        message: providerAdapters[provider].describeError(error),
        windows: [],
        checkedAt: new Date(now()).toISOString(),
      };
    }
  }

  return {
    read(provider: Provider): Promise<Usage> {
      const cached = cache.get(provider);

      if (cached && cached.expires > now()) {
        return cached.value;
      }

      const value = fetchUsage(provider);
      cache.set(provider, { expires: now() + CACHE_DURATION_MS, value });

      return value;
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
