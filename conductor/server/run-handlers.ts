import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  deleteRun,
  getRunAccess,
  listRuns,
  readRun,
  orchestrateRun,
} from "../shared/run-rpc";
import { fileRunStore } from "./run-store";
import { RunError } from "./run-files";
import { executionRuntime } from "./run-identity";
import { paseoWorkers } from "./run-workers";
import { runExecution } from "./run-execution";
import { commandServer } from "./run-command-server";
import { commandHooks } from "./run-command-hooks";
import type { PaseoApi } from "./runtime";

async function guarded<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof RunError) {
      throw error;
    }
    throw new Error(
      "Conductor could not load or save this run. Refresh and inspect run storage; native requests remain available.",
    );
  }
}

export function registerRuns(server: PluginServerContext, directory: string) {
  const store = fileRunStore(directory);
  let runtime: PaseoApi | null = null;
  const remember = (paseo: PaseoApi) => {
    runtime = paseo;
  };
  const requireRuntime = () => {
    if (!runtime) {
      throw new RunError(
        "Conductor needs an agent lifecycle event or an Inbox refresh to obtain its runtime connection. Retry after the source session starts.",
      );
    }
    return runtime;
  };
  const execution = runExecution(
    store,
    () => executionRuntime(requireRuntime()),
    () => paseoWorkers(requireRuntime()),
    () => access,
  );
  let reconciling = false;
  const reconcile = async () => {
    if (!runtime || reconciling) {
      return;
    }
    reconciling = true;
    try {
      await execution.reconcile();
    } catch {
      /* Preserve durable claims; retry observation on the next tick. */
    } finally {
      reconciling = false;
    }
  };
  const timer = setInterval(() => {
    void reconcile();
  }, 5000);
  timer.unref();
  let commands: Awaited<ReturnType<typeof commandServer>> = {
    access: {
      available: false,
      commandPath: null,
      socketPath: null,
      message:
        "Run storage could not initialize. Native requests remain available.",
    },
    close: () => Promise.resolve(),
  };
  const access = commands.access;
  const ready = (async () => {
    try {
      if (typeof server.before !== "function") {
        throw new RunError(
          "This host lacks the session hooks required for agent commands.",
        );
      }
      const opened = await commandServer(directory, execution.execute);
      try {
        if (opened.access.available) {
          await execution.interrupt(
            null,
            "Conductor reloaded with unreported work. The source agent must reclaim or report its existing attempt; no replacement was launched.",
          );
        }
        commands = opened;
        Object.assign(access, opened.access);
      } catch {
        await opened.close();
      }
    } catch (error) {
      if (error instanceof RunError) {
        access.message = error.message;
      }
    }
  })();
  const stopHooks = commandHooks(
    server,
    access,
    remember,
    execution.interrupt,
    ready,
  );
  server.handle(orchestrateRun, (input, { paseo }) =>
    guarded(async () => {
      remember(paseo);
      await ready;
      if (!access.available) {
        throw new RunError(access.message ?? "Agent commands are unavailable.");
      }
      const command = {
        kind: "orchestrate",
        key: input.key,
        goal: input.goal,
        title: input.goal.slice(0, 160),
        // App requests have no conversation to receive coordinator instructions.
        coordinator: "agent",
        ...(input.coordinatorProfile
          ? { coordinatorProfile: input.coordinatorProfile }
          : {}),
      };
      const result =
        "workspaceId" in input
          ? await execution.startWorkspace(input.workspaceId, command)
          : await execution.execute({ agentId: input.agentId, command });
      if (!("run" in result)) {
        throw new RunError("Orchestration did not return a run.");
      }
      return { run: result.run };
    }),
  );
  server.handle(getRunAccess, async (_input, { paseo }) => {
    remember(paseo);
    await ready;
    return access;
  });
  server.handle(listRuns, (input, { paseo }) =>
    guarded(async () => {
      remember(paseo);
      const list = await store.list();
      return {
        ...list,
        runs: list.runs.filter(
          (run) =>
            !["draft", "accepted"].includes(run.status) &&
            (!input.workspaceId ||
              run.source.workspaceId === input.workspaceId),
        ),
      };
    }),
  );
  server.handle(readRun, ({ id }, { paseo }) => {
    remember(paseo);
    return guarded(async () => {
      const data = await store.read(id);
      if (!data.run.execution) {
        throw new RunError(
          "This obsolete plan is no longer part of the Runs inbox.",
        );
      }
      return data;
    });
  });
  server.handle(deleteRun, ({ id, version }, { paseo }) =>
    guarded(async () => {
      remember(paseo);
      await store.remove(id, version);
      return { deleted: true } as const;
    }),
  );
  return async () => {
    clearInterval(timer);
    await ready;
    await commands.close();
    await execution.drain();
    stopHooks();
  };
}
