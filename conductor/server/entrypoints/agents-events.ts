import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { TurnJournal } from "../agents/turns";
import { paseoAgentsHost } from "../paseo/agents-host";

export function observeTurns(
  server: Pick<PluginServerContext, "on">,
  journal: TurnJournal,
): () => Promise<void> {
  const removers = [
    server.on("agent.turn_started", (event, { paseo }) =>
      journal.record(
        event.agent.id,
        { turnId: event.turnId, kind: "started", at: Date.now() },
        () => paseoAgentsHost(paseo).inspect(event.agent.id),
      ),
    ),
    server.on("agent.turn_ended", (event, { paseo }) =>
      journal.record(
        event.agent.id,
        { turnId: event.turnId, kind: event.outcome.kind, at: Date.now() },
        () => paseoAgentsHost(paseo).inspect(event.agent.id),
      ),
    ),
  ];
  return async () => {
    for (const remove of removers) {
      remove();
    }
    await journal.flush();
  };
}
