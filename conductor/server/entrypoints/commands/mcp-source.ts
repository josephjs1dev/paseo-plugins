import { z } from "zod";
import { symphonyCommandSchema } from "../../../shared/symphonies/commands";

const descriptions = {
  report:
    "Save your assigned attempt's completed or failed report with actual evidence and check results. Inspect the returned acknowledgement, then end your turn.",
  block:
    "Record a blocker on your assigned attempt when you need input or cannot proceed. This does not report successful completion.",
  get: "Inspect a symphony you own or are assigned to, including saved reports. Use this to verify an uncertain acknowledgement before retrying.",
  widen:
    "Request extra checkout-relative write paths for your assigned attempt. Subject to scope limits and resource conflict checks; never grants OS permissions.",
} as const;

// Plugin bundles may only include client/, server/ and shared/ modules, so
// package.json cannot be imported. Keep in sync; symphony-mcp.test.ts checks it.
const serverInfo = { name: "paseo-conductor", version: "0.1.0" };

// Reuse the command schemas: the daemon still validates refinements and ownership.
const tools = symphonyCommandSchema.options.flatMap((schema) => {
  const kind = schema.shape.kind.value;
  if (!(kind in descriptions)) {
    return [];
  }
  const verb = kind as keyof typeof descriptions;
  const inputSchema = z.toJSONSchema(schema, { io: "input" });
  delete inputSchema.properties?.kind;
  if (inputSchema.required) {
    inputSchema.required = inputSchema.required.filter(
      (name) => name !== "kind",
    );
  }
  return [
    {
      name: verb,
      description: descriptions[verb],
      inputSchema,
      annotations: {
        readOnlyHint: verb === "get",
        destructiveHint: false,
        idempotentHint: verb === "get" || verb === "report",
        openWorldHint: false,
      },
    },
  ];
});

/** A tools-only stdio endpoint, emitted without runtime npm dependencies. */
export const MCP_SOURCE =
  `const mcpTools = ${JSON.stringify(tools)};\nconst mcpServerInfo = ${JSON.stringify(serverInfo)};\n` +
  String.raw`
async function serveMcp(agentId, socketPath) {
  const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
  const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
  const error = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });
  const versions = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
  let initialized = false;
  let ready = false;
  const active = new Set();
  const handle = async (packet) => {
    if (!packet || Array.isArray(packet) || packet.jsonrpc !== "2.0" || typeof packet.method !== "string" ||
        ("id" in packet && typeof packet.id !== "string" && !(typeof packet.id === "number" && Number.isInteger(packet.id)))) {
      error(null, -32600, "Invalid request."); return;
    }
    if (!("id" in packet)) {
      if (packet.method === "notifications/initialized" && initialized) ready = true;
      return;
    }
    const id = packet.id;
    if (packet.method === "ping") { reply(id, {}); return; }
    if (packet.method === "initialize") {
      if (initialized || !packet.params || typeof packet.params.protocolVersion !== "string") {
        error(id, -32602, "Invalid initialization."); return;
      }
      initialized = true;
      reply(id, {
        protocolVersion: versions.includes(packet.params.protocolVersion) ? packet.params.protocolVersion : versions[0],
        capabilities: { tools: {} },
        serverInfo: mcpServerInfo,
        instructions: "Use report, block, get and widen directly as MCP tools, not through shell execution. Your agent identity is bound by Paseo. A report is saved only after its JSON acknowledgement; ending a turn alone is not task completion."
      }); return;
    }
    if (!ready) { error(id, -32600, "Initialize the MCP session first."); return; }
    if (packet.method === "tools/list") { reply(id, { tools: mcpTools }); return; }
    if (packet.method !== "tools/call") { error(id, -32601, "Method not found."); return; }
    const params = packet.params;
    const tool = mcpTools.find((value) => value.name === params?.name);
    if (!tool) { error(id, -32602, "Unknown Conductor tool."); return; }
    const fields = params.arguments;
    if (!fields || Array.isArray(fields) || typeof fields !== "object" || "kind" in fields || "agentId" in fields || "socketPath" in fields) {
      error(id, -32602, "Supply tool arguments without identity, command kind or socket overrides."); return;
    }
    try {
      const result = await requestCommand(agentId, socketPath, { kind: tool.name, ...fields });
      reply(id, { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result, isError: false });
    } catch (failure) {
      reply(id, { content: [{ type: "text", text: failure.message }], isError: true });
    }
  };
  let buffer = Buffer.alloc(0);
  let discarding = false;
  const waitForOutput = () => {
    if (process.stdout.destroyed || process.stdout.writableEnded) return Promise.reject(new Error("MCP client disconnected."));
    if (!process.stdout.writableNeedDrain) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        process.stdout.off("drain", drained);
        process.stdout.off("close", disconnected);
        process.stdout.off("error", disconnected);
      };
      const drained = () => { cleanup(); resolve(); };
      const disconnected = () => { cleanup(); reject(new Error("MCP client disconnected.")); };
      process.stdout.once("drain", drained);
      process.stdout.once("close", disconnected);
      process.stdout.once("error", disconnected);
    });
  };
  const consume = (line) => {
    let packet;
    try { packet = JSON.parse(line); }
    catch { error(null, -32700, "Invalid JSON."); return; }
    // Notifications must never receive responses, including on overload.
    const hasId = packet !== null && typeof packet === "object" && !Array.isArray(packet) && "id" in packet;
    // Initialization, notifications and pings do not occupy backend call slots.
    const isToolCall = hasId && packet.method === "tools/call";
    if (isToolCall && active.size >= commandLimits.inFlight) {
      if (hasId) error(packet.id, -32000, "Too many pending Conductor requests.");
      return;
    }
    const pending = handle(packet).catch(() => {
      if (hasId) error(packet.id, -32603, "Conductor MCP request failed.");
    });
    if (isToolCall) {
      active.add(pending);
      void pending.finally(() => active.delete(pending));
    }
  };
  for await (const chunk of process.stdin) {
    // Retain at most one input chunk while queued output drains.
    await waitForOutput();
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const end = newline === -1 ? chunk.length : newline;
      const part = chunk.subarray(offset, end);
      if (!discarding) {
        if (buffer.length + part.length > commandLimits.mcpMessageBytes) {
          buffer = Buffer.alloc(0);
          discarding = true;
          // The discarded frame's ID cannot be recovered safely.
          error(null, -32600, "MCP message exceeds its size limit.");
        } else {
          buffer = Buffer.concat([buffer, part]);
        }
      }
      if (newline === -1) break;
      if (!discarding) {
        const line = buffer.toString("utf8");
        if (line.trim()) consume(line);
      }
      buffer = Buffer.alloc(0);
      discarding = false;
      offset = newline + 1;
    }
  }
  if (buffer.length) error(null, -32700, "MCP messages must end with a newline.");
  await Promise.allSettled(active);
  await waitForOutput();
}
`;
