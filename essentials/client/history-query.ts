import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
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
  const options = historyQueryOptions(
    hostId,
    workspaceId,
    provider,
    days,
    sessionOffset,
    scope,
  );

  return useQuery({
    queryKey: options.queryKey,
    queryFn: () => read(options.input),
    placeholderData: () => undefined,
    staleTime: 60_000,
    refetchInterval: 60_000,
    retry: false,
  });
}
