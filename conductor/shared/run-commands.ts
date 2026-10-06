import { z } from "zod";
import { identifier } from "./models";
import {
  runIdSchema,
  scopeSchema,
  taskIdSchema,
  taskReportSchema,
} from "./run-models";

const text = (max: number) => z.string().trim().min(1).max(max);
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
    profile: text(160).optional(),
  })
  .strict();
export const runAgentCommandSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("orchestrate"),
      key: text(160),
      title: text(160),
      goal: text(16000),
      concurrency: z.number().int().min(1).max(4).default(3),
      coordinatorProfile: text(160).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("define"),
      runId: runIdSchema,
      tasks: z.array(commandTaskSchema).min(1).max(12),
    })
    .strict(),
  z
    .object({
      kind: z.literal("dispatch"),
      runId: runIdSchema,
      retryTaskId: taskIdSchema.optional(),
      profile: text(160).optional(),
    })
    .strict(),
  z.object({ kind: z.literal("profiles") }).strict(),

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
  z.object({ kind: z.literal("get"), runId: runIdSchema }).strict(),
  z
    .object({
      kind: z.literal("remove-legacy"),
      runId: runIdSchema,
      expectedVersion: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("claim"),
      runId: runIdSchema,
      taskId: taskIdSchema,
      retry: z.boolean().default(false),
    })
    .strict(),
  z
    .object({
      kind: z.literal("block"),
      runId: runIdSchema,
      attemptId: runIdSchema,
      message: text(4000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("report"),
      runId: runIdSchema,
      attemptId: runIdSchema,
      report: taskReportSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("finish"),
      runId: runIdSchema,
      summary: text(8000),
    })
    .strict(),
]);
export const agentCommandRequestSchema = z
  .object({ agentId: identifier, command: runAgentCommandSchema })
  .strict();
export type RunAgentCommand = z.infer<typeof runAgentCommandSchema>;
export type AgentCommandRequest = z.infer<typeof agentCommandRequestSchema>;
