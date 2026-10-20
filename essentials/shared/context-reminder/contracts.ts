import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const CONTEXT_REMINDER_KIND = "context-reminder";
export const CONTEXT_REMINDER_VERSION = 1;

const tierSchema = z.enum(["warn", "ask"]);
const percentSchema = z.int().min(1).max(100);
const agentIdSchema = z.string().min(1).max(256);

/** Timeline data for one reminder card. */
export const reminderNoticeSchema = z.object({
  usedTokens: z.int().min(0),
  maxTokens: z.int().positive(),
  tier: tierSchema,
  snoozeMinutes: z.int().positive(),
});

export type ReminderNotice = z.infer<typeof reminderNoticeSchema>;

export const characterSchema = z.enum(["girl", "boy"]);

export const contextReminderSettings = defineSettings({
  id: "context-reminder",
  scope: "host",
  version: 1,
  schema: z.object({
    enabled: z.boolean().default(true),
    warnPercent: percentSchema.default(25),
    askPercent: percentSchema.default(50),
    notifyEvery: z.int().positive().default(10),
    snoozeMinutes: z.int().positive().default(60),
    character: characterSchema.default("girl"),
  }),
});

export type ContextReminderSettings = z.output<
  typeof contextReminderSettings.schema
>;

export const DEFAULT_SETTINGS: ContextReminderSettings =
  contextReminderSettings.schema.parse({});

export const reminderConfigSchema = z.object({
  enabled: z.boolean(),
  warnPercent: percentSchema,
  askPercent: percentSchema,
  snoozeMinutes: z.int().positive(),
  notifyEvery: z.int().positive(),
});

export type ReminderConfig = z.infer<typeof reminderConfigSchema>;

export function toReminderConfig(
  settings: ContextReminderSettings,
): ReminderConfig {
  const { enabled, warnPercent, askPercent, snoozeMinutes, notifyEvery } =
    settings;

  return { enabled, warnPercent, askPercent, snoozeMinutes, notifyEvery };
}

export const readReminderConfig = defineRpc({
  name: "context_reminder.config",
  input: z.object({}),
  output: reminderConfigSchema,
});

/** Snoozes are capped at one week. */
export const snoozeReminder = defineRpc({
  name: "context_reminder.snooze",
  input: z.object({
    agentId: agentIdSchema,
    minutes: z.int().positive().max(10_080),
  }),
  output: z.object({ snoozedUntil: z.iso.datetime() }),
});

export const demoReminder = defineRpc({
  name: "context_reminder.demo",
  input: z.object({
    agentId: agentIdSchema,
    percent: z.int().min(0).max(100),
  }),
  output: z.object({}),
});

export const WARN_PERCENT_OPTIONS = [
  10, 15, 20, 25, 30, 40, 50, 60, 70, 80,
] as const;
export const ASK_PERCENT_OPTIONS = [
  20, 25, 30, 40, 50, 60, 70, 80, 90,
] as const;
export const SNOOZE_MINUTE_OPTIONS = [15, 30, 60, 120, 240] as const;
export const NOTIFY_EVERY_OPTIONS = [1, 3, 5, 10, 20] as const;

export const DEMO_USAGE = "Use /context-reminder demo <0-100>.";

/** Parses `demo <0-100>` slash-command arguments; null when malformed. */
export function parseDemoArgs(args: string): number | null {
  const match = /^demo\s+(\d{1,3})$/.exec(args.trim());
  const percent = match ? Number(match[1]) : Number.NaN;

  return percent <= 100 ? percent : null;
}
