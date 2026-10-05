import type {
  Bucket,
  InboxItem,
  InboxSnapshot,
  TurnOutcome,
} from "../shared/models";
import { requestForm } from "../shared/questions";
import { agentKey, requestKey } from "./identity";
import type {
  AgentPermissionRequest,
  PaseoAgent,
  PaseoWorkspace,
  Runtime,
} from "./runtime";
import type { InboxStore } from "./store";
import type { TurnJournal } from "./turns";
import { pages } from "./directory";
import { archiveKey } from "./archive";

function bucket(
  agent: PaseoAgent,
  request: AgentPermissionRequest | undefined,
  marked: boolean,
): Bucket {
  if (agent.status === "error") {
    return "failed";
  }
  if (agent.status === "closed") {
    return "closed";
  }
  if (request || marked || agent.attentionReason === "permission") {
    return "waiting";
  }
  if (agent.status === "running" || agent.status === "initializing") {
    return "running";
  }
  return "idle";
}
function details(value: unknown): string {
  if (value === undefined) {
    return "";
  }
  return JSON.stringify(value, null, 2).slice(0, 16000);
}
async function row(
  agent: PaseoAgent,
  request: AgentPermissionRequest | undefined,
  workspace: PaseoWorkspace | undefined,
  store: InboxStore,
  lastTurn: TurnOutcome | null,
  agents: Map<string, PaseoAgent>,
  children: Map<string, number>,
): Promise<InboxItem> {
  const key = request ? requestKey(agent, request) : agentKey(agent.id);
  const [annotation, agentAnnotation, receipt] = await Promise.all([
    store.annotation(key),
    store.annotation(agentKey(agent.id)),
    store.receipt(key),
  ]);
  const marked = agentAnnotation?.marked ?? false;
  const parentAgentId = agent.labels["paseo.parent-agent-id"]?.trim() || null;
  const state = bucket(agent, request, marked);
  const agentTitle = (agent.title?.trim() || "Untitled agent").slice(0, 1000);
  return {
    key,
    agentId: agent.id,
    requestId: request?.id ?? null,
    agentTitle,
    provider: agent.provider.slice(0, 100),
    workspaceId: agent.workspaceId ?? null,
    workspaceName: (workspace?.name ?? "Workspace unavailable").slice(0, 1000),
    projectName: (workspace?.projectDisplayName ?? "Other agents").slice(
      0,
      1000,
    ),
    parentAgentId,
    parentAgentTitle: parentAgentId
      ? (agents.get(parentAgentId)?.title?.slice(0, 1000) ?? null)
      : null,
    childAgentCount: children.get(agent.id) ?? 0,
    archiveKey: archiveKey(agent),
    bucket: state,
    lastTurn,
    title: (request?.title ?? request?.name ?? agentTitle).slice(0, 8000),
    description: (request?.description ?? "").slice(0, 16000),
    details: details(request?.input),
    error: agent.lastError?.slice(0, 2000) ?? null,
    since:
      agent.attentionTimestamp ??
      agent.activeTurn?.startedAt ??
      agent.updatedAt,
    form: request ? requestForm(request) : null,
    snoozedUntil: annotation?.until ?? null,
    marked,
    delivery:
      receipt?.status === "sending" ? "unknown" : (receipt?.status ?? null),
  };
}
export async function snapshot(
  runtime: Runtime,
  store: InboxStore,
  knownAgentIds: string[],
  now = Date.now(),
  turns?: TurnJournal,
): Promise<InboxSnapshot> {
  const [agents, workspaces, receipts] = await Promise.all([
    pages((cursor) => runtime.agents(cursor)),
    pages((cursor) => runtime.workspaces(cursor)).catch(() => ({
      entries: [],
      incomplete: true,
    })),
    store.recent(),
  ]);
  const byId = new Map(agents.entries.map((agent) => [agent.id, agent]));
  // Retained pending agents are inspected directly even when outside the paged directory.
  const missing = [
    ...new Set([
      ...knownAgentIds,
      ...receipts.map((receipt) => receipt.agentId),
    ]),
  ].filter((id) => !byId.has(id));
  for (let start = 0; start < missing.length; start += 10) {
    const inspected = await Promise.all(
      missing.slice(start, start + 10).map((id) => runtime.inspect(id)),
    );
    for (const agent of inspected) {
      if (agent) {
        byId.set(agent.id, agent);
      }
    }
  }
  const workspaceMap = new Map(
    workspaces.entries.map((workspace) => [workspace.id, workspace]),
  );
  const childCounts = new Map<string, number>();
  for (const agent of byId.values()) {
    const parent = agent.labels["paseo.parent-agent-id"]?.trim();
    if (parent && !agent.archivedAt) {
      childCounts.set(parent, (childCounts.get(parent) ?? 0) + 1);
    }
  }
  const items: InboxItem[] = [];
  let incomplete = agents.incomplete;
  let turnHistoryIncomplete = false;
  for (const agent of byId.values()) {
    if (agent.archivedAt) {
      continue;
    }
    const lastTurn = turns
      ? await turns.last(agent).catch(() => {
          turnHistoryIncomplete = true;
          return null;
        })
      : null;
    const requests = agent.pendingPermissions.slice(0, 20);
    if (requests.length !== agent.pendingPermissions.length) {
      incomplete = true;
    }
    const sources = requests.length ? requests : [undefined];
    for (const request of sources) {
      if (items.length >= 6000) {
        incomplete = true;
        break;
      }
      items.push(
        await row(
          agent,
          request,
          agent.workspaceId ? workspaceMap.get(agent.workspaceId) : undefined,
          store,
          lastTurn,
          byId,
          childCounts,
        ),
      );
    }
  }
  return {
    items,
    receipts,
    fetchedAt: now,
    incomplete,
    workspaceIncomplete: workspaces.incomplete,
    turnHistoryIncomplete,
  };
}
