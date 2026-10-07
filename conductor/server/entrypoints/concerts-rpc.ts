import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  deleteConcert,
  getConcertAccess,
  listConcerts,
  readConcert,
} from "../../shared/concerts/rpc";
import { ConcertError } from "../concerts/errors";
import { concertService } from "../concerts/service";
import { paseoConcertHost } from "../paseo/concerts-host";
import { paseoConnection } from "../paseo/connection";
import { commandHooks } from "./concerts-hooks";

async function guarded<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof ConcertError) {
      throw error;
    }
    throw new Error(
      "Conductor could not load or save this concert. Refresh and inspect concert storage; native requests remain available.",
    );
  }
}

export function registerConcerts(
  server: PluginServerContext,
  directory: string,
) {
  const connection = paseoConnection();
  const service = concertService({
    directory,
    host: () => paseoConcertHost(connection.require()),
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
  server.handle(getConcertAccess, async (_input, { paseo }) => {
    connection.remember(paseo);
    await ready;
    return access;
  });
  server.handle(listConcerts, (input, { paseo }) =>
    guarded(async () => {
      connection.remember(paseo);
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
  server.handle(readConcert, ({ id }, { paseo }) => {
    connection.remember(paseo);
    return guarded(async () => {
      const data = await store.read(id);
      if (!data.run.execution) {
        throw new ConcertError(
          "This obsolete plan is no longer part of the Podium's Concerts.",
        );
      }
      return data;
    });
  });
  server.handle(deleteConcert, ({ id, version }, { paseo }) =>
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
