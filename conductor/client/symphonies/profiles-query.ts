import { useRpc } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  importPaseoProfiles,
  listProfileProviders,
  listProfiles,
  saveProfiles,
  syncPreview,
  syncProfiles,
} from "../../shared/symphonies/profiles-rpc";
import type {
  ProfileOperation,
  SaveProfilesResult,
} from "../../shared/symphonies/profiles";
import type { ProfilesData } from "./profiles";

/** The React Query key holding the whole profiles list + mode + revision. */
export const profilesQueryKey = (hostId: string): readonly string[] => [
  "conductor",
  hostId,
  "profiles",
];

const stateKey = (hostId: string) => [...profilesQueryKey(hostId), "state"];

/**
 * Loads the Conductor worker profiles through the daemon and exposes the
 * save/delete/mode/import actions. Every mutation carries the caller's own
 * expected revision — the editor passes the revision its draft was based on,
 * so a background refresh between the open and the save is rejected stale
 * instead of silently overwriting someone else's newer changes. Successful
 * results carry the full store state, written straight back into the cache.
 */
export function useProfiles(
  hostId: string,
): ProfilesData & { fetching: boolean } {
  const list = useRpc(listProfiles);
  const save = useRpc(saveProfiles);
  const providers = useRpc(listProfileProviders);
  const importPaseoRpc = useRpc(importPaseoProfiles);
  const syncPreviewRpc = useRpc(syncPreview);
  const syncProfilesRpc = useRpc(syncProfiles);
  const cache = useQueryClient();
  const state = useQuery({
    queryKey: stateKey(hostId),
    queryFn: () => list({}),
    retry: false,
    staleTime: 5000,
  });
  const catalog = useQuery({
    queryKey: [...profilesQueryKey(hostId), "providers"],
    queryFn: () => providers({}),
    retry: false,
    staleTime: 60_000,
  });
  const commit = async (
    operation: ProfileOperation,
    expectedRevision: string,
  ): Promise<SaveProfilesResult> => {
    if (!expectedRevision) {
      throw new Error("Profiles are still loading. Try again.");
    }
    const result = await save({ expectedRevision, operation });
    cache.setQueryData(stateKey(hostId), result.state);
    return result;
  };
  const data: ProfilesData = {
    state: state.data,
    loading: state.isPending,
    stale: state.isError,
    providers: catalog.data,
    save: (draft, expectedRevision) =>
      commit({ kind: "upsert", profile: draft }, expectedRevision),
    remove: (id, expectedRevision) =>
      commit({ kind: "delete", id }, expectedRevision),
    setMode: (mode, expectedRevision) =>
      commit({ kind: "mode", mode }, expectedRevision),
    importPaseo: async (expectedRevision: string) => {
      if (!expectedRevision) {
        throw new Error("Profiles are still loading. Try again.");
      }
      const result = await importPaseoRpc({ expectedRevision });
      cache.setQueryData(stateKey(hostId), result.state);
      return result;
    },
    previewPaseoSync: () => syncPreviewRpc({}),
    syncPaseo: async (
      profileIds: readonly string[],
      expectedRevision: string,
      expectedPaseoRevision: string,
    ) => {
      if (!expectedRevision) {
        throw new Error("Profiles are still loading. Try again.");
      }
      const result = await syncProfilesRpc({
        profileIds: [...profileIds],
        expectedRevision,
        expectedPaseoRevision,
      });
      if (result.status === "saved") {
        // The Conductor store is untouched, but its cached revision must not
        // be trusted by the next mutation after a dialog cycle; refetch so it
        // carries the revision the server just verified against.
        void cache.invalidateQueries({ queryKey: stateKey(hostId) });
      }
      return result;
    },
    refresh: async () => {
      const result = await state.refetch();
      void cache.invalidateQueries({
        queryKey: [...profilesQueryKey(hostId), "providers"],
      });
      return result.data;
    },
  };
  return { ...data, fetching: state.isFetching || catalog.isFetching };
}
