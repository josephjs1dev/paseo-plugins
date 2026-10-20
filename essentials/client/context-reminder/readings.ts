import { useSyncExternalStore } from "react";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import type { ReminderNotice } from "../../shared/context-reminder/contracts";

type AgentUpdate = Parameters<
  Parameters<PluginClientContext["paseo"]["agents"]["subscribe"]>[0]
>[0];

/** The agent snapshot carried by an `agent_update` upsert. */
export type ReminderAgent = Extract<AgentUpdate, { kind: "upsert" }>["agent"];

/** One agent's latest reading above the warn threshold. */
export interface ContextReading extends ReminderNotice {
  status: ReminderAgent["status"];
}

const readings = new Map<string, ContextReading>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

export function setReading(agentId: string, reading: ContextReading): void {
  readings.set(agentId, reading);
  emit();
}

export function clearReading(agentId: string): void {
  if (readings.delete(agentId)) {
    emit();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

/** The live reading for an agent, or null when it has none. */
export function useReading(agentId: string | null): ContextReading | null {
  return useSyncExternalStore(subscribe, () =>
    agentId === null ? null : (readings.get(agentId) ?? null),
  );
}
