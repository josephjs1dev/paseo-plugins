import {
  handoffInstructions,
  taskAssignmentPrompt,
  continuationPrompt,
  nudgePrompt,
  prerequisiteResults,
  unionChangedPaths,
  type AttemptPosition,
  type CommandLine,
  type PreviousFindingsInput,
  type RecheckPromptInput,
} from "./prompts";
import { commandTaskDefinition, symphonyConductor } from "./conductor";
import { randomUUID } from "node:crypto";
import {
  attemptLoop,
  currentLoop,
  currentLoopRecord,
  effectiveTask,
  loopPrerequisites,
  loopSchedule,
  loopVerdict,
  nextAttemptWrites,
  pendingLoopEntry,
  prerequisiteCycle,
  prerequisiteReady,
  scopeConflictReason,
  scoreIssues,
  transitiveDependents,
  type LoopScheduleEntry,
} from "../../shared/symphonies/score";
import {
  attemptNumber,
  isReviewTask,
  latestAttempt,
  taskAttempts,
  SYMPHONY_LIMITS,
  type Attempt,
  type AttemptReopen,
  type GrantedWrite,
  type LoopRecord,
  type LoopReopen,
  type PreviousReport,
  type StoredSymphony,
  type TaskDefinition,
  type TaskFinding,
  type TaskReport,
} from "../../shared/symphonies/models";
import {
  workerChoice,
  type SymphonyCommand,
  type WorkerChoice,
} from "../../shared/symphonies/commands";
import {
  resolveProfileRef,
  type ConductorProfile,
} from "../../shared/symphonies/profiles";
import {
  profileIdSchema,
  type AttemptRouting,
  type CommandRouting,
  type RoutingWarning,
} from "../../shared/symphonies/routing";
import { commandSymphonyId, type ExecutionRuntime } from "./identity";
import {
  recordChangedPaths,
  type ChangedPaths,
  type SymphonyChangesRuntime,
} from "./changes";
import { contentHash, type SymphonyStore } from "./store";
import { SymphonyError, LaunchRejectedError } from "./errors";
import {
  attemptHoldsResources,
  executionStatus,
  launchUncertain,
  symphonyHoldsResources,
} from "./results";
import { nextLaunchCheckDelay, type WorkerRuntime } from "./workers";
import {
  choiceKind,
  resolveCommandTaskRouting,
  route,
  validateChoice,
  type ResolvedTaskRouting,
  type RoutingCatalogSource,
} from "./routing";

/** Truncates a field so a large symphony cannot flood the Conductor. */
const clamp = (value: string, max: number) =>
  value.length > max ? value.slice(0, max) : value;

/** Marks the interruption for a task whose prompt can't be saved. */
const OVERSIZED_PROMPT = "cannot start: its prompt exceeds";

/** The bounded per-task failure kind shown to the Conductor. */
/** Why the current loop runs a task, as the prompt and attempt record it. */
interface LoopPromptContext {
  reopen?: AttemptReopen;
  recheck?: RecheckPromptInput;
  previous?: PreviousFindingsInput;
}

type FailureKind =
  | "no-report"
  | "launch"
  | "checks-failed"
  | "blocked"
  | "failed";

function failureKind(attempt: Attempt): FailureKind {
  if (attempt.reportedBy === "launcher") {
    return "launch";
  }
  // The server settles a harness failure (no report after the nudge, an
  // unreachable agent, an unconfirmed launch) with its own failed report.
  if (attempt.reportedBy === "server") {
    return "no-report";
  }
  const report = attempt.report;
  if (!report) {
    // A task agent block and a server no-report settlement both leave a
    // blocked, report-less attempt; the persisted marker tells them apart.
    return attempt.blockedBy === "worker" ? "blocked" : "no-report";
  }
  return report.checks.some((check) => check.status === "failed")
    ? "checks-failed"
    : "failed";
}

/**
 * A short, bounded summary of one blocked or failed attempt for the Conductor
 * notification. The Conductor should be able to choose `need` without reading
 * the attempt or its conversation. The attempt number is per task, so it agrees
 * with the History tab.
 */
function failureSummary(symphony: StoredSymphony, attempt: Attempt) {
  const report = attempt.report;
  const failedChecks = (report?.checks ?? [])
    .filter((check) => check.status === "failed")
    .map((check) => clamp(check.name, 120))
    .slice(0, 8);
  const kind = failureKind(attempt);
  const diagnosis = report?.diagnosis
    ? {
        tried: report.diagnosis.tried
          .slice(0, 4)
          .map((value) => clamp(value, 200)),
        suspectedCause: clamp(report.diagnosis.suspectedCause, 300),
        need: report.diagnosis.need,
        ...(report.diagnosis.requestedWrites
          ? { requestedWrites: report.diagnosis.requestedWrites.slice(0, 8) }
          : {}),
      }
    : undefined;
  return {
    taskId: attempt.taskId,
    attempt: attemptNumber(symphony, attempt),
    attemptCount: taskAttempts(symphony, attempt.taskId).length,
    kind,
    failedChecks,
    message: clamp(report?.summary ?? attempt.message ?? "", 400),
    ...(diagnosis ? { diagnosis } : {}),
  };
}

/** A comparable identity for a finding, used to detect a repeated loop. */
function findingSignature(finding: TaskFinding): string {
  return [
    (finding.taskId ?? "").toLowerCase(),
    [...finding.paths].sort().join(","),
    finding.summary.toLowerCase().replace(/\s+/g, " ").slice(0, 120),
  ].join("|");
}

/**
 * True when every blocking finding in the current loop also appeared in the
 * previous loop (same owning task, same paths, similar summary). A repeat means
 * the fix did not land, so the wake recommends asking the user.
 */
function repeatsPreviousLoop(
  symphony: StoredSymphony,
  verdict: ReturnType<typeof loopVerdict>,
): boolean {
  if (verdict.verdict !== "needs-changes" || verdict.findings.length === 0) {
    return false;
  }
  const previous = new Set<string>();
  for (const attempt of symphony.execution.attempts) {
    if (
      !attempt.report ||
      attemptLoop(attempt) !== verdict.loop - 1 ||
      attempt.state !== "needs-changes"
    ) {
      continue;
    }
    for (const finding of attempt.report.findings ?? []) {
      if (finding.severity === "blocking") {
        previous.add(findingSignature(finding));
      }
    }
  }
  // Findings carried from an earlier loop (deferred) are not a repeat.
  const fresh = verdict.findings.filter((entry) => entry.loop === verdict.loop);
  return (
    fresh.length > 0 &&
    fresh.every((entry) => previous.has(findingSignature(entry.finding)))
  );
}

/** The per-loop wake text that states the verdict and the next step. */
function loopEndMessage(
  symphony: StoredSymphony,
  verdict: ReturnType<typeof loopVerdict>,
): string {
  if (verdict.verdict === "succeeded") {
    return `Loop ${verdict.loop} succeeded. Review the evidence, then finish the symphony with a summary.`;
  }
  const maxLoops =
    symphony.execution.conducting?.maxLoops ?? SYMPHONY_LIMITS.defaultLoops;
  const parts: string[] = [];
  const findings = verdict.findings.map(
    (entry) =>
      `${entry.finding.id} (${entry.finding.taskId ?? entry.reporterTaskId})`,
  );
  if (findings.length) {
    parts.push(
      `${findings.length} blocking finding${findings.length === 1 ? "" : "s"} [${findings.join(", ")}]`,
    );
  }
  const checks = verdict.failedChecks.map(
    (entry) => `${entry.check.name} (${entry.reporterTaskId})`,
  );
  if (checks.length) {
    parts.push(
      `${checks.length} failed check${checks.length === 1 ? "" : "s"} [${checks.join(", ")}]`,
    );
  }
  const detail = parts.length ? parts.join(" and ") : "no blocking findings";
  if (verdict.loop >= maxLoops) {
    return `Loop ${verdict.loop} needs changes: ${detail}. The loop budget (${maxLoops}) is used. Ask the user whether to continue (\`loop\` with \`approval\`) or finish with \`unresolved\`.`;
  }
  if (repeatsPreviousLoop(symphony, verdict)) {
    return `Loop ${verdict.loop} needs changes: ${detail}. The blocking findings repeat the previous loop; ask the user before the budget runs out.`;
  }
  return `Loop ${verdict.loop} needs changes: ${detail}. Start loop ${verdict.loop + 1} with \`loop\`, reopening the owning tasks.`;
}

/**
 * The worker choice a launch resolves with. A persisted `profileId` is the
 * stable identity and wins over the original reference (id or name), which is
 * kept only as historical context, so a rename cannot change which profile a
 * pending or resumed attempt uses. "inherit" means no profile is passed.
 */
export function launchChoice(
  launch: NonNullable<Attempt["launch"]>,
): WorkerChoice {
  const { profile, ...inline } = workerChoice(launch);
  const reference = launch.profileId ?? profile;
  return {
    ...(reference && reference !== "inherit" ? { profile: reference } : {}),
    ...inline,
  };
}

/** A short label for a launch's worker choice, used in a handoff preamble. */
function workerLabel(launch: Attempt["launch"] | undefined): string {
  if (!launch) {
    return "unknown";
  }
  const choice = workerChoice(launch);
  if (choice.provider && choice.model) {
    return `${choice.provider}/${choice.model}`;
  }
  return choice.provider ?? choice.model ?? choice.profile ?? "unknown";
}

export function orchestration(
  store: SymphonyStore,
  runtime: () => ExecutionRuntime & Partial<SymphonyChangesRuntime>,
  workers: () => WorkerRuntime,
  command: CommandLine,
  routing: RoutingCatalogSource,
) {
  const change = async (
    id: string,
    update: (symphony: StoredSymphony) => void,
  ) => {
    const { symphony } = await store.read(id);
    return store.update(id, symphony.version, (value) => {
      update(value);
      value.status = executionStatus(value);
      return value;
    });
  };
  const { owner, start, define } = symphonyConductor(
    store,
    runtime,
    workers,
    change,
    command,
    routing,
  );
  /**
   * The reason a task cannot start an attempt now, or null when it can. A task
   * may start only when its prerequisites are settled, its concurrency slot is
   * free, and no resource-holding attempt on this checkout conflicts under
   * effective writes. Naming the blocker lets `dispatch` refuse a retry before
   * mutating anything, including `addWrites`.
   */
  const reservationBlocker = async (
    current: StoredSymphony,
    task: TaskDefinition,
    additions: readonly GrantedWrite[] = [],
  ): Promise<string | null> => {
    const execution = current.execution;
    if (!execution.conducting || execution.finishedAt !== null) {
      return "this symphony is not ready to dispatch.";
    }
    const review = isReviewTask(task);
    // `after` prerequisites are loop-only: they hold for this loop without
    // changing the task's declared `dependsOn`. A prerequisite scheduled to
    // re-run this loop is not settled until its new attempt settles.
    const unmet = loopPrerequisites(current, task).find(
      (id) => !prerequisiteReady(current, id, review),
    );
    if (unmet) {
      return `prerequisite task "${unmet}" has not completed and settled.`;
    }
    // A retry resumes or replaces the task's own latest attempt, so that
    // attempt never counts against the concurrency limit or conflicts with
    // itself. Any other resource-holding attempt still blocks the retry.
    const own = latestAttempt(current, task.id);
    const holders = execution.attempts.filter(
      (a) => attemptHoldsResources(a) && a.id !== own?.id,
    ).length;
    if (holders >= execution.conducting.concurrency) {
      return `the symphony concurrency limit (${execution.conducting.concurrency}) is reached.`;
    }
    const list = await store.list();
    if (list.incomplete || list.unavailable) {
      throw new SymphonyError(
        "Symphony coverage is incomplete; task agent ownership cannot be checked.",
      );
    }
    // The candidate's own effective scope includes Conductor additions from its
    // earlier attempts and the ones it is about to record, so the conflict
    // check cannot miss them.
    const effective = effectiveTask(current, task);
    const grown = [
      ...new Set([
        ...effective.writes,
        ...additions.map((grant) => grant.path),
      ]),
    ];
    const candidate =
      grown.length === effective.writes.length
        ? effective
        : {
            ...effective,
            writes: grown,
            worker: { ...effective.worker, role: "implementation" as const },
          };
    for (const summary of list.symphonies) {
      if (summary.source.checkout !== current.source.checkout) {
        continue;
      }
      const other =
        summary.id === current.id
          ? current
          : (await store.read(summary.id)).symphony;
      if (!symphonyHoldsResources(other)) {
        continue;
      }
      for (const definition of other.revisions.at(-1)?.score.tasks ?? []) {
        if (other.id === current.id && definition.id === task.id) {
          continue;
        }
        const holding = latestAttempt(other, definition.id);
        // Effective writes union the task's declared scope, every Conductor
        // addition, and the latest attempt's widen grants, so both conflict
        // checks cannot drift apart.
        const held = effectiveTask(other, definition);
        if (
          attemptHoldsResources(holding) &&
          scopeConflictReason(candidate, held)
        ) {
          return `task "${definition.id}" in "${other.title}" still holds its resources.`;
        }
      }
    }
    if (execution.attempts.length >= SYMPHONY_LIMITS.attempts) {
      throw new SymphonyError("Symphony attempt limit reached.");
    }
    return null;
  };
  /**
   * True when a task may start an attempt now. Shared by fresh reservations and
   * same-agent continuations so writers never overlap in time.
   */
  const canReserve = async (
    current: StoredSymphony,
    task: TaskDefinition,
    additions?: readonly GrantedWrite[],
  ): Promise<boolean> =>
    (await reservationBlocker(current, task, additions)) === null;

  /**
   * Every finding the latest report of each task carries, whichever loop
   * produced it, keyed by the canonical `reporter#id` reference. Finding ids
   * are unique only within one report, so a bare id resolves only when exactly
   * one reporter used it.
   */
  const openFindingMap = (
    current: StoredSymphony,
  ): Map<string, { reporterTaskId: string; finding: TaskFinding }> => {
    const map = new Map<
      string,
      { reporterTaskId: string; finding: TaskFinding }
    >();
    for (const task of current.revisions.at(-1)?.score.tasks ?? []) {
      const attempt = latestAttempt(current, task.id);
      for (const finding of attempt?.report?.findings ?? []) {
        map.set(`${task.id}#${finding.id}`, {
          reporterTaskId: task.id,
          finding,
        });
      }
    }
    return map;
  };

  /**
   * The canonical `reporter#id` key a finding reference names, or an error
   * message when the reference is unknown or a bare id is ambiguous.
   */
  const findingKey = (
    map: ReturnType<typeof openFindingMap>,
    reference: string,
  ): { key: string } | { error: string } => {
    if (map.has(reference)) {
      return { key: reference };
    }
    const matches = [...map.keys()].filter((key) =>
      key.endsWith(`#${reference}`),
    );
    if (matches.length === 1 && matches[0] !== undefined) {
      return { key: matches[0] };
    }
    return {
      error: matches.length
        ? `Finding "${reference}" is ambiguous; name it as ${matches.join(" or ")}.`
        : `Unknown finding "${reference}".`,
    };
  };

  /**
   * Why the current loop runs a task, as prompt context. Explicit reopens carry
   * the finding objects captured when `loop` was accepted; a transitive
   * dependent gets a short re-check. A review, explicitly reopened or not,
   * also gets the open blocking findings captured then, so a later rerun of a
   * reporter cannot hide them.
   */
  const loopContext = (
    record: LoopRecord,
    task: TaskDefinition,
    scheduled: LoopScheduleEntry,
  ): LoopPromptContext => {
    const found = isReviewTask(task)
      ? reviewPreviousFindings(record, task.id)
      : { findings: [], omitted: 0 };
    const previous =
      found.findings.length || found.omitted ? { previous: found } : {};
    if (scheduled.reopen) {
      return {
        reopen: {
          reason: scheduled.reopen.note ?? record.reason,
          findings: scheduled.reopen.resolved ?? [],
        },
        ...previous,
      };
    }
    return {
      recheck: { loop: record.number, changed: scheduled.changed },
      ...previous,
    };
  };

  /**
   * The loop context for a task that the current loop scheduled and that has
   * not run in it yet, or null otherwise.
   */
  const loopReopenContext = (
    current: StoredSymphony,
    task: TaskDefinition,
  ): (LoopPromptContext & { entry?: LoopReopen }) | null => {
    const record = currentLoopRecord(current);
    const scheduled = pendingLoopEntry(current, task.id);
    if (!record || !scheduled) {
      return null;
    }
    return {
      ...loopContext(record, task, scheduled),
      ...(scheduled.reopen ? { entry: scheduled.reopen } : {}),
    };
  };

  /**
   * The loop context a retry or rebind of a task's current-loop attempt
   * repeats, so a replacement agent still gets the reopen findings and a
   * review's previous findings. Empty outside a loop the task was scheduled in.
   */
  const retryLoopContext = (
    current: StoredSymphony,
    task: TaskDefinition,
  ): LoopPromptContext => {
    const record = currentLoopRecord(current);
    const score = current.revisions.at(-1)?.score;
    const latest = latestAttempt(current, task.id);
    if (!record || !score || !latest || attemptLoop(latest) !== record.number) {
      return {};
    }
    const scheduled = loopSchedule(score, record).get(task.id);
    return scheduled ? loopContext(record, task, scheduled) : {};
  };

  /**
   * The previous loop's blocking findings a re-running review confirms, with
   * reporter-qualified ids. The review always gets every finding it reported
   * itself; other reporters' findings fill the list up to one report's bound,
   * and the rest are counted so the prompt never truncates silently.
   */
  const reviewPreviousFindings = (
    record: LoopRecord,
    taskId: string,
  ): { findings: TaskFinding[]; omitted: number } => {
    if (!record.previousReports) {
      return { findings: record.previousFindings ?? [], omitted: 0 };
    }
    const qualified = (entry: PreviousReport) =>
      entry.findings.map((finding) => ({
        ...finding,
        id: `${entry.reporterTaskId}#${finding.id}`,
      }));
    const own = record.previousReports
      .filter((entry) => entry.reporterTaskId === taskId)
      .flatMap(qualified);
    const others = record.previousReports
      .filter((entry) => entry.reporterTaskId !== taskId)
      .flatMap(qualified);
    const room = Math.max(0, SYMPHONY_LIMITS.findingsPerReport - own.length);
    return {
      findings: [...own, ...others.slice(0, room)],
      omitted: Math.max(0, others.length - room),
    };
  };

  /** Failed attempts of one task in the current loop, for the retry limit. */
  const failedRetriesInLoop = (
    current: StoredSymphony,
    taskId: string,
  ): number =>
    taskAttempts(current, taskId)
      .filter((attempt) => attemptLoop(attempt) === currentLoop(current))
      .reduce(
        (count, attempt) =>
          count +
          (attempt.state === "failed" ? 1 : 0) +
          (attempt.identityRetries ?? 0),
        0,
      );
  /**
   * The write scope an attempt that reuses its existing attempt starts with:
   * the task's effective scope plus the Conductor additions this attempt is
   * about to record. A new attempt uses `nextAttemptWrites` instead, because
   * the previous attempt's temporary grants expire when it becomes latest.
   */
  const attemptWrites = (
    current: StoredSymphony,
    task: TaskDefinition,
    additions?: GrantedWrite[],
  ): string[] => [
    ...new Set([
      ...effectiveTask(current, task).writes,
      ...(additions?.map((grant) => grant.path) ?? []),
    ]),
  ];
  /**
   * The changed-path fields to store when an attempt settles: fingerprint the
   * attempt's effective write scope now and diff it against the baseline
   * recorded when it launched. Empty when either observation is unknown, such
   * as a non-Git checkout.
   */
  const changedPathFields = async (
    current: StoredSymphony,
    attempt: Attempt,
  ): Promise<Partial<ChangedPaths>> => {
    if (!attempt.writeFingerprint) {
      return {};
    }
    const task = current.revisions
      .at(-1)
      ?.score.tasks.find((entry) => entry.id === attempt.taskId);
    if (!task) {
      return {};
    }
    const changed = await recordChangedPaths(
      runtime(),
      current.source.checkout,
      effectiveTask(current, task).writes,
      attempt.writeFingerprint,
    );
    return changed ?? {};
  };
  /** The bounded per-task position a newly created attempt will occupy. */
  const newAttemptPosition = (current: StoredSymphony, taskId: string) => {
    const total = taskAttempts(current, taskId).length + 1;
    return { taskId, number: total, total };
  };
  /**
   * Merges Conductor additions into an attempt's recorded scope, deduplicating
   * by path and refusing to exceed the per-attempt bound.
   */
  const mergeAddedWrites = (
    existing: GrantedWrite[] | undefined,
    additions: GrantedWrite[],
  ): GrantedWrite[] => {
    const merged = [...(existing ?? [])];
    for (const grant of additions) {
      if (!merged.some((entry) => entry.path === grant.path)) {
        merged.push(grant);
      }
    }
    if (merged.length > SYMPHONY_LIMITS.addedWritesPerAttempt) {
      throw new SymphonyError(
        `addWrites refused: this attempt may hold at most ${SYMPHONY_LIMITS.addedWritesPerAttempt} Conductor-added paths.`,
      );
    }
    return merged;
  };
  /**
   * The full assignment for a new or replacement agent, combined with an
   * optional handoff. Both `reserve` and a blocked rebind use it so their
   * prompts stay identical apart from the handoff.
   */
  const agentPrompt = (assignment: string, handoff: string | null): string =>
    [assignment, handoff]
      .filter((part): part is string => Boolean(part))
      .join("\n\n");
  /** The characters an assignment may use next to `handoff` in one prompt. */
  const assignmentBudget = (handoff: string | null): number =>
    SYMPHONY_LIMITS.promptChars - (handoff ? handoff.length + 2 : 0);
  /**
   * The interruption for a task whose prompt cannot be saved even with
   * shortened findings, so the loop does not stall silently.
   */
  const oversizedPrompt = (taskId: string): string =>
    `Task "${taskId}" ${OVERSIZED_PROMPT} ${SYMPHONY_LIMITS.promptChars} characters even with shortened findings and checks. Ask the user, then finish with \`unresolved\` covering this task.`;
  /**
   * The handoff fields for a replacement agent: the union of every earlier
   * attempt's changed paths. Omits `changedPaths` entirely when no attempt was
   * observable, so the handoff can say the files are unknown.
   */
  const handoffPaths = (current: StoredSymphony, taskId: string) => {
    const union = unionChangedPaths(taskAttempts(current, taskId));
    return {
      ...(union.observed ? { changedPaths: union.paths } : {}),
      ...(union.truncated ? { changedPathsTruncated: true } : {}),
      ...(union.observed && union.incomplete
        ? { changedPathsIncomplete: true }
        : {}),
    };
  };
  /** The available providers and the Conductor's permission mode for routing. */
  const routingContext = async (conductorId: string | null) => {
    const workerRuntime = workers();
    const parentModeId =
      conductorId !== null
        ? await workerRuntime.modeOf?.(conductorId)
        : undefined;
    const availableProviders = workerRuntime.providers
      ? new Set(
          (await workerRuntime.providers())
            .filter((entry) => entry.available)
            .map((entry) => entry.provider),
        )
      : null;
    return { parentModeId, availableProviders };
  };
  interface LaunchRoutingResolution {
    routing?: AttemptRouting | undefined;
    warnings: RoutingWarning[];
    catalogRevision: string;
    errors: string[];
    /** The chosen Conductor profile, persisted and injected into the prompt. */
    profile?: ConductorProfile | undefined;
  }
  /** The Conductor profile a worker choice names, if it resolves. */
  const chosenProfile = (
    profiles: readonly ConductorProfile[],
    choice: WorkerChoice,
  ): ConductorProfile | undefined => {
    if (!choice.profile || choice.profile === "inherit") {
      return undefined;
    }
    const resolution = resolveProfileRef(profiles, choice.profile);
    return "profile" in resolution ? resolution.profile : undefined;
  };
  /**
   * The profile fields snapshotted on an attempt launch. `profileId` is only
   * persisted when it is a schema-valid UUID, so the launch record stays valid
   * even for a test or imported id; the name always accompanies it.
   */
  const profileSnapshot = (profile: ConductorProfile) => ({
    profileName: profile.name,
    ...(profileIdSchema.safeParse(profile.id).success
      ? { profileId: profile.id }
      : {}),
  });
  /**
   * One validation path for a concrete launch choice. It loads the catalog,
   * keeps the recorded routing warnings, and revalidates against the current
   * catalog when the choice was last validated at a different revision. Warn
   * mode records a catalog-changed warning; strict mode returns errors so no
   * continuation or reuse path bypasses it.
   */
  const resolveLaunchRouting = async (input: {
    agentId: string | null;
    task: TaskDefinition;
    choice: WorkerChoice;
    /** Routing to apply; defaults to the task's define-time routing. */
    routing?: AttemptRouting | undefined;
    /** Warnings already recorded with this decision. */
    warnings?: RoutingWarning[] | undefined;
    /** The revision the choice was last validated at. */
    baselineRevision?: string | undefined;
  }): Promise<LaunchRoutingResolution> => {
    const catalog = await routing.load();
    const profile = chosenProfile(catalog.profiles, input.choice);
    const withProfile = (
      resolution: LaunchRoutingResolution,
    ): LaunchRoutingResolution =>
      profile ? { ...resolution, profile } : resolution;
    const baseRouting: AttemptRouting | undefined =
      input.routing ??
      (input.task.routing
        ? {
            reason: input.task.routing.reason,
            selectedBy: input.task.routing.selectedBy,
            ...(input.task.routing.override
              ? { override: input.task.routing.override }
              : {}),
          }
        : undefined);
    const warnings = [...(input.warnings ?? [])];
    const baseline =
      input.baselineRevision ?? input.task.routing?.catalogRevision;
    if (baseline === undefined || baseline === catalog.catalogRevision) {
      return withProfile({
        routing: baseRouting,
        warnings,
        catalogRevision: catalog.catalogRevision,
        errors: [],
      });
    }
    if (catalog.state === "invalid") {
      warnings.push({
        code: "catalog-changed",
        message:
          "Conductor profiles are invalid; kept the define-time routing.",
      });
      return withProfile({
        routing: baseRouting,
        warnings,
        catalogRevision: catalog.catalogRevision,
        errors: [],
      });
    }
    const { parentModeId, availableProviders } = await routingContext(
      input.agentId,
    );
    const result = route(catalog, {
      intent: { role: input.task.routing?.role ?? "implementation" },
      parentModeId,
      availableProviders,
    });
    const validation = validateChoice({
      taskId: input.task.id,
      choice: choiceKind(input.choice),
      ...(baseRouting?.reason !== undefined
        ? { reason: baseRouting.reason }
        : {}),
      ...(baseRouting?.override !== undefined
        ? { override: baseRouting.override }
        : {}),
      route: result,
      catalog,
      mode: catalog.mode,
    });
    if (validation.errors.length) {
      return withProfile({
        routing: baseRouting,
        warnings,
        catalogRevision: catalog.catalogRevision,
        errors: validation.errors,
      });
    }
    warnings.push(...validation.warnings, {
      code: "catalog-changed",
      message: `Profile catalog changed since define (${baseline.slice(0, 8)} to ${catalog.catalogRevision.slice(0, 8)}); routing was revalidated.`,
    });
    return withProfile({
      routing: baseRouting,
      warnings,
      catalogRevision: catalog.catalogRevision,
      errors: [],
    });
  };
  /**
   * In strict mode, the first validation error for the attempt's actual worker
   * choice whose catalog revision changed since it was validated. A retry
   * throws this before mutating.
   */
  const staleRoutingError = async (
    agentId: string,
    task: TaskDefinition,
    attempt: Attempt,
  ): Promise<string | null> => {
    if (!attempt.launch) {
      return null;
    }
    const resolved = await resolveLaunchRouting({
      agentId,
      task,
      // Resolve the persisted profile identity, matching launch and
      // continuation, so a rename cannot invalidate an otherwise valid retry.
      choice: launchChoice(attempt.launch),
      routing: attempt.launch.routing,
      warnings: [],
      baselineRevision: attempt.launch.catalogRevision,
    });
    return resolved.errors[0]
      ? `${resolved.errors[0]} The profile catalog changed; reopen the task with a worker override or update the Conductor profiles.`
      : null;
  };
  const catalogChangedMessage = (validation: { errors: string[] }) =>
    `${validation.errors[0]} The profile catalog changed; reopen the task with a worker override or update the Conductor profiles.`;
  /** Merges warning lists without duplicates, preserving order. */
  const mergeWarnings = (
    ...lists: Array<readonly RoutingWarning[] | undefined>
  ): RoutingWarning[] => {
    const seen = new Set<string>();
    const merged: RoutingWarning[] = [];
    for (const list of lists) {
      for (const warning of list ?? []) {
        const key = `${warning.code}|${warning.message}`;
        if (!seen.has(key)) {
          seen.add(key);
          merged.push(warning);
        }
      }
    }
    return merged;
  };
  const reserve = async (
    symphonyId: string,
    task: TaskDefinition,
    options: {
      retry?: boolean;
      replacement?: WorkerChoice;
      prior?: { report: TaskReport | null; note?: string };
      additions?: GrantedWrite[];
      /** The loop this attempt runs in; defaults to the current loop. */
      loop?: number;
      /** Findings a reopened task must address. */
      reopen?: AttemptReopen;
      /** A short dependent re-check after a prerequisite changed. */
      recheck?: RecheckPromptInput;
      /** A re-running review's previous-loop findings to confirm. */
      previous?: PreviousFindingsInput;
      /** The routing decision for a replacement worker, if any. */
      routing?: AttemptRouting;
      /** Warnings recorded with a replacement worker choice. */
      warnings?: RoutingWarning[];
      /** The catalog revision the replacement was last validated at. */
      baselineRevision?: string;
    } = {},
  ) => {
    const override = workerChoice(options.replacement ?? {});
    // An inline replacement must not fall back to the task's configured profile.
    const choice = Object.keys(override).length
      ? { profile: "inherit", ...override }
      : { ...workerChoice(task.worker), profile: task.worker.profile };
    const { symphony } = await store.read(symphonyId);
    // A replacement worker choice replaces the previous decision as a whole,
    // so its validated warnings (even none) are authoritative. The task's
    // define-time warnings apply only to an initial launch or when the task's
    // own routing is actually carried.
    const replacing =
      options.replacement !== undefined || options.routing !== undefined;
    const resolved = await resolveLaunchRouting({
      agentId: symphony.source.agentId,
      task,
      choice,
      ...(options.routing ? { routing: options.routing } : {}),
      warnings: replacing
        ? options.warnings
        : mergeWarnings(task.routing?.warnings, options.warnings),
      ...(options.baselineRevision !== undefined ||
      task.routing?.catalogRevision !== undefined
        ? {
            baselineRevision:
              options.baselineRevision ?? task.routing?.catalogRevision,
          }
        : {}),
    });
    if (resolved.errors.length) {
      await change(symphonyId, (current) => {
        current.execution.interruption = catalogChangedMessage(resolved);
      });
      return false;
    }
    const baseRouting = resolved.routing;
    const launchWarnings = resolved.warnings;
    let reserved = false;
    await store.update(symphonyId, symphony.version, async (current) => {
      const execution = current.execution;
      if (!execution.conducting || execution.finishedAt !== null) {
        return current;
      }
      const previous = latestAttempt(current, task.id);
      if (previous) {
        // A loop attempt supersedes a settled previous attempt from an earlier
        // loop; a retry still only continues a failed attempt.
        const looping =
          options.loop !== undefined && attemptLoop(previous) < options.loop;
        if (
          !looping &&
          !(
            options.retry &&
            previous.state === "failed" &&
            previous.launch?.settled
          )
        ) {
          return current;
        }
      }
      if (!(await canReserve(current, task, options.additions))) {
        return current;
      }
      const loop = options.loop ?? currentLoop(current);
      const attemptId = randomUUID();
      const workerId = commandSymphonyId(current.id, attemptId);
      const { context } = await store.read(current.id);
      const writes = nextAttemptWrites(current, task, options.additions ?? []);
      // A replacement agent gets the full assignment plus a handoff; its own
      // conversation does not exist yet. Changed files are recorded later.
      const handoff =
        options.retry || options.loop !== undefined
          ? handoffInstructions({
              attempt: newAttemptPosition(current, task.id),
              previousWorker: workerLabel(previous?.launch),
              report: options.prior?.report ?? null,
              ...handoffPaths(current, task.id),
              ...(options.prior?.note ? { note: options.prior.note } : {}),
              ...(resolved.profile?.instructions
                ? { instructions: resolved.profile.instructions }
                : {}),
            })
          : null;
      const prompt = agentPrompt(
        taskAssignmentPrompt({
          symphony: current,
          task,
          attemptId,
          plan: context.plan,
          writes,
          ...(options.reopen ? { reopen: options.reopen } : {}),
          ...(options.recheck ? { recheck: options.recheck } : {}),
          ...(options.previous ? { previous: options.previous } : {}),
          ...(resolved.profile?.instructions
            ? { instructions: resolved.profile.instructions }
            : {}),
          budget: assignmentBudget(handoff),
        }),
        handoff,
      );
      if (prompt.length > SYMPHONY_LIMITS.promptChars) {
        execution.interruption = oversizedPrompt(task.id);
        current.status = executionStatus(current);
        return current;
      }
      execution.attempts.push({
        id: attemptId,
        taskId: task.id,
        agentId: workerId,
        state: "running",
        startedAt: Date.now(),
        endedAt: null,
        message: "Starting task agent…",
        report: null,
        reportHash: null,
        loop,
        ...(options.reopen ? { reopen: options.reopen } : {}),
        ...(options.recheck ? { recheck: true } : {}),
        ...(options.additions?.length
          ? { addedWrites: options.additions }
          : {}),
        launch: {
          state: "pending",
          prompt,
          settled: false,
          ...choice,
          ...(resolved.profile ? profileSnapshot(resolved.profile) : {}),
          ...(baseRouting ? { routing: baseRouting } : {}),
          ...(launchWarnings.length
            ? { warnings: launchWarnings.slice(0, 8) }
            : {}),
          catalogRevision: resolved.catalogRevision,
          generation: 0,
        },
      });
      execution.interruption = null;
      current.status = executionStatus(current);
      reserved = true;
      return current;
    });
    return reserved;
  };
  const launchAttempt = async (symphonyId: string, task: TaskDefinition) => {
    const { symphony } = await store.read(symphonyId);
    const attempt = latestAttempt(symphony, task.id);
    if (
      !attempt?.launch ||
      attempt.launch.state === "started" ||
      attempt.launch.state === "failed" ||
      !symphony.source.agentId
    ) {
      return;
    }
    let creationStarted = false;
    try {
      const score = symphony.revisions.at(-1)?.score;
      // Validate the scope this attempt can actually reach: the plan plus every
      // Conductor addition and temporary grant, not just the newest revision, so
      // persistent `addedWrites` still get placement and symlink validation at
      // every launch.
      await runtime().validate(symphony.source, {
        tasks: (score?.tasks ?? []).map((entry) =>
          effectiveTask(symphony, entry),
        ),
      });
      const input = {
        agentId: attempt.agentId,
        parentAgentId: symphony.source.agentId,
        concertId: symphony.source.concertId,
        title: task.title,
        prompt: attempt.launch.prompt,
        ...launchChoice(attempt.launch),
      };
      const config = attempt.launch.config ?? (await workers().prepare(input));
      if (!attempt.launch.config) {
        await change(symphonyId, (current) => {
          const a = latestAttempt(current, task.id);
          if (a?.launch && a.id === attempt.id) {
            a.launch.config = config;
          }
        });
      }
      // The agent has not started yet, so this is the write-scope baseline its
      // settle observation is compared against. Persist it before the launch so
      // an uncertain launch keeps the first observation instead of re-basing
      // onto changes the lost launch may already have made. An attempt whose
      // first observation was unavailable is recorded as unknown and never
      // recaptured: a later rebind would otherwise capture a baseline that
      // already includes the earlier agent's edits and hide them.
      if (!attempt.writeFingerprint && !attempt.writeFingerprintUnknown) {
        const baseline = await runtime().fingerprint?.(
          symphony.source.checkout,
          attemptWrites(symphony, task),
        );
        await change(symphonyId, (current) => {
          const active = latestAttempt(current, task.id);
          if (
            active?.launch &&
            active.id === attempt.id &&
            !active.writeFingerprint &&
            !active.writeFingerprintUnknown
          ) {
            if (baseline) {
              active.writeFingerprint = baseline.paths;
            } else {
              active.writeFingerprintUnknown = true;
            }
          }
        });
      }
      creationStarted = true;
      await workers().launch({ ...input, config });
      await change(symphonyId, (current) => {
        const active = latestAttempt(current, task.id);
        if (active?.launch && active.id === attempt.id) {
          active.launch.state = "started";
          // A retry of a settled uncertain launch re-opens reconciliation.
          // Without clearing `settled` and the exhausted check schedule the
          // attempt stays settled and every later reconcile skips it, so no
          // nudge or no-report settlement is ever delivered.
          active.launch.settled = false;
          delete active.launch.checks;
          delete active.launch.nextCheckAt;
          active.state = "running";
          active.message = null;
        }
      });
    } catch (error) {
      const rejected = !creationStarted || error instanceof LaunchRejectedError;
      await change(symphonyId, (current) => {
        const active = latestAttempt(current, task.id);
        if (active?.launch && active.id === attempt.id) {
          if (rejected) {
            active.launch.state = "failed";
            active.launch.settled = true;
            active.state = "failed";
            active.reportedBy = "launcher";
            active.report = {
              outcome: "failed",
              summary:
                error instanceof SymphonyError
                  ? error.message
                  : "Task validation failed before any agent was created.",
              evidence: [
                "The launcher rejected this assignment before agent creation.",
              ],
              checks: task.checks.map((name) => ({
                name,
                status: "not-run",
                detail: "Agent creation was rejected.",
              })),
            };
            active.reportHash = contentHash(JSON.stringify(active.report));
            active.endedAt = Date.now();
            active.message = null;
            // A terminal attempt never resumes, so its baseline (or its
            // unknown marker) is no longer needed and must not grow stored
            // symphonies.
            delete active.writeFingerprint;
            delete active.writeFingerprintUnknown;
          } else {
            active.launch.state = "uncertain";
            active.state = "running";
            active.launch.settled = false;
            active.message =
              "Task agent launch could not be confirmed. The same agent identity is re-checked before it is treated as failed; no replacement has been created.";
          }
        }
      });
    }
  };
  /** True when a retry keeps the failed attempt's resolved worker choice. */
  const sameWorkerChoice = (
    task: TaskDefinition,
    attempt: Attempt,
    replacement?: WorkerChoice,
  ): boolean => {
    const override = workerChoice(replacement ?? {});
    const intended = Object.keys(override).length
      ? { profile: "inherit", ...override }
      : workerChoice(task.worker);
    const previous = workerChoice(attempt.launch ?? {});
    return (
      (intended.profile ?? null) === (previous.profile ?? null) &&
      (intended.provider ?? null) === (previous.provider ?? null) &&
      (intended.model ?? null) === (previous.model ?? null) &&
      (intended.thinkingOptionId ?? null) ===
        (previous.thinkingOptionId ?? null)
    );
  };
  /**
   * Validates a Conductor scope addition for a retry and returns the grants to
   * record on the attempt the retry creates or resumes. The plan never changes:
   * the additions live on the attempt and survive every later attempt of the
   * task. Returns undefined when every path is already in the task's effective
   * scope. Runs the same placement/symlink and conflict checks `reserve` uses.
   */
  const taskWriteAdditions = async (
    current: StoredSymphony,
    taskId: string,
    paths: string[],
    note: string,
  ): Promise<GrantedWrite[] | undefined> => {
    const execution = current.execution;
    const score = current.revisions.at(-1)?.score;
    if (!execution.conducting || !score) {
      throw new SymphonyError("This symphony is not ready to widen a task.");
    }
    const task = score.tasks.find((entry) => entry.id === taskId);
    if (!task) {
      throw new SymphonyError("Unknown task.");
    }
    const effective = effectiveTask(current, task);
    // Dedupe only against the task's persistent scope: its declared writes plus
    // the `addedWrites` of every attempt. The latest attempt's temporary
    // `widen` grants are not persistent, so promoting one of those paths must
    // still be recorded instead of dropped as already present.
    const persistent = [
      ...task.writes,
      ...taskAttempts(current, task.id).flatMap(
        (attempt) => attempt.addedWrites?.map((grant) => grant.path) ?? [],
      ),
    ];
    const additions = [...new Set(paths)].filter(
      (path) => !persistent.includes(path),
    );
    if (additions.length === 0) {
      return undefined;
    }
    const writes = [...new Set([...effective.writes, ...additions])];
    // A read-only task that gains writes is no longer exploration.
    const grown: TaskDefinition = { ...effective, writes };
    // The grown scope becomes task storage, so re-run the placement and symlink
    // validation the initial define/launch used before persisting it.
    await runtime().validate(current.source, {
      tasks: score.tasks.map((entry) => (entry.id === task.id ? grown : entry)),
    });
    const list = await store.list();
    if (list.incomplete || list.unavailable) {
      throw new SymphonyError(
        "Symphony coverage is incomplete; widen conflicts cannot be checked.",
      );
    }
    for (const summary of list.symphonies) {
      if (summary.source.checkout !== current.source.checkout) {
        continue;
      }
      const other =
        summary.id === current.id
          ? current
          : (await store.read(summary.id)).symphony;
      for (const definition of other.revisions.at(-1)?.score.tasks ?? []) {
        if (other.id === current.id && definition.id === task.id) {
          continue;
        }
        const holding = latestAttempt(other, definition.id);
        if (!symphonyHoldsResources(other) || !attemptHoldsResources(holding)) {
          continue;
        }
        const reason = scopeConflictReason(
          grown,
          effectiveTask(other, definition),
        );
        if (reason) {
          throw new SymphonyError(
            `addWrites refused: ${paths.join(", ")} overlaps task "${definition.id}" in ${other.title} (${reason}).`,
          );
        }
      }
    }
    const at = Date.now();
    const reason = clamp(note, 2000);
    return additions.map((path) => ({ path, reason, at }));
  };
  /**
   * Sends an attempt's persisted `wake` and clears it only after the keyed send
   * succeeds. A failed or uncertain send leaves the wake in place so the next
   * reconciliation replays the exact same message and identity. Nudges record
   * `nudgedAt` at that point, so a failed send never consumes the one nudge.
   */
  const deliverPendingWake = async (symphonyId: string, attemptId: string) => {
    const { symphony } = await store.read(symphonyId);
    const attempt = symphony.execution.attempts.find(
      (entry) => entry.id === attemptId,
    );
    const wake = attempt?.wake;
    if (!attempt || !wake) {
      return;
    }
    try {
      await workers().wake(attempt.agentId, wake.prompt, wake.key);
    } catch (error) {
      // A transiently busy or unavailable task agent keeps the wake pending.
      if (error instanceof SymphonyError) {
        return;
      }
      throw error;
    }
    await change(symphonyId, (current) => {
      const delivered = current.execution.attempts.find(
        (entry) => entry.id === attemptId,
      );
      if (delivered?.wake?.key !== wake.key) {
        return;
      }
      delivered.wake = undefined;
      if (wake.key.startsWith("nudge:")) {
        delivered.nudgedAt = Date.now();
      }
    });
  };
  /**
   * A failed task continues on its previous agent: a new attempt records the
   * work but the task agent keeps its conversation. The failed report stays
   * as-is.
   */
  const continueFailedAttempt = async (
    symphonyId: string,
    task: TaskDefinition,
    previous: Attempt,
    launch: NonNullable<Attempt["launch"]>,
    prior: { report: TaskReport | null; note?: string },
    additions?: GrantedWrite[],
    options: {
      /** The loop this attempt runs in; defaults to the current loop. */
      loop?: number;
      reopen?: AttemptReopen;
      recheck?: RecheckPromptInput;
      previous?: PreviousFindingsInput;
    } = {},
  ): Promise<boolean> => {
    const attemptId = randomUUID();
    // Continue the same agent under its persisted profile identity, falling back
    // to the original reference only for a record stored before profileId.
    const choice = launchChoice(launch);
    const initial = (await store.read(symphonyId)).symphony;
    // Validate the actual continued choice before creating or waking anything,
    // so a continuation cannot bypass strict mode after a profile takeover.
    const resolved = await resolveLaunchRouting({
      agentId: initial.source.agentId,
      task,
      choice,
      ...(launch.routing ? { routing: launch.routing } : {}),
      warnings: launch.warnings ?? [],
      ...(launch.catalogRevision !== undefined ||
      task.routing?.catalogRevision !== undefined
        ? {
            baselineRevision:
              launch.catalogRevision ?? task.routing?.catalogRevision,
          }
        : {}),
    });
    if (resolved.errors.length) {
      await change(symphonyId, (current) => {
        current.execution.interruption = catalogChangedMessage(resolved);
        current.status = executionStatus(current);
      });
      return false;
    }
    const writes = nextAttemptWrites(initial, task, additions ?? []);
    // The continued agent starts from the checkout as it is now, so its own
    // changed paths are measured against this baseline. Persist it before the
    // continuation so a later blocked rebind keeps the first observation
    // instead of re-basing onto changes this agent may already have made. An
    // unavailable observation is recorded as unknown and never recaptured,
    // mirroring `launchAttempt`.
    const baseline = await runtime().fingerprint?.(
      initial.source.checkout,
      writes,
    );
    const prompt = continuationPrompt({
      taskId: task.id,
      attemptId,
      position: newAttemptPosition(initial, task.id),
      ...(prior.note ? { note: prior.note } : {}),
      writes,
      added: additions?.map((grant) => grant.path) ?? [],
      ...(options.reopen ? { reopen: options.reopen } : {}),
      ...(options.recheck ? { recheck: options.recheck } : {}),
      ...(options.previous ? { previous: options.previous } : {}),
      // The agent's conversation holds only the results it started with, so
      // the continuation carries each prerequisite's current result.
      prerequisites: prerequisiteResults(initial, task),
    });
    if (prompt.length > SYMPHONY_LIMITS.promptChars) {
      await change(symphonyId, (current) => {
        current.execution.interruption = oversizedPrompt(task.id);
        current.status = executionStatus(current);
      });
      return false;
    }
    let created = false;
    await store.update(symphonyId, initial.version, async (current) => {
      const execution = current.execution;
      const latest = latestAttempt(current, task.id);
      const loop = options.loop ?? currentLoop(current);
      // A loop continuation supersedes a settled completed or needs-changes
      // attempt; a retry still only continues a failed one.
      const allowed =
        options.loop !== undefined
          ? latest !== undefined && attemptLoop(latest) < options.loop
          : latest?.state === "failed";
      if (
        !latest ||
        latest.id !== previous.id ||
        !allowed ||
        !latest.launch?.settled
      ) {
        return current;
      }
      // Keep writers serialized even though the agent is reused.
      if (!(await canReserve(current, task, additions))) {
        return current;
      }
      execution.attempts.push({
        id: attemptId,
        taskId: task.id,
        agentId: previous.agentId,
        state: "running",
        startedAt: Date.now(),
        endedAt: null,
        message: "Continuing the assignment on the same task agent…",
        report: null,
        reportHash: null,
        loop,
        ...(options.reopen ? { reopen: options.reopen } : {}),
        ...(options.recheck ? { recheck: true } : {}),
        ...(additions?.length ? { addedWrites: additions } : {}),
        ...(baseline
          ? { writeFingerprint: baseline.paths }
          : { writeFingerprintUnknown: true }),
        wake: { key: `continue:${attemptId}`, prompt },
        launch: {
          state: "started",
          prompt,
          settled: false,
          generation: 0,
          ...choice,
          profile: launch.profile,
          ...(launch.profileId ? { profileId: launch.profileId } : {}),
          ...(launch.profileName ? { profileName: launch.profileName } : {}),
          ...(resolved.routing ? { routing: resolved.routing } : {}),
          ...(resolved.warnings.length
            ? { warnings: resolved.warnings.slice(0, 8) }
            : {}),
          ...(launch.config ? { config: launch.config } : {}),
          catalogRevision: resolved.catalogRevision,
        },
      });
      execution.interruption = null;
      current.status = executionStatus(current);
      created = true;
      return current;
    });
    if (created) {
      await deliverPendingWake(symphonyId, attemptId);
    }
    return created;
  };

  /**
   * Starts the attempts the current loop scheduled and that can start now: the
   * explicit reopens (with their recorded note, write additions and findings)
   * and the transitive dependents of reopened tasks. A task waiting on a
   * loop-only `after` prerequisite or a busy checkout starts on a later call.
   * Idempotent: a task that already ran in the current loop is skipped, so
   * `loop`, every dispatch and every reconcile can safely call it.
   *
   * A task continues on its previous agent with that agent's actual worker
   * choice when the agent is idle and can receive a message. An agent that is
   * still active is never replaced; otherwise a new agent starts with the
   * previous report and the previous launch's worker choice.
   */
  const startLoopTasks = async (symphonyId: string): Promise<void> => {
    let { symphony } = await store.read(symphonyId);
    const meta = symphony.execution.conducting;
    if (
      !meta ||
      meta.phase !== "working" ||
      symphony.execution.finishedAt !== null ||
      !currentLoopRecord(symphony)
    ) {
      return;
    }
    const loop = currentLoop(symphony);
    for (const task of symphony.revisions.at(-1)?.score.tasks ?? []) {
      const context = loopReopenContext(symphony, task);
      if (!context) {
        continue;
      }
      const { entry, ...prompt } = context;
      const overrideWorker = entry?.worker;
      const additions = entry?.addedWrites?.length
        ? entry.addedWrites
        : undefined;
      if (await reservationBlocker(symphony, task, additions)) {
        continue;
      }
      const previous = latestAttempt(symphony, task.id);
      const prior: { report: TaskReport | null; note?: string } = {
        report: previous?.report ?? null,
        ...(entry?.note ? { note: entry.note } : {}),
      };
      let created = false;
      // A reopen worker override never reuses the previous agent, so the
      // replacement starts with the previous report and a handoff.
      if (previous?.launch && !overrideWorker) {
        const status = await workers().inspect(previous.agentId);
        if (status.active) {
          continue;
        }
        if (status.deliverable) {
          created = await continueFailedAttempt(
            symphony.id,
            task,
            previous,
            previous.launch,
            prior,
            additions,
            { loop, ...prompt },
          );
        }
      }
      if (!created) {
        let replacementOptions: {
          replacement?: WorkerChoice;
          routing?: AttemptRouting;
          warnings?: RoutingWarning[];
          baselineRevision?: string;
        } = {};
        if (overrideWorker) {
          replacementOptions = {
            replacement: workerChoice(overrideWorker),
            ...(entry?.routing ? { routing: entry.routing } : {}),
            ...(entry?.warnings?.length ? { warnings: entry.warnings } : {}),
            ...(previous?.launch?.catalogRevision !== undefined
              ? { baselineRevision: previous.launch.catalogRevision }
              : {}),
          };
        } else if (previous?.launch) {
          replacementOptions = {
            replacement: launchChoice(previous.launch),
            // Carry the previous launch's routing, override and warnings, not
            // the task's older define-time routing, so a takeover is validated
            // and recorded with the evidence that actually chose it.
            ...(previous.launch.routing
              ? { routing: previous.launch.routing }
              : {}),
            ...(previous.launch.warnings?.length
              ? { warnings: previous.launch.warnings }
              : {}),
            ...(previous.launch.catalogRevision !== undefined
              ? { baselineRevision: previous.launch.catalogRevision }
              : {}),
          };
        }
        created = await reserve(symphony.id, task, {
          loop,
          prior,
          ...replacementOptions,
          ...(additions ? { additions } : {}),
          ...prompt,
        });
      }
      if (created) {
        await launchAttempt(symphony.id, task);
      }
      symphony = (await store.read(symphony.id)).symphony;
    }
  };

  const dispatch = async (
    agentId: string,
    symphonyId: string,
    retryTaskId?: string,
    replacement?: WorkerChoice,
    note?: string,
    addWrites?: string[],
    routingCommand?: CommandRouting,
  ) => {
    let symphony = await owner(agentId, symphonyId);
    if (
      symphony.execution.conducting?.phase !== "working" ||
      symphony.execution.finishedAt !== null
    ) {
      throw new SymphonyError("This symphony is not ready to dispatch.");
    }
    let replacementRouting: AttemptRouting | undefined;
    let replacementWarnings: RoutingWarning[] | undefined;
    let replacementRevision: string | undefined;
    // Every attempt that already existed before this command, so the
    // acknowledgement can report only the warnings this call produced.
    const attemptIdsBefore = new Set(
      symphony.execution.attempts.map((entry) => entry.id),
    );
    if (retryTaskId) {
      const attempt = latestAttempt(symphony, retryTaskId);
      if (
        !attempt?.launch?.settled ||
        (attempt.state !== "failed" && attempt.state !== "blocked")
      ) {
        throw new SymphonyError(
          "Retry requires a settled failed or blocked task agent; a needs-changes task is resolved with `loop`, not a retry.",
        );
      }
      // Failed retries are separate from loops: at most 2 retries (3 attempts)
      // per task per loop, counted only from failed attempts in that loop.
      if (
        attempt.state === "failed" &&
        failedRetriesInLoop(symphony, retryTaskId) >
          SYMPHONY_LIMITS.failedRetriesPerLoop
      ) {
        throw new SymphonyError(
          `Retry refused: task "${retryTaskId}" already used its ${SYMPHONY_LIMITS.failedRetriesPerLoop} failed retries in loop ${currentLoop(symphony)}. Ask the user how to proceed.`,
        );
      }
      const status = await workers().inspect(attempt.agentId);
      if (status.active) {
        throw new SymphonyError("The task agent is still active.");
      }
      const currentTask = symphony.revisions
        .at(-1)
        ?.score.tasks.find((entry) => entry.id === retryTaskId);
      if (!currentTask) {
        throw new SymphonyError("Unknown task.");
      }
      // An uncertain launch may still appear, so rebinding it to a replacement
      // agent could create a duplicate. Refuse a changed worker choice before
      // any mutation and ask the Conductor to reconcile the saved identity
      // first. Dispatch without a replacement keeps reconciling as before.
      const requested = workerChoice(replacement ?? {});
      if (
        attempt.launch.state === "uncertain" &&
        Object.keys(requested).length > 0 &&
        !sameWorkerChoice(currentTask, attempt, replacement)
      ) {
        throw new SymphonyError(
          "This task's launch is unconfirmed; dispatch without a replacement worker choice to reconcile it first.",
        );
      }
      if (Object.keys(requested).length > 0) {
        const catalog = await routing.load();
        if (catalog.state === "invalid") {
          throw new SymphonyError(
            `Conductor profiles are invalid: ${catalog.error ?? "unknown error."} Fix them in Podium › Profiles.`,
          );
        }
        const { parentModeId, availableProviders } =
          await routingContext(agentId);
        const resolved = resolveCommandTaskRouting({
          catalog,
          task: {
            id: currentTask.id,
            ...requested,
            ...(routingCommand ? { routing: routingCommand } : {}),
            ...(currentTask.routing?.role
              ? { role: currentTask.routing.role }
              : {}),
            ...(currentTask.review !== undefined
              ? { review: currentTask.review }
              : {}),
            writes: currentTask.writes,
          },
          parentModeId,
          availableProviders,
        });
        if (resolved.errors.length) {
          throw new SymphonyError(resolved.errors.slice(0, 5).join(" "));
        }
        replacementRouting = {
          reason: resolved.routing.reason,
          selectedBy: resolved.routing.selectedBy,
          ...(resolved.routing.override
            ? { override: resolved.routing.override }
            : {}),
        };
        // Keep an explicitly validated empty list: a warning-free replacement
        // must not fall back to the previous attempt's obsolete warnings.
        replacementWarnings = resolved.warnings;
        replacementRevision = catalog.catalogRevision;
      }
      // Decide before any mutation, including addWrites, whether the retry can
      // start now. Otherwise dispatch would report success while the retry
      // silently never started and any added writes stayed saved.
      const blocker = await reservationBlocker(symphony, currentTask);
      if (blocker) {
        throw new SymphonyError(
          `Retry cannot start now: ${blocker} Dispatch again after it settles.`,
        );
      }
      // Validate the additions here, but record them on the attempt the retry
      // creates or resumes rather than as a new plan revision.
      const additions = addWrites?.length
        ? await taskWriteAdditions(
            symphony,
            retryTaskId,
            addWrites,
            note ?? "Conductor added write scope",
          )
        : undefined;
      symphony = (await store.read(symphonyId)).symphony;
      const task = symphony.revisions
        .at(-1)
        ?.score.tasks.find((entry) => entry.id === retryTaskId);
      if (!task) {
        throw new SymphonyError("Unknown task.");
      }
      // Revalidate the actual attempt's worker choice before any mutation when
      // the catalog changed; a replacement choice was already validated above.
      if (Object.keys(requested).length === 0) {
        const stale = await staleRoutingError(agentId, task, attempt);
        if (stale) {
          throw new SymphonyError(stale);
        }
      }
      const prior: { report: TaskReport | null; note?: string } = {
        report: attempt.report,
        ...(note ? { note } : {}),
      };
      // A replacement agent has none of the current loop's context, so it gets
      // the reopen findings and a review's previous findings again.
      const retryContext = retryLoopContext(symphony, task);
      if (attempt.state === "blocked" && attempt.launch.state === "started") {
        // A blocked attempt resumes on its agent only when the Conductor kept
        // the worker choice and that agent can still receive a message.
        const reuse =
          sameWorkerChoice(task, attempt, replacement) && status.deliverable;
        const position: AttemptPosition = {
          taskId: task.id,
          number: attemptNumber(symphony, attempt),
          total: taskAttempts(symphony, attempt.taskId).length,
        };
        const writes = attemptWrites(symphony, task, additions);
        if (reuse) {
          const wake = {
            key: `resume:${attempt.id}:${symphony.version}`,
            prompt: continuationPrompt({
              taskId: task.id,
              attemptId: attempt.id,
              position,
              ...(note ? { note } : {}),
              writes,
              added: additions?.map((grant) => grant.path) ?? [],
            }),
          };
          await change(symphonyId, (current) => {
            const a = latestAttempt(current, retryTaskId);
            if (a?.launch) {
              a.state = "running";
              a.message = null;
              a.launch.settled = false;
              a.launch.generation += 1;
              a.wake = wake;
              if (additions?.length) {
                a.addedWrites = mergeAddedWrites(a.addedWrites, additions);
              }
            }
          });
          await deliverPendingWake(symphonyId, attempt.id);
        } else {
          // A changed worker choice, or an agent that can no longer receive a
          // wake: bind the same attempt to a fresh agent with the full
          // assignment and a handoff. The previous block message is captured
          // before the rebind overwrites it.
          const newAgentId = commandSymphonyId(symphonyId, randomUUID());
          const choice = replacement
            ? { profile: "inherit", ...workerChoice(replacement) }
            : launchChoice(attempt.launch);
          const catalog = await routing.load();
          const profile = chosenProfile(catalog.profiles, choice);
          const { context } = await store.read(symphonyId);
          const handoff = handoffInstructions({
            attempt: position,
            previousWorker: workerLabel(attempt.launch),
            report: attempt.report,
            ...handoffPaths(symphony, task.id),
            ...(attempt.blockedBy ? { blockedBy: attempt.blockedBy } : {}),
            ...(attempt.message ? { blockMessage: attempt.message } : {}),
            ...(note ? { note } : {}),
            ...(profile?.instructions
              ? { instructions: profile.instructions }
              : {}),
          });
          const prompt = agentPrompt(
            taskAssignmentPrompt({
              symphony,
              task,
              attemptId: attempt.id,
              plan: context.plan,
              writes,
              ...retryContext,
              ...(profile?.instructions
                ? { instructions: profile.instructions }
                : {}),
              budget: assignmentBudget(handoff),
            }),
            handoff,
          );
          if (prompt.length > SYMPHONY_LIMITS.promptChars) {
            throw new SymphonyError(oversizedPrompt(task.id));
          }
          // With no replacement choice, carry the attempt's own routing,
          // override, warnings and revision so the takeover is validated and
          // recorded with the evidence that chose it.
          const carriedRouting = replacementRouting ?? attempt.launch.routing;
          const carriedWarnings =
            replacementWarnings ?? attempt.launch.warnings;
          const carriedRevision =
            replacementRevision ?? attempt.launch.catalogRevision;
          await change(symphonyId, (current) => {
            const a = latestAttempt(current, retryTaskId);
            if (!a?.launch) {
              return;
            }
            a.agentId = newAgentId;
            a.state = "running";
            a.message = "Replacing the task agent on this attempt…";
            a.wake = undefined;
            // The rebind replaces the launch's worker choice as a whole, so a
            // provider-only switch does not keep the old model or thinking
            // option.
            a.launch = {
              state: "pending",
              prompt,
              settled: false,
              generation: 0,
              profile: choice.profile ?? "inherit",
              ...(profile ? profileSnapshot(profile) : {}),
              ...(choice.provider !== undefined
                ? { provider: choice.provider }
                : {}),
              ...(choice.model !== undefined ? { model: choice.model } : {}),
              ...(choice.thinkingOptionId !== undefined
                ? { thinkingOptionId: choice.thinkingOptionId }
                : {}),
              ...(carriedRouting ? { routing: carriedRouting } : {}),
              ...(carriedWarnings?.length ? { warnings: carriedWarnings } : {}),
              ...(carriedRevision ? { catalogRevision: carriedRevision } : {}),
            };
            if (additions?.length) {
              a.addedWrites = mergeAddedWrites(a.addedWrites, additions);
            }
            // An attempt stored before baselines existed already ran without
            // one. The relaunch must not capture a baseline that includes the
            // earlier agent's edits, so its changed paths stay unknown.
            if (!a.writeFingerprint && !a.writeFingerprintUnknown) {
              a.writeFingerprintUnknown = true;
            }
          });
        }
      } else if (
        attempt.state === "failed" &&
        attempt.launch.state === "uncertain" &&
        (!status.exists || status.deliverable)
      ) {
        // The launch was never confirmed. A new identity could duplicate a
        // launch that lands late, and an agent that did appear already holds
        // this attempt's assignment, so the retry replays the same keyed
        // identity on this attempt. Only an archived or closed agent is
        // replaced. The replay counts toward the retry limit like a new
        // failed attempt.
        await change(symphonyId, (current) => {
          const a = latestAttempt(current, retryTaskId);
          if (
            !a?.launch ||
            a.id !== attempt.id ||
            a.state !== "failed" ||
            a.reportedBy !== "server"
          ) {
            return;
          }
          reopenServerFailure(
            a,
            "Replaying the unconfirmed task agent launch with the same identity…",
          );
          a.identityRetries = (a.identityRetries ?? 0) + 1;
          if (additions?.length) {
            a.addedWrites = mergeAddedWrites(a.addedWrites, additions);
          }
        });
      } else if (attempt.state === "failed") {
        if (launchUncertain(attempt) && status.exists) {
          // The unconfirmed agent did appear and is now archived or closed, so
          // the launch is resolved and no longer fences the replacement.
          await change(symphonyId, (current) => {
            const a = latestAttempt(current, retryTaskId);
            if (a?.launch && a.id === attempt.id && launchUncertain(a)) {
              a.launch.state = "started";
            }
          });
        }
        if (
          sameWorkerChoice(task, attempt, replacement) &&
          status.deliverable
        ) {
          await continueFailedAttempt(
            symphonyId,
            task,
            attempt,
            attempt.launch,
            prior,
            additions,
            retryContext,
          );
        } else {
          const carryRouting = replacementRouting ?? attempt.launch.routing;
          const carryWarnings = replacementWarnings ?? attempt.launch.warnings;
          const carryRevision =
            replacementRevision ?? attempt.launch.catalogRevision;
          await reserve(symphonyId, task, {
            retry: true,
            // Carry the attempt's actual choice and routing when the caller did
            // not name a replacement, never the task's older routing.
            replacement: replacement ?? launchChoice(attempt.launch),
            ...(carryRouting ? { routing: carryRouting } : {}),
            ...(carryWarnings ? { warnings: carryWarnings } : {}),
            ...(carryRevision !== undefined
              ? { baselineRevision: carryRevision }
              : {}),
            prior,
            ...(additions ? { additions } : {}),
            ...retryContext,
          });
        }
      }
    }
    symphony = (await store.read(symphonyId)).symphony;
    await startLoopTasks(symphony.id);
    symphony = (await store.read(symphonyId)).symphony;
    const tasks = symphony.revisions.at(-1)?.score.tasks ?? [];
    for (const task of tasks) {
      await reserve(symphonyId, task);
      await launchAttempt(symphonyId, task);
    }
    symphony = (await store.read(symphonyId)).symphony;
    const routingWarnings = new Map<
      string,
      { taskId: string; code: RoutingWarning["code"]; message: string }
    >();
    const addWarning = (taskId: string, warning: RoutingWarning): void => {
      routingWarnings.set(`${taskId}|${warning.code}|${warning.message}`, {
        taskId,
        code: warning.code,
        message: warning.message,
      });
    };
    for (const warning of replacementWarnings ?? []) {
      addWarning(retryTaskId ?? "", warning);
    }
    for (const attempt of symphony.execution.attempts) {
      if (attemptIdsBefore.has(attempt.id)) {
        continue;
      }
      for (const warning of attempt.launch?.warnings ?? []) {
        addWarning(attempt.taskId, warning);
      }
    }
    return {
      symphony,
      ...(routingWarnings.size
        ? { routingWarnings: [...routingWarnings.values()] }
        : {}),
    };
  };
  /**
   * Starts loop N+1 after loop N ended needing changes. Reopens the owning
   * tasks with their findings, optionally appends new tasks in a new score
   * revision, and defers the rest with a reason. Dependents of a reopened task
   * are re-run automatically by `startLoopTasks` once their prerequisites
   * settle.
   */
  const loop = async (
    agentId: string,
    command: Extract<SymphonyCommand, { kind: "loop" }>,
  ) => {
    let symphony = await owner(agentId, command.symphonyId);
    // Every attempt that already existed before this loop, so the
    // acknowledgement can report only the warnings this call produced.
    const attemptIdsBefore = new Set(
      symphony.execution.attempts.map((entry) => entry.id),
    );
    const meta = symphony.execution.conducting;
    if (
      !meta ||
      meta.phase !== "working" ||
      symphony.execution.finishedAt !== null
    ) {
      throw new SymphonyError("This symphony is not ready for another loop.");
    }
    const verdict = loopVerdict(symphony);
    if (!verdict.ended || verdict.verdict !== "needs-changes") {
      throw new SymphonyError(
        "A loop starts only after the current loop ends needing changes with no failed, blocked or running tasks.",
      );
    }
    const loop = verdict.loop;
    const next = loop + 1;
    const score = symphony.revisions.at(-1)?.score;
    if (!score) {
      throw new SymphonyError("Symphony score is missing.");
    }
    const existingIds = new Set(score.tasks.map((entry) => entry.id));
    const findingMap = openFindingMap(symphony);

    // Every named task and finding must exist before anything is mutated.
    const reopenIds = new Set<string>();
    const resolved = new Map<string, TaskFinding[]>();
    const referencedKeys = new Set<string>();
    for (const entry of command.reopen) {
      if (!existingIds.has(entry.taskId)) {
        throw new SymphonyError(`Unknown task "${entry.taskId}".`);
      }
      if (reopenIds.has(entry.taskId)) {
        throw new SymphonyError(
          `Task "${entry.taskId}" is reopened more than once.`,
        );
      }
      reopenIds.add(entry.taskId);
      const findings: TaskFinding[] = [];
      const keys = new Set<string>();
      for (const reference of entry.findings ?? []) {
        const match = findingKey(findingMap, reference);
        if ("error" in match) {
          throw new SymphonyError(
            `${match.error} (reopening task "${entry.taskId}")`,
          );
        }
        const found = findingMap.get(match.key);
        if (found && !keys.has(match.key)) {
          keys.add(match.key);
          referencedKeys.add(match.key);
          // A self-reported finding names its owner, so the prompt shows it.
          findings.push({
            ...found.finding,
            taskId: found.finding.taskId ?? found.reporterTaskId,
          });
        }
      }
      resolved.set(entry.taskId, findings);
    }
    const deferred = command.deferred ?? [];
    const deferredKeys = new Set<string>();
    for (const item of deferred) {
      if (item.finding !== undefined) {
        const match = findingKey(findingMap, item.finding);
        if ("error" in match) {
          throw new SymphonyError(`${match.error} (deferred)`);
        }
        deferredKeys.add(match.key);
      }
      if (item.taskId !== undefined && !existingIds.has(item.taskId)) {
        throw new SymphonyError(`Unknown deferred task "${item.taskId}".`);
      }
    }
    // Nothing open may be dropped silently: every open blocking finding,
    // including one deferred in an earlier loop, and every needs-changes task
    // is reopened or deferred again with a reason.
    const uncovered: string[] = [];
    for (const { reporterTaskId, finding } of verdict.findings) {
      const owner = finding.taskId ?? reporterTaskId;
      const key = `${reporterTaskId}#${finding.id}`;
      if (
        !reopenIds.has(owner) &&
        !referencedKeys.has(key) &&
        !deferredKeys.has(key)
      ) {
        uncovered.push(`finding ${key}`);
      }
    }
    const reopenedDependents = new Set(
      transitiveDependents(score, [...reopenIds]),
    );
    for (const task of score.tasks) {
      if (latestAttempt(symphony, task.id)?.state !== "needs-changes") {
        continue;
      }
      // A review is the messenger: its blocking findings are covered by
      // reopening their owners, and it re-runs as their dependent. A review
      // with no reopened ancestor still needs an explicit reopen or defer.
      if (
        reopenIds.has(task.id) ||
        deferred.some((item) => item.taskId === task.id) ||
        (isReviewTask(task) && reopenedDependents.has(task.id))
      ) {
        continue;
      }
      uncovered.push(`task ${task.id}`);
    }
    if (uncovered.length) {
      throw new SymphonyError(
        `Loop must reopen or defer every open item: ${uncovered.join(", ")}.`,
      );
    }

    const catalog = await routing.load();
    if (catalog.state === "invalid") {
      throw new SymphonyError(
        `Conductor profiles are invalid: ${catalog.error ?? "unknown error."} Fix them in Podium › Profiles.`,
      );
    }
    const { parentModeId, availableProviders } = await routingContext(agentId);
    const newTaskResolution = (command.tasks ?? []).map((commandTask) =>
      resolveCommandTaskRouting({
        catalog,
        task: commandTask,
        parentModeId,
        availableProviders,
      }),
    );
    const routingErrors = newTaskResolution.flatMap((entry) => entry.errors);
    const reopenResolution = new Map<string, ResolvedTaskRouting>();
    for (const entry of command.reopen) {
      const hasWorker = Boolean(
        entry.profile ||
          entry.provider ||
          entry.model ||
          entry.thinkingOptionId,
      );
      if (!hasWorker) {
        continue;
      }
      const currentTask = score.tasks.find((task) => task.id === entry.taskId);
      if (!currentTask) {
        continue;
      }
      const resolvedEntry = resolveCommandTaskRouting({
        catalog,
        task: {
          id: entry.taskId,
          ...(entry.profile !== undefined ? { profile: entry.profile } : {}),
          ...(entry.provider !== undefined ? { provider: entry.provider } : {}),
          ...(entry.model !== undefined ? { model: entry.model } : {}),
          ...(entry.thinkingOptionId !== undefined
            ? { thinkingOptionId: entry.thinkingOptionId }
            : {}),
          ...(entry.routing ? { routing: entry.routing } : {}),
          ...(currentTask.routing?.role
            ? { role: currentTask.routing.role }
            : {}),
          ...(currentTask.review !== undefined
            ? { review: currentTask.review }
            : {}),
          writes: currentTask.writes,
        },
        parentModeId,
        availableProviders,
      });
      reopenResolution.set(entry.taskId, resolvedEntry);
      routingErrors.push(...resolvedEntry.errors);
    }
    if (routingErrors.length) {
      throw new SymphonyError(routingErrors.slice(0, 5).join(" "));
    }
    const newTasks = (command.tasks ?? []).map((commandTask, index) =>
      commandTaskDefinition(commandTask, newTaskResolution[index]),
    );
    const newIds = new Set(newTasks.map((entry) => entry.id));
    if (newIds.size !== newTasks.length) {
      throw new SymphonyError("New task IDs must be unique.");
    }
    for (const id of newIds) {
      if (existingIds.has(id)) {
        throw new SymphonyError(`Task "${id}" already exists.`);
      }
    }
    if (score.tasks.length + newTasks.length > SYMPHONY_LIMITS.tasks) {
      throw new SymphonyError("Symphony task limit reached.");
    }
    const nextScore = { tasks: [...score.tasks, ...newTasks] };
    if (newTasks.length) {
      const issues = scoreIssues(nextScore);
      if (issues.length) {
        throw new SymphonyError(issues.slice(0, 5).join(" "));
      }
    }
    const allIds = new Set([...existingIds, ...newIds]);
    for (const entry of command.reopen) {
      for (const after of entry.after ?? []) {
        if (!allIds.has(after)) {
          throw new SymphonyError(
            `Unknown loop prerequisite "${after}" for task "${entry.taskId}".`,
          );
        }
      }
    }
    // The loop graph adds every `after` edge to the declared prerequisites; a
    // cycle there would leave its tasks waiting on each other forever.
    if (
      prerequisiteCycle(
        nextScore.tasks.map((task) => ({
          id: task.id,
          prerequisites: [
            ...task.prerequisites,
            ...(command.reopen.find((entry) => entry.taskId === task.id)
              ?.after ?? []),
          ],
        })),
      )
    ) {
      throw new SymphonyError(
        "Loop prerequisites (dependsOn plus after) must not contain a cycle.",
      );
    }

    // Past the budget, only a recorded user approval starts the loop.
    const maxLoops = meta.maxLoops ?? SYMPHONY_LIMITS.defaultLoops;
    const approval = command.approval;
    if (next > maxLoops && (!approval || approval.loops < next)) {
      throw new SymphonyError(
        `Loop ${next} exceeds the loop budget (${maxLoops}). Ask the user, then resend with approval {loops, userAnswer}.`,
      );
    }

    // Every scheduled task and new task needs room for one more attempt.
    const scheduledCount =
      reopenIds.size + reopenedDependents.size + newTasks.length;
    if (
      symphony.execution.attempts.length + scheduledCount >
      SYMPHONY_LIMITS.attempts
    ) {
      throw new SymphonyError(
        "Symphony attempt limit reached; this loop cannot start every task it schedules.",
      );
    }

    // Validate every scope addition, and the resulting placement, before the
    // loop is saved, so a refused command leaves the symphony unchanged.
    const additions = new Map<string, GrantedWrite[]>();
    for (const entry of command.reopen) {
      if (!entry.addWrites?.length) {
        continue;
      }
      const grants = await taskWriteAdditions(
        symphony,
        entry.taskId,
        entry.addWrites,
        entry.note ?? command.reason,
      );
      if (grants?.length) {
        additions.set(entry.taskId, grants);
      }
    }
    await runtime().validate(symphony.source, {
      tasks: nextScore.tasks.map((task) => {
        const effective = effectiveTask(symphony, task);
        const grants = additions.get(task.id);
        if (!grants) {
          return effective;
        }
        return {
          ...effective,
          writes: [
            ...new Set([
              ...effective.writes,
              ...grants.map((grant) => grant.path),
            ]),
          ],
          worker: { ...effective.worker, role: "implementation" as const },
        };
      }),
    });

    // Every open blocking finding, captured now per reporter for the
    // re-running reviews. Each reporter's findings come from one report, so
    // each snapshot stays within the per-report bound.
    const previousReports: PreviousReport[] = [];
    for (const { reporterTaskId, finding } of verdict.findings) {
      const owned = { ...finding, taskId: finding.taskId ?? reporterTaskId };
      const entry = previousReports.find(
        (value) => value.reporterTaskId === reporterTaskId,
      );
      if (entry) {
        entry.findings.push(owned);
      } else {
        previousReports.push({ reporterTaskId, findings: [owned] });
      }
    }
    const startedAt = Date.now();
    await change(symphony.id, (current) => {
      const conducting = current.execution.conducting;
      // Another loop command won the race; refuse instead of applying twice.
      if (!conducting || currentLoop(current) !== loop) {
        throw new SymphonyError("This symphony already started another loop.");
      }
      if (newTasks.length) {
        current.revisions.push({
          number: current.revisions.length + 1,
          parent: current.revisions.length,
          reason: `Loop ${next}: ${command.reason}`,
          acceptedAt: Date.now(),
          score: { tasks: [...score.tasks, ...newTasks] },
        });
      }
      conducting.loops = [
        ...(conducting.loops ?? []),
        {
          number: next,
          reason: command.reason,
          startedAt,
          reopened: command.reopen.map((entry) => {
            const grants = additions.get(entry.taskId);
            const replacement = reopenResolution.get(entry.taskId);
            return {
              taskId: entry.taskId,
              findings: entry.findings ?? [],
              ...(entry.after ? { after: entry.after } : {}),
              ...(entry.note ? { note: entry.note } : {}),
              ...(grants ? { addedWrites: grants } : {}),
              resolved: resolved.get(entry.taskId) ?? [],
              ...(replacement
                ? {
                    worker: {
                      ...replacement.choice,
                      ...(replacement.profile
                        ? { profileName: replacement.profile.name }
                        : {}),
                    },
                    routing: {
                      reason: replacement.routing.reason,
                      selectedBy: replacement.routing.selectedBy,
                      ...(replacement.routing.override
                        ? { override: replacement.routing.override }
                        : {}),
                    },
                    ...(replacement.warnings.length
                      ? { warnings: replacement.warnings }
                      : {}),
                  }
                : {}),
            };
          }),
          added: newTasks.map((task) => task.id),
          deferred,
          ...(approval ? { approval } : {}),
          ...(previousReports.length ? { previousReports } : {}),
        },
      ];
      current.execution.interruption = null;
    });

    // Reopens, their dependents and new tasks start as soon as they can; the
    // rest start on a later dispatch or reconcile.
    await startLoopTasks(symphony.id);
    symphony = (await store.read(symphony.id)).symphony;
    for (const task of symphony.revisions.at(-1)?.score.tasks ?? []) {
      await reserve(symphony.id, task);
      await launchAttempt(symphony.id, task);
    }
    symphony = (await store.read(symphony.id)).symphony;
    const routingWarnings = new Map<
      string,
      { taskId: string; code: RoutingWarning["code"]; message: string }
    >();
    const addWarning = (taskId: string, warning: RoutingWarning): void => {
      routingWarnings.set(`${taskId}|${warning.code}|${warning.message}`, {
        taskId,
        code: warning.code,
        message: warning.message,
      });
    };
    for (const [index, entry] of newTaskResolution.entries()) {
      for (const warning of entry.warnings) {
        addWarning(command.tasks?.[index]?.id ?? "", warning);
      }
    }
    for (const [taskId, entry] of reopenResolution) {
      for (const warning of entry.warnings) {
        addWarning(taskId, warning);
      }
    }
    for (const attempt of symphony.execution.attempts) {
      if (attemptIdsBefore.has(attempt.id)) {
        continue;
      }
      for (const warning of attempt.launch?.warnings ?? []) {
        addWarning(attempt.taskId, warning);
      }
    }
    return {
      symphony,
      catalogRevision: catalog.catalogRevision,
      ...(routingWarnings.size
        ? { routingWarnings: [...routingWarnings.values()] }
        : {}),
    };
  };

  /**
   * Settles an attempt the harness could not run as `failed` with a server
   * report and a `harness` diagnosis, so the Conductor retries it within the
   * loop under the failed-retry limit. `blocked` stays reserved for a task
   * agent that asked to pause.
   */
  const settleHarnessFailure = (
    current: StoredSymphony,
    a: Attempt,
    message: string,
    tried: string,
    fields: Partial<ChangedPaths>,
  ) => {
    const task = current.revisions
      .at(-1)
      ?.score.tasks.find((entry) => entry.id === a.taskId);
    if (a.launch) {
      a.launch.settled = true;
    }
    a.state = "failed";
    a.reportedBy = "server";
    a.report = {
      outcome: "failed",
      summary: message,
      evidence: [message],
      checks: (task?.checks ?? []).map((name) => ({
        name,
        status: "not-run",
        detail: "The task agent did not report this check.",
      })),
      diagnosis: { tried: [tried], suspectedCause: message, need: "harness" },
    };
    a.reportHash = contentHash(JSON.stringify(a.report));
    a.endedAt = Date.now();
    a.message = null;
    a.wake = undefined;
    Object.assign(a, fields);
  };

  /**
   * Returns a server-settled failed attempt to running with an unsettled
   * launch, so reconciliation observes it again. The server report goes away;
   * the write baseline stays, so changed paths remain cumulative.
   */
  const reopenServerFailure = (a: Attempt, message: string | null) => {
    a.state = "running";
    a.report = null;
    a.reportHash = null;
    a.endedAt = null;
    delete a.reportedBy;
    delete a.changedPaths;
    delete a.changedPathsTruncated;
    a.message = message;
    if (a.launch) {
      a.launch.settled = false;
      delete a.launch.checks;
      delete a.launch.nextCheckAt;
    }
  };

  /**
   * The agent of a launch settled as unconfirmed appeared after all: it holds
   * this attempt's assignment, so the attempt runs again on it and settles
   * through the usual nudge and no-report path.
   */
  const adoptLateLaunch = (a: Attempt) => {
    reopenServerFailure(a, null);
    if (a.launch) {
      a.launch.state = "started";
      a.launch.generation += 1;
    }
  };

  const reconcile = async () => {
    const list = await store.list();
    for (const summary of list.symphonies) {
      try {
        let { symphony } = await store.read(summary.id);
        const meta = symphony.execution.conducting;
        if (
          !meta ||
          symphony.execution.finishedAt !== null ||
          !symphony.source.agentId
        ) {
          continue;
        }
        if (meta.phase === "planning") {
          if (
            meta.conductorLaunch === "started" &&
            !symphony.execution.interruption
          ) {
            const status = await workers().inspect(symphony.source.agentId);
            if (!status.active) {
              await change(symphony.id, (current) => {
                current.execution.interruption =
                  "Conductor agent stopped before defining tasks. Open the Conductor agent to continue.";
              });
            }
          }
          continue;
        }
        for (const attempt of symphony.execution.attempts) {
          if (!attempt.launch) {
            continue;
          }
          if (attempt.launch.settled) {
            // A failed attempt whose launch is still unconfirmed keeps its
            // fence, and its saved identity is observed until the agent
            // appears. Then the attempt runs again under normal settlement.
            if (
              launchUncertain(attempt) &&
              latestAttempt(symphony, attempt.taskId)?.id === attempt.id
            ) {
              const status = await workers().inspect(attempt.agentId);
              if (status.exists) {
                symphony = await change(symphony.id, (current) => {
                  const a = current.execution.attempts.find(
                    (value) => value.id === attempt.id,
                  );
                  if (a?.launch?.settled && launchUncertain(a)) {
                    adoptLateLaunch(a);
                  }
                });
              }
            }
            continue;
          }
          if (attempt.launch.state === "uncertain") {
            // The creation response was lost. Re-check the saved SDK identity on
            // a bounded schedule persisted on the launch. Reconcile never
            // sleeps: it performs one lookup per due tick, so a slow launch
            // cannot block the shared command queue. It never resends the
            // initial prompt or creates a replacement agent here.
            const now = Date.now();
            if (
              attempt.launch.nextCheckAt !== undefined &&
              now < attempt.launch.nextCheckAt
            ) {
              continue;
            }
            const completed = (attempt.launch.checks ?? 0) + 1;
            const status = await workers().inspect(attempt.agentId);
            const fields = await changedPathFields(symphony, attempt);
            symphony = await change(symphony.id, (current) => {
              const a = current.execution.attempts.find(
                (value) => value.id === attempt.id,
              );
              if (
                !a?.launch ||
                a.launch.settled ||
                a.launch.state !== "uncertain"
              ) {
                return;
              }
              if (status.exists) {
                a.launch.state = "started";
                a.state = "running";
                a.message = null;
              } else {
                const delay = nextLaunchCheckDelay(
                  completed,
                  workers().launchCheckDelaysMs,
                );
                if (delay !== null) {
                  a.launch.checks = completed;
                  a.launch.nextCheckAt = Date.now() + delay;
                  return;
                }
                settleHarnessFailure(
                  current,
                  a,
                  "Task agent launch could not be confirmed after repeated identity checks. Retry with dispatch to replay the same agent identity; no replacement has been created.",
                  "Re-checked the saved task agent identity on the bounded schedule.",
                  fields,
                );
              }
            });
            continue;
          }
          if (attempt.launch.state !== "started") {
            continue;
          }
          const status = await workers().inspect(attempt.agentId);
          if (status.active) {
            continue;
          }
          if (attempt.state === "blocked") {
            // The task agent blocked this attempt before its turn ended. Settle
            // the launch without nudging and keep the task agent's message as
            // the record; a server settlement would overwrite it otherwise.
            const fields = await changedPathFields(symphony, attempt);
            symphony = await change(symphony.id, (current) => {
              const a = current.execution.attempts.find(
                (value) => value.id === attempt.id,
              );
              if (!a?.launch || a.launch.settled) {
                return;
              }
              a.launch.settled = true;
              a.blockedBy = "worker";
              a.wake = undefined;
              Object.assign(a, fields);
            });
            continue;
          }
          const pending = attempt.wake;
          if (!attempt.report && pending) {
            // A saved continuation or nudge whose delivery is unconfirmed.
            if (!status.exists || !status.deliverable) {
              const fields = await changedPathFields(symphony, attempt);
              symphony = await change(symphony.id, (current) => {
                const a = current.execution.attempts.find(
                  (value) => value.id === attempt.id,
                );
                if (!a?.launch || a.launch.settled) {
                  return;
                }
                a.launch.settled = true;
                if (!a.report) {
                  settleHarnessFailure(
                    current,
                    a,
                    "Task agent became unavailable before its saved wake could be delivered. Retry with dispatch to replace it.",
                    "Tried to deliver the saved wake to the task agent.",
                    fields,
                  );
                }
              });
              continue;
            }
            await deliverPendingWake(symphony.id, attempt.id);
            continue;
          }
          if (!status.exists) {
            // A missing task agent cannot be nudged; settle the attempt as
            // blocked.
            const fields = await changedPathFields(symphony, attempt);
            symphony = await change(symphony.id, (current) => {
              const a = current.execution.attempts.find(
                (value) => value.id === attempt.id,
              );
              if (!a?.launch || a.launch.settled) {
                return;
              }
              a.launch.settled = true;
              if (!a.report) {
                settleHarnessFailure(
                  current,
                  a,
                  "Task agent stopped or was removed without a report. Retry with dispatch to replace it.",
                  "Looked up the task agent after it stopped.",
                  fields,
                );
              }
            });
            continue;
          }
          if (!attempt.report && !attempt.nudgedAt) {
            if (!status.deliverable) {
              const fields = await changedPathFields(symphony, attempt);
              symphony = await change(symphony.id, (current) => {
                const a = current.execution.attempts.find(
                  (value) => value.id === attempt.id,
                );
                if (!a?.launch || a.launch.settled) {
                  return;
                }
                settleHarnessFailure(
                  current,
                  a,
                  "Task agent stopped but can no longer receive a nudge. Retry with dispatch to replace it.",
                  "Tried to nudge the stopped task agent for a report.",
                  fields,
                );
              });
              continue;
            }
            // First stop with no report: persist and send one nudge. The wake is
            // cleared and `nudgedAt` set only after the keyed send succeeds, so a
            // failed send or reload replays the same message exactly once.
            const generation = attempt.launch.generation;
            const wake = {
              key: `nudge:${attempt.id}:${generation}`,
              prompt: nudgePrompt(attempt.id),
            };
            symphony = await change(symphony.id, (current) => {
              const a = current.execution.attempts.find(
                (value) => value.id === attempt.id,
              );
              if (
                !a?.launch ||
                a.launch.settled ||
                a.report ||
                a.nudgedAt ||
                a.wake
              ) {
                return;
              }
              a.wake = wake;
              a.message =
                "Task agent stopped without a report; asked once to report or block this attempt.";
            });
            await deliverPendingWake(symphony.id, attempt.id);
            continue;
          }
          const fields = await changedPathFields(symphony, attempt);
          symphony = await change(symphony.id, (current) => {
            const a = current.execution.attempts.find(
              (value) => value.id === attempt.id,
            );
            if (!a?.launch) {
              return;
            }
            a.launch.settled = true;
            if (!a.report) {
              settleHarnessFailure(
                current,
                a,
                "Task agent stopped without a report after a nudge. Retry with dispatch to continue the assignment.",
                "Nudged the task agent once to report or block.",
                fields,
              );
            }
          });
        }
        await startLoopTasks(symphony.id);
        symphony = (await store.read(symphony.id)).symphony;
        const tasks = symphony.revisions.at(-1)?.score.tasks ?? [];
        for (const task of tasks) {
          const reserved = await reserve(symphony.id, task);
          const latest = latestAttempt(
            (await store.read(symphony.id)).symphony,
            task.id,
          );
          if (reserved || latest?.launch?.state === "pending") {
            await launchAttempt(symphony.id, task);
          }
        }
        symphony = (await store.read(symphony.id)).symphony;
        const verdict = loopVerdict(symphony);
        const blocked = tasks
          .map((task) => latestAttempt(symphony, task.id))
          .filter((a) => a?.state === "blocked" || a?.state === "failed");
        // A loop only ends once every launch has settled; an unsettled launch
        // may still be running even when its attempt already reported.
        const settled = tasks.every((task) => {
          const a = latestAttempt(symphony, task.id);
          return !a?.launch || a.launch.settled;
        });
        let notification: string | null = null;
        let message: string | null = null;
        if (blocked.length) {
          notification = contentHash(
            JSON.stringify(
              blocked.map((a) => [
                a?.id,
                a?.state,
                a?.blockedBy,
                a?.message,
                a?.reportHash,
                a?.launch?.generation,
              ]),
            ),
          );
          message = `Task agents need attention. Act on each summary with dispatch (retryTaskId plus note/addWrites) or ask the user; open a conversation only when the summary is unclear.\n${clamp(
            JSON.stringify(
              blocked.map((attempt) =>
                attempt ? failureSummary(symphony, attempt) : null,
              ),
            ),
            3500,
          )}`;
        } else if (
          symphony.execution.interruption?.includes(OVERSIZED_PROMPT)
        ) {
          // The task never gets an attempt, so the loop can't end on its own;
          // without this wake the Conductor would wait forever.
          notification = `interruption:${contentHash(symphony.execution.interruption)}`;
          message = `A task cannot start. ${symphony.execution.interruption}`;
        } else if (
          settled &&
          verdict.ended &&
          (verdict.verdict === "succeeded" ||
            verdict.verdict === "needs-changes")
        ) {
          notification = `loop-end:${verdict.loop}`;
          message = loopEndMessage(symphony, verdict);
        }
        if (
          notification &&
          message &&
          notification !== symphony.execution.conducting?.notification &&
          symphony.source.agentId
        ) {
          // Stable message identity makes uncertain notification retries harmless.
          await workers().wake(
            symphony.source.agentId,
            `Conductor symphony ${symphony.id}: ${message}`,
            `${symphony.id}:${notification}`,
          );
          await change(symphony.id, (current) => {
            if (current.execution.conducting) {
              current.execution.conducting.notification = notification;
            }
          });
        }
      } catch (error) {
        // One busy/unreachable Conductor agent must not starve independent symphonies.
        // Ownership stays fenced while observation/notification is retried.
        if (
          error instanceof SymphonyError &&
          error.message.includes("unavailable")
        ) {
          await change(summary.id, (current) => {
            current.execution.interruption =
              "The Conductor agent is unavailable. Existing task agents and their reports remain visible.";
          }).catch(() => {});
        }
      }
    }
  };
  return { start, define, dispatch, loop, reconcile };
}
