import type {
  PaseoProfileRecord,
  PaseoProfilesPort,
} from "../../symphonies/profiles";
import type { PaseoApi } from "./types";

// The contract lives in domain code so server/symphonies never imports a
// Paseo-specific module; the adapter below binds it to the daemon.
export type { PaseoProfileRecord, PaseoProfilesPort };

/**
 * Reads and replaces the daemon's raw Paseo agent profile entries. Writing a
 * list replaces the whole `agentProfiles` array, so callers always send the
 * full merged list.
 */
export function paseoProfilesPort(paseo: PaseoApi): PaseoProfilesPort {
  return {
    async read() {
      return (await paseo.config.get()).config.agentProfiles ?? [];
    },
    async write(next) {
      const saved = await paseo.config.patch({ agentProfiles: [...next] });
      return saved.config.agentProfiles ?? [];
    },
  };
}
