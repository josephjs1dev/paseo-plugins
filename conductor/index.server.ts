import type { PluginServerContext } from "@getpaseo/plugin/server";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileStore } from "./server/agents/store";
import { turnJournal } from "./server/agents/turns";
import { registerAgentsRpc } from "./server/entrypoints/agents-rpc";
import { observeTurns } from "./server/entrypoints/agents-events";
import { registerSymphonies } from "./server/entrypoints/symphonies-rpc";
import { registerSkillsRpc } from "./server/entrypoints/skills-rpc";

export default function contribute(
  server: PluginServerContext,
): () => Promise<void> {
  const directory = join(
    process.env.PASEO_HOME ?? join(homedir(), ".paseo"),
    "plugin-data",
    "conductor",
  );
  const turns = turnJournal(join(directory, "turns"));
  const stopSymphonies = registerSymphonies(server, directory);
  const stopTurns = observeTurns(server, turns);
  registerSkillsRpc(server, homedir());
  registerAgentsRpc(server, fileStore(directory), turns);
  return async () => {
    try {
      await stopTurns();
    } finally {
      await stopSymphonies();
    }
  };
}
