import type { PaseoApi } from "@getpaseo/client";
import { cliNames, type CliId } from "../shared/cli-maintenance";
import { inspectInstallation } from "./cli-installation";
import { run } from "./cli-process";

type ModelHost = {
  workspaces: Pick<PaseoApi["workspaces"], "ref">;
  config: Pick<PaseoApi["config"], "get">;
  providers: Pick<PaseoApi["providers"], "refresh" | "waitForReady">;
};

export async function refreshModels(
  id: CliId,
  workspaceId: string | undefined,
  paseo: ModelHost,
  signal: AbortSignal,
): Promise<string> {
  const workspace = workspaceId
    ? await paseo.workspaces.ref(workspaceId).refresh()
    : undefined;

  if (workspaceId && !workspace?.workspaceDirectory) {
    throw new Error("Workspace unavailable.");
  }

  let cacheWarning = "";

  if (id === "opencode" || id === "pi") {
    try {
      const overrides = (await paseo.config.get()).config.providers;
      const installation = await inspectInstallation(id, overrides[id], signal);
      const args =
        id === "opencode"
          ? ["models", "--refresh"]
          : ["update", "--models", "--no-approve"];

      if (
        id === "pi" &&
        !(
          await run(
            installation.executable,
            ["update", "--help"],
            installation.env,
            signal,
          )
        ).includes("--models")
      ) {
        throw new Error("Pi model refresh requires a newer CLI.");
      }

      await run(
        installation.executable,
        args,
        installation.env,
        signal,
        45_000,
      );
    } catch {
      cacheWarning =
        " The CLI cache could not be refreshed; check its version and connection.";
    }
  }

  const options = workspace?.workspaceDirectory
    ? { cwd: workspace.workspaceDirectory }
    : {};
  await paseo.providers.refresh({ ...options, providers: [id] });
  const catalog = await paseo.providers.waitForReady({
    ...options,
    timeoutMs: 60_000,
  });
  const entry = catalog.entries.find((entry) => entry.provider === id);

  if (!entry || entry.status !== "ready") {
    throw new Error("Provider discovery failed.");
  }

  return `${cliNames[id]} model picker refreshed: ${entry.models?.length ?? 0} models.${cacheWarning}`;
}
