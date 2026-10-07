import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import {
  contextSchema,
  runIdSchema,
  runSchema,
  runSummarySchema,
  RUN_LIMITS,
} from "./models";
import { identifier } from "../schema";

export const listRuns = defineRpc({
  name: "runs.list",
  input: z.object({ workspaceId: identifier.optional() }),
  output: z.object({
    runs: z.array(runSummarySchema).max(RUN_LIMITS.runs),
    unavailable: z.number().int().nonnegative(),
    incomplete: z.boolean(),
  }),
});
export const readRun = defineRpc({
  name: "runs.read",
  input: z.object({ id: runIdSchema }),
  output: z.object({ run: runSchema, context: contextSchema }),
});
export const deleteRun = defineRpc({
  name: "runs.delete",
  input: z
    .object({
      id: runIdSchema,
      version: z.number().int().nonnegative(),
    })
    .strict(),
  output: z.object({ deleted: z.literal(true) }),
});
export const getRunAccess = defineRpc({
  name: "runs.access",
  input: z.object({}),
  output: z.object({
    available: z.boolean(),
    commandPath: z.string().nullable(),
    socketPath: z.string().nullable(),
    message: z.string().nullable(),
  }),
});
