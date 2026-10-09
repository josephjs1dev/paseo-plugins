import {
  latestAttempt,
  SYMPHONY_LIMITS,
  type StoredSymphony,
  type TaskDefinition,
  type TaskReport,
} from "../../shared/symphonies/models";
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
}

/**
 * The full assignment for a new task agent. It states what to do and which
 * checks to run, not how to format a tool call: the harness already carries the
 * MCP schemas and a "[Conductor agent commands]" system prompt.
 */
export function assignmentPrompt(input: AssignmentPromptInput): string {
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
  if (input.prerequisites.length) {
    lines.push("Prerequisite results:");
    for (const result of input.prerequisites) {
      const detail = clamp(result.summary ?? "", 1000);
      lines.push(
        `- ${result.taskId}: ${result.outcome ?? "completed"}. ${detail}`.trimEnd(),
      );
    }
  }
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
    "- completed: what changed, evidence, and a result for each required check.",
    "- failed: also say what you tried, the suspected cause, and what you need.",
    "",
    "If your change breaks a file outside your write paths, call `widen` before",
    "editing it. If you can't continue, call `block`. If you can't find the",
    "Conductor tools, follow [Conductor agent commands] in your instructions.",
    "End your turn only after the report is accepted.",
  );
  return lines.join("\n");
}

export interface TaskAssignmentInput {
  symphony: StoredSymphony;
  task: TaskDefinition;
  attemptId: string;
  plan: string;
  writes: string[];
}

/**
 * The full assignment for a task's new or replacement agent, including one
 * bounded line per prerequisite's latest report. `reserve` and a blocked rebind
 * both build their prompts from it, so the two paths cannot drift apart.
 */
export function taskAssignmentPrompt(input: TaskAssignmentInput): string {
  return assignmentPrompt({
    symphonyId: input.symphony.id,
    attemptId: input.attemptId,
    taskId: input.task.id,
    title: input.task.title,
    goal: input.plan,
    outcome: input.task.outcome,
    reads: input.task.reads,
    writes: input.writes,
    checks: input.task.checks,
    prerequisites: input.task.prerequisites.map((id) => {
      const report = latestAttempt(input.symphony, id)?.report;
      return {
        taskId: id,
        ...(report?.outcome ? { outcome: report.outcome } : {}),
        ...(report?.summary ? { summary: report.summary } : {}),
      };
    }),
  });
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
}

/** A same-agent continuation or resume; the agent still holds its conversation. */
export function continuationPrompt(input: ContinuationInput): string {
  const lines = [
    `Continue task ${input.taskId}, now attempt ${input.attemptId} (${input.position.number} of ${input.position.total}).`,
  ];
  if (input.note) {
    lines.push(`Conductor note: ${clamp(input.note, 2000)}`);
  }
  lines.push(
    `Write paths now: ${paths(input.writes, "none (read-only)")} (added: ${paths(
      input.added,
      "none",
    )})`,
    "Report or block this attempt when done.",
  );
  return lines.join("\n");
}

/** The one nudge a stopped task agent gets before its attempt is blocked. */
export function nudgePrompt(attemptId: string): string {
  return `You ended your turn without reporting attempt ${attemptId}.\nCall \`report\` or \`block\` now.`;
}
