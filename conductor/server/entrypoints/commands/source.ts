import { COMMAND_REQUEST_SOURCE } from "./request-source";
import { MCP_SOURCE } from "./mcp-source";

// This dependency-free MCP server is emitted beside the socket so Git-installed
// plugins do not need a separate SDK installation in the provider's environment.
// Agents reach Conductor only through MCP; there is no shell command interface.
// The provider passes the agent's JSON binding, written at session opening.
export const SYMPHONY_COMMAND_SOURCE = String.raw`import http from "node:http";
import { readFile } from "node:fs/promises";
${COMMAND_REQUEST_SOURCE}
${MCP_SOURCE}

async function main() {
  const [mode, bindingPath] = process.argv.slice(2);
  if (process.argv.length !== 4 || mode !== "mcp") throw new Error("Conductor runs only as an MCP server started by the agent's provider.");
  let binding;
  try { binding = JSON.parse(await readFile(bindingPath, "utf8")); } catch { binding = null; }
  if (!binding || typeof binding.agentId !== "string" || !binding.agentId || typeof binding.socketPath !== "string" || !binding.socketPath) {
    throw new Error("This Conductor binding has no agent. Start a new agent session.");
  }
  await serveMcp(binding.agentId, binding.socketPath);
}
main().catch((error) => { console.error(JSON.stringify({ error: error.message })); process.exitCode = 1; });
`;
