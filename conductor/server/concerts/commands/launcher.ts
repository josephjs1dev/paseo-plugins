import { randomUUID } from "node:crypto";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import type { ConcertCommandAccess } from "./server";
import {
  ensureConcertDirectory,
  readConcertFile,
  writeConcertFile,
} from "../files";
import { ConcertError } from "../errors";
import { missing } from "../../files";

/** Creation has no agent ID yet; session opening binds it before the first turn. */
export function newAgentCommand(commandPath: string): string {
  return join(dirname(commandPath), "agent-commands", `${randomUUID()}.mjs`);
}

export async function bindAgentCommand(
  access: ConcertCommandAccess & { commandPath: string; socketPath: string },
  proposedPath: string | undefined,
  agentId: string,
): Promise<string> {
  const directory = join(dirname(access.commandPath), "agent-commands");
  const name = proposedPath ? relative(directory, proposedPath) : "";
  // Restrict writes to launcher names inside this plugin's command directory.
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\.mjs$/.test(name)) {
    return access.commandPath;
  }
  const path = join(directory, name);
  await ensureConcertDirectory(directory);
  const source =
    `// Conductor command bound before this agent's first interactive turn.\n` +
    `process.env.CONDUCTOR_AGENT_ID = ${JSON.stringify(agentId)};\n` +
    `process.env.CONDUCTOR_SOCKET = ${JSON.stringify(access.socketPath)};\n` +
    `await import(${JSON.stringify(pathToFileURL(access.commandPath).href)});\n`;
  try {
    if ((await readConcertFile(path, 16384)) !== source) {
      throw new ConcertError(
        "This Conductor command is already bound to another session.",
      );
    }
  } catch (error) {
    if (!missing(error)) {
      throw error;
    }
    await writeConcertFile(path, source);
  }
  return path;
}
