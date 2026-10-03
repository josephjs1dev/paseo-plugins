import { homedir } from "node:os";
import { join } from "node:path";
import { createPiHistoryParser } from "../../shared/history-parsers";
import type { HistoryCollection } from "../../shared/history";
import { collectJsonl } from "../history-sources";
import type { UsageCollector } from "./types";

export const piCollector: UsageCollector = {
  harness: "pi",
  providers: ["chatgpt", "opencode-go"],
  collectHistory({ since, signal, modifiedSince }) {
    return collectPi(since, signal, undefined, modifiedSince);
  },
};

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
  modifiedSince?: number,
): Promise<HistoryCollection> {
  return collectJsonl(
    roots,
    since,
    signal,
    createPiHistoryParser,
    modifiedSince,
  );
}
