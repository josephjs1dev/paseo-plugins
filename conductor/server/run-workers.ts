import { createHash } from "node:crypto";
import { z } from "zod";
import type { PaseoApi } from "./runtime";
import { RunError } from "./run-files";

export class LaunchRejectedError extends RunError {}

export interface WorkerLaunch {
  agentId: string;
  parentAgentId: string | null;
  workspaceId: string;
  title: string;
  prompt: string;
  profile?: string;
  config?: string;
}

export interface WorkerRuntime {
  prepare(input: WorkerLaunch): Promise<string>;
  launch(input: WorkerLaunch): Promise<void>;
  inspect(agentId: string): Promise<{ exists: boolean; active: boolean }>;
  wake(agentId: string, prompt: string, key?: string): Promise<void>;
  profiles(): Promise<Array<{ name: string; notes: string }>>;
}

type Agent = NonNullable<
  Awaited<ReturnType<ReturnType<PaseoApi["agents"]["ref"]>["refresh"]>>
>["agent"];
type LaunchConfig = Parameters<
  ReturnType<PaseoApi["workspaces"]["ref"]>["agents"]["create"]
>[0]["config"];
const launchConfigSchema = z
  .object({
    provider: z.string().min(1),
    modeId: z.string().optional(),
    thinkingOptionId: z.string().optional(),
    featureValues: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

function parseLaunchConfig(serialized: string): LaunchConfig {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new LaunchRejectedError("Prepared worker configuration is invalid.");
  }
  const parsed = launchConfigSchema.safeParse(value);
  if (!parsed.success) {
    throw new LaunchRejectedError("Prepared worker configuration is invalid.");
  }
  const { provider, modeId, thinkingOptionId, featureValues } = parsed.data;
  const config: LaunchConfig = {
    provider,
    ...(modeId !== undefined ? { modeId } : {}),
    ...(thinkingOptionId !== undefined ? { thinkingOptionId } : {}),
    ...(featureValues !== undefined ? { featureValues } : {}),
  };
  return config;
}

function isActive(agent: Agent): boolean {
  if (agent.archivedAt || agent.status === "closed") {
    return false;
  }
  return (
    agent.status === "running" ||
    agent.status === "initializing" ||
    (agent.pendingPermissions?.length ?? 0) > 0 ||
    agent.attentionReason === "permission"
  );
}

function isAvailableParent(agent: Agent): boolean {
  return !agent.archivedAt && agent.status !== "closed";
}

function normalizedMode(modeId: string): string {
  return modeId.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
}

function isKnownElevatedMode(modeId: string): boolean {
  const mode = normalizedMode(modeId).replaceAll("_", "-");
  return (
    mode === "full-access" ||
    mode === "bypass-permissions" ||
    mode === "danger-full-access"
  );
}

function isKnownSafeMode(modeId: string): boolean {
  const mode = normalizedMode(modeId).replaceAll("_", "-");
  return ["auto", "auto-review", "default"].includes(mode);
}

function profileSelection(provider: string, model: string | null | undefined) {
  return model ? `${provider}/${model}` : provider;
}

function wakeMessageId(agentId: string, prompt: string, key?: string): string {
  return createHash("sha256")
    .update(JSON.stringify(["conductor-wake", agentId, key ?? prompt]))
    .digest("hex");
}

export function paseoWorkers(paseo: PaseoApi): WorkerRuntime {
  async function refresh(agentId: string): Promise<Agent | null> {
    try {
      return (await paseo.agents.ref(agentId).refresh())?.agent ?? null;
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === `Agent not found: ${agentId}`
      ) {
        return null;
      }
      throw error;
    }
  }

  async function configuredProfile(name: string) {
    const { config } = await paseo.config.get();
    const matches = (config.agentProfiles ?? []).filter(
      (profile) => profile.id === name || profile.name === name,
    );
    const match = matches[0];
    if (matches.length !== 1 || !match) {
      throw new LaunchRejectedError(
        matches.length === 0
          ? `Unknown worker profile: ${name}`
          : `Ambiguous worker profile: ${name}`,
      );
    }
    return match;
  }

  function assertExistingMatches(input: WorkerLaunch, existing: Agent): void {
    if (
      existing.workspaceId !== input.workspaceId ||
      (existing.labels["paseo.parent-agent-id"] ?? null) !== input.parentAgentId
    ) {
      throw new LaunchRejectedError(
        `Worker ID ${input.agentId} already belongs to another launch`,
      );
    }
  }

  async function requireParent(input: WorkerLaunch): Promise<Agent> {
    if (!input.parentAgentId) {
      throw new LaunchRejectedError(
        "A task worker requires its conductor parent.",
      );
    }
    const parent = await refresh(input.parentAgentId);
    if (!parent || !isAvailableParent(parent)) {
      throw new LaunchRejectedError(
        `Worker parent is unavailable: ${input.parentAgentId}`,
      );
    }
    if (parent.workspaceId !== input.workspaceId) {
      throw new LaunchRejectedError(
        "Worker parent is not in the requested workspace",
      );
    }
    return parent;
  }

  async function assertProviderAvailable(
    provider: string,
    model: string | null | undefined,
    cwd: string,
  ): Promise<void> {
    const availability = await paseo.providers.listAvailable();
    const available = availability.providers.find(
      (entry) => entry.provider === provider,
    );
    if (!available?.available) {
      throw new LaunchRejectedError(
        `Worker provider is unavailable: ${provider}`,
      );
    }
    if (!model) {
      return;
    }

    const models = await paseo.providers.listModels(provider, { cwd });
    if (!(models.models ?? []).some((entry) => entry.id === model)) {
      throw new LaunchRejectedError(
        `Worker model is unavailable: ${provider}/${model}`,
      );
    }
  }

  function validateMode(
    modeId: string | undefined,
    parent: Pick<Agent, "currentModeId">,
  ): void {
    if (!modeId || modeId === parent.currentModeId) {
      return;
    }
    const parentHasElevatedMode = parent.currentModeId
      ? isKnownElevatedMode(parent.currentModeId)
      : false;
    if (isKnownElevatedMode(modeId) && !parentHasElevatedMode) {
      throw new LaunchRejectedError(
        `Worker profile requests elevated permission mode: ${modeId}`,
      );
    }
    if (
      !isKnownSafeMode(modeId) &&
      !(isKnownElevatedMode(modeId) && parentHasElevatedMode)
    ) {
      throw new LaunchRejectedError(
        `Worker profile changes to an unverified permission mode: ${modeId}`,
      );
    }
  }

  function providerAndModel(selection: string): {
    provider: string;
    model: string | undefined;
  } {
    const separator = selection.indexOf("/");
    if (separator === 0 || separator === selection.length - 1) {
      throw new LaunchRejectedError("Prepared worker provider is invalid.");
    }
    return separator === -1
      ? { provider: selection, model: undefined }
      : {
          provider: selection.slice(0, separator),
          model: selection.slice(separator + 1),
        };
  }

  async function resolveConfig(
    input: WorkerLaunch,
    parent: Agent,
  ): Promise<LaunchConfig> {
    const profile = input.profile
      ? await configuredProfile(input.profile)
      : undefined;
    const provider = profile?.provider ?? parent.provider;
    const model = profile ? profile.model : parent.model;
    const sameProvider = provider === parent.provider;
    const modeId =
      profile?.modeId ??
      (sameProvider ? (parent.currentModeId ?? undefined) : undefined);
    validateMode(modeId, parent);
    await assertProviderAvailable(provider, model, parent.cwd);

    const featureValues = profile
      ? { ...profile.featureValues }
      : Object.fromEntries(
          (parent.features ?? []).map((feature) => [feature.id, feature.value]),
        );
    const thinkingOptionId =
      (profile
        ? profile.thinkingOptionId
        : (parent.effectiveThinkingOptionId ?? parent.thinkingOptionId)) ??
      undefined;
    return {
      provider: profileSelection(provider, model),
      ...(modeId ? { modeId } : {}),
      ...(thinkingOptionId ? { thinkingOptionId } : {}),
      ...(Object.keys(featureValues).length > 0 ? { featureValues } : {}),
    };
  }

  async function resolvedConfigFor(input: WorkerLaunch): Promise<LaunchConfig> {
    if (input.config !== undefined) {
      return parseLaunchConfig(input.config);
    }
    return parseLaunchConfig(await prepare(input));
  }

  async function createWorker(
    input: WorkerLaunch,
    config: LaunchConfig,
    title: string,
  ): Promise<void> {
    await paseo.workspaces.ref(input.workspaceId).agents.create({
      agentId: input.agentId,
      idempotencyKey: input.agentId,
      ...(input.parentAgentId ? { parent: input.parentAgentId } : {}),
      title,
      prompt: input.prompt,
      config,
    });
  }

  function configFromAgent(agent: Agent): LaunchConfig {
    const featureValues = Object.fromEntries(
      (agent.features ?? []).map((feature) => [feature.id, feature.value]),
    );
    const thinkingOptionId =
      agent.effectiveThinkingOptionId ??
      agent.thinkingOptionId ??
      agent.runtimeInfo?.thinkingOptionId ??
      undefined;
    return {
      provider: profileSelection(agent.provider, agent.model),
      ...(agent.currentModeId ? { modeId: agent.currentModeId } : {}),
      ...(thinkingOptionId ? { thinkingOptionId } : {}),
      ...(Object.keys(featureValues).length > 0 ? { featureValues } : {}),
    };
  }

  async function rootConfig(input: WorkerLaunch): Promise<LaunchConfig> {
    const workspace = await paseo.workspaces.ref(input.workspaceId).refresh();
    if (!workspace?.workspaceDirectory || workspace.archivingAt) {
      throw new LaunchRejectedError("The selected workspace is unavailable.");
    }
    const profile = await configuredProfile(input.profile ?? "Plan");
    validateMode(profile.modeId, { currentModeId: null });
    await assertProviderAvailable(
      profile.provider,
      profile.model,
      workspace.workspaceDirectory,
    );
    return {
      provider: profileSelection(profile.provider, profile.model),
      ...(profile.modeId ? { modeId: profile.modeId } : {}),
      ...(profile.thinkingOptionId
        ? { thinkingOptionId: profile.thinkingOptionId }
        : {}),
      ...(profile.featureValues
        ? { featureValues: profile.featureValues }
        : {}),
    };
  }

  async function prepare(input: WorkerLaunch): Promise<string> {
    const existing = await refresh(input.agentId);
    if (existing) {
      assertExistingMatches(input, existing);
      return JSON.stringify(configFromAgent(existing));
    }
    if (!input.parentAgentId) {
      return JSON.stringify(await rootConfig(input));
    }
    const parent = await requireParent(input);
    return JSON.stringify(await resolveConfig(input, parent));
  }

  return {
    prepare,

    async inspect(agentId) {
      const agent = await refresh(agentId);
      return {
        exists: agent !== null,
        active: agent ? isActive(agent) : false,
      };
    },

    async launch(input) {
      const existing = await refresh(input.agentId);
      if (existing) {
        assertExistingMatches(input, existing);
        // Replay the keyed SDK creation transaction. Paseo deduplicates the
        // agent and initial prompt if the earlier response was lost.
        await createWorker(
          input,
          input.config === undefined
            ? configFromAgent(existing)
            : parseLaunchConfig(input.config),
          input.title,
        );
        return;
      }

      if (!input.parentAgentId) {
        const workspace = await paseo.workspaces
          .ref(input.workspaceId)
          .refresh();
        if (!workspace?.workspaceDirectory || workspace.archivingAt) {
          throw new LaunchRejectedError(
            "The selected workspace is unavailable.",
          );
        }
        const config = await resolvedConfigFor(input);
        validateMode(config.modeId, { currentModeId: null });
        const selection = providerAndModel(config.provider);
        await assertProviderAvailable(
          selection.provider,
          selection.model,
          workspace.workspaceDirectory,
        );
        await createWorker(input, config, input.title);
        return;
      }
      const parent = await requireParent(input);
      const config = await resolvedConfigFor(input);
      validateMode(config.modeId, parent);
      const selection = providerAndModel(config.provider);
      await assertProviderAvailable(
        selection.provider,
        selection.model,
        parent.cwd,
      );
      await createWorker(input, config, input.title);
    },

    async wake(agentId, prompt, key) {
      const agent = await refresh(agentId);
      if (!agent || agent.archivedAt || agent.status === "closed") {
        throw new RunError(`Worker is unavailable: ${agentId}`);
      }
      if (isActive(agent)) {
        throw new RunError(
          "Worker is busy; this Paseo SDK version has no queue option, so the prompt was not sent",
        );
      }
      await paseo.agents.ref(agentId).send(prompt, {
        // Protect against a turn starting between refresh and send. Steering is
        // non-interrupting; when already observed busy above, refuse instead.
        activeTurnBehavior: "steer",
        messageId: wakeMessageId(agentId, prompt, key),
      });
    },

    async profiles() {
      const { config } = await paseo.config.get();
      return (config.agentProfiles ?? []).map((profile) => ({
        name: profile.name,
        notes: profile.notes ?? "",
      }));
    },
  };
}
