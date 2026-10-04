import { z } from "zod";

export const identifier = z.string().min(1).max(512);
export const keySchema = z.string().regex(/^[a-f0-9]{64}$/);
export const bucketSchema = z.enum([
  "waiting",
  "failed",
  "running",
  "closed",
  "idle",
]);
export type Bucket = z.infer<typeof bucketSchema>;
export const questionSchema = z.object({
  header: z.string().min(1).max(200),
  question: z.string().min(1).max(8000),
  options: z
    .array(
      z.object({
        label: z.string().min(1).max(1000),
        description: z.string().max(4000),
      }),
    )
    .max(30),
  multiSelect: z.boolean(),
  allowOther: z.boolean(),
  allowEmpty: z.boolean(),
});
export type Question = z.infer<typeof questionSchema>;
export const formSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("questions"),
    questions: z.array(questionSchema).min(1).max(12),
  }),
  z.object({
    kind: z.literal("actions"),
    actions: z
      .array(
        z.object({
          id: z.string().min(1).max(512),
          label: z.string().min(1).max(1000),
          behavior: z.enum(["allow", "deny"]),
        }),
      )
      .min(1)
      .max(12),
  }),
  z.object({ kind: z.literal("native"), reason: z.string().max(500) }),
]);
export type RequestForm = z.infer<typeof formSchema>;
export const decisionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("answers"),
    answers: z
      .array(
        z.object({
          selected: z.array(z.number().int().min(0).max(29)).max(30),
          text: z.string().max(4000),
        }),
      )
      .min(1)
      .max(12),
  }),
  z.object({ kind: z.literal("action"), actionId: identifier }),
]);
export type Decision = z.infer<typeof decisionSchema>;
export const deliverySchema = z.enum(["sending", "answered", "unknown"]);
export type Delivery = z.infer<typeof deliverySchema>;
export const turnOutcomeSchema = z.object({
  key: keySchema,
  turnId: identifier.nullable(),
  outcome: z.enum(["completed", "canceled", "failed"]),
  observedAt: z.string().datetime(),
});
export type TurnOutcome = z.infer<typeof turnOutcomeSchema>;
export const itemSchema = z.object({
  key: keySchema,
  agentId: identifier,
  requestId: identifier.nullable(),
  agentTitle: z.string().max(1000),
  provider: z.string().max(100),
  workspaceId: identifier.nullable(),
  workspaceName: z.string().max(1000),
  projectName: z.string().max(1000),
  parentAgentId: identifier.nullable(),
  parentAgentTitle: z.string().max(1000).nullable(),
  childAgentCount: z.number().int().nonnegative(),
  archiveKey: keySchema.nullable(),
  bucket: bucketSchema,
  lastTurn: turnOutcomeSchema.nullable(),
  title: z.string().max(8000),
  description: z.string().max(16000),
  details: z.string().max(16000),
  error: z.string().max(2000).nullable(),
  since: z.string().max(100),
  form: formSchema.nullable(),
  snoozedUntil: z.number().nullable(),
  marked: z.boolean(),
  delivery: deliverySchema.nullable(),
});
export type InboxItem = z.infer<typeof itemSchema>;
export const receiptSchema = z.object({
  key: keySchema,
  agentId: identifier,
  requestId: identifier,
  digest: keySchema,
  status: deliverySchema,
  at: z.number(),
});
export type Receipt = z.infer<typeof receiptSchema>;
export const snapshotSchema = z.object({
  items: z.array(itemSchema).max(6000),
  receipts: z.array(receiptSchema).max(30),
  fetchedAt: z.number(),
  incomplete: z.boolean(),
  workspaceIncomplete: z.boolean(),
  turnHistoryIncomplete: z.boolean(),
});
export type InboxSnapshot = z.infer<typeof snapshotSchema>;
export const answerResultSchema = z.object({
  status: z.enum(["answered", "unknown", "stale", "unsupported"]),
});
export type AnswerResult = z.infer<typeof answerResultSchema>;
export const archiveResultSchema = z.object({
  status: z.enum([
    "archived",
    "stale",
    "has_children",
    "incomplete",
    "unknown",
  ]),
});
export type ArchiveResult = z.infer<typeof archiveResultSchema>;
