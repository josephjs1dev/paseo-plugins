import { z } from "zod";
import {
  symphonyCommandSchema,
  type SymphonyCommand,
} from "../../../shared/symphonies/commands";

const descriptions = {
  orchestrate:
    'Start a conducted symphony for authorized multi-part work and become its Conductor agent. key is a stable request key: reuse it after an uncertain result, and a repeated key returns the same symphony. goal carries the plan, constraints and acceptance criteria. concurrency is 1-4 (default 3); maxLoops is 1-5 (default 3). Set conductor "agent", optionally with conductorProfile, only when the user wants a dedicated Conductor agent. The result\'s instructions explain how to define, dispatch and finish.',
  define:
    "Conductor only. Record the symphony's task score once. Each task needs id, title and a standalone description, plus dependsOn, reads, writes and checks. Always set writes: [] is read-only, and an omitted writes covers the checkout and runs that task alone. Set review true for a read-only review task. role planning needs openDecision. Choose a worker with either profile or provider/model/thinkingOptionId, and give routing {reason, override?}.",
  loop: 'Conductor only. After a loop ends needing changes, start the next loop in the same symphony. reopen names each owning task with its findings ("<reporter task>#<id>"), an optional note, addWrites, after (loop-only prerequisites) and a worker override with routing.reason. tasks appends new tasks. deferred lists open items not reopened, with reasons. Every blocking finding and needs-changes task must be reopened or deferred. Past the loop budget, approval {loops, userAnswer} needs the user\'s own answer.',
  dispatch:
    "Conductor only. Create task agents for ready tasks; dependencies are followed automatically. retryTaskId resumes a settled blocked task or retries a settled failed attempt, at most 2 failed retries per loop. A needs-changes task uses loop instead. note and addWrites require retryTaskId. A replacement worker (profile or provider/model/thinkingOptionId) needs routing.reason. An active task agent is never replaced.",
  route:
    "Read-only routing preview. Give a role (exploration, implementation, planning or review) and optionally an explicit profile or provider/model/thinkingOptionId. Returns the selected profile, eligible alternatives ordered by size, exclusions and reasons.",
  profiles:
    "List the Conductor's worker profiles with routing classification, the provider catalog, the catalog revision and diagnostics. Takes no arguments.",
  models:
    "List available providers and model IDs for a per-task worker choice. Takes no arguments.",
  start:
    "Source-only tracking, not orchestration: record a symphony for work you do yourself. key is stable per agent; repeat identical input after a lost acknowledgement. Omitted tasks create one task named work with checkout-wide scope. Use orchestrate to delegate work to task agents.",
  list: "List the symphonies you own. Takes no arguments.",
  get: "Inspect a symphony you own or are assigned to, including saved reports. Use this to verify an uncertain acknowledgement before retrying.",
  claim:
    "Source-only workflow: claim a task in a symphony you started, before you work on it. Keep the returned attempt ID. Repeating a claim returns the unfinished attempt; retry true starts a new attempt only after an explicitly failed one.",
  report:
    "Save your assigned attempt's completed, needs-changes or failed report with actual evidence and check results. Use the symphonyId and attemptId from your assignment. Give a result for every required check. completed needs every declared check passed and no blocking findings; needs-changes needs at least one blocking finding or failed check and is resolved by the next loop, not retried; failed is for a harness problem (launch, unreachable agent, missing permissions, unavailable model) and needs a diagnosis. A review names each blocking defect in findings with its owning taskId and path:line. Reporting succeeds only when the result contains your saved report. Inspect the returned acknowledgement, then end your turn.",
  block:
    "Record a blocker on your assigned attempt when you need input or cannot proceed. This does not report successful completion. Use when you need input or cannot proceed and no report applies. The Conductor resumes you with an answer.",
  finish:
    "End a symphony you own after every task's latest attempt is completed and its agent has settled. summary states what changed, the check results, the loop count, deferred items and granted paths. When the user chose to stop with open work, unresolved [{finding|taskId, reason}] must cover every open finding and non-completed task; the symphony then ends failed.",
  widen:
    'Request extra checkout-relative write paths for your assigned attempt. Subject to scope limits and resource conflict checks; never grants OS permissions. Only for a file your own change broke, or one that blocks a required check. A refusal names the holder; then report failed with need "scope" and requestedWrites instead of editing the file.',
} as const satisfies Record<SymphonyCommand["kind"], string>;

const readOnly = new Set<SymphonyCommand["kind"]>([
  "route",
  "profiles",
  "models",
  "list",
  "get",
]);

// Plugin bundles may only include client/, server/ and shared/ modules, so
// package.json cannot be imported. Keep in sync; symphony-mcp.test.ts checks it.
const serverInfo = { name: "paseo-conductor", version: "0.1.0" };

// Reuse the command schemas: the daemon still validates refinements and ownership.
const tools = symphonyCommandSchema.options.map((schema) => {
  const kind = schema.shape.kind.value;
  const inputSchema = z.toJSONSchema(schema, { io: "input" });
  delete inputSchema.properties?.kind;
  if (inputSchema.required) {
    inputSchema.required = inputSchema.required.filter(
      (name) => name !== "kind",
    );
  }
  return {
    name: kind,
    description: descriptions[kind],
    inputSchema,
    annotations: {
      readOnlyHint: readOnly.has(kind),
      destructiveHint: false,
      idempotentHint: readOnly.has(kind) || kind === "report",
      openWorldHint: false,
    },
  };
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
        instructions: "Call these Conductor tools directly, never through a shell. Paseo binds your agent identity. A task agent uses report, block, get and widen for its assigned attempt; only a symphony's Conductor agent defines, dispatches, loops and finishes it. A report is saved only after its acknowledgement; ending a turn alone is not task completion."
      }); return;
    }
    if (!ready) { error(id, -32600, "Initialize the MCP session first."); return; }
    if (packet.method === "tools/list") { reply(id, { tools: mcpTools }); return; }
    if (packet.method !== "tools/call") { error(id, -32601, "Method not found."); return; }
    const params = packet.params;
    const tool = mcpTools.find((value) => value.name === params?.name);
    if (!tool) { error(id, -32602, "Unknown Conductor tool."); return; }
    // Tools without fields, such as list, may omit arguments.
    const fields = params.arguments ?? {};
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
