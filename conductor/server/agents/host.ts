import type {
  AgentPermissionResponse,
  PaseoAgent,
  PaseoWorkspace,
} from "../paseo/types";

export interface Directory<T> {
  entries: T[];
  next: string | null;
}

/** Paseo operations that the Podium's Agents section needs. server/paseo/agents-host.ts implements it. */
export interface AgentsHost {
  agents(cursor?: string): Promise<Directory<PaseoAgent>>;
  workspaces(cursor?: string): Promise<Directory<PaseoWorkspace>>;
  inspect(agentId: string): Promise<PaseoAgent | null>;
  archive(agentId: string): Promise<void>;
  answer(
    agentId: string,
    requestId: string,
    response: AgentPermissionResponse,
  ): Promise<void>;
}
