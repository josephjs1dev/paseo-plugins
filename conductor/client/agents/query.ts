import { useRpc } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getAgents } from "../../shared/agents/rpc";
import type { AgentsSnapshot } from "../../shared/agents/models";
import { useDirectoryInvalidation } from "../paseo/use-directory";

export const agentsQueryKey = (hostId: string) =>
  ["conductor", hostId, "agents"] as const;
export function useAgents(hostId: string) {
  const fetch = useRpc(getAgents);
  const cache = useQueryClient();
  useDirectoryInvalidation([...agentsQueryKey(hostId)]);
  const query = useQuery({
    queryKey: agentsQueryKey(hostId),
    queryFn: () => {
      const previous = cache.getQueryData<AgentsSnapshot>(
        agentsQueryKey(hostId),
      );
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
  return query;
}
