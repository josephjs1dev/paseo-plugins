import { z } from "zod";
import { identifier } from "./models";

export const RUN_LIMITS = {
  runs: 200,
  tasks: 40,
  revisions: 24,
  snapshotBytes: 2_000_000,
  contextBytes: 128_000,
  attempts: 120,
} as const;
export const runIdSchema = z.string().uuid();
export const taskIdSchema = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
const text = (max: number) => z.string().trim().min(1).max(max);
// Literal checkout-relative paths, not shell patterns or filesystem capabilities.
export const scopeSchema = text(512).refine(
  (path) =>
    path === "." ||
    (!/[\\:*?\[\]{}\x00-\x1f]/.test(path) &&
      !path.startsWith("/") &&
      path
        .split("/")
        .every((part) => part !== ".." && part !== "." && part !== "")),
  "Use a relative path without traversal, wildcards, or empty segments.",
);
export const taskSchema = z
  .object({
    id: taskIdSchema,
    title: text(160),
    outcome: text(4000),
    prerequisites: z.array(taskIdSchema).max(RUN_LIMITS.tasks),
    inputs: z.array(text(2000)).max(16),
    reads: z.array(scopeSchema).max(32),
    writes: z.array(scopeSchema).max(32),
    resources: z.array(taskIdSchema).max(16),
    worker: z
      .object({
        role: z.enum(["exploration", "implementation"]),
        profile: text(160),
      })
      .strict(),
    criteria: z.array(text(1000)).min(1).max(16),
    checks: z.array(text(1000)).max(16),
    stopWhen: text(2000),
  })
  .strict();
export const graphSchema = z
  .object({ tasks: z.array(taskSchema).max(RUN_LIMITS.tasks) })
  .strict();
export const contextSchema = z
  .object({
    plan: text(64_000),
    provenance: text(512),
    decisions: z.array(text(2000)).max(24),
    constraints: z.array(text(2000)).max(24),
    expectedOutcome: text(4000),
  })
  .strict();
export const sourceSchema = z
  .object({
    workspaceId: identifier,
    agentId: identifier.nullable(),
  })
  .strict();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const placementSchema = sourceSchema.extend({
  workspaceName: text(512),
  checkout: text(4096),
  // A planning-time observation, never a worker ownership or freshness claim.
  branch: z.string().max(512).nullable(),
  base: z.string().max(64).nullable(),
  dirtyFingerprint: hash.nullable(),
});
export const revisionSchema = z.object({
  number: z.number().int().positive(),
  parent: z.number().int().positive().nullable(),
  reason: text(2000),
  acceptedAt: z.number().int().nonnegative(),
  authority: z.enum(["operator", "agent"]),
  graph: graphSchema,
});
export const checkReportSchema = z
  .object({
    name: text(1000),
    status: z.enum(["passed", "failed", "not-run"]),
    detail: text(2000),
  })
  .strict();
export const taskReportSchema = z
  .object({
    outcome: z.enum(["completed", "failed"]),
    summary: text(8000),
    evidence: z.array(text(2000)).min(1).max(24),
    checks: z.array(checkReportSchema).max(16),
  })
  .strict();
export const attemptSchema = z.object({
  id: runIdSchema,
  taskId: taskIdSchema,
  agentId: identifier,
  state: z.enum(["running", "blocked", "completed", "failed"]),
  startedAt: z.number().int().nonnegative(),
  endedAt: z.number().int().nonnegative().nullable(),
  message: text(4000).nullable(),
  report: taskReportSchema.nullable(),
  reportHash: hash.nullable(),
  reportedBy: z.enum(["worker", "launcher"]).optional(),
  launch: z
    .object({
      state: z.enum(["pending", "started", "uncertain", "failed"]),
      profile: text(160).optional(),
      config: text(32000).optional(),
      generation: z.number().int().nonnegative().optional(),
      prompt: text(128000),
      settled: z.boolean(),
    })
    .optional(),
});
export const executionSchema = z.object({
  origin: z.enum(["source-agent", "orchestrator"]),
  orchestration: z
    .object({
      phase: z.enum(["planning", "working"]),
      concurrency: z.number().int().min(1).max(4),
      requestedBy: identifier.nullable(),
      coordinatorLaunch: z.enum(["pending", "started", "uncertain"]),
      coordinatorProfile: text(160).optional(),
      coordinatorConfig: text(32000).optional(),
      prompt: text(128000),
      notification: z.string().max(128).nullable(),
    })
    .optional(),
  attempts: z.array(attemptSchema).max(RUN_LIMITS.attempts),
  summary: text(8000).nullable(),
  finishedAt: z.number().int().nonnegative().nullable(),
  interruption: text(4000).nullable(),
});
export const runSchema = z.object({
  schemaVersion: z.literal(1),
  id: runIdSchema,
  version: z.number().int().nonnegative(),
  title: text(160),
  source: placementSchema,
  contextHash: hash,
  requestHash: hash,
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  status: z.enum([
    "draft",
    "accepted",
    "planning",
    "ready",
    "running",
    "blocked",
    "completed",
    "failed",
  ]),
  execution: executionSchema.nullable().default(null),
  draft: graphSchema.nullable(),
  revisions: z.array(revisionSchema).max(RUN_LIMITS.revisions),
});
export const runSummarySchema = runSchema
  .omit({
    draft: true,
    revisions: true,
    contextHash: true,
    requestHash: true,
    execution: true,
  })
  .extend({
    taskCount: z.number().int().nonnegative(),
    acceptedRevision: z.number().int().positive().nullable(),
    hasDraft: z.boolean(),
    completedTasks: z.number().int().nonnegative(),
    activeTasks: z.number().int().nonnegative(),
    message: z.string().max(8000).nullable(),
  });
export type TaskDefinition = z.infer<typeof taskSchema>;
export type RunGraph = z.infer<typeof graphSchema>;
export type RunContext = z.infer<typeof contextSchema>;
export type RunSource = z.infer<typeof sourceSchema>;
export type RunPlacement = z.infer<typeof placementSchema>;
export type StoredRun = z.infer<typeof runSchema>;
export type RunSummary = z.infer<typeof runSummarySchema>;
export type RunAttempt = z.infer<typeof attemptSchema>;
export type TaskReport = z.infer<typeof taskReportSchema>;

export function runStatusLabel(status: StoredRun["status"]): string {
  const labels = {
    draft: "Legacy plan · Not started",
    accepted: "Legacy plan · Not started",
    planning: "Planning",
    ready: "Ready",
    running: "Running",
    blocked: "Needs attention",
    completed: "Complete",
    failed: "Failed",
  };
  return labels[status];
}

export function latestAttempt(
  run: StoredRun,
  taskId: string,
): RunAttempt | undefined {
  return run.execution?.attempts
    .slice()
    .reverse()
    .find((attempt) => attempt.taskId === taskId);
}

export function summarizeRun(run: StoredRun): RunSummary {
  const latest = run.revisions.at(-1);
  const tasks = (latest?.graph ?? run.draft)?.tasks ?? [];
  const attempts = tasks.map((task) => latestAttempt(run, task.id));
  return runSummarySchema.parse({
    ...run,
    taskCount: tasks.length,
    acceptedRevision: latest?.number ?? null,
    hasDraft: run.draft !== null,
    completedTasks: attempts.filter((attempt) => attempt?.state === "completed")
      .length,
    activeTasks: attempts.filter((attempt) => attempt?.state === "running")
      .length,
    message:
      run.execution?.summary ??
      run.execution?.interruption ??
      attempts.find((attempt) => attempt?.state === "blocked")?.message ??
      null,
  });
}
