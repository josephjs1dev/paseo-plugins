import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  applyCliUpdate,
  checkCliUpdates,
  readMaintenance,
  refreshCliModels,
  cliIds,
  cliNames,
  type CliId,
  type Maintenance,
} from "../shared/cli-maintenance";
import {
  inspectInstallation,
  latestVersion,
  describeInstallation,
  updateInstallation,
  type Installation,
} from "./cli-installation";
import { run } from "./cli-process";
import { readMaintenanceHost } from "../shared/maintenance-host";
import { readHostIdentity } from "./maintenance-host";

export function createMaintenanceService(
  dependencies = {
    inspect: inspectInstallation,
    latest: latestVersion,
    update: updateInstallation,
  },
) {
  const controller = new AbortController();
  const installations = new Map<CliId, Installation>();
  let state: Maintenance = {
    busy: false,
    action: "",
    checkedAt: null,
    rows: [],
    message: "",
  };
  let task: Promise<void> | null = null;
  const read = () => structuredClone(state);
  function start(action: string, work: () => Promise<void>) {
    if (controller.signal.aborted || state.busy) {
      throw new Error(
        "Another CLI operation is running. Wait for it to finish.",
      );
    }

    state = { ...state, busy: true, action, message: "" };
    task = work()
      .catch(() => {
        state.message =
          "Operation failed or timed out. Check the host's connection and installation permissions, then check again.";
      })
      .finally(() => {
        state.busy = false;
        state.action = "";
      });

    return read();
  }

  return {
    read,
    refresh(id: CliId, work: (signal: AbortSignal) => Promise<string>) {
      return start(`Refreshing ${cliNames[id]} models…`, async () => {
        state.message = await work(controller.signal);
      });
    },
    check(getOverrides: () => Promise<Record<string, unknown>>) {
      return start("Checking CLI updates…", async () => {
        installations.clear();
        state.rows = state.rows.map((row) => ({ ...row, canUpdate: false }));
        const overrides = await getOverrides();
        state.rows = await Promise.all(
          cliIds.map(async (id) => {
            try {
              const installation = await dependencies.inspect(
                id,
                overrides[id],
                controller.signal,
              );
              const latest = await dependencies
                .latest(installation.packageName, controller.signal)
                .catch(() => null);
              installations.set(id, installation);

              return describeInstallation(id, installation, latest);
            } catch {
              return {
                id,
                installed: null,
                latest: null,
                executable: "",
                method: "Unknown",
                canUpdate: false,
                message:
                  "Unavailable or custom launch wrapper. Check this provider's installation and command configuration.",
              };
            }
          }),
        );
        state.checkedAt = new Date().toISOString();
      });
    },
    update(
      id: CliId,
      version: string,
      getOverrides: () => Promise<Record<string, unknown>>,
    ) {
      const previous = installations.get(id);
      const row = state.rows.find((entry) => entry.id === id);

      if (!previous || !row?.canUpdate || row.latest !== version) {
        throw new Error("Check for updates before applying this version.");
      }

      return start(`Updating ${cliNames[id]}…`, async () => {
        // Consume the offer before any side effect; reconnects cannot accidentally replay it.
        row.canUpdate = false;
        const overrides = await getOverrides();
        const current = await dependencies.inspect(
          id,
          overrides[id],
          controller.signal,
        );

        if (
          current.executable !== previous.executable ||
          current.resolvedPath !== previous.resolvedPath ||
          current.installed !== previous.installed ||
          current.method !== previous.method ||
          current.updater !== previous.updater ||
          current.prefix !== previous.prefix
        ) {
          throw new Error("Installation changed since the check.");
        }

        await dependencies.update(current, version, controller.signal);
        const updated = await dependencies.inspect(
          id,
          overrides[id],
          controller.signal,
        );
        installations.set(id, updated);
        state.rows = state.rows.map((entry) =>
          entry.id === id ? describeInstallation(id, updated, version) : entry,
        );
        state.message = `${cliNames[id]} updated to ${updated.installed}. Refresh models to discover new choices. Existing sessions may need reopening to use the new CLI.`;
      });
    },
    async settled() {
      await task;
    },
    close() {
      controller.abort();
    },
  };
}

export default function contribute(server: PluginServerContext) {
  const service = createMaintenanceService();
  server.handle(readMaintenanceHost, () => readHostIdentity());
  server.handle(readMaintenance, () => service.read());
  server.handle(checkCliUpdates, (_, { paseo }) =>
    service.check(async () => (await paseo.config.get()).config.providers),
  );
  server.handle(applyCliUpdate, ({ id, version }, { paseo }) =>
    service.update(
      id,
      version,
      async () => (await paseo.config.get()).config.providers,
    ),
  );
  server.handle(refreshCliModels, ({ id, workspaceId }, { paseo }) =>
    service.refresh(id, async (signal) => {
      const workspace = workspaceId
        ? await paseo.workspaces.ref(workspaceId).refresh()
        : undefined;

      if (workspaceId && !workspace?.workspaceDirectory) {
        throw new Error("Workspace unavailable.");
      }

      let cacheWarning = "";

      if (id !== "codex") {
        try {
          const overrides = (await paseo.config.get()).config.providers;
          const installation = await inspectInstallation(
            id,
            overrides[id],
            signal,
          );
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
    }),
  );

  return () => service.close();
}
