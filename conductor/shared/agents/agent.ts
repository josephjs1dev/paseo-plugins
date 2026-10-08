/**
 * Domain agent types shared by the host ports. They are declared explicitly and
 * never derived from Paseo SDK types; `server/paseo/mapping.ts` translates
 * Paseo records into these shapes.
 */
export type AgentStatus =
  | "error"
  | "initializing"
  | "idle"
  | "running"
  | "closed";

/** One provider feature toggle or select, flattened to its id and value. */
export interface AgentFeature {
  id: string;
  value: boolean | string | null;
}

export interface AgentPermissionAction {
  id: string;
  label: string;
  behavior: "allow" | "deny";
}

/** One pending provider request, in the shape the Podium renders. */
export interface AgentPermissionRequest {
  id: string;
  provider: string;
  kind: string;
  name: string;
  title?: string;
  description?: string;
  input?: Record<string, unknown>;
  actions?: AgentPermissionAction[];
}

/** A decision the Podium sends back for one pending request. */
export interface AgentPermissionResponse {
  behavior: "allow" | "deny";
  selectedActionId?: string;
  updatedInput?: Record<string, unknown>;
}

/**
 * A Paseo agent record translated into Conductor terms. The adapter resolves
 * Paseo's several thinking fields and attention fields into the single fields
 * below.
 */
export interface AgentSnapshot {
  id: string;
  /** The Paseo workspace behind this agent; null when it belongs to none. */
  concertId: string | null;
  parentAgentId: string | null;
  provider: string;
  status: AgentStatus;
  archived: boolean;
  /** True when a permission request is pending or the agent awaits a decision. */
  awaitingPermission: boolean;
  title: string | null;
  cwd: string;
  model: string | null;
  modeId: string | null;
  thinkingOptionId: string | null;
  features: AgentFeature[];
  createdAt: string;
  updatedAt: string;
  lastUserMessageAt: string | null;
  attentionTimestamp: string | null;
  lastError: string | null;
  activeTurn: { turnId: string; startedAt: string | null } | null;
  /** Provider session identity; the adapter folds runtime and persistence. */
  sessionId: string | null;
  pendingPermissions: AgentPermissionRequest[];
}

/** A named launch bundle the Conductor can select for a task agent. */
export interface AgentProfile {
  id: string;
  name: string;
  notes?: string;
  provider: string;
  model?: string;
  modeId?: string;
  thinkingOptionId?: string;
  featureValues?: Record<string, unknown>;
}

/** Provider and model settings for a newly created agent. */
export interface AgentLaunchConfig {
  provider: string;
  modeId?: string;
  thinkingOptionId?: string;
  featureValues?: Record<string, unknown>;
}
