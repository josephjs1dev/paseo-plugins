import { readFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { maintenanceHostSchema } from "../shared/maintenance-host";

export async function readHostIdentity(
  env: NodeJS.ProcessEnv = process.env,
  name: string = hostname(),
) {
  try {
    // Match Paseo's daemon identity, without creating or modifying it.
    const id =
      env.PASEO_SERVER_ID?.trim() ||
      (
        await readFile(
          join(env.PASEO_HOME || join(homedir(), ".paseo"), "server-id"),
          "utf8",
        )
      ).trim();

    return maintenanceHostSchema.parse({ id, name });
  } catch {
    throw new Error("Could not identify this host. Check the host connection.");
  }
}
