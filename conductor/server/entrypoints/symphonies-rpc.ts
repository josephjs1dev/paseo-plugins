import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  deleteSymphony,
  getSymphonyAccess,
  listSymphonies,
  readSymphony,
} from "../../shared/symphonies/rpc";
import { SymphonyError } from "../symphonies/errors";
import { listWithProjects } from "../symphonies/projects";
import { symphonyService } from "./symphonies-service";
import { paseoSymphonyHost } from "../paseo/symphony-host";
import { paseoAgentsHost } from "../paseo/agents-host";
import { pages } from "../agents/directory";
import { paseoConnection } from "../paseo/connection";
import { commandHooks } from "./symphonies-hooks";

async function guarded<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof SymphonyError) {
      throw error;
    }
    throw new Error(
      "Conductor could not load or save this symphony. Refresh and inspect symphony storage; native requests remain available.",
    );
  }
}

export function registerSymphonies(
  server: PluginServerContext,
  directory: string,
) {
  const connection = paseoConnection();
  const service = symphonyService({
    directory,
    host: () => paseoSymphonyHost(connection.require()),
    connected: () => connection.available,
    hooksAvailable: typeof server.before === "function",
  });
  const { store, access, ready } = service;
  const stopHooks = commandHooks(
    server,
    access,
    connection.remember,
    service.interrupt,
    ready,
  );
  server.handle(getSymphonyAccess, async (_input, { paseo }) => {
    connection.remember(paseo);
    await ready;
    return access;
  });
  server.handle(listSymphonies, (input, { paseo }) =>
    guarded(async () => {
      connection.remember(paseo);
      const host = paseoAgentsHost(paseo);
      return listWithProjects(
        () => store.list(),
        async () => (await pages((cursor) => host.concerts(cursor))).entries,
        input.concertId,
      );
    }),
  );
  server.handle(readSymphony, ({ id }, { paseo }) => {
    connection.remember(paseo);
    return guarded(async () => store.read(id));
  });
  server.handle(deleteSymphony, ({ id, version }, { paseo }) =>
    guarded(async () => {
      connection.remember(paseo);
      await store.remove(id, version);
      return { deleted: true } as const;
    }),
  );
  return async () => {
    await service.close();
    stopHooks();
  };
}
