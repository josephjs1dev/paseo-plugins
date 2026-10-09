import type { SymphonyHost } from "../symphonies/host";
import { SymphonyError } from "../symphonies/errors";
import { fileSymphonyStore } from "../symphonies/store";
import { executionRuntime } from "../symphonies/identity";
import { changesRuntime } from "../symphonies/changes";
import { workerRuntime } from "../symphonies/workers";
import { symphonyExecution } from "../symphonies/execution";
import { commandServer } from "./commands/server";
import { symphonyAck } from "./commands/ack";

export interface SymphonyServiceOptions {
  directory: string;
  /** Throws a SymphonyError while no daemon connection is known. */
  host: () => SymphonyHost;
  /** Reconciliation waits until a daemon connection is known. */
  connected: () => boolean;
  hooksAvailable: boolean;
}

/** Owns symphony storage, execution, the agent command server, and reconciliation. */
export function symphonyService({
  directory,
  host,
  connected,
  hooksAvailable,
}: SymphonyServiceOptions) {
  const store = fileSymphonyStore(directory);
  const execution = symphonyExecution(
    store,
    () => ({ ...executionRuntime(host()), ...changesRuntime() }),
    () => workerRuntime(host()),
    () => access,
  );
  let reconciling = false;
  const reconcile = async () => {
    if (!connected() || reconciling) {
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
        "Symphony storage could not initialize. Native requests remain available.",
    },
    close: () => Promise.resolve(),
  };
  const access = commands.access;
  const ready = (async () => {
    try {
      if (!hooksAvailable) {
        throw new SymphonyError(
          "This host lacks the session hooks required for agent commands.",
        );
      }
      const opened = await commandServer(directory, async (input) =>
        symphonyAck(await execution.execute(input)),
      );
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
      if (error instanceof SymphonyError) {
        access.message = error.message;
      }
    }
  })();
  return {
    store,
    access,
    ready,
    interrupt: execution.interrupt,
    async close(): Promise<void> {
      clearInterval(timer);
      await ready;
      await commands.close();
      await execution.drain();
    },
  };
}
export type SymphonyService = ReturnType<typeof symphonyService>;
