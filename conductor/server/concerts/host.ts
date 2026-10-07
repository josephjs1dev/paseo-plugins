import type {
  PaseoAgent,
  PaseoLaunchConfig,
  PaseoProfile,
} from "../paseo/types";

export type HostAgent = PaseoAgent;
export type HostProfile = PaseoProfile;
export type LaunchConfig = PaseoLaunchConfig;

export interface CreateAgentInput {
  agentId: string;
  workspaceId: string;
  parentAgentId: string | null;
  title: string;
  prompt: string;
  config: LaunchConfig;
}

/** Paseo operations that concerts need. server/paseo/concerts-host.ts implements it. */
export interface ConcertHost {
  /** Returns null when Paseo does not know the agent. */
  agent(agentId: string): Promise<HostAgent | null>;
  workspace(
    workspaceId: string,
  ): Promise<{ name: string; directory: string | null } | null>;
  profiles(): Promise<HostProfile[]>;
  providers(): Promise<Array<{ provider: string; available: boolean }>>;
  models(provider: string, cwd: string): Promise<string[]>;
  /** Keyed by agentId; Paseo deduplicates a replayed create. */
  createAgent(input: CreateAgentInput): Promise<void>;
  /** Steers without interrupting a turn that starts after the caller's busy check. */
  send(agentId: string, prompt: string, messageId: string): Promise<void>;
}
