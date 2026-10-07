import { createHash } from "node:crypto";
import { z } from "zod";
import type { ConcertHost, HostAgent, LaunchConfig } from "./host";
import { LaunchRejectedError, ConcertError } from "./errors";

export interface WorkerLaunch {
  agentId: string;
  parentAgentId: string | null;
  workspaceId: string;
  title: string;
  prompt: string;
  profile?: string;
  provider?: string;
  model?: string;
  thinkingOptionId?: string;
  config?: string;
}

export interface WorkerProfile {
  id: string;
  name: string;
  notes: string;
  provider: string;
  model?: string;
  modeId?: string;
  thinkingOptionId?: string;
}

export interface WorkerRuntime {
  prepare(input: WorkerLaunch): Promise<string>;
  launch(input: WorkerLaunch): Promise<void>;
  inspect(agentId: string): Promise<{
    exists: boolean;
    active: boolean;
    /** False for archived or closed agents, which cannot receive a wake. */
    deliverable: boolean;
  }>;
  wake(agentId: string, prompt: string, key?: string): Promise<void>;
  profiles(): Promise<WorkerProfile[]>;
  models(
    agentId: string,
  ): Promise<Array<{ provider: string; models: string[] }>>;
  /**
   * Optional schedule for re-checking an uncertain launch, as delays between
   * checks. Absent means `LAUNCH_CHECK_DELAYS_MS`; tests set [] for an
   * immediate single check or a short schedule. Reconcile persists the schedule
   * on the launch and performs one lookup per due tick, so it never sleeps.
   */
  launchCheckDelaysMs?: readonly number[];
}

/** Default launch re-check schedule: three identity checks over about 25s. */
export const LAUNCH_CHECK_DELAYS_MS = [5_000, 20_000] as const;

/**
 * The delay in milliseconds before the next identity re-check of an uncertain
 * launch, given how many checks have completed. Returns null once the bounded
 * schedule is exhausted, so the caller settles the launch as blocked. The
 * schedule has one more check than delay; the first check happens immediately.
 */
export function nextLaunchCheckDelay(
  completedChecks: number,
  delays?: readonly number[],
): number | null {
  const schedule = delays ?? LAUNCH_CHECK_DELAYS_MS;
  if (completedChecks > schedule.length) {
    return null;
  }
  return schedule[completedChecks - 1] ?? 0;
}

type Agent = HostAgent;
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

/**
 * An archived or closed agent exists but can never receive a wake message, so
 * it is neither an available parent nor a deliverable worker.
 */
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

/** Worker launch policy: resolves configs, guards permission modes, and creates agents through the host. */
export function workerRuntime(host: ConcertHost): WorkerRuntime {
  const refresh = (agentId: string) => host.agent(agentId);

  async function configuredProfile(name: string) {
    const matches = (await host.profiles()).filter(
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
    const available = (await host.providers()).find(
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

    if (!(await host.models(provider, cwd)).includes(model)) {
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
    const provider = profile?.provider ?? input.provider ?? parent.provider;
    const sameProvider = provider === parent.provider;
    let model: string | null | undefined = parent.model;
    if (profile) {
      model = profile.model;
    } else if (input.model || !sameProvider) {
      // An inline provider without a model uses that provider's default model.
      model = input.model;
    }
    const modeId =
      profile?.modeId ??
      (sameProvider ? (parent.currentModeId ?? undefined) : undefined);
    validateMode(modeId, parent);
    await assertProviderAvailable(provider, model, parent.cwd);

    // Features and thinking options are provider-specific; copy them only
    // within the Conductor's own provider.
    let featureValues: Record<string, unknown> = {};
    if (profile) {
      featureValues = { ...profile.featureValues };
    } else if (sameProvider) {
      featureValues = Object.fromEntries(
        (parent.features ?? []).map((feature) => [feature.id, feature.value]),
      );
    }
    let thinkingOptionId = input.thinkingOptionId;
    if (profile) {
      thinkingOptionId = profile.thinkingOptionId ?? undefined;
    } else if (!thinkingOptionId && sameProvider) {
      thinkingOptionId =
        parent.effectiveThinkingOptionId ??
        parent.thinkingOptionId ??
        undefined;
    }
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
    await host.createAgent({
      agentId: input.agentId,
      workspaceId: input.workspaceId,
      parentAgentId: input.parentAgentId,
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

  async function prepare(input: WorkerLaunch): Promise<string> {
    const existing = await refresh(input.agentId);
    if (existing) {
      assertExistingMatches(input, existing);
      return JSON.stringify(configFromAgent(existing));
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
        deliverable: agent ? isAvailableParent(agent) : false,
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
        throw new ConcertError(`Worker is unavailable: ${agentId}`);
      }
      if (isActive(agent)) {
        throw new ConcertError(
          "Worker is busy; this Paseo SDK version has no queue option, so the prompt was not sent",
        );
      }
      // When already observed busy above, refuse instead of steering.
      await host.send(agentId, prompt, wakeMessageId(agentId, prompt, key));
    },

    async models(agentId) {
      const agent = await refresh(agentId);
      if (!agent) {
        throw new ConcertError(`Agent not found: ${agentId}`);
      }
      return Promise.all(
        (await host.providers())
          .filter((entry) => entry.available)
          .map(async ({ provider }) => ({
            provider,
            models: await host.models(provider, agent.cwd),
          })),
      );
    },

    async profiles() {
      // Routing fields only: profiles are loose objects and may carry more.
      return (await host.profiles()).map((profile) => ({
        id: profile.id,
        name: profile.name,
        notes: profile.notes ?? "",
        provider: profile.provider,
        ...(profile.model ? { model: profile.model } : {}),
        ...(profile.modeId ? { modeId: profile.modeId } : {}),
        ...(profile.thinkingOptionId
          ? { thinkingOptionId: profile.thinkingOptionId }
          : {}),
      }));
    },
  };
}
