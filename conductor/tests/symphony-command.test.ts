import assert from "node:assert/strict";
import test from "node:test";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { request } from "node:http";
import { stat } from "node:fs/promises";
import { z } from "zod";
import { commandServer } from "../server/entrypoints/commands/server";
import { symphonyExecution } from "../server/symphonies/execution";
import { contentHash, fileSymphonyStore } from "../server/symphonies/store";
import { SymphonyError } from "../server/symphonies/errors";
import { placement, planContext } from "./symphony-fixtures";
import { testDirectory } from "./fixtures";

function cli(
  file: string,
  socket: string,
  command: string,
  input: unknown,
  agentId = "agent-1",
) {
  return new Promise<{ code: number | null; output: string; error: string }>(
    (resolve, reject) => {
      const child = spawn(
        process.execPath,
        [file, command, "--agent", agentId, "--socket", socket],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      let output = "";
      let error = "";
      child.stdout.on("data", (data: Buffer) => {
        output += data.toString();
      });
      child.stderr.on("data", (data: Buffer) => {
        error += data.toString();
      });
      child.once("error", reject);
      child.once("exit", (code) => resolve({ code, output, error }));
      child.stdin.end(JSON.stringify(input));
    },
  );
}
const responseSchema = z.object({
  symphony: z.object({ id: z.string(), status: z.string() }),
  attempt: z.object({ id: z.string() }).optional(),
});

void test("standalone command supports a real start/claim/report/finish over an owner-only socket", async () => {
  const directory = await testDirectory();
  const store = fileSymphonyStore(directory);
  const runtime = {
    source: async (agentId: string) => ({ agentId, concertId: "ws-api" }),
    capture: async (source: { agentId: string | null; concertId: string }) => ({
      ...placement,
      ...source,
    }),
    validate: async () => {},
  };
  const engine = symphonyExecution(store, () => runtime);
  const server = await commandServer(directory, engine.execute);
  const { socketPath, commandPath } = server.access;
  assert.ok(socketPath && commandPath);
  try {
    assert.equal((await stat(socketPath)).mode & 0o777, 0o600);
    const started = await cli(commandPath, socketPath, "start", {
      key: "cli",
      title: "CLI fix",
      goal: "Verify the real command",
    });
    assert.equal(started.code, 0, started.error);
    const symphonyId = responseSchema.parse(
      JSON.parse(started.output) as unknown,
    ).symphony.id;
    const claimed = await cli(commandPath, socketPath, "claim", {
      symphonyId: symphonyId,
      taskId: "work",
    });
    assert.equal(claimed.code, 0, claimed.error);
    const attemptId = responseSchema.parse(
      JSON.parse(claimed.output) as unknown,
    ).attempt?.id;
    assert.ok(attemptId);
    await server.close();
    const resumed = await commandServer(directory, engine.execute);
    try {
      const result = await cli(commandPath, socketPath, "report", {
        symphonyId: symphonyId,
        attemptId,
        report: {
          outcome: "completed",
          summary: "Verified the command",
          evidence: ["CLI completed after reconnect"],
          checks: [],
        },
      });
      assert.equal(result.code, 0, result.error);
      assert.equal(
        (
          await cli(commandPath, socketPath, "finish", {
            symphonyId: symphonyId,
            summary: "All command operations passed",
          })
        ).code,
        0,
      );
      assert.equal((await store.read(symphonyId)).symphony.status, "completed");
      assert.equal((await cli(commandPath, socketPath, "help", {})).code, 0);
    } finally {
      await resumed.close();
    }
  } finally {
    await server.close();
  }
});

void test("the CLI routes widen and publishes a runnable stdin example in help", async () => {
  const directory = await testDirectory();
  const store = fileSymphonyStore(directory);
  const runtime = {
    source: async (agentId: string) => ({ agentId, concertId: "ws-api" }),
    capture: async (source: { agentId: string | null; concertId: string }) => ({
      ...placement,
      ...source,
    }),
    validate: async () => {},
  };
  const engine = symphonyExecution(store, () => runtime);
  const symphonyId = "12121212-1212-4212-8212-121212121212";
  const attemptId = "00000000-0000-4000-8000-000000000001";
  await store.create(
    {
      schemaVersion: 1,
      id: symphonyId,
      version: 0,
      title: "CLI widening",
      source: placement,
      contextHash: contentHash(JSON.stringify(planContext)),
      requestHash: "b".repeat(64),
      createdAt: 1,
      updatedAt: 1,
      status: "running",
      execution: {
        origin: "conducted",
        conducting: {
          phase: "working",
          concurrency: 2,
          requestedBy: "requester",
          conductor: "self",
          conductorLaunch: "started",
          prompt: "Split the work",
          notification: null,
        },
        attempts: [
          {
            id: attemptId,
            taskId: "writer",
            agentId: "worker-writer",
            state: "running",
            startedAt: 1,
            endedAt: null,
            message: null,
            report: null,
            reportHash: null,
            launch: {
              state: "started",
              profile: "inherit",
              generation: 0,
              prompt: "Carry out the task",
              settled: true,
            },
          },
        ],
        summary: null,
        finishedAt: null,
        interruption: null,
      },
      revisions: [
        {
          number: 1,
          parent: null,
          reason: "Accepted decomposition",
          acceptedAt: 1,
          score: {
            tasks: [
              {
                id: "writer",
                title: "Write",
                outcome: "Change the writer",
                prerequisites: [],
                inputs: ["Symphony context"],
                reads: [],
                writes: ["src/api"],
                resources: [],
                worker: { role: "implementation", profile: "default" },
                criteria: ["Report evidence"],
                checks: [],
                stopWhen: "Report",
              },
            ],
          },
        },
      ],
    },
    planContext,
  );
  const server = await commandServer(directory, engine.execute);
  const { commandPath, socketPath } = server.access;
  assert.ok(commandPath && socketPath);
  try {
    const widened = await cli(
      commandPath,
      socketPath,
      "widen",
      {
        symphonyId,
        attemptId,
        paths: ["shared/schema.ts"],
        reason: "Typecheck reads the exported schema",
      },
      "worker-writer",
    );
    assert.equal(widened.code, 0, widened.error);
    const parsed = JSON.parse(widened.output) as {
      acknowledged: boolean;
      grantedWrites: { path: string; reason: string }[];
    };
    assert.equal(parsed.acknowledged, true);
    assert.equal(parsed.grantedWrites[0]?.path, "shared/schema.ts");

    const help = await cli(commandPath, socketPath, "help", {});
    assert.equal(help.code, 0, help.error);
    const commands = (
      JSON.parse(help.output) as {
        commands: { widen?: { example?: string } };
      }
    ).commands;
    assert.match(commands.widen?.example ?? "", /widen --agent/);
  } finally {
    await server.close();
  }
});

void test("a second command server cannot steal ownership and cleanup releases the socket", async () => {
  const directory = await testDirectory();
  const first = await commandServer(directory, async () => ({ ok: true }));
  try {
    const second = await commandServer(directory, async () => ({ ok: false }));
    assert.equal(second.access.available, false);
    await second.close();
    assert.equal(first.access.available, true);
  } finally {
    await first.close();
  }
  const replacement = await commandServer(directory, async () => ({}));
  assert.equal(replacement.access.available, true);
  await replacement.close();
});

void test("CLI reports missing runtime context and refuses malformed command fields", async () => {
  const directory = await testDirectory();
  const engine = symphonyExecution(fileSymphonyStore(directory), () => {
    throw new SymphonyError("Runtime context unavailable");
  });
  const server = await commandServer(directory, engine.execute);
  const { commandPath, socketPath } = server.access;
  assert.ok(commandPath && socketPath);
  try {
    const result = await cli(commandPath, socketPath, "start", {
      key: "one",
      title: "One",
      goal: "One",
    });
    assert.equal(result.code, 1);
    assert.match(result.error, /Runtime context unavailable/);
    const invalid = await cli(commandPath, socketPath, "start", {
      kind: "finish",
    });
    assert.equal(invalid.code, 1);
    assert.match(invalid.error, /without a kind/);
    const huge = await cli(commandPath, socketPath, "start", {
      key: "x".repeat(270000),
    });
    assert.equal(huge.code, 1);
    assert.match(huge.error, /256 KiB/);
  } finally {
    await server.close();
  }
});

void test("socket rejects malformed JSON, unsupported routes, and browser origins", async () => {
  const directory = await testDirectory();
  let calls = 0;
  const server = await commandServer(directory, async () => {
    calls++;
    return {};
  });
  const socketPath = server.access.socketPath;
  assert.ok(socketPath);
  const post = (body: string, path: string, origin?: string) =>
    new Promise<number | undefined>((resolve, reject) => {
      const call = request(
        {
          socketPath,
          path,
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(origin ? { origin } : {}),
          },
        },
        (response) => {
          response.resume();
          response.on("end", () => resolve(response.statusCode));
        },
      );
      call.on("error", reject);
      call.end(body);
    });
  try {
    assert.equal(await post("{", "/command"), 400);
    assert.equal(await post("{}", "/elsewhere"), 400);
    assert.equal(
      await post("{}", "/command", "https://untrusted.invalid"),
      400,
    );
    assert.equal(calls, 0);
  } finally {
    await server.close();
  }
});

void test("session hooks preserve configuration and inject command context without launching work", async () => {
  const { commandHooks } = await import(
    "../server/entrypoints/symphonies-hooks"
  );
  const { createPaseoClient } = await import("@getpaseo/client");
  const paseo = createPaseoClient({
    url: "ws://127.0.0.1:1/ws",
    reconnect: { enabled: false },
  });
  type Context = import("@getpaseo/plugin/server").PluginHookContext;
  type Requests = import("@getpaseo/plugin/server").PluginBeforeRequests;
  type Handler<K extends keyof Requests> = (
    input: { request: Requests[K] },
    context: Context,
  ) => Requests[K] | void | Promise<Requests[K] | void>;
  let create: Handler<"agent.create"> | undefined;
  let open: Handler<"agent.session_open"> | undefined;
  let remembered = 0;
  let removed = 0;
  const commands = await commandServer(
    await testDirectory(),
    async (input) => ({ acknowledged: input }),
  );
  const registrations: Parameters<typeof commandHooks>[0] = {
    before(name, handler) {
      // The SDK associates each name and callback generically; TS cannot narrow that generic by comparing name.
      if (name === "agent.create") {
        create = handler as Handler<"agent.create">;
      }
      if (name === "agent.session_open") {
        open = handler as Handler<"agent.session_open">;
      }
      return () => {
        removed++;
      };
    },
    on() {
      return () => {
        removed++;
      };
    },
  };
  const cleanup = commandHooks(
    registrations,
    commands.access,
    () => {
      remembered++;
    },
    async () => {},
  );
  try {
    assert.ok(create && open);
    const context: Context = { paseo, signal: new AbortController().signal };
    const original: Requests["agent.create"] = {
      config: {
        provider: "codex",
        cwd: "/test/repo",
        systemPrompt: "Existing user guidance",
        modeId: "read-only",
        model: "chosen-model",
        mcpServers: { existing: { type: "stdio", command: "existing-tool" } },
      },
      env: { KEEP: "value" },
    };
    const configured = await create({ request: original }, context);
    assert.ok(configured);
    assert.match(
      configured.config.systemPrompt ?? "",
      /^Existing user guidance/,
    );
    assert.match(
      configured.config.systemPrompt ?? "",
      /Conductor agent commands/,
    );
    assert.equal(configured.config.modeId, "read-only");
    assert.equal(configured.config.model, "chosen-model");
    assert.deepEqual(
      configured.config.mcpServers?.existing,
      original.config.mcpServers?.existing,
    );
    assert.equal(configured.env?.KEEP, "value");
    assert.equal(configured.env?.CONDUCTOR_SOCKET, commands.access.socketPath);
    const launcher = configured.env?.CONDUCTOR_COMMAND;
    assert.ok(launcher);
    assert.deepEqual(configured.config.mcpServers?.conductor, {
      type: "stdio",
      command: process.execPath,
      args: [launcher, "mcp"],
      alwaysLoad: true,
    });
    assert.match(configured.config.systemPrompt ?? "", /conductor MCP server/);
    const conflicting: Requests["agent.create"] = {
      ...original,
      config: {
        ...original.config,
        mcpServers: {
          conductor: { type: "stdio", command: "user-tool" },
          conductor_2: { type: "stdio", command: "another-user-tool" },
        },
        toolPolicy: {
          preapproved: [
            { kind: "mcp", server: "conductor", tool: "user-tool" },
          ],
        },
      },
    };
    const preserved: Requests["agent.create"] | void = await create(
      { request: conflicting },
      context,
    );
    assert.deepEqual(
      preserved?.config.mcpServers?.conductor,
      conflicting.config.mcpServers?.conductor,
    );
    assert.deepEqual(
      preserved?.config.mcpServers?.conductor_2,
      conflicting.config.mcpServers?.conductor_2,
    );
    assert.equal(preserved?.config.mcpServers?.conductor_3?.type, "stdio");
    assert.deepEqual(
      preserved?.config.toolPolicy,
      conflicting.config.toolPolicy,
    );
    assert.match(
      preserved?.config.systemPrompt ?? "",
      /Use the injected conductor_3 MCP server/,
    );
    for (const provider of ["claude", "opencode", "pi", "custom-provider"]) {
      const configuredProvider: Requests["agent.create"] | void = await create(
        { request: { ...original, config: { ...original.config, provider } } },
        context,
      );
      assert.equal(
        configuredProvider?.config.mcpServers?.conductor?.type,
        "stdio",
        provider,
      );
      assert.deepEqual(
        configuredProvider?.config.mcpServers?.existing,
        original.config.mcpServers?.existing,
      );
      assert.equal(configuredProvider?.config.modeId, original.config.modeId);
    }
    assert.ok(configured.config.systemPrompt?.includes(launcher));
    assert.equal(
      configured.config.systemPrompt?.includes("$CONDUCTOR_COMMAND"),
      false,
    );
    assert.equal(
      await create({ request: configured }, context),
      undefined,
      "Guidance is not duplicated",
    );
    const request: Requests["agent.session_open"] = {
      agentId: "agent-1",
      workspaceId: null,
      provider: "codex",
      cwd: "/test/repo",
      reason: "create",
      purpose: "interactive",
      env: configured.env ?? {},
    };
    const session = await open({ request }, context);
    assert.ok(session);
    assert.equal(session.env.KEEP, "value");
    assert.equal(session.env.CONDUCTOR_AGENT_ID, "agent-1");
    assert.equal(session.env.CONDUCTOR_COMMAND, launcher);
    const result = await promisify(execFile)(
      process.execPath,
      [launcher, "list"],
      {
        env: {},
        timeout: 5000,
      },
    );
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout) as unknown, {
      acknowledged: { agentId: "agent-1", command: { kind: "list" } },
    });
    const resumed = await open(
      { request: { ...request, reason: "resume" } },
      context,
    );
    assert.equal(resumed?.env.CONDUCTOR_COMMAND, launcher);
    const mcpBefore = configured.config.mcpServers?.conductor;
    assert.equal(
      mcpBefore?.type,
      "stdio",
      "The same bound launcher serves MCP across session resumes",
    );
    await assert.rejects(async () => {
      assert.ok(open);
      return open(
        { request: { ...request, agentId: "different-agent" } },
        context,
      );
    }, /already bound/);
    const unrelated = await open(
      {
        request: {
          ...request,
          env: { CONDUCTOR_COMMAND: "/tmp/unrelated-command.mjs" },
        },
      },
      context,
    );
    assert.equal(unrelated?.env.CONDUCTOR_COMMAND, commands.access.commandPath);
    assert.equal(
      await open({ request: { ...request, purpose: "history" } }, context),
      undefined,
    );
    assert.ok(remembered >= 4);
  } finally {
    cleanup();
    await commands.close();
    await paseo.close();
  }
  assert.equal(removed, 5);
});

void test("plugin contribution registers synchronously while command startup and cleanup can await I/O", async () => {
  const { default: contribute } = await import("../index.server");
  const directory = await testDirectory();
  const previous = process.env.PASEO_HOME;
  const handles = new Set<string>();
  const server: import("@getpaseo/plugin/server").PluginServerContext = {
    handle(rpc) {
      handles.add(rpc.name);
    },
    before() {
      return () => {};
    },
    on() {
      return () => {};
    },
    registerSettings() {
      throw new Error("Unexpected settings registration");
    },
    registerProvider() {
      throw new Error("Unexpected provider registration");
    },
    registerUsageSource() {
      throw new Error("Unexpected usage registration");
    },
  };
  try {
    process.env.PASEO_HOME = directory;
    const cleanup = contribute(server);
    assert.equal(
      typeof cleanup,
      "function",
      "Paseo beta.3 rejects a Promise as the contribution result",
    );
    assert.ok(
      ["symphonies.access", "symphonies.list", "symphonies.read"].every(
        (name) => handles.has(name),
      ),
      "RPC handlers must be registered before contribute returns",
    );
    assert.equal(handles.has("symphonies.prepare"), false);
    assert.equal(handles.has("symphonies.change"), false);
    await cleanup();
  } finally {
    if (previous === undefined) {
      delete process.env.PASEO_HOME;
    } else {
      process.env.PASEO_HOME = previous;
    }
  }
});
