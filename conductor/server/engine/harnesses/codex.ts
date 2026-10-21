import type { AttemptUsage } from "../../../shared/symphonies/models";
import {
  asCount,
  asInstant,
  asRecord,
  asText,
  jsonlFileNamesSession,
  listJsonlFiles,
  readJsonlFirstRecord,
  readJsonlRecords,
  type JsonlFile,
} from "./jsonl";
import type { HarnessPathOptions } from "./paths";
import { codexSessionRoots } from "./paths";
import { addUsage, createUsageTotals, finishUsage } from "./tokens";
import type { UsageReader } from "./usage";

interface CodexTokens {
  readonly input: number | undefined;
  readonly cached: number | undefined;
  readonly output: number | undefined;
}

function tokens(value: unknown): CodexTokens | undefined {
  const total = asRecord(value);
  const input = asCount(total?.input_tokens);
  const cached = asCount(total?.cached_input_tokens);
  const output = asCount(total?.output_tokens);

  if (input === undefined && cached === undefined && output === undefined) {
    return undefined;
  }

  return { input, cached, output };
}

function delta(
  current: number | undefined,
  previous: number | undefined,
  first: boolean,
): number | undefined {
  if (current === undefined) {
    return undefined;
  }

  if (first) {
    return current;
  }

  if (previous === undefined) {
    return undefined;
  }

  // A provider counter reset starts a new baseline instead of underflowing.
  return current >= previous ? current - previous : current;
}

function tokenDelta(
  current: CodexTokens,
  previous: CodexTokens | undefined,
  first: boolean,
): AttemptUsage {
  const rawInput = delta(current.input, previous?.input, first);
  const cached = delta(current.cached, previous?.cached, first);
  const output = delta(current.output, previous?.output, first);

  return {
    // Uncached input needs both inclusive input and cache reads.
    ...(rawInput !== undefined && cached !== undefined
      ? { input: Math.max(0, rawInput - cached) }
      : {}),
    ...(cached === undefined ? {} : { cached }),
    // output_tokens already includes reasoning_output_tokens.
    ...(output === undefined ? {} : { output }),
  };
}

function eventKey(timestamp: number, current: CodexTokens): string {
  return JSON.stringify([
    timestamp,
    current.input ?? null,
    current.cached ?? null,
    current.output ?? null,
  ]);
}

async function candidateFiles(
  files: readonly JsonlFile[],
  sessionId: string,
): Promise<JsonlFile[]> {
  const named = files.filter((file) =>
    jsonlFileNamesSession(file.path, sessionId),
  );

  if (named.length > 0) {
    return named;
  }

  const matched: JsonlFile[] = [];

  // Real Codex filenames contain the session id. This bounded fallback covers
  // renamed logs without loading any unrelated conversation body.
  for (const file of files) {
    const record = asRecord(await readJsonlFirstRecord(file.path));
    const payload = asRecord(record?.payload);

    if (record?.type === "session_meta" && asText(payload?.id) === sessionId) {
      matched.push(file);
    }
  }

  return matched;
}

/**
 * Reads Codex rollout logs. `total_token_usage` is cumulative, so each entry
 * contributes the difference from the previous entry. A fork's first entry
 * starts from inherited parent totals and is used only as a baseline.
 */
export function createCodexReader(
  options: HarnessPathOptions = {},
): UsageReader {
  return {
    provider: "codex",
    async read(
      sessionId: string,
      from: number,
      to: number,
    ): Promise<AttemptUsage | null> {
      const files = (
        await Promise.all(
          codexSessionRoots(options).map((root) => listJsonlFiles(root)),
        )
      )
        .flat()
        .sort(
          (left, right) =>
            right.mtimeMs - left.mtimeMs || left.path.localeCompare(right.path),
        );
      const candidates = await candidateFiles(files, sessionId);
      const seen = new Set<string>();
      const totals = createUsageTotals();
      let found = false;

      for (const file of candidates) {
        const records = await readJsonlRecords(file.path);

        if (!records) {
          continue;
        }

        let currentSession: string | undefined;
        let forked = false;
        let previous: CodexTokens | undefined;
        let first = true;

        for (const record of records) {
          const entry = asRecord(record);

          if (!entry) {
            continue;
          }

          if (entry.type === "session_meta") {
            const payload = asRecord(entry.payload);
            currentSession = asText(payload?.id);
            forked = asText(payload?.forked_from_id) !== undefined;
            previous = undefined;
            first = true;

            if (currentSession === sessionId) {
              found = true;
            }

            continue;
          }

          if (currentSession !== sessionId) {
            continue;
          }

          const payload = asRecord(entry.payload);
          const info = asRecord(payload?.info);

          if (entry.type !== "event_msg" || payload?.type !== "token_count") {
            continue;
          }

          const current = tokens(info?.total_token_usage);

          if (!current) {
            continue;
          }

          const prior = previous;
          previous = current;
          const isFirst = first;
          first = false;

          if (isFirst && forked) {
            continue;
          }

          const timestamp = asInstant(entry.timestamp);

          if (timestamp === undefined || timestamp < from || timestamp > to) {
            continue;
          }

          const key = eventKey(timestamp, current);

          if (seen.has(key)) {
            continue;
          }

          seen.add(key);
          addUsage(totals, tokenDelta(current, prior, isFirst));
        }
      }

      return found ? finishUsage(totals) : null;
    },
  };
}
