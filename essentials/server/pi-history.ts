import { homedir } from "node:os";
import { join } from "node:path";

import { createPiHistoryParser } from "../shared/pi-history";
import { collectJsonl } from "./history-sources";

function expandHome(path: string): string {
  if (path === "~") {
    return homedir();
  }

  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

export function piHistoryDirectory(env = process.env): string {
  const agentDirectory =
    env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");

  return expandHome(
    env.PI_USAGE_SESSION_DIR ??
      env.PI_CODING_AGENT_SESSION_DIR ??
      join(expandHome(agentDirectory), "sessions"),
  );
}

export function collectPi(
  since: number,
  signal: AbortSignal,
  roots = [piHistoryDirectory()],
) {
  return collectJsonl(roots, since, signal, createPiHistoryParser);
}
