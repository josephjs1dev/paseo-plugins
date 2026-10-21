import { basename } from "node:path";
import type { AttemptUsage } from "../../../shared/symphonies/models";
import {
  asCount,
  asInstant,
  asRecord,
  asText,
  listJsonlFiles,
  readJsonlRecords,
} from "./jsonl";
import type { HarnessPathOptions } from "./paths";
import { claudeProjectsRoot } from "./paths";
import { addUsage, createUsageTotals, finishUsage } from "./tokens";
import type { UsageReader } from "./usage";

interface ClaudeEntry {
  readonly timestamp: number;
  readonly usage: AttemptUsage;
}

function isSubagentPath(path: string): boolean {
  return /(^|[\\/])subagents([\\/]|$)/.test(path);
}

function sessionFileStem(path: string): string {
  return basename(path).replace(/\.jsonl(?:\.zst)?$/u, "");
}

function usageEntry(record: Record<string, unknown>): ClaudeEntry | undefined {
  if (record.type !== "assistant") {
    return;
  }

  const message = asRecord(record.message);
  const usage = asRecord(message?.usage);

  if (!message || !usage || message.model === "<synthetic>") {
    return;
  }

  const messageId = asText(message.id);

  if (!messageId) {
    return;
  }

  const timestamp = asInstant(record.timestamp);
  const input = asCount(usage.input_tokens);
  const output = asCount(usage.output_tokens);
  const cacheCreation = asCount(usage.cache_creation_input_tokens);
  const cached = asCount(usage.cache_read_input_tokens);

  if (timestamp === undefined) {
    return;
  }

  return {
    timestamp,
    usage: {
      // Cache writes are uncached input; cache reads stay separate.
      ...(input === undefined ? {} : { input: input + (cacheCreation ?? 0) }),
      ...(cached === undefined ? {} : { cached }),
      ...(output === undefined ? {} : { output }),
    },
  };
}

/**
 * Reads Claude Code transcripts by session filename. A streamed response can
 * appear several times with cumulative counters, so the last record per request
 * and message wins. Subagent transcripts are separate logs and stay out of
 * scope, and unrelated transcripts are never opened.
 */
export function createClaudeReader(
  options: HarnessPathOptions = {},
): UsageReader {
  return {
    provider: "claude",
    async read(
      sessionId: string,
      from: number,
      to: number,
    ): Promise<AttemptUsage | null> {
      const files = (await listJsonlFiles(claudeProjectsRoot(options))).filter(
        (file) =>
          !isSubagentPath(file.path) &&
          sessionFileStem(file.path) === sessionId,
      );
      const entries = new Map<string, ClaudeEntry>();
      const totals = createUsageTotals();
      let found = false;

      for (const file of files) {
        const records = await readJsonlRecords(file.path);

        if (!records) {
          continue;
        }

        found = true;

        for (const record of records) {
          const entry = asRecord(record);

          if (!entry || entry.sessionId !== sessionId) {
            continue;
          }

          const usage = usageEntry(entry);

          if (!usage) {
            continue;
          }

          const message = asRecord(entry.message);
          const messageId = asText(message?.id);

          if (!messageId) {
            continue;
          }

          const requestId = asText(entry.requestId) ?? sessionId;
          const key = JSON.stringify([requestId, messageId]);
          const previous = entries.get(key);

          if (!previous || usage.timestamp >= previous.timestamp) {
            entries.set(key, usage);
          }
        }
      }

      if (!found) {
        return null;
      }

      for (const entry of entries.values()) {
        if (entry.timestamp >= from && entry.timestamp <= to) {
          addUsage(totals, entry.usage);
        }
      }

      return finishUsage(totals);
    },
  };
}
