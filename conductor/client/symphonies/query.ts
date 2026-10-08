import { useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  deleteSymphony,
  getSymphonyAccess,
  listSymphonies,
  readSymphony,
} from "../../shared/symphonies/rpc";
import type { SymphonySelection } from "./selection";

export function useSymphonies(
  hostId: string,
  concertId: string | undefined,
  selection: SymphonySelection | null,
) {
  const list = useRpc(listSymphonies);
  const read = useRpc(readSymphony);
  const access = useRpc(getSymphonyAccess);
  const remove = useRpc(deleteSymphony);
  const cache = useQueryClient();
  const key = ["conductor", hostId, "symphonies"];
  const capabilities = useQuery({
    queryKey: [...key, "access"],
    queryFn: () => access({}),
    retry: false,
    staleTime: 15000,
  });
  const summaries = useQuery({
    queryKey: [...key, "list", concertId ?? null],
    queryFn: () => list(concertId ? { concertId } : {}),
    retry: false,
    refetchInterval: 15000,
  });
  const id = selection?.id;
  const detail = useQuery({
    queryKey: [...key, "detail", id],
    queryFn: () => {
      if (!id) {
        throw new Error("Select a symphony first.");
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
      // refresh the shared symphonies key (list, detail, access).
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
