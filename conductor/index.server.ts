import type { PluginServerContext } from "@getpaseo/plugin/server";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  getInbox,
  answerRequest,
  annotate,
  getContext,
  archiveAgent,
} from "./shared/rpc";
import { archiveInactive } from "./server/archive";
import { fileStore } from "./server/store";
import { paseoRuntime } from "./server/runtime";
import { snapshot } from "./server/snapshot";
import { answer } from "./server/answer";
import { agentKey } from "./server/identity";
import { observeTurns, turnJournal } from "./server/turns";

export default function contribute(server: PluginServerContext) {
  const directory = join(
    process.env.PASEO_HOME ?? join(homedir(), ".paseo"),
    "plugin-data",
    "conductor",
  );
  const store = fileStore(directory);
  const turns = turnJournal(join(directory, "turns"));
  const stopTurns = observeTurns(server, turns);
  server.handle(archiveAgent, (input, { paseo }) =>
    archiveInactive(paseoRuntime(paseo), input),
  );
  server.handle(getInbox, async (input, { paseo }) => {
    try {
      return await snapshot(
        paseoRuntime(paseo),
        store,
        input.knownAgentIds,
        Date.now(),
        turns,
      );
    } catch {
      throw new Error(
        "Conductor could not refresh this host. Previous items remain visible; reconnect or check plugin logs.",
      );
    }
  });
  server.handle(answerRequest, async (input, { paseo }) => {
    try {
      return await answer(paseoRuntime(paseo), store, input);
    } catch {
      throw new Error(
        "The request could not be checked or saved. Open the agent to verify its current state.",
      );
    }
  });
  server.handle(annotate, async (input) => {
    try {
      if (input.kind === "snooze") {
        const previous = await store.annotation(input.key);
        await store.annotate({
          key: input.key,
          marked: previous?.marked ?? false,
          until: input.minutes ? Date.now() + input.minutes * 60_000 : null,
        });
      } else {
        const key = agentKey(input.agentId);
        const previous = await store.annotation(key);
        await store.annotate({
          key,
          marked: input.marked,
          until: previous?.until ?? null,
        });
      }
      return {};
    } catch {
      throw new Error("Conductor could not save this inbox preference.");
    }
  });
  server.handle(getContext, async ({ agentId }, { paseo }) => {
    try {
      return { messages: await paseoRuntime(paseo).context(agentId) };
    } catch {
      throw new Error(
        "Recent conversation is unavailable. Open the agent for its full context.",
      );
    }
  });
  return stopTurns;
}
