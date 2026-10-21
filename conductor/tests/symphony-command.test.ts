import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { request } from "node:http";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { commandServer } from "../server/entrypoints/commands/server";
import { symphonyExecution } from "../server/symphonies/execution";
import { contentHash, fileSymphonyStore } from "../server/symphonies/store";
import { SymphonyError } from "../server/symphonies/errors";
import { placement, planContext } from "./symphony-fixtures";
import { testDirectory } from "./fixtures";
import { boundMcpClient, mcpClient } from "./mcp-client";

const responseSchema = z.object({
  symphony: z.object({ id: z.string(), status: z.string() }),
  attempt: z.object({ id: z.string() }).optional(),
});

void test("MCP supports a real start/claim/report/finish over an owner-only socket", async (t) => {
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
  const agent = await boundMcpClient({ commandPath, socketPath }, "agent-1");
  t.after(() => agent.child.kill());
  try {
    assert.equal((await stat(socketPath)).mode & 0o777, 0o600);
    await agent.initialize();
    const started = await agent.tool("start", {
      key: "mcp",
      title: "MCP fix",
      goal: "Verify the real command",
    });
    assert.equal(started.isError, false, started.content[0]?.text);
    const symphonyId = responseSchema.parse(started.structuredContent).symphony
      .id;
    const claimed = await agent.tool("claim", {
      symphonyId: symphonyId,
      taskId: "work",
    });
    assert.equal(claimed.isError, false, claimed.content[0]?.text);
    const attemptId = responseSchema.parse(claimed.structuredContent).attempt
      ?.id;
    assert.ok(attemptId);
    await server.close();
    const resumed = await commandServer(directory, engine.execute);
    try {
      const result = await agent.tool("report", {
        symphonyId: symphonyId,
        attemptId,
        report: {
          outcome: "completed",
          summary: "Verified the command",
          evidence: ["MCP completed after reconnect"],
          checks: [],
        },
      });
      assert.equal(result.isError, false, result.content[0]?.text);
      const finished = await agent.tool("finish", {
        symphonyId: symphonyId,
        summary: "All command operations passed",
      });
      assert.equal(finished.isError, false, finished.content[0]?.text);
      assert.equal((await store.read(symphonyId)).symphony.status, "completed");
      const listed = await agent.tool("list");
      assert.equal(listed.isError, false, listed.content[0]?.text);
    } finally {
      await resumed.close();
    }
    await agent.close();
  } finally {
    await server.close();
  }
});

void test("MCP routes widen for the assigned task agent", async (t) => {
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
    const worker = await boundMcpClient(
      { commandPath, socketPath },
      "worker-writer",
    );
    t.after(() => worker.child.kill());
    await worker.initialize();
    const widened = await worker.tool("widen", {
      symphonyId,
      attemptId,
      paths: ["shared/schema.ts"],
      reason: "Typecheck reads the exported schema",
    });
    assert.equal(widened.isError, false, widened.content[0]?.text);
    const parsed = z
      .object({
        acknowledged: z.boolean(),
        grantedWrites: z.array(z.object({ path: z.string() })),
      })
      .parse(widened.structuredContent);
    assert.equal(parsed.acknowledged, true);
    assert.equal(parsed.grantedWrites[0]?.path, "shared/schema.ts");
    await worker.close();
  } finally {
    await server.close();
  }
});

void test("starting the command server removes legacy per-agent launchers", async () => {
  const directory = await testDirectory();
  const legacy = join(directory, "agent-commands");
  await mkdir(legacy, { recursive: true });
  await writeFile(join(legacy, "old.mjs"), "// legacy launcher\n");
  await writeFile(join(legacy, "kept.json"), "{}\n");
  const server = await commandServer(directory, async () => ({}));
  try {
    await assert.rejects(readFile(join(legacy, "old.mjs")), {
      code: "ENOENT",
    });
    assert.equal(await readFile(join(legacy, "kept.json"), "utf8"), "{}\n");
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

void test("MCP reports missing runtime context and refuses malformed command fields", async (t) => {
  const directory = await testDirectory();
  const engine = symphonyExecution(fileSymphonyStore(directory), () => {
    throw new SymphonyError("Runtime context unavailable");
  });
  const server = await commandServer(directory, engine.execute);
  const { commandPath, socketPath } = server.access;
  assert.ok(commandPath && socketPath);
  const agent = await boundMcpClient({ commandPath, socketPath }, "agent-1");
  t.after(() => agent.child.kill());
  try {
    await agent.initialize();
    const result = await agent.tool("start", {
      key: "one",
      title: "One",
      goal: "One",
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0]?.text ?? "", /Runtime context unavailable/);
    assert.equal(
      (await agent.call("start", { kind: "finish" })).error?.code,
      -32602,
    );
    const huge = await agent.tool("start", { key: "x".repeat(270000) });
    assert.equal(huge.isError, true);
    assert.match(huge.content[0]?.text ?? "", /256 KiB/);
    await agent.close();
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
  type Events = import("@getpaseo/plugin/server").PluginLifecycleEvents;
  let archived:
    | ((event: Events["agent.archived"], context: Context) => Promise<void>)
    | undefined;
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
    on(name, handler) {
      // As above, the generic handler is narrowed by its registered name.
      if (name === "agent.archived") {
        archived = handler as typeof archived;
      }
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
    assert.equal(configured.env?.CONDUCTOR_SOCKET, undefined);
    assert.equal(configured.env?.CONDUCTOR_COMMAND, undefined);
    const binding = configured.env?.CONDUCTOR_BINDING;
    const { commandPath } = commands.access;
    assert.ok(binding && commandPath);
    assert.match(binding, /agent-commands\/[0-9a-f-]{36}\.json$/);
    assert.deepEqual(configured.config.mcpServers?.conductor, {
      type: "stdio",
      command: process.execPath,
      args: [commandPath, "mcp", binding],
      env: { ELECTRON_RUN_AS_NODE: "1" },
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
      /tools on the injected conductor_3 MCP server/,
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
    for (const shell of [binding, commandPath, "node ", "help"]) {
      assert.equal(
        configured.config.systemPrompt?.includes(shell),
        false,
        `guidance must not offer a shell command: ${shell}`,
      );
    }
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
    assert.equal(await open({ request }, context), undefined);
    assert.deepEqual(JSON.parse(await readFile(binding, "utf8")) as unknown, {
      agentId: "agent-1",
      socketPath: commands.access.socketPath,
    });
    const serverArgs = configured.config.mcpServers?.conductor?.args ?? [];
    const bound = mcpClient(serverArgs);
    await bound.initialize();
    assert.deepEqual((await bound.tool("list")).structuredContent, {
      acknowledged: { agentId: "agent-1", command: { kind: "list" } },
    });
    await bound.close();
    await assert.rejects(
      promisify(execFile)(process.execPath, [commandPath, "list"], {
        env: {},
        timeout: 5000,
      }),
      /only as an MCP server/,
      "The server offers no shell command interface",
    );
    await open({ request: { ...request, reason: "resume" } }, context);
    await assert.rejects(async () => {
      assert.ok(open);
      return open(
        { request: { ...request, agentId: "different-agent" } },
        context,
      );
    }, /already belongs/);
    const unrelated = join(dirname(binding), "unrelated.json");
    await open(
      { request: { ...request, env: { CONDUCTOR_BINDING: unrelated } } },
      context,
    );
    await assert.rejects(readFile(unrelated), { code: "ENOENT" });
    assert.ok(archived);
    await archived(
      {
        agent: {
          id: "agent-1",
          workspaceId: null,
          parentAgentId: null,
          provider: "codex",
          cwd: "/test/repo",
          title: null,
        },
        archivedAt: "2026-10-21T00:00:00.000Z",
      },
      context,
    );
    await assert.rejects(readFile(binding), { code: "ENOENT" });
    await open({ request: { ...request, reason: "resume" } }, context);
    assert.ok(
      await readFile(binding, "utf8"),
      "A reopened session writes its binding again",
    );
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
