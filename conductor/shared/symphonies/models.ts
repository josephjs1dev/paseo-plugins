import { z } from "zod";
import { identifier } from "../schema";

export const SYMPHONY_LIMITS = {
  symphonies: 200,
  tasks: 40,
  revisions: 24,
  snapshotBytes: 2_000_000,
  contextBytes: 128_000,
  attempts: 120,
  /** Paths a task agent may add in one `widen` call. */
  widenPathsPerCall: 5,
  /** `widen` calls a single attempt may make before it must report. */
  widenCallsPerAttempt: 2,
} as const;
export const uuidSchema = z.string().uuid();
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
    prerequisites: z.array(taskIdSchema).max(SYMPHONY_LIMITS.tasks),
    inputs: z.array(text(2000)).max(16),
    reads: z.array(scopeSchema).max(32),
    writes: z.array(scopeSchema).max(32),
    resources: z.array(taskIdSchema).max(16),
    worker: z
      .object({
        role: z.enum(["exploration", "implementation"]),
        profile: text(160),
        provider: text(80).optional(),
        model: text(160).optional(),
        thinkingOptionId: text(80).optional(),
      })
      .strict(),
    criteria: z.array(text(1000)).min(1).max(16),
    checks: z.array(text(1000)).max(16),
    stopWhen: text(2000),
  })
  .strict();
export const scoreSchema = z
  .object({ tasks: z.array(taskSchema).max(SYMPHONY_LIMITS.tasks) })
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
    concertId: identifier,
    agentId: identifier.nullable(),
  })
  .strict();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const placementSchema = sourceSchema.extend({
  concertName: text(512),
  checkout: text(4096),
  // A planning-time observation, never a task agent ownership or freshness
  // claim.
  branch: z.string().max(512).nullable(),
  base: z.string().max(64).nullable(),
  dirtyFingerprint: hash.nullable(),
});
export const revisionSchema = z
  .object({
    number: z.number().int().positive(),
    parent: z.number().int().positive().nullable(),
    reason: text(2000),
    acceptedAt: z.number().int().nonnegative(),
    score: scoreSchema,
  })
  .strict();
export const checkReportSchema = z
  .object({
    name: text(1000),
    status: z.enum(["passed", "failed", "not-run"]),
    detail: text(2000),
  })
  .strict();
// The action a failed task agent asks the Conductor for: widen the write scope,
// answer a question, change the model, or retry with a direction.
export const failureNeedSchema = z.enum(["scope", "input", "model", "none"]);
export const taskDiagnosisSchema = z
  .object({
    tried: z.array(text(1000)).min(1).max(8),
    suspectedCause: text(2000),
    need: failureNeedSchema,
    requestedWrites: z.array(scopeSchema).max(32).optional(),
  })
  .strict()
  .refine(
    (diagnosis) =>
      diagnosis.need !== "scope" ||
      (diagnosis.requestedWrites?.length ?? 0) > 0,
    {
      message: "List requestedWrites when need is scope.",
      path: ["requestedWrites"],
    },
  );
export const taskReportSchema = z
  .object({
    outcome: z.enum(["completed", "failed"]),
    summary: text(8000),
    evidence: z.array(text(2000)).min(1).max(24),
    checks: z.array(checkReportSchema).max(16),
    diagnosis: taskDiagnosisSchema.optional(),
  })
  .strict()
  .refine(
    (report) => report.diagnosis === undefined || report.outcome === "failed",
    {
      message: "A completed report cannot include a diagnosis.",
      path: ["diagnosis"],
    },
  );
// A server-checked scope grant recorded on the attempt that received it.
export const grantedWriteSchema = z
  .object({
    path: scopeSchema,
    reason: text(2000),
    at: z.number().int().nonnegative(),
  })
  .strict();
export const attemptSchema = z
  .object({
    id: uuidSchema,
    taskId: taskIdSchema,
    agentId: identifier,
    state: z.enum(["running", "blocked", "completed", "failed"]),
    startedAt: z.number().int().nonnegative(),
    endedAt: z.number().int().nonnegative().nullable(),
    message: text(4000).nullable(),
    report: taskReportSchema.nullable(),
    reportHash: hash.nullable(),
    reportedBy: z.enum(["worker", "launcher"]).optional(),
    grantedWrites: z
      .array(grantedWriteSchema)
      .max(
        SYMPHONY_LIMITS.widenPathsPerCall *
          SYMPHONY_LIMITS.widenCallsPerAttempt,
      )
      .optional(),
    nudgedAt: z.number().int().nonnegative().optional(),
    // Who made the attempt blocked: "worker" when the assigned agent called
    // `block`, "server" when reconciliation settled a stop with no report. The
    // marker distinguishes a task agent's blocker from a server settlement for
    // the Conductor notification; never infer it from the message text.
    blockedBy: z.enum(["worker", "server"]).optional(),
    // An undelivered server wake (a one-time nudge, a same-agent continuation,
    // or a blocker resume). Persisted before the send and cleared only after the
    // keyed send succeeds, so a failed send or a reload replays the same message.
    wake: z
      .object({
        key: text(200),
        prompt: text(128000),
      })
      .strict()
      .optional(),
    launch: z
      .object({
        state: z.enum(["pending", "started", "uncertain", "failed"]),
        profile: text(160),
        provider: text(80).optional(),
        model: text(160).optional(),
        thinkingOptionId: text(80).optional(),
        config: text(32000).optional(),
        generation: z.number().int().nonnegative(),
        // Persisted progress of the bounded re-check for an uncertain launch.
        // The reconciler performs at most one identity lookup per due tick
        // instead of sleeping, so it never blocks the shared command queue.
        checks: z.number().int().nonnegative().optional(),
        nextCheckAt: z.number().int().nonnegative().optional(),
        prompt: text(128000),
        settled: z.boolean(),
      })
      .strict()
      .optional(),
  })
  .strict();
export const executionSchema = z
  .object({
    origin: z.enum(["tracked", "conducted"]),
    conducting: z
      .object({
        phase: z.enum(["planning", "working"]),
        concurrency: z.number().int().min(1).max(4),
        requestedBy: identifier.nullable(),
        conductorLaunch: z.enum(["pending", "started", "uncertain"]),
        conductor: z.enum(["self", "agent"]),
        conductorProfile: text(160).optional(),
        conductorConfig: text(32000).optional(),
        prompt: text(128000),
        notification: z.string().max(128).nullable(),
      })
      .strict()
      .optional(),
    attempts: z.array(attemptSchema).max(SYMPHONY_LIMITS.attempts),
    summary: text(8000).nullable(),
    finishedAt: z.number().int().nonnegative().nullable(),
    interruption: text(4000).nullable(),
  })
  .strict();
export const symphonySchema = z
  .object({
    schemaVersion: z.literal(1),
    id: uuidSchema,
    version: z.number().int().nonnegative(),
    title: text(160),
    source: placementSchema,
    contextHash: hash,
    requestHash: hash,
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    status: z.enum([
      "planning",
      "ready",
      "running",
      "blocked",
      "completed",
      "failed",
    ]),
    execution: executionSchema,
    revisions: z.array(revisionSchema).max(SYMPHONY_LIMITS.revisions),
  })
  .strict();
export const symphonySummarySchema = symphonySchema
  .omit({
    revisions: true,
    contextHash: true,
    requestHash: true,
    execution: true,
  })
  .extend({
    taskCount: z.number().int().nonnegative(),
    acceptedRevision: z.number().int().positive().nullable(),
    completedTasks: z.number().int().nonnegative(),
    activeTasks: z.number().int().nonnegative(),
    message: z.string().max(8000).nullable(),
  });
export type TaskDefinition = z.infer<typeof taskSchema>;
export type Score = z.infer<typeof scoreSchema>;
export type SymphonyContext = z.infer<typeof contextSchema>;
export type SymphonySource = z.infer<typeof sourceSchema>;
export type SymphonyPlacement = z.infer<typeof placementSchema>;
export type StoredSymphony = z.infer<typeof symphonySchema>;
export type SymphonySummary = z.infer<typeof symphonySummarySchema>;
export type Attempt = z.infer<typeof attemptSchema>;
export type TaskReport = z.infer<typeof taskReportSchema>;
export type TaskDiagnosis = z.infer<typeof taskDiagnosisSchema>;
export type FailureNeed = z.infer<typeof failureNeedSchema>;
export type GrantedWrite = z.infer<typeof grantedWriteSchema>;
export type PendingWake = NonNullable<Attempt["wake"]>;

export function symphonyStatusLabel(status: StoredSymphony["status"]): string {
  const labels = {
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
  symphony: StoredSymphony,
  taskId: string,
): Attempt | undefined {
  return symphony.execution.attempts
    .slice()
    .reverse()
    .find((attempt) => attempt.taskId === taskId);
}

export function summarizeSymphony(symphony: StoredSymphony): SymphonySummary {
  const latest = symphony.revisions.at(-1);
  const tasks = latest?.score.tasks ?? [];
  const attempts = tasks.map((task) => latestAttempt(symphony, task.id));
  return symphonySummarySchema.parse({
    schemaVersion: symphony.schemaVersion,
    id: symphony.id,
    version: symphony.version,
    title: symphony.title,
    source: symphony.source,
    createdAt: symphony.createdAt,
    updatedAt: symphony.updatedAt,
    status: symphony.status,
    taskCount: tasks.length,
    acceptedRevision: latest?.number ?? null,
    completedTasks: attempts.filter((attempt) => attempt?.state === "completed")
      .length,
    activeTasks: attempts.filter((attempt) => attempt?.state === "running")
      .length,
    message:
      symphony.execution.summary ??
      symphony.execution.interruption ??
      attempts.find((attempt) => attempt?.state === "blocked")?.message ??
      null,
  });
}
