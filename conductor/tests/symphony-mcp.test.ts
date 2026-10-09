import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { COMMAND_LIMITS } from "../server/entrypoints/commands/limits";
import { agentCommandRequestSchema } from "../shared/symphonies/commands";
import { commandServer } from "../server/entrypoints/commands/server";
import {
  bindAgentCommand,
  newAgentCommand,
} from "../server/entrypoints/commands/launcher";
import { symphonyAck } from "../server/entrypoints/commands/ack";
import { symphonyExecution } from "../server/symphonies/execution";
import { contentHash, fileSymphonyStore } from "../server/symphonies/store";
import { testDirectory } from "./fixtures";
import {
  fixtureAttempt,
  fixtureLaunch,
  planContext,
  storedSymphony,
  task,
} from "./symphony-fixtures";
import type { TaskReport } from "../shared/symphonies/models";

const responseSchema = z.object({
  id: z.union([z.string(), z.number(), z.null()]),
  result: z.record(z.string(), z.unknown()).optional(),
  error: z.object({ code: z.number(), message: z.string() }).optional(),
});
const toolResultSchema = z.object({
  content: z.array(z.object({ type: z.literal("text"), text: z.string() })),
  isError: z.boolean(),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
});

async function client(
  access: { commandPath: string; socketPath: string },
  agentId: string,
) {
  const launcher = await bindAgentCommand(
    { ...access, available: true, message: null },
    newAgentCommand(access.commandPath),
    agentId,
  );
  const child = spawn(process.execPath, [launcher, "mcp"], {
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
    async call(name: string, args: unknown) {
      return request("tools/call", { name, arguments: args });
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

void test(
  "host-launched MCP saves and verifies reports with bound identity and existing validation",
  { timeout: 15000 },
  async (t) => {
    const directory = await testDirectory();
    const store = fileSymphonyStore(directory);
    const symphony = storedSymphony();
    const attemptId = "00000000-0000-4000-8000-000000000001";
    symphony.contextHash = contentHash(JSON.stringify(planContext));
    symphony.status = "running";
    symphony.execution.origin = "conducted";
    symphony.execution.conducting = {
      phase: "working",
      concurrency: 1,
      requestedBy: "agent-1",
      conductor: "self",
      conductorLaunch: "started",
      prompt: "Report the assigned task",
      notification: null,
    };
    symphony.execution.attempts = [
      fixtureAttempt("api", "running", attemptId, {
        launch: fixtureLaunch(false),
      }),
    ];
    const revision = symphony.revisions[0];
    assert.ok(revision);
    revision.score.tasks = [task("api", { checks: ["verify"] })];
    await store.create(symphony, planContext);
    const engine = symphonyExecution(store, () => ({
      source: async (agentId) => ({
        agentId,
        concertId: symphony.source.concertId,
      }),
      capture: async () => symphony.source,
      validate: async () => {},
    }));
    const server = await commandServer(directory, async (input) =>
      symphonyAck(await engine.execute(input)),
    );
    t.after(() => server.close());
    const { commandPath, socketPath } = server.access;
    assert.ok(commandPath && socketPath);
    const worker = await client({ commandPath, socketPath }, "worker-api");
    t.after(() => worker.child.kill());
    await worker.initialize();
    const report: {
      symphonyId: string;
      attemptId: string;
      report: TaskReport;
    } = {
      symphonyId: symphony.id,
      attemptId,
      report: {
        outcome: "completed",
        summary: "Observed the result",
        evidence: ["Verified behavior"],
        checks: [],
      },
    };
    const invalid = toolResultSchema.parse(
      (await worker.call("report", report)).result,
    );
    assert.equal(
      invalid.isError,
      true,
      "A completed report must pass every declared check",
    );
    assert.equal(
      (await store.read(symphony.id)).symphony.execution.attempts[0]?.report,
      null,
    );
    report.report.checks = [
      {
        name: "verify",
        status: "passed",
        detail: "Observed the expected result",
      },
    ];
    const saved = toolResultSchema.parse(
      (await worker.call("report", report)).result,
    );
    assert.equal(saved.isError, false);
    assert.equal(saved.structuredContent?.symphonyId, symphony.id);
    const version = (await store.read(symphony.id)).symphony.version;
    assert.equal(
      toolResultSchema.parse((await worker.call("report", report)).result)
        .isError,
      false,
    );
    assert.equal(
      (await store.read(symphony.id)).symphony.version,
      version,
      "Identical reports remain idempotent",
    );
    const verified = toolResultSchema.parse(
      (await worker.call("get", { symphonyId: symphony.id })).result,
    );
    assert.equal(verified.isError, false);
    const attempt = (await store.read(symphony.id)).symphony.execution
      .attempts[0];
    assert.equal(attempt?.state, "completed");
    assert.equal(
      attempt?.launch?.settled,
      false,
      "A report alone must not release the worker's resources",
    );
    const conflicting = {
      ...report,
      report: { ...report.report, summary: "Different result" },
    };
    assert.equal(
      toolResultSchema.parse((await worker.call("report", conflicting)).result)
        .isError,
      true,
    );
    assert.equal(
      (await worker.call("report", { ...report, agentId: "agent-1" })).error
        ?.code,
      -32602,
    );
    await worker.close();
    const other = await client({ commandPath, socketPath }, "unassigned-agent");
    t.after(() => other.child.kill());
    await other.initialize();
    assert.equal(
      toolResultSchema.parse((await other.call("report", report)).result)
        .isError,
      true,
    );
    assert.equal(
      toolResultSchema.parse(
        (await other.call("get", { symphonyId: symphony.id })).result,
      ).isError,
      true,
    );
    await other.close();
  },
);

void test(
  "MCP overload does not respond to notifications and uses a server error code",
  { timeout: 10000 },
  async (t) => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const server = await commandServer(await testDirectory(), async () => {
      await gate;
      return { acknowledged: true };
    });
    t.after(async () => {
      release?.();
      await server.close();
    });
    const { commandPath, socketPath } = server.access;
    assert.ok(commandPath && socketPath);
    const worker = await client({ commandPath, socketPath }, "worker-1");
    t.after(() => worker.child.kill());
    await worker.request("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "batched-test", version: "1" },
    });
    const requests = Array.from({ length: 16 }, (_, index) => ({
      jsonrpc: "2.0",
      id: index + 100,
      method: "tools/call",
      params: { name: "get", arguments: { symphonyId: "id" } },
    }));
    const packet =
      [
        { jsonrpc: "2.0", method: "notifications/initialized" },
        ...requests,
        { jsonrpc: "2.0", method: "notifications/example" },
        {
          jsonrpc: "2.0",
          id: 116,
          method: "tools/call",
          params: { name: "get", arguments: { symphonyId: "id" } },
        },
      ]
        .map((value) => JSON.stringify(value))
        .join("\n") + "\n";
    const overload = await worker.raw(packet);
    assert.equal(
      overload.id,
      116,
      "The notification must not produce an id:null reply",
    );
    assert.equal(overload.error?.code, -32000);
    assert.equal(
      (await worker.request("ping")).error,
      undefined,
      "Pings remain available while all backend slots are occupied",
    );
    release?.();
    const received = new Set<number>();
    for (let index = 0; index < requests.length; index++) {
      const response = await worker.raw("");
      assert.equal(typeof response.id, "number");
      received.add(Number(response.id));
      assert.equal(toolResultSchema.parse(response.result).isError, false);
    }
    assert.deepEqual(
      [...received].sort((a, b) => a - b),
      requests.map((request) => request.id),
    );
    assert.equal((await worker.request("ping")).error, undefined);
    await worker.close();
  },
);

void test(
  "oversized MCP frames are discarded without disabling later tools",
  { timeout: 10000 },
  async (t) => {
    const received: unknown[] = [];
    const server = await commandServer(await testDirectory(), async (input) => {
      received.push(input);
      return { acknowledged: input };
    });
    t.after(() => server.close());
    const { commandPath, socketPath } = server.access;
    assert.ok(commandPath && socketPath);
    const worker = await client({ commandPath, socketPath }, "worker-1");
    t.after(() => worker.child.kill());
    await worker.initialize();
    const oversized =
      JSON.stringify({
        jsonrpc: "2.0",
        id: 100,
        method: "tools/call",
        params: {
          name: "report",
          arguments: { report: "x".repeat(COMMAND_LIMITS.mcpMessageBytes) },
        },
      }) + "\n";
    const rejected = await worker.raw(oversized);
    assert.equal(
      rejected.id,
      null,
      "Discarding a frame loses its request ID; the client handles that request's timeout",
    );
    assert.equal(rejected.error?.code, -32600);
    assert.equal(received.length, 0);
    assert.equal((await worker.request("ping")).error, undefined);
    const interrupted = await worker.raw(
      "x".repeat(COMMAND_LIMITS.mcpMessageBytes + 1),
    );
    assert.equal(interrupted.id, null);
    assert.equal(interrupted.error?.code, -32600);
    const resynchronized = await worker.raw(
      'discarded remainder\n{"jsonrpc":"2.0","id":101,"method":"ping"}\n',
    );
    assert.equal(resynchronized.id, 101);
    assert.deepEqual(resynchronized.result, {});
    assert.equal(
      toolResultSchema.parse(
        (await worker.call("get", { symphonyId: "id" })).result,
      ).isError,
      false,
    );
    assert.equal(
      toolResultSchema.parse(
        (
          await worker.call("report", {
            symphonyId: "id",
            attemptId: "attempt",
            report: {
              outcome: "completed",
              summary: "Recovered",
              evidence: ["Tools remained available"],
              checks: [],
            },
          })
        ).result,
      ).isError,
      false,
    );
    assert.equal(received.length, 2);
    await worker.close();
  },
);

void test(
  "MCP stops accepting new work while its client is not reading replies",
  { timeout: 10000 },
  async (t) => {
    let calls = 0;
    const server = await commandServer(await testDirectory(), async () => {
      calls++;
      return { payload: "x".repeat(1_000_000) };
    });
    t.after(() => server.close());
    const { commandPath, socketPath } = server.access;
    assert.ok(commandPath && socketPath);
    const worker = await client({ commandPath, socketPath }, "worker-1");
    t.after(() => worker.child.kill());
    await worker.initialize();
    const packet = (id: number) =>
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name: "get", arguments: { symphonyId: "id" } },
      }) + "\n";
    worker.child.stdout.pause();
    worker.child.stdin.write(packet(100));
    const deadline = Date.now() + 3000;
    while (
      (calls === 0 || worker.child.stdout.readableLength === 0) &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    assert.equal(calls, 1);
    assert.ok(
      worker.child.stdout.readableLength > 0,
      "The first reply is waiting in the client's unread pipe",
    );
    worker.child.stdin.write(packet(101));
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(
      calls,
      1,
      "Queued output must prevent another command from reaching the backend",
    );
    worker.child.stdout.resume();
    assert.equal((await worker.raw("")).id, 100);
    assert.equal((await worker.raw("")).id, 101);
    assert.equal(calls, 2);
    await worker.close();
  },
);

void test(
  "official MCP SDK interoperates with the emitted agent-bound server",
  { timeout: 10000 },
  async (t) => {
    const server = await commandServer(await testDirectory(), async (input) => {
      const request = agentCommandRequestSchema.parse(input);
      assert.equal(request.agentId, "sdk-worker");
      assert.equal(request.command.kind, "report");
      return { accepted: request.command };
    });
    t.after(() => server.close());
    const { commandPath, socketPath } = server.access;
    assert.ok(commandPath && socketPath);
    const launcher = await bindAgentCommand(
      { ...server.access, commandPath, socketPath },
      newAgentCommand(commandPath),
      "sdk-worker",
    );
    const sdk = new Client({ name: "conductor-interop-test", version: "1" });
    t.after(() => sdk.close());
    await sdk.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [launcher, "mcp"],
        env: {},
      }),
    );
    assert.deepEqual(
      (await sdk.listTools()).tools.map((tool) => tool.name).sort(),
      ["block", "get", "report", "widen"],
    );
    const args = {
      symphonyId: "f1151538-5302-4fbf-b50b-f6a55f2a5940",
      attemptId: "00000000-0000-4000-8000-000000000001",
      report: {
        outcome: "completed",
        summary: "SDK acknowledgement verified",
        evidence: ["Official SDK called report"],
        checks: [],
      },
    };
    const result = toolResultSchema.parse(
      await sdk.callTool({ name: "report", arguments: args }),
    );
    assert.equal(result.isError, false);
    assert.deepEqual(result.structuredContent, {
      accepted: { kind: "report", ...args },
    });
    assert.deepEqual(
      JSON.parse(result.content[0]?.text ?? "null") as unknown,
      result.structuredContent,
    );
  },
);

void test(
  "MCP negotiates versions, advertises only worker tools, and rejects protocol overrides",
  { timeout: 10000 },
  async (t) => {
    const requests: unknown[] = [];
    const server = await commandServer(await testDirectory(), async (input) => {
      requests.push(input);
      return { acknowledged: true };
    });
    t.after(() => server.close());
    const { commandPath, socketPath } = server.access;
    assert.ok(commandPath && socketPath);
    const worker = await client({ commandPath, socketPath }, "worker-1");
    t.after(() => worker.child.kill());
    assert.equal((await worker.request("tools/list")).error?.code, -32600);
    assert.equal((await worker.request("ping")).error, undefined);
    const initialized = await worker.initialize("2024-11-05");
    assert.equal(initialized.result?.protocolVersion, "2024-11-05");
    const { name, version } = z
      .object({ name: z.string(), version: z.string() })
      .parse(
        JSON.parse(
          await readFile(
            join(import.meta.dirname, "..", "package.json"),
            "utf8",
          ),
        ),
      );
    assert.deepEqual(initialized.result?.serverInfo, { name, version });
    assert.equal((await worker.raw("{\n")).error?.code, -32700);
    assert.equal((await worker.raw("null\n")).error?.code, -32600);
    assert.equal((await worker.request("unknown-method")).error?.code, -32601);
    const tools = z
      .object({
        tools: z.array(
          z.object({
            name: z.string(),
            description: z.string(),
            inputSchema: z.record(z.string(), z.unknown()),
          }),
        ),
      })
      .parse((await worker.request("tools/list")).result).tools;
    assert.deepEqual(tools.map((tool) => tool.name).sort(), [
      "block",
      "get",
      "report",
      "widen",
    ]);
    for (const tool of tools) {
      assert.equal(tool.inputSchema.additionalProperties, false);
      assert.equal(
        JSON.stringify(tool.inputSchema).includes('"agentId"'),
        false,
      );
    }
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    assert.match(
      byName.get("report")?.description ?? "",
      /A failed report needs a diagnosis; need "scope" needs requestedWrites/,
    );
    assert.match(
      byName.get("report")?.description ?? "",
      /A completed report has no diagnosis/,
    );
    assert.match(
      byName.get("widen")?.description ?? "",
      /Only for a file your own change broke/,
    );
    assert.match(
      byName.get("block")?.description ?? "",
      /The Conductor resumes you with an answer/,
    );
    assert.equal((await worker.call("finish", {})).error?.code, -32602);
    assert.equal(
      (await worker.call("get", { symphonyId: "id", kind: "finish" })).error
        ?.code,
      -32602,
    );
    assert.equal(
      (
        await worker.call("get", {
          symphonyId: "id",
          socketPath: "/tmp/other.sock",
        })
      ).error?.code,
      -32602,
    );
    assert.equal(requests.length, 0);
    for (const name of ["block", "widen"]) {
      const result = toolResultSchema.parse(
        (await worker.call(name, { symphonyId: "id", attemptId: "attempt" }))
          .result,
      );
      assert.equal(result.isError, false);
    }
    assert.deepEqual(requests, [
      {
        agentId: "worker-1",
        command: { kind: "block", symphonyId: "id", attemptId: "attempt" },
      },
      {
        agentId: "worker-1",
        command: { kind: "widen", symphonyId: "id", attemptId: "attempt" },
      },
    ]);
    await server.close();
    assert.equal(
      toolResultSchema.parse(
        (await worker.call("get", { symphonyId: "id" })).result,
      ).isError,
      true,
      "An unavailable plugin cannot return a successful acknowledgement",
    );
    await worker.close();
    const unsupportedVersion = await client(
      { commandPath, socketPath },
      "worker-1",
    );
    t.after(() => unsupportedVersion.child.kill());
    assert.equal(
      (await unsupportedVersion.initialize("2099-01-01")).result
        ?.protocolVersion,
      "2025-11-25",
    );
    await unsupportedVersion.close();
  },
);
