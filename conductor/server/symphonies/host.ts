import type {
  AgentLaunchConfig,
  AgentProfile,
  AgentSnapshot,
} from "../../shared/agents/agent";
import type { Concert } from "../../shared/concert";

export type { AgentLaunchConfig, AgentProfile, AgentSnapshot };

export interface CreateAgentInput {
  agentId: string;
  concertId: string;
  parentAgentId: string | null;
  title: string;
  prompt: string;
  config: AgentLaunchConfig;
}

/** Paseo operations that symphonies need. server/paseo/symphony-host.ts implements it. */
export interface SymphonyHost {
  /** Returns null when Paseo does not know the agent. */
  agent(agentId: string): Promise<AgentSnapshot | null>;
  concert(concertId: string): Promise<Concert | null>;
  profiles(): Promise<AgentProfile[]>;
  providers(): Promise<Array<{ provider: string; available: boolean }>>;
  models(provider: string, cwd: string): Promise<string[]>;
  /** Keyed by agentId; Paseo deduplicates a replayed create. */
  createAgent(input: CreateAgentInput): Promise<void>;
  /** Steers without interrupting a turn that starts after the caller's busy check. */
  send(agentId: string, prompt: string, messageId: string): Promise<void>;
}
