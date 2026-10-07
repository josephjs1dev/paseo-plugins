import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import {
  contextSchema,
  uuidSchema,
  concertSchema,
  concertSummarySchema,
  CONCERT_LIMITS,
} from "./models";
import { identifier } from "../schema";

export const listConcerts = defineRpc({
  name: "runs.list",
  input: z.object({ workspaceId: identifier.optional() }),
  output: z.object({
    runs: z.array(concertSummarySchema).max(CONCERT_LIMITS.concerts),
    unavailable: z.number().int().nonnegative(),
    incomplete: z.boolean(),
  }),
});
export const readConcert = defineRpc({
  name: "runs.read",
  input: z.object({ id: uuidSchema }),
  output: z.object({ run: concertSchema, context: contextSchema }),
});
export const deleteConcert = defineRpc({
  name: "runs.delete",
  input: z
    .object({
      id: uuidSchema,
      version: z.number().int().nonnegative(),
    })
    .strict(),
  output: z.object({ deleted: z.literal(true) }),
});
export const getConcertAccess = defineRpc({
  name: "runs.access",
  input: z.object({}),
  output: z.object({
    available: z.boolean(),
    commandPath: z.string().nullable(),
    socketPath: z.string().nullable(),
    message: z.string().nullable(),
  }),
});
