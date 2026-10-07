import { z } from "zod";
import { identifier } from "../schema";
import {
  runIdSchema,
  scopeSchema,
  taskIdSchema,
  taskReportSchema,
} from "./models";

const text = (max: number) => z.string().trim().min(1).max(max);
// A worker comes from a configured profile or an inline provider/model choice.
// The permission mode is never chosen here; it derives from the Conductor.
const workerChoiceFields = {
  profile: text(160).optional(),
  provider: text(80).optional(),
  model: text(160).optional(),
  thinkingOptionId: text(80).optional(),
};
export interface WorkerChoice {
  profile?: string;
  provider?: string;
  model?: string;
  thinkingOptionId?: string;
}
type LooseWorkerChoice = {
  [Key in keyof WorkerChoice]?: WorkerChoice[Key] | undefined;
};
/** Keeps only the worker fields that are set, so stored records stay minimal. */
export function workerChoice(value: LooseWorkerChoice): WorkerChoice {
  const choice: WorkerChoice = {};
  for (const key of [
    "profile",
    "provider",
    "model",
    "thinkingOptionId",
  ] as const) {
    const field = value[key];
    if (field !== undefined) {
      choice[key] = field;
    }
  }
  return choice;
}
const oneWorkerSource = (value: LooseWorkerChoice) =>
  !(value.profile && (value.provider || value.model || value.thinkingOptionId));
const workerSourceMessage =
  "Use either profile or provider/model/thinkingOptionId, not both.";

// Concerts started before the renames stored prompts that send runId or
// performanceId.
function acceptLegacyIds(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const { runId, performanceId, ...rest } = value as Record<string, unknown>;
  const ids = [rest.concertId, performanceId, runId].filter(
    (id) => id !== undefined,
  );
  if (ids.length === 0 || ids.some((id) => id !== ids[0])) {
    // Keep every key so the strict schema rejects a conflicting pair.
    return value;
  }
  return { ...rest, concertId: ids[0] };
}

export const commandTaskSchema = z
  .object({
    id: taskIdSchema,
    title: text(160),
    description: text(4000),
    dependsOn: z.array(taskIdSchema).max(40).default([]),
    reads: z.array(scopeSchema).max(32).default(["."]),
    writes: z.array(scopeSchema).max(32).default(["."]),
    resources: z.array(taskIdSchema).max(16).default([]),
    checks: z.array(text(1000)).max(16).default([]),
    ...workerChoiceFields,
  })
  .strict()
  .refine(oneWorkerSource, workerSourceMessage);
const runAgentCommandUnion = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("orchestrate"),
      key: text(160),
      title: text(160),
      goal: text(16000),
      concurrency: z.number().int().min(1).max(4).default(3),
      coordinator: z.enum(["self", "agent"]).optional(),
      coordinatorProfile: text(160).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("define"),
      concertId: runIdSchema,
      tasks: z.array(commandTaskSchema).min(1).max(12),
    })
    .strict(),
  z
    .object({
      kind: z.literal("dispatch"),
      concertId: runIdSchema,
      retryTaskId: taskIdSchema.optional(),
      ...workerChoiceFields,
    })
    .strict()
    .refine(oneWorkerSource, workerSourceMessage),
  z.object({ kind: z.literal("profiles") }).strict(),
  z.object({ kind: z.literal("models") }).strict(),

  z
    .object({
      kind: z.literal("start"),
      key: text(160),
      title: text(160),
      goal: text(16000),
      tasks: z.array(commandTaskSchema).min(1).max(40).optional(),
    })
    .strict(),
  z.object({ kind: z.literal("list") }).strict(),
  z.object({ kind: z.literal("get"), concertId: runIdSchema }).strict(),
  z
    .object({
      kind: z.literal("remove-legacy"),
      concertId: runIdSchema,
      expectedVersion: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("claim"),
      concertId: runIdSchema,
      taskId: taskIdSchema,
      retry: z.boolean().default(false),
    })
    .strict(),
  z
    .object({
      kind: z.literal("block"),
      concertId: runIdSchema,
      attemptId: runIdSchema,
      message: text(4000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("report"),
      concertId: runIdSchema,
      attemptId: runIdSchema,
      report: taskReportSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("finish"),
      concertId: runIdSchema,
      summary: text(8000),
    })
    .strict(),
]);
export const runAgentCommandSchema = z.preprocess(
  acceptLegacyIds,
  runAgentCommandUnion,
);
export const agentCommandRequestSchema = z
  .object({ agentId: identifier, command: runAgentCommandSchema })
  .strict();
export type RunAgentCommand = z.infer<typeof runAgentCommandSchema>;
export type AgentCommandRequest = z.infer<typeof agentCommandRequestSchema>;
