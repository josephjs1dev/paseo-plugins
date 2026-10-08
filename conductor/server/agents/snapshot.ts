import type {
  AgentSnapshot,
  AgentPermissionRequest,
} from "../../shared/agents/agent";
import type { ConcertEntry } from "../../shared/concert";
import type {
  Bucket,
  AgentItem,
  AgentsSnapshot,
  TurnOutcome,
} from "../../shared/agents/models";
import { requestForm } from "../../shared/agents/questions";
import { agentKey, requestKey } from "./identity";
import type { AgentsHost } from "./host";
import type { AgentsStore } from "./store";
import type { TurnJournal } from "./turns";
import { pages } from "./directory";
import { archiveKey } from "./archive";

function bucket(
  agent: AgentSnapshot,
  request: AgentPermissionRequest | undefined,
  marked: boolean,
): Bucket {
  if (agent.status === "error") {
    return "failed";
  }
  if (agent.status === "closed") {
    return "closed";
  }
  if (request || marked || agent.awaitingPermission) {
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
  agent: AgentSnapshot,
  request: AgentPermissionRequest | undefined,
  concert: ConcertEntry | undefined,
  store: AgentsStore,
  lastTurn: TurnOutcome | null,
  agents: Map<string, AgentSnapshot>,
  children: Map<string, number>,
): Promise<AgentItem> {
  const key = request ? requestKey(agent, request) : agentKey(agent.id);
  const [annotation, agentAnnotation, receipt] = await Promise.all([
    store.annotation(key),
    store.annotation(agentKey(agent.id)),
    store.receipt(key),
  ]);
  const marked = agentAnnotation?.marked ?? false;
  const parentAgentId = agent.parentAgentId;
  const state = bucket(agent, request, marked);
  const agentTitle = (agent.title?.trim() || "Untitled agent").slice(0, 1000);
  return {
    key,
    agentId: agent.id,
    requestId: request?.id ?? null,
    agentTitle,
    provider: agent.provider.slice(0, 100),
    concertId: agent.concertId,
    concertName: (concert?.name ?? "Concert unavailable").slice(0, 1000),
    projectName: (concert?.projectName ?? "Other agents").slice(0, 1000),
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
  runtime: AgentsHost,
  store: AgentsStore,
  knownAgentIds: string[],
  now = Date.now(),
  turns?: TurnJournal,
): Promise<AgentsSnapshot> {
  const [agents, concerts, receipts] = await Promise.all([
    pages((cursor) => runtime.agents(cursor)),
    pages((cursor) => runtime.concerts(cursor)).catch(() => ({
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
  const concertMap = new Map(
    concerts.entries.map((concert) => [concert.id, concert]),
  );
  const childCounts = new Map<string, number>();
  for (const agent of byId.values()) {
    const parent = agent.parentAgentId;
    if (parent && !agent.archived) {
      childCounts.set(parent, (childCounts.get(parent) ?? 0) + 1);
    }
  }
  const items: AgentItem[] = [];
  let incomplete = agents.incomplete;
  let turnHistoryIncomplete = false;
  for (const agent of byId.values()) {
    if (agent.archived) {
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
          agent.concertId ? concertMap.get(agent.concertId) : undefined,
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
    concertIncomplete: concerts.incomplete,
    turnHistoryIncomplete,
  };
}
