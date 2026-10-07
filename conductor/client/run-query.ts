import { useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { deleteRun, getRunAccess, listRuns, readRun } from "../shared/run-rpc";
import type { RunSelection } from "./run-state";

export function useRuns(
  hostId: string,
  workspaceId: string | undefined,
  selection: RunSelection | null,
) {
  const list = useRpc(listRuns);
  const read = useRpc(readRun);
  const access = useRpc(getRunAccess);
  const remove = useRpc(deleteRun);
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
        throw new Error("Select a performance first.");
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
      // refresh the shared runs key (list, detail, access).
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
