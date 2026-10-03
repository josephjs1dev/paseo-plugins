import { z } from "zod";

import type { HistoryRow, Totals } from "./history";

const count = z.number().finite().nonnegative();
const codexTokensSchema = z.object({
  input_tokens: count,
  cached_input_tokens: count.optional(),
  output_tokens: count,
  reasoning_output_tokens: count.optional(),
});

const codexEventSchema = z.object({
  timestamp: z.string().datetime({ offset: true }),
  type: z.literal("event_msg"),
  payload: z.object({
    type: z.literal("token_count"),
    info: z.object({ total_token_usage: codexTokensSchema }),
  }),
});

const codexMetadataSchema = z.object({
  type: z.literal("session_meta"),
  payload: z.object({
    id: z.string().max(160),
    cwd: z.string().max(4096),
    forked_from_id: z.string().optional(),
  }),
});

const codexContextSchema = z.object({
  type: z.literal("turn_context"),
  payload: z.object({ model: z.string().min(1).max(160) }),
});

const goRowSchema = z.object({
  session_id: z.string().max(160),
  directory: z.string().max(4096),
  time_created: count,
  input: count,
  output: count,
  reasoning: count,
  cached: count,
  written: count,
  cost: count.nullable(),
  model: z.string().max(160).nullable().optional(),
});

type CodexTokens = z.infer<typeof codexTokensSchema>;
type CodexSession = z.infer<typeof codexMetadataSchema>["payload"];

/** One parser per log; the shared event set also deduplicates archived copies. */
export function createCodexHistoryParser(since: number, seen: Set<string>) {
  let session: CodexSession | undefined;
  let previous: CodexTokens | undefined;
  let model: string | undefined;

  return function parseLine(line: string): HistoryRow | undefined {
    if (line.length > 2 * 1024 * 1024) {
      return;
    }

    if (
      !line.includes('"session_meta"') &&
      !line.includes('"token_count"') &&
      !line.includes('"turn_context"')
    ) {
      return;
    }

    let data: unknown;

    try {
      data = JSON.parse(line);
    } catch {
      // A live log may end with a partial line.
      return;
    }

    const metadata = codexMetadataSchema.safeParse(data);

    if (metadata.success) {
      session = metadata.data.payload;

      return;
    }

    const context = codexContextSchema.safeParse(data);

    if (
      typeof data === "object" &&
      data !== null &&
      "type" in data &&
      data.type === "turn_context"
    ) {
      model = context.success ? context.data.payload.model : undefined;

      return;
    }

    const event = codexEventSchema.safeParse(data);

    if (!event.success || !session) {
      return;
    }

    const current = event.data.payload.info.total_token_usage;
    const prior = previous;
    previous = current;

    // Forked sessions may start with inherited totals that belong to the parent.
    if (!prior && session.forked_from_id) {
      return;
    }

    const timestamp = new Date(event.data.timestamp).toISOString();
    const totals = tokenDelta(current, prior);

    if (Date.parse(timestamp) < since || totals.input + totals.output === 0) {
      return;
    }

    const key = JSON.stringify([session.id, timestamp, current]);

    if (seen.has(key)) {
      return;
    }

    seen.add(key);

    return {
      provider: "codex",
      sessionId: session.id,
      model: model ?? null,
      cwd: session.cwd,
      day: timestamp.slice(0, 10),
      lastAt: timestamp,
      totals,
    };
  };
}

export function parseGoHistoryRow(input: unknown): HistoryRow {
  const row = goRowSchema.parse(input);
  const timestamp = new Date(row.time_created).toISOString();

  return {
    provider: "opencode-go",
    sessionId: row.session_id,
    model: row.model ?? null,
    cwd: row.directory,
    day: timestamp.slice(0, 10),
    lastAt: timestamp,
    totals: {
      input: row.input + row.cached + row.written,
      cached: row.cached,
      output: row.output + row.reasoning,
      reasoning: row.reasoning,
      cost: row.cost,
    },
  };
}

function tokenDelta(current: CodexTokens, previous?: CodexTokens): Totals {
  function delta(key: keyof CodexTokens): number {
    const value = current[key] ?? 0;
    const baseline = previous?.[key] ?? 0;

    // Treat a provider counter reset as a new baseline.
    return value >= baseline ? value - baseline : value;
  }

  return {
    input: delta("input_tokens"),
    cached: delta("cached_input_tokens"),
    output: delta("output_tokens"),
    reasoning: delta("reasoning_output_tokens"),
    cost: null,
  };
}
