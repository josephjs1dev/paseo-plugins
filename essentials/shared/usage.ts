import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

import { providerDefinitions, providerSchema } from "./providers";
import { remainingPercent } from "./usage-display";

export { providerSchema } from "./providers";
export type { Provider } from "./providers";

export const creditsSchema = z.object({
  hasCredits: z.boolean(),
  unlimited: z.boolean(),
  balance: z.number().finite().nonnegative().nullable(),
});

export const usageSchema = z.object({
  provider: providerSchema,
  status: z.enum(["ok", "unavailable"]),
  message: z.string().max(240),
  issue: z.enum(["sign-in", "rate-limit"]).optional(),
  checkedAt: z.string().datetime(),
  credits: creditsSchema.nullable().optional(),
  resetCredits: z
    .object({
      availableCount: z.number().int().nonnegative(),
      earliestExpiresAt: z.string().datetime().optional(),
    })
    .nullable()
    .optional(),
  windows: z
    .array(
      z.object({
        name: z.string().max(160),
        usedPercent: z.number().finite().min(0),
        resetsAt: z.string().datetime().nullable(),
        durationMinutes: z.number().finite().positive().optional(),
      }),
    )
    .max(64),
});

export type Usage = z.infer<typeof usageSchema>;
export const quotaSchema = usageSchema.pick({
  windows: true,
  resetCredits: true,
  credits: true,
});
export type Quota = z.infer<typeof quotaSchema>;

export const readUsage = defineRpc({
  name: "usage.read",
  input: z.object({
    provider: providerSchema,
    refresh: z.boolean().optional(),
  }),
  output: usageSchema,
});

export function usageLabel(usage: Usage): string {
  const { name } = providerDefinitions[usage.provider];

  if (usage.status !== "ok" || !usage.windows.length) {
    return `${name} · —`;
  }

  const used = Math.max(...usage.windows.map((window) => window.usedPercent));
  const fiveHour = usage.windows.filter(
    (window) => window.durationMinutes === 300,
  );

  if (fiveHour.length) {
    const remaining = Math.round(
      remainingPercent(
        Math.max(...fiveHour.map((window) => window.usedPercent)),
      ),
    );

    return `${name} · 5h ${remaining}% left`;
  }

  return `${name} · ${Math.round(remainingPercent(used))}% left`;
}
