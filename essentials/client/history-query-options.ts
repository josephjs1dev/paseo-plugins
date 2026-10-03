import type { HistoryScope } from "../shared/history";
import type { Provider } from "../shared/providers";

export function historyQueryOptions(
  hostId: string,
  workspaceId: string,
  provider: Provider,
  days: 7 | 30,
  sessionOffset = 0,
  scope: HistoryScope = "workspace",
) {
  const filterKey = [
    "nestkit-history",
    hostId,
    workspaceId,
    provider,
    days,
    scope,
  ] as const;

  return {
    filterKey,
    queryKey: [...filterKey, sessionOffset] as const,
    input: { provider, workspaceId, days, sessionOffset, scope },
  };
}

export function validSessionOffset(offset: number, count: number): number {
  return Math.min(offset, Math.max(0, Math.ceil(count / 20) - 1) * 20);
}
