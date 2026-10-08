import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import {
  contextSchema,
  uuidSchema,
  symphonySchema,
  symphonySummarySchema,
  SYMPHONY_LIMITS,
} from "./models";
import { identifier } from "../schema";

export const listSymphonies = defineRpc({
  name: "symphonies.list",
  input: z.object({ concertId: identifier.optional() }).strict(),
  output: z.object({
    symphonies: z.array(symphonySummarySchema).max(SYMPHONY_LIMITS.symphonies),
    unavailable: z.number().int().nonnegative(),
    incomplete: z.boolean(),
  }),
});
export const readSymphony = defineRpc({
  name: "symphonies.read",
  input: z.object({ id: uuidSchema }).strict(),
  output: z.object({ symphony: symphonySchema, context: contextSchema }),
});
export const deleteSymphony = defineRpc({
  name: "symphonies.delete",
  input: z
    .object({
      id: uuidSchema,
      version: z.number().int().nonnegative(),
    })
    .strict(),
  output: z.object({ deleted: z.literal(true) }),
});
export const getSymphonyAccess = defineRpc({
  name: "symphonies.access",
  input: z.object({}).strict(),
  output: z.object({
    available: z.boolean(),
    commandPath: z.string().nullable(),
    socketPath: z.string().nullable(),
    message: z.string().nullable(),
  }),
});
