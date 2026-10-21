import { z } from "zod";
import { identifier } from "../schema";
import {
  attemptRoutingSchema,
  profileIdSchema,
  routingWarningSchema,
  taskRoutingSchema,
} from "./routing";

export const SYMPHONY_LIMITS = {
  symphonies: 200,
  tasks: 40,
  revisions: 24,
  snapshotBytes: 2_000_000,
  contextBytes: 128_000,
  attempts: 120,
  /** Closed or open blocked intervals one attempt may record. */
  blockedIntervalsPerAttempt: 24,
  /** Provider-session windows one attempt may record across agent rebinds. */
  sessionsPerAttempt: 8,
  /** Paths the Conductor may add to one task attempt with `addWrites`. */
  addedWritesPerAttempt: 32,
  /** Paths a task agent may add in one `widen` call. */
  widenPathsPerCall: 5,
  /** `widen` calls a single attempt may make before it must report. */
  widenCallsPerAttempt: 2,
  /** Paths one attempt may record as changed in its write scope. */
  changedPaths: 50,
  /** Dirty write-scope entries one fingerprint observation may return. */
  fingerprintPaths: 200,
  /** `orchestrate` accepts a loop budget of 1..maxLoops. */
  maxLoops: 5,
  /** Loop budget when `orchestrate` omits `maxLoops`. */
  defaultLoops: 3,
  /** `failed` attempts a task may retry within one loop (so 3 attempts). */
  failedRetriesPerLoop: 2,
  /** Findings one report may carry. */
  findingsPerReport: 24,
  /** Characters a saved agent prompt or wake may hold. */
  promptChars: 128_000,
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
// A checkout-relative file name observed from Git, not a scope pattern.
// Brackets, braces, `*`, `?` and `:` are real file-name characters, so only
// traversal, absolute paths, empty segments and control characters are rejected.
// The value is never trimmed: a leading or trailing space is part of the name.
export const observedPathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (path) =>
      !/[\x00-\x1f]/.test(path) &&
      !path.startsWith("/") &&
      path
        .split("/")
        .every((part) => part !== ".." && part !== "." && part !== ""),
    "Use a relative path without traversal or control characters.",
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
        role: z.enum(["exploration", "implementation", "review"]),
        profile: text(160),
        // The profile's name at definition time, so History renders after a
        // rename or delete. Absent on records stored before profiles existed.
        profileName: text(160).optional(),
        provider: text(80).optional(),
        model: text(160).optional(),
        thinkingOptionId: text(80).optional(),
      })
      .strict(),
    criteria: z.array(text(1000)).min(1).max(16),
    checks: z.array(text(1000)).max(16),
    // Mirrors `worker.role === "review"` for callers that read the definition
    // directly. The role is the canonical marker; `define`/`loop` set both.
    review: z.boolean().optional(),
    // The routing decision recorded when the task was created or last routed.
    // Absent on records stored before routing existed.
    routing: taskRoutingSchema.optional(),
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
// A defect a task agent reports, usually a reviewer against another task's
// code. `taskId` names the owning task and is omitted for a finding about the
// reporting task itself. `paths` are display locations such as
// `src/api.ts:41`, never scope grants.
export const findingSchema = z
  .object({
    id: text(200),
    severity: z.enum(["blocking", "minor"]),
    taskId: taskIdSchema.optional(),
    paths: z.array(observedPathSchema).min(1).max(16),
    summary: text(2000),
    suggestedFix: text(2000).optional(),
  })
  .strict();
// The action a failed task agent asks the Conductor for: widen the write scope,
// answer a question, change the model, or report a harness defect. `none` is
// kept so reports stored before `needs-changes` existed stay readable.
export const failureNeedSchema = z.enum([
  "scope",
  "input",
  "model",
  "harness",
  "none",
]);
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
    outcome: z.enum(["completed", "needs-changes", "failed"]),
    summary: text(8000),
    evidence: z.array(text(2000)).min(1).max(24),
    checks: z.array(checkReportSchema).max(16),
    // A review or integration task lists the defects it found. `loop` refers to
    // findings by id, so the ids must be unique within the report.
    findings: z
      .array(findingSchema)
      .max(SYMPHONY_LIMITS.findingsPerReport)
      .optional(),
    diagnosis: taskDiagnosisSchema.optional(),
  })
  .strict()
  .refine(
    (report) => report.diagnosis === undefined || report.outcome === "failed",
    {
      message: "A completed report cannot include a diagnosis.",
      path: ["diagnosis"],
    },
  )
  .refine(
    (report) =>
      report.outcome !== "completed" ||
      !report.findings?.some((finding) => finding.severity === "blocking"),
    {
      message: "A completed report cannot include a blocking finding.",
      path: ["findings"],
    },
  )
  .refine(
    (report) =>
      report.outcome !== "needs-changes" ||
      (report.findings?.some((finding) => finding.severity === "blocking") ??
        false) ||
      report.checks.some((check) => check.status === "failed"),
    {
      message:
        "A needs-changes report requires a blocking finding or a failed check.",
      path: ["findings"],
    },
  )
  .refine(
    (report) => {
      const ids = report.findings?.map((finding) => finding.id) ?? [];
      return new Set(ids).size === ids.length;
    },
    { message: "Finding IDs must be unique.", path: ["findings"] },
  );
// A server-checked scope grant recorded on the attempt that received it.
export const grantedWriteSchema = z
  .object({
    path: scopeSchema,
    reason: text(2000),
    at: z.number().int().nonnegative(),
  })
  .strict();
// Closed and open intervals in one attempt, oldest first. An open interval has
// `to: null` and counts up to the current time. Absent on records stored before
// blocked time was tracked; those attempts' work time equals wall time.
export const blockedIntervalSchema = z
  .object({
    from: z.number().int().nonnegative(),
    to: z.number().int().nonnegative().nullable(),
  })
  .strict();
// One provider session's window inside an attempt, oldest first. A blocked
// retry can rebind the attempt to another agent, so an attempt may hold several
// segments. An open segment has `to: null`; absent on records stored before
// sessions were tracked.
export const attemptSessionSegmentSchema = z
  .object({
    provider: text(64),
    id: text(160),
    from: z.number().int().nonnegative(),
    to: z.number().int().nonnegative().nullable(),
  })
  .strict();
// Tokens the harness session log records inside the attempt's window. Absent
// fields are unknown, never zero. `input` excludes cache reads; `output`
// includes reasoning tokens when the harness reports them separately.
export const attemptUsageSchema = z
  .object({
    input: z.number().int().nonnegative().optional(),
    cached: z.number().int().nonnegative().optional(),
    output: z.number().int().nonnegative().optional(),
    collectedAt: z.number().int().nonnegative(),
  })
  .strict();
export const attemptSchema = z
  .object({
    id: uuidSchema,
    taskId: taskIdSchema,
    agentId: identifier,
    state: z.enum([
      "running",
      "blocked",
      "completed",
      "needs-changes",
      "failed",
    ]),
    startedAt: z.number().int().nonnegative(),
    endedAt: z.number().int().nonnegative().nullable(),
    blocked: z
      .array(blockedIntervalSchema)
      .max(SYMPHONY_LIMITS.blockedIntervalsPerAttempt)
      .optional(),
    sessions: z
      .array(attemptSessionSegmentSchema)
      .max(SYMPHONY_LIMITS.sessionsPerAttempt)
      .optional(),
    usage: attemptUsageSchema.optional(),
    message: text(4000).nullable(),
    report: taskReportSchema.nullable(),
    reportHash: hash.nullable(),
    // Who wrote the report: the task agent, the launcher when agent creation was
    // rejected, or the server when the harness could not run the work (an
    // unconfirmed launch, an unreachable agent, or no report after the nudge).
    reportedBy: z.enum(["worker", "launcher", "server"]).optional(),
    // Failed retries that replayed this attempt's unconfirmed launch identity
    // instead of creating another attempt. They count toward the per-loop
    // retry limit like failed attempts do.
    identityRetries: z.number().int().nonnegative().optional(),
    // The loop this attempt ran in. Absent on records stored before loops
    // existed; readers treat it as loop 1 (`attemptLoop`).
    loop: z.number().int().min(1).optional(),
    // Set when the Conductor reopened this task with review findings in a new
    // loop. `findings` are the reported defects the attempt addresses and
    // `recheck` marks an attempt that only re-checks a reopened prerequisite.
    reopen: z
      .object({
        reason: text(2000),
        findings: z.array(findingSchema).max(SYMPHONY_LIMITS.findingsPerReport),
      })
      .strict()
      .optional(),
    recheck: z.boolean().optional(),
    grantedWrites: z
      .array(grantedWriteSchema)
      .max(
        SYMPHONY_LIMITS.widenPathsPerCall *
          SYMPHONY_LIMITS.widenCallsPerAttempt,
      )
      .optional(),
    // Paths the Conductor added to this task's write scope for this attempt.
    // Unlike `grantedWrites`, they last for the whole task: the effective scope
    // unions the additions of every attempt of the task.
    addedWrites: z
      .array(grantedWriteSchema)
      .max(SYMPHONY_LIMITS.addedWritesPerAttempt)
      .optional(),
    // Checkout-relative paths whose write-scope state changed while this
    // attempt ran, recorded when it settles. Advisory only: it is never a scope
    // check, and it is absent when the checkout observation is unavailable.
    changedPaths: z
      .array(observedPathSchema)
      .max(SYMPHONY_LIMITS.changedPaths)
      .optional(),
    // True when more than `changedPaths` paths changed and only the first
    // `changedPaths` limit were kept.
    changedPathsTruncated: z.boolean().optional(),
    // Per-path state hashes taken when the attempt launched. Diffing them
    // against the settle observation derives `changedPaths`; the baseline is
    // absent in a non-Git checkout or when Git failed.
    writeFingerprint: z
      .array(z.object({ path: observedPathSchema, hash: text(128) }).strict())
      .max(SYMPHONY_LIMITS.fingerprintPaths)
      .optional(),
    // True when the launch baseline was attempted but the observation was
    // unavailable, such as a non-Git checkout or a failed Git call. The attempt
    // never retries the baseline, because a later capture would already include
    // the earlier agent's edits. `changedPaths` stays absent: an empty list
    // would falsely claim nothing changed.
    writeFingerprintUnknown: z.boolean().optional(),
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
        prompt: text(SYMPHONY_LIMITS.promptChars),
      })
      .strict()
      .optional(),
    launch: z
      .object({
        state: z.enum(["pending", "started", "uncertain", "failed"]),
        profile: text(160),
        // The resolved profile's id and name at launch time, so the attempt
        // renders after a rename or delete. Absent on old records.
        profileId: profileIdSchema.optional(),
        profileName: text(160).optional(),
        provider: text(80).optional(),
        model: text(160).optional(),
        thinkingOptionId: text(80).optional(),
        // The provider/model/thinking option this launch actually resolved to.
        // A profile launch records the profile's values here instead of the
        // inline fields above, which mean "the Conductor chose an inline
        // model" and drive `launchChoice` and revalidation. Absent on old
        // records and for an `inherit` launch whose conductor worker is
        // unknown at launch time.
        resolved: z
          .object({
            provider: text(80),
            model: text(160).optional(),
            thinkingOptionId: text(80).optional(),
          })
          .strict()
          .optional(),
        config: text(32000).optional(),
        // The catalog revision this launch was validated against, so a changed
        // catalog is revalidated before dispatch. Absent on old records.
        catalogRevision: hash.optional(),
        routing: attemptRoutingSchema.optional(),
        warnings: z.array(routingWarningSchema).max(8).optional(),
        generation: z.number().int().nonnegative(),
        // Persisted progress of the bounded re-check for an uncertain launch.
        // The reconciler performs at most one identity lookup per due tick
        // instead of sleeping, so it never blocks the shared command queue.
        checks: z.number().int().nonnegative().optional(),
        nextCheckAt: z.number().int().nonnegative().optional(),
        prompt: text(SYMPHONY_LIMITS.promptChars),
        settled: z.boolean(),
      })
      .strict()
      .optional(),
  })
  .strict();
// A blocking finding or a needs-changes task the Conductor chose not to
// reopen, with a reason, so nothing is dropped silently. `loop` uses the shape
// for its `deferred` list and `finish` for `unresolved`.
export const unresolvedItemSchema = z
  .object({
    finding: text(300).optional(),
    taskId: taskIdSchema.optional(),
    reason: text(2000),
  })
  .strict()
  .refine((item) => item.finding !== undefined || item.taskId !== undefined, {
    message: "Name the finding or task left unresolved.",
    path: ["finding"],
  });
/** The `loop` command's deferred entry; same shape as an unresolved item. */
export const deferredItemSchema = unresolvedItemSchema;
export const loopApprovalSchema = z
  .object({
    /** The loop number the user approved. */
    loops: z.number().int().min(1),
    /** The user's own words, recorded on the loop and shown in History. */
    userAnswer: text(2000),
  })
  .strict();
export const loopReopenSchema = z
  .object({
    taskId: taskIdSchema,
    /** Finding ids from the previous loop, such as `review#F1`. */
    findings: z
      .array(text(300))
      .max(SYMPHONY_LIMITS.findingsPerReport)
      .default([]),
    /** Loop-only prerequisites that do not change the declared `dependsOn`. */
    after: z.array(taskIdSchema).max(SYMPHONY_LIMITS.tasks).optional(),
    /** The Conductor's note for the reopened attempt. */
    note: text(2000).optional(),
    /** Validated write additions recorded on the reopened attempt. */
    addedWrites: z
      .array(grantedWriteSchema)
      .max(SYMPHONY_LIMITS.addedWritesPerAttempt)
      .optional(),
    /**
     * The full finding objects `findings` named, captured when `loop` was
     * accepted so a later rerun of the reporter cannot change them.
     */
    resolved: z
      .array(findingSchema)
      .max(SYMPHONY_LIMITS.findingsPerReport)
      .optional(),
    // The replacement worker a re-opened loop task takes over with, if any.
    // Absent on records stored before routing existed.
    worker: z
      .object({
        profile: text(160).optional(),
        profileName: text(160).optional(),
        provider: text(80).optional(),
        model: text(160).optional(),
        thinkingOptionId: text(80).optional(),
      })
      .strict()
      .optional(),
    routing: attemptRoutingSchema.optional(),
    warnings: z.array(routingWarningSchema).max(8).optional(),
  })
  .strict();
// The blocking findings one task's latest report still carried when a loop
// started. Finding ids are unique only within a report, so the reporter
// qualifies them as `reporterTaskId#id`.
export const previousReportSchema = z
  .object({
    reporterTaskId: taskIdSchema,
    findings: z
      .array(findingSchema)
      .min(1)
      .max(SYMPHONY_LIMITS.findingsPerReport),
  })
  .strict();
// One record per loop the Conductor started with `loop`. Loop 1 is implicit
// and has no record.
export const loopRecordSchema = z
  .object({
    number: z.number().int().min(1),
    reason: text(2000),
    startedAt: z.number().int().nonnegative(),
    reopened: z.array(loopReopenSchema).max(SYMPHONY_LIMITS.tasks).default([]),
    added: z.array(taskIdSchema).max(SYMPHONY_LIMITS.tasks).default([]),
    deferred: z.array(deferredItemSchema).max(24).default([]),
    approval: loopApprovalSchema.optional(),
    // Legacy aggregate of the open blocking findings, capped at one report's
    // limit. Kept readable for records stored before `previousReports`.
    previousFindings: z
      .array(findingSchema)
      .max(SYMPHONY_LIMITS.findingsPerReport)
      .optional(),
    // The open blocking findings when the loop started, one snapshot per
    // reporting task, captured for the re-running reviews to confirm each one
    // is fixed. Each snapshot is bounded like the report it came from.
    previousReports: z
      .array(previousReportSchema)
      .max(SYMPHONY_LIMITS.tasks)
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
        // A digest of the accepted `define` command's tasks, so a replayed
        // define is idempotent. Absent on records stored before it existed.
        defineHash: hash.optional(),
        prompt: text(SYMPHONY_LIMITS.promptChars),
        notification: z.string().max(128).nullable(),
        // The loop budget chosen at `orchestrate`; absent means
        // `SYMPHONY_LIMITS.defaultLoops`.
        maxLoops: z
          .number()
          .int()
          .min(1)
          .max(SYMPHONY_LIMITS.maxLoops)
          .optional(),
        // Records of loops started with `loop`, oldest first. Grows past
        // `maxLoops` only with a recorded approval.
        loops: z
          .array(loopRecordSchema)
          .max(SYMPHONY_LIMITS.attempts)
          .optional(),
      })
      .strict()
      .optional(),
    attempts: z.array(attemptSchema).max(SYMPHONY_LIMITS.attempts),
    summary: text(8000).nullable(),
    finishedAt: z.number().int().nonnegative().nullable(),
    interruption: text(4000).nullable(),
    // Set by `finish` when the user stopped a symphony with open findings or
    // non-completed tasks; such a symphony ends `failed` and lists them.
    unresolved: z
      .array(unresolvedItemSchema)
      .max(SYMPHONY_LIMITS.attempts)
      .optional(),
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
/** A summary as the Podium lists it, with its concert's current project. */
export const symphonyListEntrySchema = symphonySummarySchema.extend({
  projectName: z.string().max(1000),
});
export type TaskDefinition = z.infer<typeof taskSchema>;
export type Score = z.infer<typeof scoreSchema>;
export type SymphonyContext = z.infer<typeof contextSchema>;
export type SymphonySource = z.infer<typeof sourceSchema>;
export type SymphonyPlacement = z.infer<typeof placementSchema>;
export type StoredSymphony = z.infer<typeof symphonySchema>;
export type SymphonySummary = z.infer<typeof symphonySummarySchema>;
export type SymphonyListEntry = z.infer<typeof symphonyListEntrySchema>;
export type Attempt = z.infer<typeof attemptSchema>;
export type BlockedInterval = z.infer<typeof blockedIntervalSchema>;
export type AttemptSessionSegment = z.infer<typeof attemptSessionSegmentSchema>;
/** Token counts a harness reader returns; the Conductor adds `collectedAt`. */
export type AttemptUsage = Omit<
  z.infer<typeof attemptUsageSchema>,
  "collectedAt"
>;
export type TaskReport = z.infer<typeof taskReportSchema>;
export type TaskDiagnosis = z.infer<typeof taskDiagnosisSchema>;
export type TaskFinding = z.infer<typeof findingSchema>;
export type CheckReport = z.infer<typeof checkReportSchema>;
export type FailureNeed = z.infer<typeof failureNeedSchema>;
export type GrantedWrite = z.infer<typeof grantedWriteSchema>;
export type LoopApproval = z.infer<typeof loopApprovalSchema>;
export type LoopReopen = z.infer<typeof loopReopenSchema>;
export type LoopRecord = z.infer<typeof loopRecordSchema>;
export type PreviousReport = z.infer<typeof previousReportSchema>;
export type UnresolvedItem = z.infer<typeof unresolvedItemSchema>;
export type AttemptReopen = NonNullable<Attempt["reopen"]>;
export type PendingWake = NonNullable<Attempt["wake"]>;

/**
 * The number of open blocking findings a loop record captured when it
 * started, or undefined for a record that captured none. Reads the
 * per-reporter snapshots, falling back to the legacy capped aggregate.
 */
export function previousFindingCount(record: LoopRecord): number | undefined {
  if (record.previousReports) {
    return record.previousReports.reduce(
      (count, entry) => count + entry.findings.length,
      0,
    );
  }
  return record.previousFindings?.length;
}

/**
 * Whether a task is a review: a read-only pass over other tasks' work. The
 * review role is canonical; `review` mirrors it for definitions built by hand.
 */
export function isReviewTask(task: TaskDefinition): boolean {
  return task.worker.role === "review" || task.review === true;
}

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

/** A task's attempts, oldest first. Derived from `taskId` and array order. */
export function taskAttempts(
  symphony: StoredSymphony,
  taskId: string,
): Attempt[] {
  return symphony.execution.attempts.filter(
    (attempt) => attempt.taskId === taskId,
  );
}

/** 1-based position of an attempt among its task's attempts, oldest first. */
export function attemptNumber(
  symphony: StoredSymphony,
  attempt: Attempt,
): number {
  return (
    taskAttempts(symphony, attempt.taskId).findIndex(
      (entry) => entry.id === attempt.id,
    ) + 1
  );
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
