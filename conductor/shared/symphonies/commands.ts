import { z } from "zod";
import { identifier } from "../schema";
import {
  SYMPHONY_LIMITS,
  uuidSchema,
  scopeSchema,
  taskIdSchema,
  taskReportSchema,
  unresolvedItemSchema,
  loopApprovalSchema,
} from "./models";
import {
  commandRoutingSchema,
  routingRoleSchema,
  type WorkerChoice,
} from "./routing";

export type { WorkerChoice };

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
type LooseWorkerChoice = {
  [Key in keyof WorkerChoice]?: WorkerChoice[Key] | undefined;
};
const hasWorkerSource = (value: LooseWorkerChoice) =>
  Boolean(
    value.profile || value.provider || value.model || value.thinkingOptionId,
  );
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
    /** A read-only review of the other tasks' work; sets `role: "review"`. */
    review: z.boolean().optional(),
    /** The routing role; inferred from `review` and `writes` when omitted. */
    role: routingRoleSchema.optional(),
    /** The unresolved design decision a planning task exists to settle. */
    openDecision: text(500).optional(),
    routing: commandRoutingSchema.optional(),
    ...workerChoiceFields,
  })
  .strict()
  .superRefine((task, ctx) => {
    if (!oneWorkerSource(task)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: workerSourceMessage,
        path: ["profile"],
      });
    }
    if (task.role === "review" && !task.review) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "role review requires review: true.",
        path: ["role"],
      });
    }
    if (task.review && task.role && task.role !== "review") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A review task uses role review.",
        path: ["role"],
      });
    }
    if (task.role === "planning" && !task.openDecision) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Role planning needs openDecision naming the unresolved design decision; executing an approved design is implementation.",
        path: ["openDecision"],
      });
    }
    if (task.openDecision && task.role !== "planning") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "openDecision applies only to role planning.",
        path: ["openDecision"],
      });
    }
  });
export const symphonyCommandSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("orchestrate"),
      key: text(160),
      title: text(160),
      goal: text(16000),
      concurrency: z.number().int().min(1).max(4).default(3),
      maxLoops: z
        .number()
        .int()
        .min(1)
        .max(SYMPHONY_LIMITS.maxLoops)
        .optional(),
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
  // Starts loop N+1 after loop N ended needing changes: reopen the owning tasks
  // with their findings, optionally append new tasks, and defer the rest.
  z
    .object({
      kind: z.literal("loop"),
      symphonyId: uuidSchema,
      reason: text(2000),
      reopen: z
        .array(
          z
            .object({
              taskId: taskIdSchema,
              /** Finding ids from the previous loop, such as `review#F1`. */
              findings: z
                .array(text(300))
                .max(SYMPHONY_LIMITS.findingsPerReport)
                .optional(),
              note: text(2000).optional(),
              addWrites: z
                .array(scopeSchema)
                .min(1)
                .max(SYMPHONY_LIMITS.addedWritesPerAttempt)
                .optional(),
              /** Loop-only prerequisites; do not change the declared score. */
              after: z
                .array(taskIdSchema)
                .max(SYMPHONY_LIMITS.tasks)
                .optional(),
              ...workerChoiceFields,
              routing: commandRoutingSchema.optional(),
            })
            .strict()
            .superRefine((entry, ctx) => {
              if (!oneWorkerSource(entry)) {
                ctx.addIssue({
                  code: z.ZodIssueCode.custom,
                  message: workerSourceMessage,
                  path: ["profile"],
                });
              }
              if (hasWorkerSource(entry) && entry.routing === undefined) {
                ctx.addIssue({
                  code: z.ZodIssueCode.custom,
                  message: "A reopen worker override needs routing.reason.",
                  path: ["routing"],
                });
              }
              if (entry.routing !== undefined && !hasWorkerSource(entry)) {
                ctx.addIssue({
                  code: z.ZodIssueCode.custom,
                  message: "routing on a reopen requires a worker override.",
                  path: ["routing"],
                });
              }
            }),
        )
        .max(SYMPHONY_LIMITS.tasks)
        .default([]),
      tasks: z
        .array(commandTaskSchema)
        .min(1)
        .max(SYMPHONY_LIMITS.tasks)
        .optional(),
      deferred: z.array(unresolvedItemSchema).max(24).optional(),
      /** Required to pass the loop budget; recorded and shown in History. */
      approval: loopApprovalSchema.optional(),
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
      routing: commandRoutingSchema.optional(),
    })
    .strict()
    .refine(oneWorkerSource, workerSourceMessage)
    .refine(
      (value) =>
        value.retryTaskId !== undefined ||
        (value.note === undefined && value.addWrites === undefined),
      "note and addWrites require retryTaskId.",
    )
    .refine(
      (value) => value.routing === undefined || hasWorkerSource(value),
      "routing requires a replacement worker choice.",
    ),
  z
    .object({
      kind: z.literal("route"),
      role: routingRoleSchema,
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
      /** Open findings or non-completed tasks the user chose to stop on. */
      unresolved: z.array(unresolvedItemSchema).max(64).optional(),
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
