import { randomUUID } from "node:crypto";
import { readdir, unlink } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import {
  ensureSymphonyDirectory,
  readSymphonyFile,
  writeSymphonyFile,
} from "../../symphonies/files";
import { SymphonyError } from "../../symphonies/errors";
import { missing } from "../../files";

// Each agent's MCP server reads its identity from agent-commands/<uuid>.json
// beside the emitted command.mjs.
const BINDING = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\.json$/;
const BINDING_BYTES = 4096;

const directoryOf = (commandPath: string) =>
  join(dirname(commandPath), "agent-commands");

const bindingSource = (agentId: string, socketPath: string) =>
  `${JSON.stringify({ agentId, socketPath })}\n`;

/** Creation has no agent ID yet; session opening writes it before the first turn. */
export function newAgentBinding(commandPath: string): string {
  return join(directoryOf(commandPath), `${randomUUID()}.json`);
}

/** The injected MCP server's arguments for one agent binding. */
export function mcpArgs(commandPath: string, binding: string): string[] {
  return [commandPath, "mcp", binding];
}

/**
 * Writes `agentId` into the binding proposed at creation. Returns false when
 * the path is not a binding in this plugin's directory, so an unrelated agent
 * gets nothing. Refuses to rebind a file to another agent.
 */
export async function bindAgent(
  access: { commandPath: string; socketPath: string },
  proposedPath: string | undefined,
  agentId: string,
): Promise<boolean> {
  const directory = directoryOf(access.commandPath);
  const name = proposedPath ? relative(directory, proposedPath) : "";
  // Restrict writes to binding names inside this plugin's directory.
  if (!BINDING.test(name)) {
    return false;
  }
  const path = join(directory, name);
  await ensureSymphonyDirectory(directory);
  const source = bindingSource(agentId, access.socketPath);
  try {
    if ((await readSymphonyFile(path, BINDING_BYTES)) !== source) {
      throw new SymphonyError(
        "This Conductor binding already belongs to another session.",
      );
    }
  } catch (error) {
    if (!missing(error)) {
      throw error;
    }
    await writeSymphonyFile(path, source);
  }
  return true;
}

async function entries(directory: string): Promise<string[]> {
  try {
    return await readdir(directory);
  } catch (error) {
    if (missing(error)) {
      return [];
    }
    throw error;
  }
}

async function remove(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!missing(error)) {
      throw error;
    }
  }
}

/** Deletes the bindings of an archived agent; a reopened session rebinds. */
export async function unbindAgent(
  commandPath: string,
  agentId: string,
): Promise<void> {
  const directory = directoryOf(commandPath);
  for (const name of await entries(directory)) {
    if (!BINDING.test(name)) {
      continue;
    }
    const path = join(directory, name);
    let bound: unknown;
    try {
      bound = JSON.parse(await readSymphonyFile(path, BINDING_BYTES));
    } catch {
      continue;
    }
    if (
      bound !== null &&
      typeof bound === "object" &&
      "agentId" in bound &&
      bound.agentId === agentId
    ) {
      await remove(path);
    }
  }
}

/** Deletes the executable launchers that earlier versions wrote per agent. */
export async function removeLegacyLaunchers(commandPath: string) {
  const directory = directoryOf(commandPath);
  for (const name of await entries(directory)) {
    if (name.endsWith(".mjs")) {
      await remove(join(directory, name));
    }
  }
}
