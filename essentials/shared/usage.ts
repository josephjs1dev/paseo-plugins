import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

import { providerDefinitions, providerSchema } from "./providers";
import { remainingPercent } from "./usage-display";

export { providerSchema } from "./providers";
export type { Provider } from "./providers";

export const usageSchema = z.object({
  provider: providerSchema,
  status: z.enum(["ok", "unavailable"]),
  message: z.string().max(240),
  checkedAt: z.string().datetime(),
  resetCredits: z
    .object({ availableCount: z.number().int().nonnegative() })
    .nullable()
    .optional(),
  windows: z
    .array(
      z.object({
        name: z.string().max(160),
        usedPercent: z.number().finite().min(0),
        resetsAt: z.string().datetime().nullable(),
      }),
    )
    .max(64),
});

export type Usage = z.infer<typeof usageSchema>;
export type Quota = Pick<Usage, "windows" | "resetCredits">;

export const readUsage = defineRpc({
  name: "usage.read",
  input: z.object({ provider: providerSchema }),
  output: usageSchema,
});

export function usageLabel(usage: Usage): string {
  const { name } = providerDefinitions[usage.provider];

  if (usage.status !== "ok" || !usage.windows.length) {
    return `${name} · —`;
  }

  const used = Math.max(...usage.windows.map((window) => window.usedPercent));

  return `${name} · ${Math.round(remainingPercent(used))}% left`;
}
