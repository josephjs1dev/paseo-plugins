import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const cliIds = ["codex", "opencode", "pi"] as const;
export const cliSchema = z.enum(cliIds);
export type CliId = z.infer<typeof cliSchema>;
export const cliNames: Record<CliId, string> = {
  codex: "Codex",
  opencode: "OpenCode",
  pi: "Pi",
};
export const cliStatusSchema = z.object({
  id: cliSchema,
  installed: z.string().nullable(),
  latest: z.string().nullable(),
  executable: z.string(),
  method: z.string(),
  canUpdate: z.boolean(),
  message: z.string(),
});
export type CliStatus = z.infer<typeof cliStatusSchema>;
export const maintenanceSchema = z.object({
  busy: z.boolean(),
  action: z.string(),
  checkedAt: z.string().nullable(),
  rows: z.array(cliStatusSchema),
  message: z.string(),
});
export type Maintenance = z.infer<typeof maintenanceSchema>;
export const readMaintenance = defineRpc({
  name: "cli.status",
  input: z.object({}),
  output: maintenanceSchema,
});
export const checkCliUpdates = defineRpc({
  name: "cli.check",
  input: z.object({}),
  output: maintenanceSchema,
});
export const applyCliUpdate = defineRpc({
  name: "cli.update",
  input: z.object({ id: cliSchema, version: z.string().max(100) }),
  output: maintenanceSchema,
});
export const refreshCliModels = defineRpc({
  name: "cli.models.refresh",
  input: z.object({
    id: cliSchema,
    workspaceId: z.string().min(1).max(200).optional(),
  }),
  output: maintenanceSchema,
});

export function isNewerStable(installed: string, latest: string): boolean {
  const pattern = /^\d+\.\d+\.\d+$/;

  if (!pattern.test(installed) || !pattern.test(latest)) {
    return false;
  }

  const a = installed.split(".").map(Number);
  const b = latest.split(".").map(Number);

  for (let i = 0; i < 3; i++) {
    const delta = (b[i] ?? 0) - (a[i] ?? 0);

    if (delta !== 0) {
      return delta > 0;
    }
  }

  return false;
}
