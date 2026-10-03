import { useRpc } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { readHistory, type HistoryScope } from "../shared/history";
import type { Provider } from "../shared/providers";
import { historyQueryOptions } from "./history-query-options";

export function useHistoryQuery(
  hostId: string,
  workspaceId: string,
  provider: Provider,
  days: 7 | 30,
  sessionOffset = 0,
  scope: HistoryScope = "workspace",
) {
  const read = useRpc(readHistory);
  const cache = useQueryClient();
  const options = historyQueryOptions(
    hostId,
    workspaceId,
    provider,
    days,
    sessionOffset,
    scope,
  );

  const query = useQuery({
    queryKey: options.queryKey,
    queryFn: () => read(options.input),
    placeholderData: () => undefined,
    staleTime: 60_000,
    gcTime: 24 * 60 * 60_000,
    refetchOnMount: "always",
    refetchInterval: (state) => (state.state.data?.refreshing ? 1500 : 60_000),
    retry: false,
  });

  return {
    ...query,
    refresh: () =>
      cache
        .fetchQuery({
          queryKey: options.queryKey,
          queryFn: () => read({ ...options.input, refresh: true }),
          staleTime: 0,
          retry: false,
        })
        .catch(() => undefined),
  };
}
