import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { z } from "zod";
import {
  bindAgent,
  mcpArgs,
  newAgentBinding,
} from "../server/entrypoints/commands/launcher";

const responseSchema = z.object({
  id: z.union([z.string(), z.number(), z.null()]),
  result: z.record(z.string(), z.unknown()).optional(),
  error: z.object({ code: z.number(), message: z.string() }).optional(),
});
export const toolResultSchema = z.object({
  content: z.array(z.object({ type: z.literal("text"), text: z.string() })),
  isError: z.boolean(),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
});

/** A line-level MCP client for the emitted server, as a provider starts it. */
export function mcpClient(args: string[]) {
  const child = spawn(process.execPath, args, {
    env: {},
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout });
  const iterator = lines[Symbol.asyncIterator]();
  let sequence = 0;
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  async function raw(message: string) {
    child.stdin.write(message);
    const next = await iterator.next();
    assert.equal(next.done, false, stderr);
    return responseSchema.parse(JSON.parse(next.value ?? "null") as unknown);
  }
  async function request(method: string, params?: unknown) {
    const id = ++sequence;
    const response = await raw(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        method,
        ...(params === undefined ? {} : { params }),
      }) + "\n",
    );
    assert.equal(response.id, id);
    return response;
  }
  async function call(name: string, args?: unknown) {
    return request("tools/call", {
      name,
      ...(args === undefined ? {} : { arguments: args }),
    });
  }
  return {
    child,
    raw,
    request,
    async initialize(version = "2025-11-25") {
      const result = await request("initialize", {
        protocolVersion: version,
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      });
      child.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized",
        }) + "\n",
      );
      return result;
    },
    call,
    /** Calls a tool and returns its parsed result, failing on protocol errors. */
    async tool(name: string, args?: unknown) {
      const response = await call(name, args);
      assert.equal(response.error, undefined, response.error?.message);
      return toolResultSchema.parse(response.result);
    },
    async close() {
      const closed = once(child, "close");
      child.stdin.end();
      await closed;
      lines.close();
      assert.equal(stderr, "");
      assert.equal(child.exitCode, 0);
    },
  };
}

/** Binds a fresh binding to `agentId`, then starts its MCP server. */
export async function boundMcpClient(
  access: { commandPath: string; socketPath: string },
  agentId: string,
) {
  return mcpClient(await boundArgs(access, agentId));
}

/** The MCP server arguments for a fresh binding written for `agentId`. */
export async function boundArgs(
  access: { commandPath: string; socketPath: string },
  agentId: string,
): Promise<string[]> {
  const binding = newAgentBinding(access.commandPath);
  assert.equal(await bindAgent(access, binding, agentId), true);
  return mcpArgs(access.commandPath, binding);
}
