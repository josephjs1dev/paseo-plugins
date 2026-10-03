import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const maintenanceHostSchema = z.object({
  id: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(/^[A-Za-z0-9_-]+$/),
  name: z.string().trim().min(1).max(255),
});

export const readMaintenanceHost = defineRpc({
  name: "cli.host",
  input: z.object({}),
  output: maintenanceHostSchema,
});
