import { z } from "zod";
import { identifier } from "../schema";
import {
  SYMPHONY_LIMITS,
  uuidSchema,
  scopeSchema,
  taskIdSchema,
  taskReportSchema,
} from "./models";

const text = (max: number) => z.string().trim().min(1).max(max);
// A task agent comes from a configured profile or an inline provider/model
// choice. The permission mode is never chosen here; it derives from the
// Conductor.
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
/** Keeps only the set worker choice fields, so stored records stay minimal. */
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
export const symphonyCommandSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("orchestrate"),
      key: text(160),
      title: text(160),
      goal: text(16000),
      concurrency: z.number().int().min(1).max(4).default(3),
      conductor: z.enum(["self", "agent"]).optional(),
      conductorProfile: text(160).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("define"),
      symphonyId: uuidSchema,
      tasks: z.array(commandTaskSchema).min(1).max(12),
    })
    .strict(),
  z
    .object({
      kind: z.literal("dispatch"),
      symphonyId: uuidSchema,
      retryTaskId: taskIdSchema.optional(),
      note: text(2000).optional(),
      addWrites: z.array(scopeSchema).min(1).max(32).optional(),
      ...workerChoiceFields,
    })
    .strict()
    .refine(oneWorkerSource, workerSourceMessage)
    .refine(
      (value) =>
        value.retryTaskId !== undefined ||
        (value.note === undefined && value.addWrites === undefined),
      "note and addWrites require retryTaskId.",
    ),
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
  z.object({ kind: z.literal("get"), symphonyId: uuidSchema }).strict(),
  z
    .object({
      kind: z.literal("claim"),
      symphonyId: uuidSchema,
      taskId: taskIdSchema,
      retry: z.boolean().default(false),
    })
    .strict(),
  z
    .object({
      kind: z.literal("block"),
      symphonyId: uuidSchema,
      attemptId: uuidSchema,
      message: text(4000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("report"),
      symphonyId: uuidSchema,
      attemptId: uuidSchema,
      report: taskReportSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("finish"),
      symphonyId: uuidSchema,
      summary: text(8000),
    })
    .strict(),
  // The assigned task agent widens its own attempt's write scope.
  z
    .object({
      kind: z.literal("widen"),
      symphonyId: uuidSchema,
      attemptId: uuidSchema,
      paths: z.array(scopeSchema).min(1).max(SYMPHONY_LIMITS.widenPathsPerCall),
      reason: text(2000),
    })
    .strict(),
]);
export const agentCommandRequestSchema = z
  .object({ agentId: identifier, command: symphonyCommandSchema })
  .strict();
export type SymphonyCommand = z.infer<typeof symphonyCommandSchema>;
export type AgentCommandRequest = z.infer<typeof agentCommandRequestSchema>;
