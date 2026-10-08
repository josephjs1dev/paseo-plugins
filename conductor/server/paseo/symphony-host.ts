import type { SymphonyHost } from "../symphonies/host";
import { workerRuntime, type WorkerRuntime } from "../symphonies/workers";
import { toAgentProfile, toAgentSnapshot } from "./mapping";
import type { PaseoApi } from "./types";

export function paseoSymphonyHost(paseo: PaseoApi): SymphonyHost {
  return {
    async agent(agentId) {
      try {
        const value =
          (await paseo.agents.ref(agentId).refresh())?.agent ?? null;
        return value ? toAgentSnapshot(value) : null;
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === `Agent not found: ${agentId}`
        ) {
          return null;
        }
        throw error;
      }
    },
    async concert(concertId) {
      const value = await paseo.workspaces.ref(concertId).refresh();
      return value
        ? {
            id: value.id,
            name: value.name,
            directory: value.workspaceDirectory ?? null,
          }
        : null;
    },
    async profiles() {
      const profiles = (await paseo.config.get()).config.agentProfiles ?? [];
      return profiles.map(toAgentProfile);
    },
    async providers() {
      return (await paseo.providers.listAvailable()).providers;
    },
    async models(provider, cwd) {
      const { models } = await paseo.providers.listModels(provider, { cwd });
      return (models ?? []).map((entry) => entry.id);
    },
    async createAgent(input) {
      await paseo.workspaces.ref(input.concertId).agents.create({
        agentId: input.agentId,
        idempotencyKey: input.agentId,
        ...(input.parentAgentId ? { parent: input.parentAgentId } : {}),
        title: input.title,
        prompt: input.prompt,
        config: input.config,
      });
    },
    async send(agentId, prompt, messageId) {
      await paseo.agents.ref(agentId).send(prompt, {
        // Protect against a turn starting between the caller's busy check and
        // send. Steering is non-interrupting.
        activeTurnBehavior: "steer",
        messageId,
      });
    },
  };
}

/** Task agent launch policy bound to the Paseo SDK. */
export function paseoWorkers(paseo: PaseoApi): WorkerRuntime {
  return workerRuntime(paseoSymphonyHost(paseo));
}
