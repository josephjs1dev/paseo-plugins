import type { TaskReport } from "../../shared/concerts/models";
import type { ConcertCommandAccess } from "./commands/server";

export type CommandLine = (agentId: string, verb: string) => string;
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export function launcherCommand(path: string, verb: string): string {
  return `node ${shellQuote(path)} ${verb}`;
}

export function agentCommand(
  access: ConcertCommandAccess | undefined,
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

export function reportInstructions(
  command: CommandLine,
  agentId: string,
  concertId: string,
  attemptId: string,
  checks: string[],
): string {
  const example = jsonCommand(command(agentId, "report"), {
    concertId: concertId,
    attemptId,
    report: {
      outcome: "completed",
      summary: "Replace with the actual result",
      evidence: ["Replace with concrete evidence"],
      checks: checks.map((name) => ({
        name,
        status: "passed",
        detail: "Replace with the observed check result",
      })),
    },
  });
  return `Report your own findings using this exact command structure, replacing the sample report with actual evidence. JSON goes on STANDARD INPUT, not in a positional argument. Use the explicit script/socket paths and your agent ID; environment variables may be absent from shell tool calls.\n\n${example}\n\nRead the acknowledgement: a report succeeds only when the command prints JSON containing this concert and your saved attempt report. Exit code zero with empty output is NOT acknowledgement. Never claim you reported without inspecting that JSON. Use ${command(agentId, "get")} with {"concertId":"${concertId}"} on stdin to verify an uncertain result. For an unresolved blocker, use ${command(agentId, "block")} with concertId, attemptId and message on stdin. After successful reporting, stop tool work and end your turn.`;
}

/** Executable `widen` request for a file the worker's own change broke. */
export function widenInstructions(
  command: CommandLine,
  agentId: string,
  concertId: string,
  attemptId: string,
): string {
  const example = jsonCommand(command(agentId, "widen"), {
    concertId,
    attemptId,
    paths: ["shared/schema.ts"],
    reason: "My change breaks the exported schema that a required check reads",
  });
  return `If a fix needs a file outside your write scope and your change caused the breakage or it blocks a required check, request it with widen:\n\n${example}\n\nThe server grants the paths only when no other task or reader holds them and the attempt is within its widen limits. A refusal names the holder; report outcome failed with need "scope" and requestedWrites instead of editing outside your scope.`;
}

/**
 * Fix-first guidance for every worker assignment and resume: diagnose and fix
 * failing checks before reporting, bounded to three rounds, with an executable
 * `widen` request for a nearby file the change broke.
 */
export function fixFirstInstructions(
  command: CommandLine,
  agentId: string,
  concertId: string,
  attemptId: string,
): string {
  return `If a required check fails or the work is incomplete, diagnose the cause, fix it, and re-run the failing checks. Make up to 3 fix rounds; a fix round is one change followed by re-running the checks that failed. Stop early if two rounds in a row end with the same error, if widen is refused, or if you need user input or a different model. Report breakage that existed before your change and is unrelated to it as evidence; don't fix it. Report outcome failed only then, and include a diagnosis that says what you tried, the suspected cause, and what you need.\n${widenInstructions(command, agentId, concertId, attemptId)}`;
}

/** Fix-first recovery guidance plus the exact report commands for one turn. */
export function workerInstructions(
  command: CommandLine,
  agentId: string,
  concertId: string,
  attemptId: string,
  checks: string[],
): string {
  return `${fixFirstInstructions(command, agentId, concertId, attemptId)}\n${reportInstructions(command, agentId, concertId, attemptId, checks)}`;
}

export interface PriorAttempt {
  report: TaskReport | null;
  note?: string;
}

/**
 * The failed report and Conductor note for a retry. A continuation on the same
 * agent omits the report copy because the agent still holds its conversation;
 * a replacement agent receives the truncated report and diagnosis.
 */
export function retryInstructions(
  prior: PriorAttempt,
  continuation: boolean,
): string {
  const parts: string[] = [];
  if (prior.note) {
    parts.push(`Conductor note for this retry: ${clamp(prior.note, 2000)}`);
  }
  if (!continuation && prior.report) {
    parts.push(
      `Your previous attempt failed. Its truncated report: ${JSON.stringify(
        reportForRetry(prior.report),
      )}`,
    );
  }
  return parts.join("\n");
}

/** A bounded projection of a failed report, like a prerequisite report. */
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
