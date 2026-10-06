import type { RunCommandAccess } from "./run-command-server";

export type CommandLine = (agentId: string, verb: string) => string;
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export function launcherCommand(path: string, verb: string): string {
  return `node ${shellQuote(path)} ${verb}`;
}

export function agentCommand(
  access: RunCommandAccess | undefined,
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

export function reportInstructions(
  command: CommandLine,
  agentId: string,
  runId: string,
  attemptId: string,
  checks: string[],
): string {
  const example = jsonCommand(command(agentId, "report"), {
    runId,
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
  return `Report your own findings using this exact command structure, replacing the sample report with actual evidence. JSON goes on STANDARD INPUT, not in a positional argument. Use the explicit script/socket paths and your agent ID; environment variables may be absent from shell tool calls.\n\n${example}\n\nRead the acknowledgement: a report succeeds only when the command prints JSON containing this run and your saved attempt report. Exit code zero with empty output is NOT acknowledgement. Never claim you reported without inspecting that JSON. Use ${command(agentId, "get")} with {"runId":"${runId}"} on stdin to verify an uncertain result. For an unresolved blocker, use ${command(agentId, "block")} with runId, attemptId and message on stdin. After successful reporting, stop tool work and end your turn.`;
}
