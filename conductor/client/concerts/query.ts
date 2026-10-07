import { useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  deleteConcert,
  getConcertAccess,
  listConcerts,
  readConcert,
} from "../../shared/concerts/rpc";
import type { ConcertSelection } from "./selection";

export function useConcerts(
  hostId: string,
  workspaceId: string | undefined,
  selection: ConcertSelection | null,
) {
  const list = useRpc(listConcerts);
  const read = useRpc(readConcert);
  const access = useRpc(getConcertAccess);
  const remove = useRpc(deleteConcert);
  const cache = useQueryClient();
  const key = ["conductor", hostId, "runs"];
  const capabilities = useQuery({
    queryKey: [...key, "access"],
    queryFn: () => access({}),
    retry: false,
    staleTime: 15000,
  });
  const summaries = useQuery({
    queryKey: [...key, "list", workspaceId ?? null],
    queryFn: () => list(workspaceId ? { workspaceId } : {}),
    retry: false,
    refetchInterval: 15000,
  });
  const id = selection?.id;
  const detail = useQuery({
    queryKey: [...key, "detail", id],
    queryFn: () => {
      if (!id) {
        throw new Error("Select a concert first.");
      }
      return read({ id });
    },
    enabled: Boolean(id),
    retry: false,
    refetchInterval: 15000,
  });
  const removeMutation = useMutation({
    mutationFn: (input: { id: string; version: number }) => remove(input),
    onSuccess: (_data, variables) => {
      // Drop the cached detail so a stale snapshot cannot reappear, then
      // refresh the shared concerts key (list, detail, access).
      cache.removeQueries({ queryKey: [...key, "detail", variables.id] });
      void cache.invalidateQueries({ queryKey: key });
    },
  });
  return {
    summaries,
    detail,
    access: capabilities,
    refresh: () => cache.invalidateQueries({ queryKey: key }),
    remove: (id: string, version: number): Promise<unknown> =>
      removeMutation.mutateAsync({ id, version }),
  };
}
