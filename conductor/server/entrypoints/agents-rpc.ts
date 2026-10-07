import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  annotate,
  answerRequest,
  archiveAgent,
  getAgents,
} from "../../shared/agents/rpc";
import { answer } from "../agents/answer";
import { archiveInactive } from "../agents/archive";
import { agentKey } from "../agents/identity";
import { snapshot } from "../agents/snapshot";
import type { AgentsStore } from "../agents/store";
import type { TurnJournal } from "../agents/turns";
import { paseoAgentsHost } from "../paseo/agents-host";

export function registerAgentsRpc(
  server: Pick<PluginServerContext, "handle">,
  store: AgentsStore,
  turns: TurnJournal,
): void {
  server.handle(archiveAgent, (input, { paseo }) =>
    archiveInactive(paseoAgentsHost(paseo), input),
  );
  server.handle(getAgents, async (input, { paseo }) => {
    try {
      return await snapshot(
        paseoAgentsHost(paseo),
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
      return await answer(paseoAgentsHost(paseo), store, input);
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
      throw new Error("Conductor could not save this Podium preference.");
    }
  });
}
