import { createElement, type ComponentType } from "react";
import type { RpcOutput } from "@getpaseo/plugin";
import type {
  PluginButtonContentProps,
  PluginButtonRegistration,
  PluginComposerPillContribution,
} from "@getpaseo/plugin/client";
import { listSymphonies } from "../../shared/symphonies/rpc";
import type {
  StoredSymphony,
  SymphonyListEntry,
} from "../../shared/symphonies/models";
import { symphonyStatusLabel } from "../../shared/symphonies/models";
import { SymphoniesPillContent } from "./pills-popover";

/** A symphony is ongoing while it plans, waits, runs, or needs attention. */
const ONGOING_STATUSES: ReadonlySet<StoredSymphony["status"]> = new Set([
  "planning",
  "ready",
  "running",
  "blocked",
]);

const PILL_ID = "symphonies";
const PILL_TITLE = "Ongoing symphonies";
/** Host Lucide names; they mirror `client/ui/status.tsx` symphony icons. */
const PILL_ICON = "Activity";
const PILL_ATTENTION_ICON = "CirclePause";
const PILL_ATTENTION_LABEL = symphonyStatusLabel("blocked");
const DEFAULT_DEBOUNCE_MS = 500;
const DEFAULT_FALLBACK_MS = 30_000;

/** The agents-list slice reconcile needs; tests fake the same shape. */
interface PillAgentSnapshot {
  readonly entries: readonly { readonly agent: { id: string } }[];
}

interface PillAgentsSubscription {
  subscribe(observer: {
    snapshot: (snapshot: PillAgentSnapshot) => void;
    /** An `agent_update` message; narrowed at runtime, see {@link updateAgentIds}. */
    update: (message: unknown) => void;
    error?(error: unknown): void;
  }): () => void;
  release(): Promise<void>;
}

/** The client slice this module uses; hosts without pills skip everything. */
export interface SymphonyPillClient {
  paseo: {
    agents: {
      list(options: {
        subscribe: Record<string, never>;
      }): Promise<PillAgentSnapshot & { subscription: PillAgentsSubscription }>;
    };
  };
  rpc(
    contract: typeof listSymphonies,
    input: Record<string, never>,
  ): Promise<RpcOutput<typeof listSymphonies>>;
  openPanel(
    id: string,
    options: { workspaceId: string; agentId: string },
  ): void;
  addComposerPill?(
    contribution: PluginComposerPillContribution,
  ): PluginButtonRegistration;
}

/** The remover may await a subscription release; simple aborts may not. */
type SymphonyPillsCleanup = () => Promise<void> | void;

/** Timer pair, injectable so tests can drive every refresh trigger. */
export interface SymphonyPillTimers {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface SymphonyPillOptions {
  /** Debounce for agent-list updates before a refresh, as `observeDirectory`. */
  debounceMs?: number;
  /** Fallback refresh interval when no agent event fires. */
  fallbackMs?: number;
  timers?: SymphonyPillTimers;
  /**
   * Selects a symphony in the workspace Podium before its panel opens; a
   * panel takes no params, so selection travels through shared Podium state.
   */
  selectSymphony?: (input: {
    hostId: string;
    workspaceId: string;
    symphonyId: string;
  }) => void;
}

interface SymphoniesPill {
  registration: PluginButtonRegistration;
  /** The workspace the pill was registered at; moved groups re-register. */
  workspaceId: string;
  /** The popover reads this holder live; each refresh swaps the list. */
  current: { symphonies: SymphonyListEntry[] };
  label: string;
  icon: string;
}

interface OngoingGroup {
  /** The first group member's concert; the pill placement rides on it. */
  readonly workspaceId: string;
  readonly symphonies: SymphonyListEntry[];
}

const defaultTimers: SymphonyPillTimers = {
  set(callback, ms) {
    return setTimeout(callback, ms);
  },
  // `handle` is only ever a value this module received from `set`, so the
  // default clear may assume the ambient timer handle shape.
  clear(handle) {
    if (typeof handle !== "undefined") {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    }
  },
};

/** Reads one object property when the value is an object; else undefined. */
function readProp(source: unknown, key: string): unknown {
  if (typeof source !== "object" || source === null) {
    return undefined;
  }
  return (source as Record<string, unknown>)[key];
}

/**
 * Applies one `agent_update` payload to the known agent ids. Recognizes the
 * upsert and removal shapes without importing Paseo protocol types into
 * client code; unrecognized messages are ignored.
 */
function updateAgentIds(agentIds: Set<string>, message: unknown): boolean {
  const payload = readProp(message, "payload");
  const kind = readProp(payload, "kind");
  if (kind === "upsert") {
    const id = readProp(readProp(payload, "agent"), "id");
    if (typeof id === "string") {
      agentIds.add(id);
      return true;
    }
  }
  if (kind === "remove") {
    const id = readProp(payload, "agentId");
    if (typeof id === "string") {
      agentIds.delete(id);
      return true;
    }
  }
  return false;
}

/** Label for one agent's ongoing symphonies: a count, attention first. */
export function symphonyPillLabel(
  symphonies: readonly SymphonyListEntry[],
): string {
  const only = symphonies[0];
  if (symphonies.length === 1 && only) {
    return `Symphony ${only.completedTasks}/${only.taskCount}`;
  }
  return `${symphonies.length} symphonies`;
}

function pillLabel(symphonies: readonly SymphonyListEntry[]): string {
  const blocked = pillIcon(symphonies) === PILL_ATTENTION_ICON;
  return blocked ? PILL_ATTENTION_LABEL : symphonyPillLabel(symphonies);
}

function pillIcon(symphonies: readonly SymphonyListEntry[]): string {
  return symphonies.some((symphony) => symphony.status === "blocked")
    ? PILL_ATTENTION_ICON
    : PILL_ICON;
}

/** Groups ongoing symphonies by Conductor agent, in list order. */
function ongoingGroups(
  symphonies: readonly SymphonyListEntry[],
  agentIds: ReadonlySet<string>,
): Map<string, OngoingGroup> {
  const groups = new Map<string, OngoingGroup>();
  for (const symphony of symphonies) {
    if (!ONGOING_STATUSES.has(symphony.status)) {
      continue;
    }
    const agentId = symphony.source.agentId;
    // Symphonies without a Conductor agent get no pill anywhere.
    if (agentId === null || !agentIds.has(agentId)) {
      continue;
    }
    const group = groups.get(agentId);
    if (group) {
      group.symphonies.push(symphony);
    } else {
      groups.set(agentId, {
        workspaceId: symphony.source.concertId,
        symphonies: [symphony],
      });
    }
  }
  return groups;
}

/**
 * Registers one composer pill per Conductor agent that has ongoing
 * symphonies, refreshed from `symphonies.list`: once at registration, again
 * after every debounced agent-list update, and every fallback interval. The
 * returned remover aborts the loop, releases the subscription, and removes
 * every pill.
 */
export function registerSymphonyPills(
  client: SymphonyPillClient,
  options: SymphonyPillOptions = {},
): SymphonyPillsCleanup {
  const timers = options.timers ?? defaultTimers;
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const fallbackMs = options.fallbackMs ?? DEFAULT_FALLBACK_MS;
  const lifetime = new AbortController();
  if (typeof client.addComposerPill !== "function") {
    // A host without the composer-pill API must still load the rest of the
    // plugin: skip the refresh loop entirely, abort nothing in flight.
    return () => {
      lifetime.abort();
    };
  }
  const addComposerPill = client.addComposerPill.bind(client);
  const pills = new Map<string, SymphoniesPill>();
  /** Agents currently present, from the live agents subscription. */
  const agentIds = new Set<string>();
  /** Last successful list; reconcile rereads it when the agent set moves. */
  let latest: SymphonyListEntry[] = [];
  let subscription: PillAgentsSubscription | undefined;
  let debounce: unknown;
  let fallback: unknown;

  function reconcile(): void {
    if (lifetime.signal.aborted) {
      return;
    }
    const groups = ongoingGroups(latest, agentIds);
    for (const [agentId, group] of groups) {
      const label = pillLabel(group.symphonies);
      const icon = pillIcon(group.symphonies);
      let pill = pills.get(agentId);
      if (pill && pill.workspaceId !== group.workspaceId) {
        // The host keys a pill by workspace and agent, so a moved group must
        // re-register: one live registration per agent, never a duplicate.
        pill.registration.remove();
        pills.delete(agentId);
        pill = undefined;
      }
      if (pill) {
        pill.current.symphonies = group.symphonies;
        if (pill.label !== label || pill.icon !== icon) {
          // Presentation only: a behavior patch would close an open popover.
          pill.registration.update({ title: PILL_TITLE, label, icon });
          pill.label = label;
          pill.icon = icon;
        }
        continue;
      }
      const current = { symphonies: group.symphonies };
      pills.set(agentId, {
        workspaceId: group.workspaceId,
        registration: addComposerPill({
          id: PILL_ID,
          workspaceId: group.workspaceId,
          agentId,
          button: {
            title: PILL_TITLE,
            label,
            icon,
            behavior: {
              kind: "popover",
              Content: createContent(
                client,
                agentId,
                current,
                options.selectSymphony,
              ),
            },
          },
        }),
        current,
        label,
        icon,
      });
    }
    for (const [agentId, pill] of pills) {
      if (groups.has(agentId)) {
        continue;
      }
      pill.registration.remove();
      pills.delete(agentId);
    }
  }

  /** At most one list request in flight; extra triggers queue one rerun. */
  let refreshing = false;
  let rerunQueued = false;

  /** Serializes refreshes so an older response can never overwrite a newer
   * one: the request order is the apply order. */
  async function refresh(): Promise<void> {
    if (refreshing) {
      rerunQueued = true;
      return;
    }
    refreshing = true;
    try {
      for (;;) {
        if (lifetime.signal.aborted) {
          return;
        }
        let symphonies: SymphonyListEntry[];
        try {
          symphonies = (await client.rpc(listSymphonies, {})).symphonies;
        } catch {
          // An RPC failure keeps the current pills; the next trigger retries.
          return;
        }
        if (lifetime.signal.aborted) {
          return;
        }
        latest = symphonies;
        reconcile();
        if (!rerunQueued || lifetime.signal.aborted) {
          return;
        }
        rerunQueued = false;
      }
    } finally {
      refreshing = false;
    }
  }

  function scheduleRefresh(): void {
    if (lifetime.signal.aborted || debounce !== undefined) {
      return;
    }
    debounce = timers.set(() => {
      debounce = undefined;
      refresh().catch(() => undefined);
    }, debounceMs);
  }

  function scheduleFallback(): void {
    if (lifetime.signal.aborted || fallback !== undefined) {
      return;
    }
    fallback = timers.set(() => {
      fallback = undefined;
      if (lifetime.signal.aborted) {
        return;
      }
      refresh().catch(() => undefined);
      scheduleFallback();
    }, fallbackMs);
  }

  const attach = async (): Promise<void> => {
    const agents = await client.paseo.agents.list({ subscribe: {} });
    if (lifetime.signal.aborted) {
      await agents.subscription.release();
      return;
    }
    subscription = agents.subscription;
    // The list response seeds the agent set, but subscribe() may deliver its
    // snapshot and buffered updates synchronously, so it goes last and the
    // delivered state stands; resetting from the response afterward would
    // undo a buffered removal or drop an upserted agent.
    for (const entry of agents.entries) {
      agentIds.add(entry.agent.id);
    }
    agents.subscription.subscribe({
      snapshot: (snapshot) => {
        agentIds.clear();
        for (const entry of snapshot.entries) {
          agentIds.add(entry.agent.id);
        }
        // A symphony whose agent left drops its pill even before the next
        // list succeeds, so an RPC failure cannot pin a stale pill.
        reconcile();
        scheduleRefresh();
      },
      update: (message) => {
        if (updateAgentIds(agentIds, message)) {
          reconcile();
          scheduleRefresh();
        }
      },
      error: scheduleRefresh,
    });
    reconcile();
    scheduleFallback();
  };

  attach().catch(() => {
    scheduleFallback();
  });
  refresh().catch(() => undefined);

  return async () => {
    lifetime.abort();
    timers.clear(debounce);
    timers.clear(fallback);
    debounce = undefined;
    fallback = undefined;
    for (const pill of pills.values()) {
      pill.registration.remove();
    }
    pills.clear();
    await subscription?.release().catch(() => undefined);
  };
}

function createContent(
  client: Pick<SymphonyPillClient, "openPanel">,
  agentId: string,
  current: { symphonies: SymphonyListEntry[] },
  selectSymphony: SymphonyPillOptions["selectSymphony"],
): ComponentType<PluginButtonContentProps> {
  const Content: ComponentType<PluginButtonContentProps> = (props) =>
    createElement(SymphoniesPillContent, {
      theme: props.theme,
      // Read live at every open; a snapshot would go stale between opens.
      entries: current.symphonies,
      onOpen: (symphony) => {
        props.close();
        const workspaceId = symphony.source.concertId;
        selectSymphony?.({
          hostId: props.host.id,
          workspaceId,
          symphonyId: symphony.id,
        });
        client.openPanel("podium", { workspaceId, agentId });
      },
    });
  return Content;
}
