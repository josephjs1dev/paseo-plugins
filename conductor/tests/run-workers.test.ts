import assert from "node:assert/strict";
import test from "node:test";
import type { PaseoApi } from "../server/runtime";
import { RunError } from "../server/run-files";
import {
  LaunchRejectedError,
  paseoWorkers,
  type WorkerLaunch,
} from "../server/run-workers";
import { agent } from "./fixtures";

type CreateInput = Parameters<
  ReturnType<PaseoApi["workspaces"]["ref"]>["agents"]["create"]
>[0];

const launchInput = {
  agentId: "worker-1",
  parentAgentId: "parent-1",
  workspaceId: "workspace-1",
  title: "Review worker",
  prompt: "Review the implementation and report findings.",
} satisfies WorkerLaunch;

function parent(overrides: Partial<ReturnType<typeof agent>> = {}) {
  return agent({
    id: launchInput.parentAgentId,
    status: "running",
    workspaceId: launchInput.workspaceId,
    model: "gpt-test",
    currentModeId: "auto-review",
    effectiveThinkingOptionId: "high",
    features: [{ type: "toggle", id: "web", label: "Web", value: true }],
    pendingPermissions: [],
    attentionReason: null,
    requiresAttention: false,
    ...overrides,
  });
}

interface SendRecord {
  agentId: string;
  prompt: string;
  options?: {
    messageId?: string;
    activeTurnBehavior?: "interrupt" | "steer";
  };
}

function fakePaseo(
  options: {
    agents?: ReturnType<typeof agent>[];
    profiles?: Array<{
      id: string;
      name: string;
      provider: string;
      model?: string;
      modeId?: string;
      thinkingOptionId?: string;
      featureValues?: Record<string, unknown>;
      notes?: string;
    }>;
    createError?: Error;
    workspaceUnavailable?: boolean;
    refreshErrors?: Map<string, Error>;
  } = {},
) {
  const agents = new Map((options.agents ?? []).map((item) => [item.id, item]));
  const created: CreateInput[] = [];
  const sent: SendRecord[] = [];
  const actualWorkers = new Set(agents.keys());
  const initialPromptsStarted = new Set<string>();
  const paseo = {
    async dispose() {},
    observeEvents() {
      throw new Error("observeEvents is not used by this fake");
    },
    terminals: {
      create() {
        throw new Error("terminals are not used by this fake");
      },
      list() {
        throw new Error("terminals are not used by this fake");
      },
      ref() {
        throw new Error("terminals are not used by this fake");
      },
    },
    projects: {
      list() {
        throw new Error("projects are not used by this fake");
      },
      subscribe() {
        throw new Error("projects are not used by this fake");
      },
    },
    agents: {
      ref(agentId: string) {
        return {
          async refresh() {
            const refreshError = options.refreshErrors?.get(agentId);
            if (refreshError) {
              throw refreshError;
            }
            const found = agents.get(agentId);
            if (found) {
              return { agent: found, project: null };
            }
            throw new Error(`Agent not found: ${agentId}`);
          },
          async send(prompt: string, sendOptions?: SendRecord["options"]) {
            sent.push({
              agentId,
              prompt,
              ...(sendOptions ? { options: sendOptions } : {}),
            });
          },
        };
      },
    },
    workspaces: {
      ref(_workspaceId: string) {
        return {
          async refresh() {
            return options.workspaceUnavailable
              ? null
              : { workspaceDirectory: "/test/repo", archivingAt: null };
          },
          agents: {
            async create(input: CreateInput) {
              if (options.createError) {
                throw options.createError;
              }
              created.push(input);
              if (!initialPromptsStarted.has(input.idempotencyKey ?? "")) {
                actualWorkers.add(input.agentId ?? "");
                initialPromptsStarted.add(input.idempotencyKey ?? "");
              }
            },
          },
        };
      },
    },
    providers: {
      async listAvailable() {
        return {
          providers: [
            { provider: "codex", available: true },
            { provider: "pi", available: true },
          ],
        };
      },
      async listModels(provider: string) {
        return {
          models: [
            { provider, id: "gpt-test" },
            { provider, id: "pi-test" },
          ],
        };
      },
    },
    config: {
      async get() {
        return {
          requestId: "request-1",
          config: { agentProfiles: options.profiles ?? [] },
        };
      },
    },
  };
  // The public PaseoApi includes unrelated host methods; this runtime fake
  // supplies the exact SDK methods used by the adapter.
  return {
    paseo: paseo as unknown as PaseoApi,
    created,
    sent,
    actualWorkers,
    initialPromptsStarted,
    setAgent(item: ReturnType<typeof agent>) {
      agents.set(item.id, item);
    },
  };
}

void test("matching existing child replays the same keyed creation transaction", async () => {
  const child = agent({
    id: launchInput.agentId,
    workspaceId: launchInput.workspaceId,
    title: launchInput.title,
    provider: "pi",
    model: "pi-test",
    currentModeId: "auto-review",
    effectiveThinkingOptionId: "low",
    features: [
      { type: "toggle", id: "extensions", label: "Extensions", value: false },
    ],
    labels: { "paseo.parent-agent-id": launchInput.parentAgentId },
  });
  const fake = fakePaseo({ agents: [child] });
  const workers = paseoWorkers(fake.paseo);

  await workers.launch(launchInput);
  await workers.launch(launchInput);

  assert.equal(fake.created.length, 2);
  assert.deepEqual(fake.created[0], {
    agentId: launchInput.agentId,
    idempotencyKey: launchInput.agentId,
    parent: launchInput.parentAgentId,
    title: launchInput.title,
    prompt: launchInput.prompt,
    config: {
      provider: "pi/pi-test",
      modeId: "auto-review",
      thinkingOptionId: "low",
      featureValues: { extensions: false },
    },
  });
  assert.deepEqual(fake.created[1], fake.created[0]);
  assert.equal(fake.actualWorkers.size, 1);
  assert.equal(fake.initialPromptsStarted.size, 1);
  assert.deepEqual(fake.sent, []);
});

void test("prepared config is stable across parent and profile changes and retries", async () => {
  const profiles = [
    {
      id: "pi-reviewer",
      name: "Pi reviewer",
      provider: "pi",
      model: "pi-test",
      featureValues: { extensions: false },
      notes: "Independent review.",
    },
  ];
  const fake = fakePaseo({
    agents: [parent({ currentModeId: "full-access" })],
    profiles,
  });
  const workers = paseoWorkers(fake.paseo);
  const intent = { ...launchInput, profile: "pi-reviewer" };
  const prepared = await workers.prepare(intent);
  const serializedConfig = JSON.stringify({
    provider: "pi/pi-test",
    featureValues: { extensions: false },
  });
  assert.equal(prepared, serializedConfig);

  const persistedIntent = { ...intent, config: prepared };
  await workers.launch(persistedIntent);
  fake.setAgent(
    agent({
      id: launchInput.agentId,
      workspaceId: launchInput.workspaceId,
      title: "Changed live title",
      provider: "pi",
      model: "pi-test",
      currentModeId: "auto",
      labels: { "paseo.parent-agent-id": launchInput.parentAgentId },
    }),
  );
  fake.setAgent(
    parent({
      provider: "codex",
      model: "changed-parent-model",
      currentModeId: "auto",
      features: [],
    }),
  );
  const changedProfile = profiles[0];
  assert.ok(changedProfile);
  changedProfile.model = "gpt-test";
  changedProfile.featureValues = { extensions: true };

  await workers.launch(persistedIntent);

  assert.equal(fake.created.length, 2);
  assert.deepEqual(fake.created[0], fake.created[1]);
  assert.equal(fake.created[1]?.title, launchInput.title);
  assert.equal(fake.created[1]?.prompt, launchInput.prompt);
  assert.deepEqual(fake.created[1]?.config, JSON.parse(prepared));
});

void test("malformed persisted launch config is definitively rejected before create", async () => {
  const fake = fakePaseo({ agents: [parent()] });

  await assert.rejects(
    paseoWorkers(fake.paseo).launch({ ...launchInput, config: "not-json" }),
    (error: unknown) =>
      error instanceof LaunchRejectedError &&
      /configuration is invalid/.test(error.message),
  );
  assert.deepEqual(fake.created, []);
});

void test("exact SDK not-found errors allow prepare and missing-parent rejection", async () => {
  const fake = fakePaseo({ agents: [parent()] });
  const prepared = await paseoWorkers(fake.paseo).prepare(launchInput);
  assert.deepEqual(JSON.parse(prepared), {
    provider: "codex/gpt-test",
    modeId: "auto-review",
    thinkingOptionId: "high",
    featureValues: { web: true },
  });

  const noParent = fakePaseo();
  await assert.rejects(
    paseoWorkers(noParent.paseo).prepare(launchInput),
    (error: unknown) =>
      error instanceof LaunchRejectedError &&
      /parent is unavailable/.test(error.message),
  );
});

void test("refresh propagates errors other than the exact SDK not-found", async () => {
  const refreshError = new Error("Daemon connection lost");
  const fake = fakePaseo({
    refreshErrors: new Map([[launchInput.agentId, refreshError]]),
  });

  await assert.rejects(
    paseoWorkers(fake.paseo).prepare(launchInput),
    (error: unknown) => error === refreshError,
  );
});

void test("an existing worker ID with another parent or workspace is LaunchRejectedError", async () => {
  for (const child of [
    agent({
      id: launchInput.agentId,
      workspaceId: "workspace-elsewhere",
      labels: { "paseo.parent-agent-id": launchInput.parentAgentId },
    }),
    agent({
      id: launchInput.agentId,
      workspaceId: launchInput.workspaceId,
      labels: { "paseo.parent-agent-id": "another-parent" },
    }),
  ]) {
    const fake = fakePaseo({ agents: [child] });
    await assert.rejects(
      paseoWorkers(fake.paseo).launch(launchInput),
      (error: unknown) =>
        error instanceof LaunchRejectedError &&
        /already belongs to another launch/.test(error.message),
    );
    assert.deepEqual(fake.created, []);
  }
});

void test("missing, archived, closed, and foreign-workspace parents cannot launch", async () => {
  const cases = [
    { name: "missing", agents: [] },
    {
      name: "archived",
      agents: [parent({ archivedAt: "2026-10-05T00:00:00.000Z" })],
    },
    { name: "closed", agents: [parent({ status: "closed" })] },
    { name: "foreign workspace", agents: [parent({ workspaceId: "other" })] },
  ];
  for (const item of cases) {
    const fake = fakePaseo({ agents: item.agents });
    await assert.rejects(
      paseoWorkers(fake.paseo).launch(launchInput),
      (error: unknown) =>
        error instanceof LaunchRejectedError &&
        /parent (is unavailable|is not in the requested workspace)/.test(
          error.message,
        ),
      item.name,
    );
    assert.deepEqual(fake.created, [], item.name);
  }
});

void test("an idle, available parent can launch with inherited settings", async () => {
  const fake = fakePaseo({ agents: [parent({ status: "idle" })] });

  await paseoWorkers(fake.paseo).launch(launchInput);

  assert.deepEqual(fake.created, [
    {
      agentId: launchInput.agentId,
      idempotencyKey: launchInput.agentId,
      parent: launchInput.parentAgentId,
      title: launchInput.title,
      prompt: launchInput.prompt,
      config: {
        provider: "codex/gpt-test",
        modeId: "auto-review",
        thinkingOptionId: "high",
        featureValues: { web: true },
      },
    },
  ]);
});

void test("named profile settings apply without carrying a provider-specific mode", async () => {
  const fake = fakePaseo({
    agents: [parent({ currentModeId: "full-access" })],
    profiles: [
      {
        id: "pi-reviewer",
        name: "Pi reviewer",
        provider: "pi",
        model: "pi-test",
        featureValues: { extensions: false },
        notes: "Use the independent reviewer profile.",
      },
    ],
  });

  await paseoWorkers(fake.paseo).launch({
    ...launchInput,
    profile: "pi-reviewer",
  });

  assert.deepEqual(fake.created, [
    {
      agentId: launchInput.agentId,
      idempotencyKey: launchInput.agentId,
      parent: launchInput.parentAgentId,
      title: launchInput.title,
      prompt: launchInput.prompt,
      config: {
        provider: "pi/pi-test",
        featureValues: { extensions: false },
      },
    },
  ]);
});

void test("a configured auto-review downgrade is allowed from full access", async () => {
  const fake = fakePaseo({
    agents: [parent({ currentModeId: "full-access" })],
    profiles: [
      {
        id: "safe-review",
        name: "Safe review",
        provider: "codex",
        model: "gpt-test",
        modeId: "auto-review",
      },
    ],
  });

  await paseoWorkers(fake.paseo).launch({
    ...launchInput,
    profile: "Safe review",
  });

  assert.deepEqual(fake.created[0], {
    agentId: launchInput.agentId,
    idempotencyKey: launchInput.agentId,
    parent: launchInput.parentAgentId,
    title: launchInput.title,
    prompt: launchInput.prompt,
    config: { provider: "codex/gpt-test", modeId: "auto-review" },
  });
});

void test("known elevated profile modes are rejected when the parent lacks them", async () => {
  for (const modeId of ["full-access", "bypassPermissions"]) {
    const fake = fakePaseo({
      agents: [parent({ currentModeId: "auto" })],
      profiles: [
        {
          id: "elevated",
          name: "Elevated",
          provider: "codex",
          model: "gpt-test",
          modeId,
        },
      ],
    });
    await assert.rejects(
      paseoWorkers(fake.paseo).launch({ ...launchInput, profile: "elevated" }),
      (error: unknown) =>
        error instanceof LaunchRejectedError &&
        /requests elevated permission mode/.test(error.message),
    );
    assert.deepEqual(fake.created, []);
  }
});

void test("unknown profiles and unavailable providers produce RunError", async () => {
  const base = {
    agents: [parent()],
    profiles: [
      {
        id: "offline",
        name: "Offline",
        provider: "uninstalled-provider",
      },
    ],
  };
  const unknownProfile = fakePaseo({ agents: base.agents });
  await assert.rejects(
    paseoWorkers(unknownProfile.paseo).launch({
      ...launchInput,
      profile: "missing",
    }),
    (error: unknown) =>
      error instanceof LaunchRejectedError &&
      error instanceof RunError &&
      /Unknown worker profile/.test(error.message),
  );

  const unavailableProvider = fakePaseo(base);
  await assert.rejects(
    paseoWorkers(unavailableProvider.paseo).launch({
      ...launchInput,
      profile: "offline",
    }),
    (error: unknown) =>
      error instanceof LaunchRejectedError &&
      error instanceof RunError &&
      /provider is unavailable/.test(error.message),
  );
});

void test("SDK create errors remain uncertain and are not launch rejections", async () => {
  const sdkError = new Error("creation response lost");
  const fake = fakePaseo({ agents: [parent()], createError: sdkError });

  await assert.rejects(
    paseoWorkers(fake.paseo).launch(launchInput),
    (error: unknown) =>
      error === sdkError && !(error instanceof LaunchRejectedError),
  );
});

void test("busy wake refuses to send or interrupt the current turn", async () => {
  const fake = fakePaseo({ agents: [parent({ status: "running" })] });

  await assert.rejects(
    paseoWorkers(fake.paseo).wake(launchInput.parentAgentId, "Continue", "n1"),
    /no queue option/,
  );
  assert.deepEqual(fake.sent, []);
});

void test("wake uses a stable send messageId for a repeated notification key", async () => {
  const idleWorker = parent({ id: "wake-worker", status: "idle" });
  const fake = fakePaseo({ agents: [idleWorker] });
  const firstRuntime = paseoWorkers(fake.paseo);
  const restartedRuntime = paseoWorkers(fake.paseo);

  await firstRuntime.wake(idleWorker.id, "Continue the task", "notification-7");
  await restartedRuntime.wake(
    idleWorker.id,
    "Continue the task",
    "notification-7",
  );

  assert.equal(fake.sent.length, 2);
  assert.equal(fake.sent[0]?.prompt, "Continue the task");
  assert.equal(
    fake.sent[0]?.options?.messageId,
    fake.sent[1]?.options?.messageId,
  );
  assert.equal(fake.sent[0]?.options?.activeTurnBehavior, "steer");
});

void test("inspect distinguishes active, permission-wait, settled, closed, and missing agents", async () => {
  const cases = [
    {
      id: "running",
      agent: agent({ id: "running", status: "running" }),
      active: true,
    },
    {
      id: "initializing",
      agent: agent({ id: "initializing", status: "initializing" }),
      active: true,
    },
    {
      id: "permission",
      agent: agent({
        id: "permission",
        status: "idle",
        attentionReason: "permission",
      }),
      active: true,
    },
    {
      id: "idle",
      agent: agent({
        id: "idle",
        status: "idle",
        pendingPermissions: [],
        attentionReason: null,
      }),
      active: false,
    },
    {
      id: "closed",
      agent: agent({
        id: "closed",
        status: "closed",
        attentionReason: "permission",
      }),
      active: false,
    },
    {
      id: "archived-running",
      agent: agent({
        id: "archived-running",
        status: "running",
        archivedAt: "2026-10-05T00:00:00.000Z",
      }),
      active: false,
    },
  ];
  const fake = fakePaseo({ agents: cases.map((item) => item.agent) });
  const workers = paseoWorkers(fake.paseo);

  for (const item of cases) {
    assert.deepEqual(await workers.inspect(item.id), {
      exists: true,
      active: item.active,
    });
  }
  assert.deepEqual(await workers.inspect("missing"), {
    exists: false,
    active: false,
  });
});

void test("profiles exposes only configured names and notes", async () => {
  const fake = fakePaseo({
    profiles: [
      {
        id: "review",
        name: "Reviewer",
        provider: "codex",
        notes: "Review only",
      },
      { id: "pi", name: "Pi", provider: "pi" },
    ],
  });

  assert.deepEqual(await paseoWorkers(fake.paseo).profiles(), [
    { name: "Reviewer", notes: "Review only" },
    { name: "Pi", notes: "" },
  ]);
});

void test("workspace launch creates the coordinator directly with the Plan profile and no parent", async () => {
  const f = fakePaseo({
    profiles: [
      {
        id: "plan",
        name: "Plan",
        provider: "codex",
        model: "gpt-test",
        modeId: "auto-review",
        thinkingOptionId: "high",
      },
    ],
  });
  const runtime = paseoWorkers(f.paseo);
  const input = { ...launchInput, parentAgentId: null };
  const config = await runtime.prepare(input);
  await runtime.launch({ ...input, config });
  assert.equal(f.created.length, 1);
  assert.equal(f.created[0]?.parent, undefined);
  assert.equal(f.created[0]?.config.provider, "codex/gpt-test");
  assert.equal(f.created[0]?.config.modeId, "auto-review");
  f.setAgent(
    agent({
      id: input.agentId,
      workspaceId: input.workspaceId,
      labels: {},
      status: "idle",
    }),
  );
  await runtime.launch({ ...input, config });
  assert.deepEqual(f.created[1], f.created[0]);
  assert.equal(f.actualWorkers.size, 1);
});

void test("workspace entry refuses missing profiles, unavailable workspaces and permission elevation", async () => {
  const input = { ...launchInput, parentAgentId: null };
  const missing = fakePaseo();
  await assert.rejects(
    paseoWorkers(missing.paseo).prepare(input),
    /Unknown worker profile: Plan/,
  );
  const unavailable = fakePaseo({ workspaceUnavailable: true });
  await assert.rejects(
    paseoWorkers(unavailable.paseo).prepare(input),
    /workspace is unavailable/,
  );
  const elevated = fakePaseo({
    profiles: [
      {
        id: "plan",
        name: "Plan",
        provider: "codex",
        model: "gpt-test",
        modeId: "full-access",
      },
    ],
  });
  await assert.rejects(
    paseoWorkers(elevated.paseo).prepare(input),
    /elevated permission/,
  );
  assert.equal(
    missing.created.length +
      unavailable.created.length +
      elevated.created.length,
    0,
  );
});
