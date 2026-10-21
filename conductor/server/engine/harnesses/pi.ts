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
import { piSessionsRoot } from "./paths";
import { addUsage, createUsageTotals, finishUsage } from "./tokens";
import type { UsageReader } from "./usage";

interface PiEntry {
  readonly timestamp: number;
  readonly usage: AttemptUsage;
  readonly id?: string;
}

function usageEntry(record: Record<string, unknown>): PiEntry | undefined {
  let usageRecord: Record<string, unknown> | undefined;
  let id: string | undefined;

  if (record.type === "message") {
    const message = asRecord(record.message);

    if (!message || message.role !== "assistant") {
      return;
    }

    usageRecord = asRecord(message.usage);
    id = asText(record.id);
  } else if (record.type === "usage") {
    usageRecord = asRecord(record.usage);
    id = asText(record.id);
  } else if (
    (record.type === "compaction" || record.type === "branch_summary") &&
    record.fromHook !== true
  ) {
    usageRecord = asRecord(record.usage);
    id = asText(record.id);
  }

  if (!usageRecord) {
    return;
  }

  const timestamp = asInstant(record.timestamp);

  if (timestamp === undefined) {
    return;
  }

  const input = asCount(usageRecord.input);
  const output = asCount(usageRecord.output);
  const cacheWrite = asCount(usageRecord.cacheWrite);
  const cached = asCount(usageRecord.cacheRead);
  const reasoning = asCount(usageRecord.reasoning);

  return {
    timestamp,
    usage: {
      // Pi reports cache writes separately from input; cache reads stay cached.
      ...(input === undefined ? {} : { input: input + (cacheWrite ?? 0) }),
      ...(cached === undefined ? {} : { cached }),
      // Reasoning is reported separately from visible output tokens.
      ...(output === undefined ? {} : { output: output + (reasoning ?? 0) }),
    },
    ...(id === undefined ? {} : { id }),
  };
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

  // Real Pi filenames usually contain the session id. This bounded fallback
  // covers renamed logs without loading any unrelated conversation body.
  for (const file of files) {
    const record = asRecord(await readJsonlFirstRecord(file.path));

    if (record?.type === "session" && asText(record.id) === sessionId) {
      matched.push(file);
    }
  }

  return matched;
}

/**
 * Reads Pi session transcripts. The `session` header selects the log, and each
 * usage record is per request. Copied records are deduplicated by entry id.
 */
export function createPiReader(options: HarnessPathOptions = {}): UsageReader {
  return {
    provider: "pi",
    async read(
      sessionId: string,
      from: number,
      to: number,
    ): Promise<AttemptUsage | null> {
      const files = await listJsonlFiles(piSessionsRoot(options));
      const candidates = await candidateFiles(files, sessionId);
      const entries = new Map<string, PiEntry>();
      const totals = createUsageTotals();
      let found = false;

      for (const file of candidates) {
        const records = await readJsonlRecords(file.path);

        if (!records) {
          continue;
        }

        let inSession = false;

        for (const record of records) {
          const entry = asRecord(record);

          if (!entry) {
            continue;
          }

          if (entry.type === "session") {
            inSession = asText(entry.id) === sessionId;

            if (inSession) {
              found = true;
            }

            continue;
          }

          if (!inSession) {
            continue;
          }

          const usage = usageEntry(entry);

          if (!usage) {
            continue;
          }

          if (usage.timestamp < from || usage.timestamp > to) {
            continue;
          }

          const key =
            usage.id ??
            JSON.stringify([
              usage.timestamp,
              usage.usage.input ?? null,
              usage.usage.cached ?? null,
              usage.usage.output ?? null,
            ]);

          if (!entries.has(key)) {
            entries.set(key, usage);
          }
        }
      }

      if (!found) {
        return null;
      }

      for (const entry of entries.values()) {
        addUsage(totals, entry.usage);
      }

      return finishUsage(totals);
    },
  };
}
