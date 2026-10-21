import type { SymphonyHost } from "../symphonies/host";
import { join } from "node:path";
import { SymphonyError } from "../symphonies/errors";
import { fileSymphonyStore } from "../symphonies/store";
import { executionRuntime } from "../symphonies/identity";
import { changesRuntime } from "../symphonies/changes";
import { workerRuntime } from "../symphonies/workers";
import { symphonyExecution } from "../symphonies/execution";
import { symphonyMetrics } from "../symphonies/metrics";
import { readerFor } from "../engine/harnesses/usage";
import {
  PROFILES_FILE,
  profileStoreSource,
  type PaseoProfilesPort,
} from "../symphonies/profiles";
import { commandServer } from "./commands/server";
import { symphonyAck } from "./commands/ack";

export interface SymphonyServiceOptions {
  directory: string;
  /** Throws a SymphonyError while no daemon connection is known. */
  host: () => SymphonyHost;
  /** Throws a SymphonyError while no daemon connection is known. */
  paseoProfilesPort: () => PaseoProfilesPort;
  /** Reconciliation waits until a daemon connection is known. */
  connected: () => boolean;
  hooksAvailable: boolean;
}

/** Owns symphony storage, execution, the agent command server, and reconciliation. */
export function symphonyService({
  directory,
  host,
  paseoProfilesPort,
  connected,
  hooksAvailable,
}: SymphonyServiceOptions) {
  const store = fileSymphonyStore(directory);
  const metrics = symphonyMetrics(store, {
    now: () => Date.now(),
    async sessionOf(agentId) {
      try {
        const agent = await host().agent(agentId);
        if (!agent?.sessionId) {
          return null;
        }
        return { provider: agent.provider, id: agent.sessionId };
      } catch {
        // A disconnected or archived agent has no readable session now.
        return null;
      }
    },
    readerFor,
    setTimer(callback, delayMs) {
      const timer = setTimeout(callback, delayMs);
      timer.unref();
      return timer;
    },
    clearTimer(handle) {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    },
  });
  const profiles = profileStoreSource(
    join(directory, PROFILES_FILE),
    () => host().profiles(),
    paseoProfilesPort,
  );
  const execution = symphonyExecution(
    store,
    () => ({ ...executionRuntime(host()), ...changesRuntime() }),
    () => workerRuntime(host(), async () => (await profiles.load()).profiles),
    profiles,
    () => metrics,
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
    profiles,
    access,
    ready,
    interrupt: execution.interrupt,
    async close(): Promise<void> {
      clearInterval(timer);
      await ready;
      await commands.close();
      // Drain commands before metrics shutdown; collection writes share the
      // same queue and must not race teardown.
      await execution.drain();
      await metrics.close();
    },
  };
}
export type SymphonyService = ReturnType<typeof symphonyService>;
