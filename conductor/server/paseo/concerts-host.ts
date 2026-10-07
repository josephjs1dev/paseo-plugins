import type { ConcertHost } from "../concerts/host";
import { workerRuntime, type WorkerRuntime } from "../concerts/workers";
import type { PaseoApi } from "./types";

export function paseoConcertHost(paseo: PaseoApi): ConcertHost {
  return {
    async agent(agentId) {
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
    },
    async workspace(workspaceId) {
      const value = await paseo.workspaces.ref(workspaceId).refresh();
      return value
        ? { name: value.name, directory: value.workspaceDirectory ?? null }
        : null;
    },
    async profiles() {
      return (await paseo.config.get()).config.agentProfiles ?? [];
    },
    async providers() {
      return (await paseo.providers.listAvailable()).providers;
    },
    async models(provider, cwd) {
      const { models } = await paseo.providers.listModels(provider, { cwd });
      return (models ?? []).map((entry) => entry.id);
    },
    async createAgent(input) {
      await paseo.workspaces.ref(input.workspaceId).agents.create({
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

/** Worker policy bound to the Paseo SDK. */
export function paseoWorkers(paseo: PaseoApi): WorkerRuntime {
  return workerRuntime(paseoConcertHost(paseo));
}
