import type { ConcertHost } from "./host";
import { RunError } from "./errors";
import { fileRunStore } from "./store";
import { executionRuntime } from "./identity";
import { workerRuntime } from "./workers";
import { runExecution } from "./execution";
import { commandServer } from "./commands/server";
import { concertAck } from "./commands/ack";

export interface ConcertServiceOptions {
  directory: string;
  /** Throws a RunError while no daemon connection is known. */
  host: () => ConcertHost;
  /** Reconciliation waits until a daemon connection is known. */
  connected: () => boolean;
  hooksAvailable: boolean;
}

/** Owns concert storage, execution, the agent command server, and reconciliation. */
export function concertService({
  directory,
  host,
  connected,
  hooksAvailable,
}: ConcertServiceOptions) {
  const store = fileRunStore(directory);
  const execution = runExecution(
    store,
    () => executionRuntime(host()),
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
        "Run storage could not initialize. Native requests remain available.",
    },
    close: () => Promise.resolve(),
  };
  const access = commands.access;
  const ready = (async () => {
    try {
      if (!hooksAvailable) {
        throw new RunError(
          "This host lacks the session hooks required for agent commands.",
        );
      }
      const opened = await commandServer(directory, async (input) =>
        concertAck(await execution.execute(input)),
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
      if (error instanceof RunError) {
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
export type ConcertService = ReturnType<typeof concertService>;
