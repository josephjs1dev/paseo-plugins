import { useState } from "react";
import type { ProfilesData } from "../../client/symphonies/profiles";
import { PreviewProfilesController } from "./profiles-controller";

/**
 * Preview-only stand-in for the profiles RPC level, built on the preview
 * store engine (profiles-controller.ts) so both the stub path and the real
 * `useProfiles` query path mutate through the same revision semantics.
 */
export function usePreviewProfiles(
  options: {
    empty?: boolean;
    stale?: boolean;
    noProviders?: boolean;
    invalid?: boolean;
  } = {},
): ProfilesData {
  const [controller] = useState(() => new PreviewProfilesController(options));
  const [, setTick] = useState(0);
  const bump = (): void => setTick((value) => value + 1);
  const data: ProfilesData = {
    state: controller.state(),
    loading: false,
    stale: false,
    providers: controller.providers(),
    save: async (draft, expectedRevision) => {
      const result = await controller.save(expectedRevision, {
        kind: "upsert",
        profile: draft,
      });
      bump();
      return result;
    },
    remove: async (id, expectedRevision) => {
      const result = await controller.save(expectedRevision, {
        kind: "delete",
        id,
      });
      bump();
      return result;
    },
    setMode: async (mode, expectedRevision) => {
      const result = await controller.save(expectedRevision, {
        kind: "mode",
        mode,
      });
      bump();
      return result;
    },
    importPaseo: async (expectedRevision) => {
      const result = await controller.importFromPaseo(expectedRevision);
      bump();
      return result;
    },
    previewPaseoSync: () => controller.syncPreview(),
    syncPaseo: async (profileIds, expectedRevision, expectedPaseoRevision) => {
      const result = await controller.syncToPaseo(
        expectedRevision,
        expectedPaseoRevision,
        profileIds,
      );
      bump();
      return result;
    },
    refresh: async () => controller.state(),
  };
  return data;
}
