import { join } from "node:path";
import { identifier } from "../../shared/schema";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AgentSnapshot } from "../../shared/agents/agent";
import {
  keySchema,
  turnOutcomeSchema,
  type TurnOutcome,
} from "../../shared/agents/models";
import { atomicJson, readJson } from "../files";
import { agentKey, digest } from "./identity";

const recordSchema = z.object({
  identity: keySchema,
  turnId: identifier.nullable(),
  key: keySchema,
  state: z.enum(["running", "ended"]),
  lastUserMessageAt: z.string().nullable(),
  observedAt: z.string().datetime(),
  outcome: turnOutcomeSchema.nullable(),
});
type TurnEvent = {
  turnId: string | null;
  kind: "started" | TurnOutcome["outcome"];
  at: number;
};
export interface TurnJournal {
  record(
    agentId: string,
    event: TurnEvent,
    inspect: () => Promise<AgentSnapshot | null>,
  ): Promise<void>;
  last(agent: AgentSnapshot): Promise<TurnOutcome | null>;
  flush(): Promise<void>;
}
function identity(agent: AgentSnapshot): string {
  return digest([agent.id, agent.provider, agent.createdAt, agent.sessionId]);
}

/** One bounded latest-turn record per agent. Lifecycle evidence never uses unread flags. */
export function turnJournal(directory: string): TurnJournal {
  const writes = new Map<string, Promise<void>>();
  const path = (id: string) => join(directory, `${agentKey(id)}.json`);
  const read = async (id: string) => {
    const raw = await readJson(path(id));
    return raw === undefined ? undefined : recordSchema.parse(raw);
  };
  return {
    record(agentId, event, inspect) {
      // Queue before inspecting: overlapping asynchronous hook callbacks retain their order.
      const write = (writes.get(agentId) ?? Promise.resolve())
        .catch(() => undefined)
        .then(async () => {
          const agent = await inspect();
          if (!agent || agent.archived) {
            return;
          }
          if (
            event.turnId &&
            agent.activeTurn?.turnId &&
            event.turnId !== agent.activeTurn.turnId
          ) {
            return;
          }
          const session = identity(agent);
          const stored = await read(agentId);
          const prior = stored?.identity === session ? stored : undefined;
          const observedAt = new Date(event.at).toISOString();
          if (prior && prior.observedAt > observedAt) {
            return;
          }
          const sameTurn = Boolean(
            prior && event.turnId && prior.turnId === event.turnId,
          );
          // Duplicate/replayed hooks must not clear an ended outcome or change its identity.
          if (
            sameTurn &&
            (event.kind === "started" || prior?.state === "ended")
          ) {
            return;
          }
          if (
            event.kind !== "started" &&
            prior?.state === "running" &&
            prior.turnId &&
            event.turnId &&
            prior.turnId !== event.turnId
          ) {
            return;
          }
          const key =
            sameTurn || (prior?.state === "running" && !event.turnId)
              ? (prior?.key ?? digest([session, randomUUID()]))
              : digest([session, event.turnId ?? randomUUID()]);
          await atomicJson(
            path(agentId),
            recordSchema.parse({
              identity: session,
              turnId: event.turnId,
              key,
              state: event.kind === "started" ? "running" : "ended",
              lastUserMessageAt: agent.lastUserMessageAt ?? null,
              observedAt,
              outcome:
                event.kind === "started"
                  ? null
                  : {
                      key,
                      turnId: event.turnId,
                      outcome: event.kind,
                      observedAt,
                    },
            }),
          );
        });
      writes.set(agentId, write);
      const remove = () => {
        if (writes.get(agentId) === write) {
          writes.delete(agentId);
        }
      };
      // Consume the cleanup chain's rejection; the returned write still reports failures to Paseo.
      write.then(remove, remove);
      return write;
    },
    async last(agent) {
      await writes.get(agent.id);
      const value = await read(agent.id);
      if (
        !value ||
        value.identity !== identity(agent) ||
        value.state !== "ended" ||
        value.lastUserMessageAt !== (agent.lastUserMessageAt ?? null) ||
        agent.activeTurn ||
        agent.status === "running" ||
        agent.status === "initializing"
      ) {
        return null;
      }
      return value.outcome;
    },
    async flush() {
      await Promise.all(writes.values());
    },
  };
}
