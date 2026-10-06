import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import {
  contextSchema,
  runIdSchema,
  runSchema,
  runSummarySchema,
  RUN_LIMITS,
} from "./run-models";
import { identifier } from "./models";

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

const orchestrationRequest = {
  key: z.string().trim().min(1).max(160),
  goal: z.string().trim().min(1).max(16000),
  coordinatorProfile: z.string().trim().min(1).max(160).optional(),
};
export const orchestrateRun = defineRpc({
  name: "runs.orchestrate",
  input: z.union([
    z.object({ ...orchestrationRequest, agentId: identifier }).strict(),
    z.object({ ...orchestrationRequest, workspaceId: identifier }).strict(),
  ]),
  output: z.object({ run: runSchema }),
});
