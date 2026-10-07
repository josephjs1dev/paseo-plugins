import { useEffect } from "react";
import { usePaseo, useRpc } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getInbox } from "../../shared/agents/rpc";
import type { InboxSnapshot } from "../../shared/agents/models";
import { observeDirectory } from "../paseo/observation";

export const inboxKey = (hostId: string) =>
  ["conductor", hostId, "inbox"] as const;
export function useInbox(hostId: string) {
  const fetch = useRpc(getInbox);
  const paseo = usePaseo();
  const cache = useQueryClient();
  const query = useQuery({
    queryKey: inboxKey(hostId),
    queryFn: () => {
      const previous = cache.getQueryData<InboxSnapshot>(inboxKey(hostId));
      const knownAgentIds = [
        ...new Set(
          previous?.items
            .filter((item) => item.requestId !== null)
            .map((item) => item.agentId) ?? [],
        ),
      ].slice(0, 2000);
      return fetch({ knownAgentIds });
    },
    retry: false,
    staleTime: 2000,
    refetchInterval: 15_000,
  });
  useEffect(
    () =>
      observeDirectory(paseo, () => {
        cache
          .invalidateQueries({ queryKey: inboxKey(hostId) })
          .catch(() => undefined);
      }),
    [paseo, cache, hostId],
  );
  return query;
}
