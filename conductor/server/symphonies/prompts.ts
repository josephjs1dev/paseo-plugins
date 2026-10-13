import {
  latestAttempt,
  SYMPHONY_LIMITS,
  type StoredSymphony,
  type TaskDefinition,
  type TaskFinding,
  type TaskReport,
} from "../../shared/symphonies/models";
import { loopPrerequisites } from "../../shared/symphonies/score";
import type { SymphonyCommandAccess } from "./command-access";

export type CommandLine = (agentId: string, verb: string) => string;
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export function launcherCommand(path: string, verb: string): string {
  return `node ${shellQuote(path)} ${verb}`;
}

export function agentCommand(
  access: SymphonyCommandAccess | undefined,
  agentId: string,
  verb: string,
): string {
  const script = access?.commandPath
    ? shellQuote(access.commandPath)
    : '"${CONDUCTOR_COMMAND:?Missing Conductor command}"';
  const socket = access?.socketPath
    ? shellQuote(access.socketPath)
    : '"${CONDUCTOR_SOCKET:?Missing Conductor socket}"';
  return `node ${script} ${verb} --agent ${shellQuote(agentId)} --socket ${socket}`;
}

export function jsonCommand(command: string, input: unknown): string {
  return `${command} <<'CONDUCTOR_JSON'\n${JSON.stringify(input, null, 2)}\nCONDUCTOR_JSON`;
}

function clamp(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

const paths = (value: readonly string[], empty: string): string =>
  value.length ? value.join(", ") : empty;

/** One prerequisite task's bounded result, rendered as an assignment line. */
export interface PrerequisiteResult {
  taskId: string;
  outcome?: string;
  summary?: string;
  /** Blocking findings and failed checks the prerequisite left open. */
  findings?: readonly TaskFinding[];
  failedChecks?: readonly string[];
}

/** The full findings a reopened task must address. */
export interface ReopenPromptInput {
  reason: string;
  findings: readonly TaskFinding[];
}

/** A dependent re-run after a prerequisite changed in a new loop. */
export interface RecheckPromptInput {
  loop: number;
  /** Reopened prerequisite task ids this task transitively depends on. */
  changed: readonly string[];
}

/**
 * A re-running review's blocking findings from the previous loop, with
 * reporter-qualified ids, and the count of other reporters' findings left out.
 */
export interface PreviousFindingsInput {
  findings: readonly TaskFinding[];
  omitted: number;
}

/**
 * How much of each finding a prompt carries. `full` renders every field;
 * `brief` keeps each finding's identity, owner and first path; `count` only
 * counts them. A prompt falls back to a shorter level when the full one
 * exceeds the saved prompt limit, and then says where the full findings are.
 */
export type FindingDetail = "full" | "brief" | "count";
const FINDING_DETAILS: readonly FindingDetail[] = ["full", "brief", "count"];

/** Renders each finding with its owning task and display paths. */
export function findingLines(
  findings: readonly TaskFinding[],
  detail: FindingDetail = "full",
): string[] {
  if (detail === "count") {
    return findings.length
      ? [
          `- ${findings.length} finding${findings.length === 1 ? "" : "s"}, not listed here to fit the prompt.`,
        ]
      : [];
  }
  return findings.map((finding) => {
    const owner = finding.taskId ? ` task ${finding.taskId}` : "";
    if (detail === "brief") {
      const [first = ""] = finding.paths;
      const more =
        finding.paths.length > 1 ? ` (+${finding.paths.length - 1} more)` : "";
      return `- ${finding.id} [${finding.severity}]${owner} at ${clamp(first, 200)}${more}`;
    }
    const paths = finding.paths.join(", ");
    const line = `- ${finding.id} [${finding.severity}]${owner} at ${paths}: ${clamp(
      finding.summary,
      2000,
    )}`;
    return finding.suggestedFix
      ? `${line}\n  Suggested fix: ${clamp(finding.suggestedFix, 2000)}`
      : line;
  });
}

/** The pointer a shortened prompt gives to the saved, complete findings. */
function shortenedLines(detail: FindingDetail): string[] {
  return detail === "full"
    ? []
    : [
        "",
        "Findings and failed checks are shortened to fit the prompt. Read each full finding and check in the saved reports and loop record with the Conductor `get` tool before you act on it.",
      ];
}

function reopenLines(
  input: ReopenPromptInput,
  detail: FindingDetail,
): string[] {
  return [
    `Reopened: ${clamp(input.reason, 2000)}`,
    "Findings to address:",
    ...findingLines(input.findings, detail),
  ];
}

function recheckLines(input: RecheckPromptInput): string[] {
  const changed = input.changed.join(", ");
  return [
    `Prerequisite ${changed} changed in loop ${input.loop}. Re-check your work against it. Report completed if nothing needs to change.`,
  ];
}

function previousLines(
  input: PreviousFindingsInput,
  detail: FindingDetail,
): string[] {
  const lines: string[] = [];
  if (input.findings.length) {
    lines.push(
      "Previous loop findings to confirm fixed:",
      ...findingLines(input.findings, detail),
      "Confirm each finding is fixed; report completed only when none remain.",
    );
  }
  if (input.omitted) {
    lines.push(
      `${input.omitted} more previous finding${input.omitted === 1 ? "" : "s"} from other reporters ${input.omitted === 1 ? "is" : "are"} not listed; their reporters re-check them.`,
    );
  }
  return lines;
}

/**
 * Renders failed check names at the same detail level as findings: check names
 * may be up to 1000 characters each, so a shortened prompt caps or counts them.
 */
function failedCheckLine(
  names: readonly string[],
  detail: FindingDetail,
): string | null {
  if (!names.length) {
    return null;
  }
  if (detail === "count") {
    return `  ${names.length} failed check${names.length === 1 ? "" : "s"}, not listed here to fit the prompt.`;
  }
  const shown =
    detail === "brief" ? names.map((name) => clamp(name, 200)) : names;
  return `  Failed checks: ${shown.join(", ")}`;
}

/** Renders each prerequisite's latest result with its open findings. */
function prerequisiteLines(
  results: readonly PrerequisiteResult[],
  detail: FindingDetail,
): string[] {
  if (!results.length) {
    return [];
  }
  const lines = ["Prerequisite results:"];
  for (const result of results) {
    const summary = clamp(
      result.summary ?? "",
      detail === "count" ? 200 : 1000,
    );
    lines.push(
      `- ${result.taskId}: ${result.outcome ?? "completed"}. ${summary}`.trimEnd(),
    );
    lines.push(
      ...findingLines(result.findings ?? [], detail).map(
        (line) => `  ${line.trimStart()}`,
      ),
    );
    const checks = failedCheckLine(result.failedChecks ?? [], detail);
    if (checks) {
      lines.push(checks);
    }
  }
  return lines;
}

/**
 * The current result of each prerequisite a task has in this loop, including
 * loop-only `after` prerequisites: the latest report's outcome and summary,
 * plus the blocking findings and failed checks it left open. New agents and
 * same-agent continuations both receive it, so a re-running review sees the
 * owner's newest defects and a reopened owner sees its planning task's result.
 */
export function prerequisiteResults(
  symphony: StoredSymphony,
  task: TaskDefinition,
): PrerequisiteResult[] {
  return loopPrerequisites(symphony, task).map((id) => {
    const report = latestAttempt(symphony, id)?.report;
    const findings = (report?.findings ?? []).filter(
      (finding) => finding.severity === "blocking",
    );
    const failedChecks = (report?.checks ?? [])
      .filter((check) => check.status === "failed")
      .map((check) => check.name);
    return {
      taskId: id,
      ...(report?.outcome ? { outcome: report.outcome } : {}),
      ...(report?.summary ? { summary: report.summary } : {}),
      ...(findings.length ? { findings } : {}),
      ...(failedChecks.length ? { failedChecks } : {}),
    };
  });
}

export interface AssignmentPromptInput {
  symphonyId: string;
  attemptId: string;
  taskId: string;
  title: string;
  goal: string;
  outcome: string;
  reads: string[];
  writes: string[];
  checks: string[];
  prerequisites: PrerequisiteResult[];
  /** True for a read-only review of the other tasks' work. */
  review?: boolean;
  /** Set when the Conductor reopened this task with findings. */
  reopen?: ReopenPromptInput;
  /** Set when a reopened prerequisite requires a re-check. */
  recheck?: RecheckPromptInput;
  /** Set for a re-running review: the previous loop's findings to confirm. */
  previous?: PreviousFindingsInput;
}

/**
 * Renders a prompt at the most detailed finding level that fits `budget`
 * characters. The `count` level is returned even when it does not fit, so the
 * caller can refuse a prompt that cannot be saved instead of truncating it.
 */
function fitPrompt(
  budget: number,
  render: (detail: FindingDetail) => string,
): string {
  let prompt = "";
  for (const detail of FINDING_DETAILS) {
    prompt = render(detail);
    if (prompt.length <= budget) {
      break;
    }
  }
  return prompt;
}

/**
 * The full assignment for a new task agent. It states what to do and which
 * checks to run, not how to format a tool call: the harness already carries the
 * MCP schemas and a "[Conductor agent commands]" system prompt. Findings are
 * shortened only when the full prompt would exceed `budget` characters.
 */
export function assignmentPrompt(
  input: AssignmentPromptInput,
  budget: number = SYMPHONY_LIMITS.promptChars,
): string {
  return fitPrompt(budget, (detail) => renderAssignment(input, detail));
}

function renderAssignment(
  input: AssignmentPromptInput,
  detail: FindingDetail,
): string {
  const lines = [
    `You are a task agent in Conductor symphony ${input.symphonyId}, attempt ${input.attemptId}.`,
    "",
    `Task ${input.taskId}: ${input.title}`,
    `Goal: ${input.goal}`,
    `Assignment: ${input.outcome}`,
    `Reads: ${paths(input.reads, "none")}`,
    `Writes: ${paths(input.writes, "none (read-only)")}`,
    `Required checks: ${paths(input.checks, "none")}`,
  ];
  lines.push(...prerequisiteLines(input.prerequisites, detail));
  if (input.reopen) {
    lines.push("", ...reopenLines(input.reopen, detail));
  }
  if (input.recheck) {
    lines.push("", ...recheckLines(input.recheck));
  }
  if (input.previous) {
    lines.push("", ...previousLines(input.previous, detail));
  }
  lines.push(...shortenedLines(detail));
  lines.push(
    "",
    "Other agents share this checkout. Edit only your write paths. Do not commit,",
    "push, reload plugins, start agents, or go beyond this assignment.",
    "",
    "When the work is done, run the required checks. If one fails because of your",
    "change, fix it and run it again, up to 3 rounds. Stop early if the same error",
    "repeats or if you need user input, more write paths, or a different model.",
    "Report problems that already existed and aren't caused by your change; don't",
    "fix them.",
    "",
    "Then call the Conductor `report` tool:",
    "- completed: the work is done and every required check passed. A review also",
    "  needs no blocking findings. Minor findings are allowed.",
    "- needs-changes: the work ran but required checks still fail after your own fix",
    "  rounds, or a review found blocking defects. List each defect in `findings`",
    "  with its owning taskId and `path:line`, or name the failed checks. This ends",
    "  the loop; the Conductor reopens the owning tasks for the next loop.",
    "- failed: the harness could not run the work (launch failed or unconfirmed,",
    "  you are unreachable, you cannot edit, read or run what the task needs, or you",
    "  refuse the scope). Also say what you tried, the suspected cause, and what you",
    "  need. The Conductor retries a failed task in the same loop and never uses",
    "  `failed` for a failing check.",
    "",
    "If your change breaks a file outside your write paths, call `widen` before",
    "editing it. If you can't continue, call `block`. If you can't find the",
    "Conductor tools, follow [Conductor agent commands] in your instructions.",
    "End your turn only after the report is accepted.",
  );
  if (input.review) {
    lines.push(
      "",
      "This is a review task: report completed only when no blocking finding",
      "remains. Otherwise report needs-changes with each finding's owning taskId and",
      "`path:line`, and give the previous findings' ids when confirming a fix.",
    );
  }
  return lines.join("\n");
}

export interface TaskAssignmentInput {
  symphony: StoredSymphony;
  task: TaskDefinition;
  attemptId: string;
  plan: string;
  writes: string[];
  reopen?: ReopenPromptInput;
  recheck?: RecheckPromptInput;
  previous?: PreviousFindingsInput;
  /** Characters available to the assignment; see `assignmentPrompt`. */
  budget?: number;
}

/**
 * The full assignment for a task's new or replacement agent, including one
 * bounded line per current loop prerequisite's latest report. `reserve` and a blocked rebind
 * both build their prompts from it, so the two paths cannot drift apart.
 */
export function taskAssignmentPrompt(input: TaskAssignmentInput): string {
  return assignmentPrompt(
    {
      symphonyId: input.symphony.id,
      attemptId: input.attemptId,
      taskId: input.task.id,
      title: input.task.title,
      goal: input.plan,
      outcome: input.task.outcome,
      reads: input.task.reads,
      writes: input.writes,
      checks: input.task.checks,
      ...(input.task.worker.role === "review" || input.task.review
        ? { review: true }
        : {}),
      ...(input.reopen ? { reopen: input.reopen } : {}),
      ...(input.recheck ? { recheck: input.recheck } : {}),
      ...(input.previous ? { previous: input.previous } : {}),
      prerequisites: prerequisiteResults(input.symphony, input.task),
    },
    input.budget,
  );
}

/** Per-task attempt position shared by prompts and notifications. */
export interface AttemptPosition {
  taskId: string;
  number: number;
  total: number;
}

/** A bounded projection of a failed report, rendered as handoff lines. */
function reportForRetry(report: TaskReport) {
  const diagnosis = report.diagnosis;
  return {
    outcome: report.outcome,
    summary: clamp(report.summary, 1000),
    evidence: report.evidence.slice(0, 2).map((value) => clamp(value, 300)),
    checks: report.checks.slice(0, 8).map((check) => ({
      name: clamp(check.name, 80),
      status: check.status,
      detail: clamp(check.detail, 300),
    })),
    ...(diagnosis
      ? {
          diagnosis: {
            tried: diagnosis.tried
              .slice(0, 4)
              .map((value) => clamp(value, 300)),
            suspectedCause: clamp(diagnosis.suspectedCause, 1000),
            need: diagnosis.need,
            ...(diagnosis.requestedWrites
              ? { requestedWrites: diagnosis.requestedWrites.slice(0, 8) }
              : {}),
          },
        }
      : {}),
  };
}

/** The previous attempt's report as lines, so a replacement agent can read it. */
function reportedLines(report: TaskReport): string[] {
  const projection = reportForRetry(report);
  const lines = ["What it reported:", `- Result: ${projection.summary}`];
  if (projection.diagnosis) {
    for (const tried of projection.diagnosis.tried) {
      lines.push(`- Tried: ${tried}`);
    }
    lines.push(`- Suspected cause: ${projection.diagnosis.suspectedCause}`);
  }
  const failed = projection.checks.filter((check) => check.status === "failed");
  if (failed.length) {
    lines.push(
      `- Failing checks: ${failed
        .map((check) => `${check.name}: ${check.detail}`)
        .join("; ")}`,
    );
  }
  return lines;
}

/** The union of a task's earlier attempts' changed-path observations. */
export interface HandoffPaths {
  /** Sorted, deduplicated and capped at `SYMPHONY_LIMITS.changedPaths`. */
  paths: string[];
  /** True when an attempt was truncated or the union overflows the cap. */
  truncated: boolean;
  /** True when at least one earlier attempt recorded an observation. */
  observed: boolean;
  /** True when at least one earlier attempt had no observation. */
  incomplete: boolean;
}

/**
 * Unions the changed paths across a task's earlier attempts. `observed` and
 * `incomplete` let a handoff distinguish a complete empty list from a partial
 * one and from a checkout that was never observed at all.
 */
export function unionChangedPaths(
  attempts: readonly {
    changedPaths?: readonly string[] | undefined;
    changedPathsTruncated?: boolean | undefined;
  }[],
): HandoffPaths {
  const seen = new Set<string>();
  let truncated = false;
  let observed = false;
  let incomplete = false;
  for (const attempt of attempts) {
    if (attempt.changedPaths === undefined) {
      incomplete = true;
      continue;
    }
    observed = true;
    truncated ||= attempt.changedPathsTruncated === true;
    for (const path of attempt.changedPaths) {
      seen.add(path);
    }
  }
  const sorted = [...seen].sort();
  const paths = sorted.slice(0, SYMPHONY_LIMITS.changedPaths);
  return {
    paths,
    truncated: truncated || paths.length < sorted.length,
    observed,
    incomplete,
  };
}

export interface HandoffInput {
  attempt: AttemptPosition;
  /** The previous agent's profile or provider/model for the preamble. */
  previousWorker: string;
  report?: TaskReport | null;
  blockedBy?: "worker" | "server";
  blockMessage?: string | null;
  /** The union of earlier attempts' changed paths, when any was observed. */
  changedPaths?: readonly string[];
  changedPathsTruncated?: boolean;
  /** True when some earlier attempt had no observation. */
  changedPathsIncomplete?: boolean;
  note?: string;
}

/**
 * The handoff a replacement agent needs: what the previous attempts reported or
 * why they stopped, and which paths they changed. A new agent starts from a full
 * assignment and has no access to the previous conversation.
 */
export function handoffInstructions(input: HandoffInput): string {
  const lines = [
    `Attempt ${input.attempt.number} of ${input.attempt.total} for task ${input.attempt.taskId}. You are replacing the agent from the previous attempt (${input.previousWorker}) and you do not have its conversation.`,
    "",
    "Files in your write paths changed by earlier attempts:",
  ];
  const changed = input.changedPaths;
  const listed = changed ?? [];
  for (const path of listed) {
    lines.push(`- ${path}`);
  }
  if (listed.length && input.changedPathsTruncated) {
    lines.push("- (More paths changed than are listed.)");
  }
  if (input.changedPathsIncomplete) {
    lines.push("This list may be incomplete; review your write paths.");
  } else if (listed.length) {
    lines.push("Review them before you continue; they may be incomplete.");
  } else if (changed === undefined) {
    lines.push("Changed files are unknown; review your write paths.");
  } else {
    lines.push("No changes were observed in your write paths.");
  }
  lines.push("");
  if (input.report) {
    lines.push(...reportedLines(input.report));
  } else if (input.blockedBy === "worker" && input.blockMessage) {
    lines.push(
      "What it reported:",
      `It blocked with: \`${clamp(input.blockMessage, 4000)}\``,
    );
  } else {
    lines.push("What it reported:", "It stopped without reporting.");
  }
  if (input.note) {
    lines.push("", `Conductor note: ${clamp(input.note, 2000)}`);
  }
  return lines.join("\n");
}

export interface ContinuationInput {
  taskId: string;
  attemptId: string;
  position: AttemptPosition;
  note?: string;
  writes: string[];
  added: readonly string[];
  reopen?: ReopenPromptInput;
  recheck?: RecheckPromptInput;
  previous?: PreviousFindingsInput;
  /** The current prerequisite results; see `prerequisiteResults`. */
  prerequisites?: readonly PrerequisiteResult[];
}

/**
 * A same-agent continuation or resume; the agent still holds its conversation.
 * Findings are shortened only when the full prompt would exceed the limit.
 */
export function continuationPrompt(input: ContinuationInput): string {
  return fitPrompt(SYMPHONY_LIMITS.promptChars, (detail) =>
    renderContinuation(input, detail),
  );
}

function renderContinuation(
  input: ContinuationInput,
  detail: FindingDetail,
): string {
  const lines = [
    `Continue task ${input.taskId}, now attempt ${input.attemptId} (${input.position.number} of ${input.position.total}).`,
  ];
  if (input.note) {
    lines.push(`Conductor note: ${clamp(input.note, 2000)}`);
  }
  if (input.reopen) {
    lines.push("", ...reopenLines(input.reopen, detail));
  }
  if (input.recheck) {
    lines.push("", ...recheckLines(input.recheck));
  }
  if (input.previous) {
    lines.push("", ...previousLines(input.previous, detail));
  }
  if (input.prerequisites?.length) {
    lines.push("", ...prerequisiteLines(input.prerequisites, detail));
  }
  lines.push(...shortenedLines(detail));
  lines.push(
    `Write paths now: ${paths(input.writes, "none (read-only)")} (added: ${paths(
      input.added,
      "none",
    )})`,
    "Report or block this attempt when done.",
  );
  return lines.join("\n");
}

/** The one nudge a stopped task agent gets before its attempt fails. */
export function nudgePrompt(attemptId: string): string {
  return `You ended your turn without reporting attempt ${attemptId}.\nCall \`report\` or \`block\` now.`;
}
