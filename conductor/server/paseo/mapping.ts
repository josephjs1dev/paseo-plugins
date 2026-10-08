import type {
  AgentPermissionRequest,
  AgentProfile,
  AgentSnapshot,
} from "../../shared/agents/agent";
import type { ConcertEntry } from "../../shared/concert";
import type { PaseoAgent, PaseoProfile, PaseoWorkspace } from "./types";

/** Paseo stores the parent relationship as a label on the agent record. */
const parentLabel = "paseo.parent-agent-id";

function thinkingOptionId(agent: PaseoAgent): string | null {
  return (
    agent.effectiveThinkingOptionId ??
    agent.thinkingOptionId ??
    agent.runtimeInfo?.thinkingOptionId ??
    null
  );
}

function permissionRequest(
  request: PaseoAgent["pendingPermissions"][number],
): AgentPermissionRequest {
  return {
    id: request.id,
    provider: request.provider,
    kind: request.kind,
    name: request.name,
    ...(request.title !== undefined ? { title: request.title } : {}),
    ...(request.description !== undefined
      ? { description: request.description }
      : {}),
    ...(request.input !== undefined ? { input: request.input } : {}),
    ...(request.actions !== undefined
      ? {
          actions: request.actions.map((action) => ({
            id: action.id,
            label: action.label,
            behavior: action.behavior,
          })),
        }
      : {}),
  };
}

/** Translate one Paseo agent record into the Conductor domain shape. */
export function toAgentSnapshot(agent: PaseoAgent): AgentSnapshot {
  return {
    id: agent.id,
    concertId: agent.workspaceId ?? null,
    parentAgentId: agent.labels[parentLabel]?.trim() || null,
    provider: agent.provider,
    status: agent.status,
    archived: Boolean(agent.archivedAt),
    awaitingPermission:
      agent.pendingPermissions.length > 0 ||
      agent.attentionReason === "permission",
    title: agent.title ?? null,
    cwd: agent.cwd,
    model: agent.model ?? null,
    modeId: agent.currentModeId ?? null,
    thinkingOptionId: thinkingOptionId(agent),
    features: (agent.features ?? []).map((feature) => ({
      id: feature.id,
      value: feature.value,
    })),
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
    lastUserMessageAt: agent.lastUserMessageAt ?? null,
    attentionTimestamp: agent.attentionTimestamp ?? null,
    lastError: agent.lastError ?? null,
    activeTurn: agent.activeTurn
      ? {
          turnId: agent.activeTurn.turnId,
          startedAt: agent.activeTurn.startedAt ?? null,
        }
      : null,
    sessionId:
      agent.runtimeInfo?.sessionId ?? agent.persistence?.sessionId ?? null,
    pendingPermissions: agent.pendingPermissions.map(permissionRequest),
  };
}

/** Translate one Paseo workspace into the Agents section's concert entry. */
export function toConcertEntry(workspace: PaseoWorkspace): ConcertEntry {
  return {
    id: workspace.id,
    name: workspace.name,
    projectName: workspace.projectDisplayName,
  };
}

/** Translate a Paseo profile into the domain profile. */
export function toAgentProfile(profile: PaseoProfile): AgentProfile {
  return {
    id: profile.id,
    name: profile.name,
    ...(profile.notes !== undefined ? { notes: profile.notes } : {}),
    provider: profile.provider,
    ...(profile.model !== undefined ? { model: profile.model } : {}),
    ...(profile.modeId !== undefined ? { modeId: profile.modeId } : {}),
    ...(profile.thinkingOptionId !== undefined
      ? { thinkingOptionId: profile.thinkingOptionId }
      : {}),
    ...(profile.featureValues !== undefined
      ? { featureValues: profile.featureValues }
      : {}),
  };
}
