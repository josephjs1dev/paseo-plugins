import type {
  PluginHandlerContext,
  PluginServerContext,
} from "@getpaseo/plugin/server";
import {
  CONTEXT_REMINDER_KIND,
  CONTEXT_REMINDER_VERSION,
  DEFAULT_SETTINGS,
  contextReminderSettings,
  demoReminder,
  readReminderConfig,
  snoozeReminder,
  toReminderConfig,
  type ContextReminderSettings,
  type ReminderNotice,
} from "../shared/context-reminder/contracts";
import { DEFAULT_WINDOW_TOKENS } from "../shared/context-reminder/gauge";
import {
  FRESH_STATE,
  nextReminder,
  reminderTier,
  type ReminderState,
} from "../shared/context-reminder/reminder-policy";

type Paseo = PluginHandlerContext["paseo"];

const LOG_PREFIX = "[context-reminder]";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function appendNotice(
  paseo: Paseo,
  agentId: string,
  id: string,
  notice: ReminderNotice,
): Promise<void> {
  await paseo.agents.ref(agentId).timeline.append({
    type: "plugin",
    id,
    kind: CONTEXT_REMINDER_KIND,
    version: CONTEXT_REMINDER_VERSION,
    data: notice,
  });
}

/**
 * Watches top-level agents' context-window fill after each turn and appends
 * a reminder card when a threshold is crossed. Reminder state lives in daemon
 * memory, so a daemon restart clears turn counts and snoozes.
 */
export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(contextReminderSettings);
  const states = new Map<string, ReminderState>();
  let missingReadLogged = false;

  async function readSettings(): Promise<ContextReminderSettings> {
    // Older hosts can return a handle without `read`.
    if (typeof settings?.read !== "function") {
      if (!missingReadLogged) {
        missingReadLogged = true;
        console.error(
          `${LOG_PREFIX} settings handle has no read(); using defaults`,
        );
      }

      return DEFAULT_SETTINGS;
    }

    try {
      const state = await settings.read();

      if (state.status !== "ready") {
        return DEFAULT_SETTINGS;
      }

      const parsed = contextReminderSettings.schema.safeParse(state.values);

      return parsed.success ? parsed.data : DEFAULT_SETTINGS;
    } catch (error) {
      console.error(
        `${LOG_PREFIX} settings read failed: ${errorMessage(error)}`,
      );

      return DEFAULT_SETTINGS;
    }
  }

  async function remind(
    paseo: Paseo,
    agentId: string,
    turnId: string | null,
  ): Promise<void> {
    const refreshed = await paseo.agents.ref(agentId).refresh();
    const usage = refreshed?.agent.lastUsage;
    const used = usage?.contextWindowUsedTokens;

    if (!used) {
      return;
    }

    const config = await readSettings();

    if (!config.enabled) {
      return;
    }

    const max = usage.contextWindowMaxTokens || DEFAULT_WINDOW_TOKENS;
    const next = nextReminder(
      states.get(agentId) ?? FRESH_STATE,
      used,
      max,
      config,
      Date.now(),
    );
    states.set(agentId, next.state);

    if (next.tier === null) {
      return;
    }

    await appendNotice(
      paseo,
      agentId,
      `context-reminder-${turnId ?? Date.now()}`,
      {
        usedTokens: used,
        maxTokens: max,
        tier: next.tier,
        snoozeMinutes: config.snoozeMinutes,
      },
    );
  }

  server.handle(readReminderConfig, async () =>
    toReminderConfig(await readSettings()),
  );
  server.handle(snoozeReminder, ({ agentId, minutes }) => {
    const snoozedUntil = Date.now() + minutes * 60_000;
    states.set(agentId, {
      ...(states.get(agentId) ?? FRESH_STATE),
      snoozedUntil,
    });

    return { snoozedUntil: new Date(snoozedUntil).toISOString() };
  });
  server.handle(demoReminder, async ({ agentId, percent }, { paseo }) => {
    const config = await readSettings();
    const used = Math.round((percent * DEFAULT_WINDOW_TOKENS) / 100);
    await appendNotice(paseo, agentId, `context-reminder-demo-${Date.now()}`, {
      usedTokens: used,
      maxTokens: DEFAULT_WINDOW_TOKENS,
      tier: reminderTier(used, DEFAULT_WINDOW_TOKENS, config) ?? "warn",
      snoozeMinutes: config.snoozeMinutes,
    });

    return {};
  });

  const removeTurnEnded = server.on(
    "agent.turn_ended",
    ({ agent, turnId }, { paseo }) => {
      if (agent.parentAgentId) {
        return;
      }

      // Hooks time out after 30 s; the refresh and append run detached.
      void (async () => {
        try {
          await remind(paseo, agent.id, turnId);
        } catch (error) {
          console.error(
            `${LOG_PREFIX} reminder failed for agent ${agent.id}: ${errorMessage(error)}`,
          );
        }
      })();
    },
  );
  const removeArchived = server.on("agent.archived", ({ agent }) => {
    states.delete(agent.id);
  });

  // RPC handlers have no remover; Paseo drops them when the plugin stops.
  return () => {
    removeTurnEnded();
    removeArchived();
    states.clear();
  };
}
