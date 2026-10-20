import { Text, View } from "react-native";
import type {
  PluginButtonContentProps,
  PluginButtonRegistration,
  PluginClientContext,
} from "@getpaseo/plugin/client";
import {
  readReminderConfig,
  type ReminderConfig,
} from "../../shared/context-reminder/contracts";
import {
  DEFAULT_WINDOW_TOKENS,
  percentOfWindow,
} from "../../shared/context-reminder/gauge";
import { reminderTier } from "../../shared/context-reminder/reminder-policy";
import { ReminderCard } from "./reminder-card";
import {
  clearReading,
  setReading,
  useReading,
  type ReminderAgent,
} from "./readings";

const PILL_ID = "context-reminder";
const PILL_TITLE = "Context Reminder";
const PILL_ICON = "AlarmClock";
const CONFIG_TTL_MS = 60_000;
/** Mirrors Paseo's delegated-agent label; client code cannot import protocol. */
const PARENT_AGENT_ID_LABEL = "paseo.parent-agent-id";

type PillClient = Pick<
  PluginClientContext,
  "paseo" | "rpc" | "addComposerPill"
>;

interface ReminderPill {
  registration: PluginButtonRegistration;
  workspaceId: string;
  label: string;
  visible: boolean;
}

const refreshers = new Set<() => void>();

/** Drops the cached config and checks every known agent again. */
export function refreshReminderPills(): void {
  for (const refresh of refreshers) {
    refresh();
  }
}

function isTopLevel(agent: ReminderAgent): boolean {
  return !agent.labels[PARENT_AGENT_ID_LABEL]?.trim();
}

function ReminderPillContent(props: PluginButtonContentProps) {
  const agentId = props.context === "agent" ? props.agentId : null;
  const reading = useReading(agentId);

  if (agentId === null || reading === null) {
    return (
      <Text style={{ color: props.theme.colors.foregroundMuted }}>
        No context reading yet.
      </Text>
    );
  }

  return (
    <View
      style={{ width: props.layout.compact ? "100%" : 380, maxWidth: "100%" }}
    >
      <ReminderCard
        theme={props.theme}
        layout={props.layout}
        agentId={agentId}
        notice={reading}
      />
    </View>
  );
}

/**
 * Shows a composer pill for each top-level agent whose context fill is at or
 * above the warn threshold. The popover shows the agent's live reading.
 */
export function registerReminderPills(client: PillClient): () => void {
  const lifetime = new AbortController();
  const agents = new Map<string, ReminderAgent>();
  const pills = new Map<string, ReminderPill>();
  let cached: { config: ReminderConfig; at: number } | null = null;
  let pendingConfig: Promise<ReminderConfig> | null = null;
  let release: (() => Promise<void>) | undefined;

  function readConfig(): Promise<ReminderConfig> {
    if (cached && Date.now() - cached.at < CONFIG_TTL_MS) {
      return Promise.resolve(cached.config);
    }

    pendingConfig ??= client
      .rpc(readReminderConfig, {})
      .then((config) => {
        cached = { config, at: Date.now() };

        return config;
      })
      .catch((error: unknown) => {
        cached = null;
        throw error;
      })
      .finally(() => {
        pendingConfig = null;
      });

    return pendingConfig;
  }

  function hide(agentId: string): void {
    const pill = pills.get(agentId);

    if (pill?.visible) {
      pill.registration.update({ visible: false });
      pill.visible = false;
    }

    clearReading(agentId);
  }

  function forget(agentId: string): void {
    agents.delete(agentId);
    pills.get(agentId)?.registration.remove();
    pills.delete(agentId);
    clearReading(agentId);
  }

  function show(agentId: string, workspaceId: string, label: string): void {
    let pill = pills.get(agentId);

    if (pill && pill.workspaceId !== workspaceId) {
      // Pills are keyed by workspace and agent; a moved agent re-registers.
      pill.registration.remove();
      pills.delete(agentId);
      pill = undefined;
    }

    if (!pill) {
      pills.set(agentId, {
        workspaceId,
        label,
        visible: true,
        registration: client.addComposerPill({
          id: PILL_ID,
          workspaceId,
          agentId,
          button: {
            title: PILL_TITLE,
            icon: PILL_ICON,
            label,
            behavior: { kind: "popover", Content: ReminderPillContent },
          },
        }),
      });

      return;
    }

    if (pill.label !== label || !pill.visible) {
      // Presentation only: a behavior patch would close an open popover.
      pill.registration.update({ label, visible: true });
      pill.label = label;
      pill.visible = true;
    }
  }

  async function check(agent: ReminderAgent): Promise<void> {
    const usage = agent.lastUsage;
    const used = usage?.contextWindowUsedTokens;

    if (!isTopLevel(agent) || !agent.workspaceId || agent.archivedAt || !used) {
      hide(agent.id);

      return;
    }

    let config: ReminderConfig;

    try {
      config = await readConfig();
    } catch {
      // Keep the current pill; the next update or refresh retries.
      return;
    }

    // Skip stale checks: the agent moved on, left, or the plugin stopped.
    if (lifetime.signal.aborted || agents.get(agent.id) !== agent) {
      return;
    }

    const max = usage.contextWindowMaxTokens || DEFAULT_WINDOW_TOKENS;
    const tier = config.enabled ? reminderTier(used, max, config) : null;

    if (tier === null) {
      hide(agent.id);

      return;
    }

    setReading(agent.id, {
      usedTokens: used,
      maxTokens: max,
      tier,
      snoozeMinutes: config.snoozeMinutes,
      status: agent.status,
    });
    show(agent.id, agent.workspaceId, `${percentOfWindow(used, max)}%`);
  }

  function track(agent: ReminderAgent): void {
    agents.set(agent.id, agent);
    void check(agent);
  }

  function seed(entries: readonly { agent: ReminderAgent }[]): void {
    const present = new Set(entries.map((entry) => entry.agent.id));

    for (const agentId of [...agents.keys()]) {
      if (!present.has(agentId)) {
        forget(agentId);
      }
    }

    for (const { agent } of entries) {
      track(agent);
    }
  }

  function refresh(): void {
    cached = null;

    for (const agent of agents.values()) {
      void check(agent);
    }
  }

  refreshers.add(refresh);

  const unsubscribe = client.paseo.agents.subscribe((update) => {
    if (update.kind === "upsert") {
      track(update.agent);
    } else {
      forget(update.agentId);
    }
  });

  // The owned list subscription starts the daemon's agent stream; its
  // snapshots also resynchronize the agent set after a reconnect.
  client.paseo.agents
    .list({ subscribe: {}, signal: lifetime.signal })
    .then(async ({ entries, subscription }) => {
      if (lifetime.signal.aborted) {
        await subscription.release();

        return;
      }

      release = () => subscription.release();
      seed(entries);
      subscription.subscribe({
        snapshot: (snapshot) => seed(snapshot.entries),
        update: () => undefined,
      });
    })
    .catch((error: unknown) => {
      if (!lifetime.signal.aborted) {
        console.error("[context-reminder] agent observation failed", error);
      }
    });

  return () => {
    lifetime.abort();
    refreshers.delete(refresh);
    unsubscribe();

    for (const agentId of [...agents.keys(), ...pills.keys()]) {
      forget(agentId);
    }

    release?.().catch(() => undefined);
  };
}
