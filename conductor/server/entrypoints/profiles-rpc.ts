import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  importPaseoProfiles,
  listProfileProviders,
  listProfiles,
  saveProfiles,
  syncPreview,
  syncProfiles,
} from "../../shared/symphonies/profiles-rpc";
import { providerCatalog } from "../engine/paseo/provider-catalog";
import { SymphonyError } from "../symphonies/errors";
import { profilesState, type ProfilesSource } from "../symphonies/profiles";

async function guarded<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof SymphonyError) {
      throw error;
    }
    throw new Error(
      "Conductor could not load or save the worker profiles. Refresh and check conductor storage.",
    );
  }
}

/** Registers the Conductor profile store RPCs used by the Podium editor. */
export function registerProfilesRpc(
  server: Pick<PluginServerContext, "handle">,
  profiles: ProfilesSource,
): void {
  server.handle(listProfiles, () =>
    guarded(async () => profilesState(await profiles.load())),
  );
  server.handle(saveProfiles, (input) =>
    guarded(() => profiles.save(input.expectedRevision, input.operation)),
  );
  server.handle(listProfileProviders, (_input, { paseo }) =>
    guarded(() => providerCatalog(paseo)),
  );
  server.handle(importPaseoProfiles, (input) =>
    guarded(() => profiles.importFromPaseo(input.expectedRevision)),
  );
  server.handle(syncPreview, () => guarded(() => profiles.syncPreview()));
  server.handle(syncProfiles, (input) =>
    guarded(() =>
      profiles.syncToPaseo(
        input.expectedRevision,
        input.expectedPaseoRevision,
        input.profileIds,
      ),
    ),
  );
}
