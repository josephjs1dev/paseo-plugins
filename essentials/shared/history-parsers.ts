import { z } from "zod";

import type { HistoryRow, Totals } from "./history";
import type { Provider } from "./providers";

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
      provider: "chatgpt",
      harness: "codex",
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
    harness: "opencode",
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

const timestamp = z.string().datetime({ offset: true });
const piHeaderSchema = z.object({
  type: z.literal("session"),
  id: z.string().min(1).max(160),
  cwd: z.string().max(4096),
  timestamp,
  parentSession: z.string().max(4096).optional(),
});
const piModelSchema = z.object({
  provider: z.string().max(160),
  model: z.string().min(1).max(160),
});
const piUsageSchema = z.object({
  input: count,
  output: count,
  cacheRead: count.default(0),
  cacheWrite: count.default(0),
  reasoning: count.optional(),
  // Missing or malformed estimates must not discard otherwise valid tokens.
  cost: z.object({ total: count }).nullish().catch(null),
});
const piEntrySchema = z.object({
  id: z.string().min(1).max(160),
  timestamp,
});
const piMessageSchema = piModelSchema.extend({
  role: z.literal("assistant"),
  usage: piUsageSchema,
});

function piProviderId(provider: string): Provider | undefined {
  if (provider === "openai-codex") {
    return "chatgpt";
  }

  if (provider === "opencode-go") {
    return "opencode-go";
  }
}

/** Pi usage is per request, unlike Codex's cumulative token counters. */
export function createPiHistoryParser(since: number, seen: Set<string>) {
  let session: z.infer<typeof piHeaderSchema> | undefined;
  let model: z.infer<typeof piModelSchema> | undefined;

  return (line: string): HistoryRow | undefined => {
    if (line.length > 2 * 1024 * 1024) {
      throw new Error("Pi history line limit reached");
    }

    let data: Record<string, unknown>;

    try {
      const value: unknown = JSON.parse(line);

      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return;
      }

      data = value as Record<string, unknown>;
    } catch {
      // Live JSONL files may end with an incomplete record.
      return;
    }

    if (data.type === "session") {
      session = piHeaderSchema.parse(data);
      model = undefined;

      return;
    }

    if (!session) {
      return;
    }

    if (data.type === "model_change") {
      const parsed = piModelSchema.safeParse({
        provider: data.provider,
        model: data.modelId,
      });
      model = parsed.success ? parsed.data : undefined;

      return;
    }

    let usage: z.infer<typeof piUsageSchema>;
    let attribution: z.infer<typeof piModelSchema>;

    if (data.type === "message") {
      const message = data.message;

      if (
        !message ||
        typeof message !== "object" ||
        !("role" in message) ||
        message.role !== "assistant"
      ) {
        return;
      }

      const messageModel = piModelSchema.parse(message);
      model = messageModel;

      if (!piProviderId(messageModel.provider)) {
        return;
      }

      const parsed = piMessageSchema.parse(message);
      attribution = parsed;
      usage = parsed.usage;
      model = attribution;
    } else if (data.type === "usage") {
      attribution = piModelSchema.parse(data);

      if (!piProviderId(attribution.provider)) {
        return;
      }

      usage = piUsageSchema.parse(data.usage);
    } else if (
      (data.type === "compaction" || data.type === "branch_summary") &&
      data.usage !== undefined
    ) {
      // Built-in summary calls use the active model. Extension calls may use another.
      if (data.fromHook === true || !model) {
        return;
      }

      attribution = model;
      usage = piUsageSchema.parse(data.usage);
    } else {
      return;
    }

    const provider = piProviderId(attribution.provider);

    if (!provider) {
      return;
    }

    const entry = piEntrySchema.parse(data);
    const instant = Date.parse(entry.timestamp);

    // Forks copy earlier messages. Their original session owns that usage.
    if (
      instant < since ||
      (session.parentSession && instant < Date.parse(session.timestamp))
    ) {
      return;
    }

    const key = JSON.stringify([session.id, entry.id]);

    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    const input = usage.input + usage.cacheRead + usage.cacheWrite;

    if (input + usage.output === 0) {
      return;
    }

    const lastAt = new Date(instant).toISOString();

    return {
      provider,
      harness: "pi",
      sessionId: session.id,
      model: attribution.model,
      cwd: session.cwd,
      day: lastAt.slice(0, 10),
      lastAt,
      totals: {
        input,
        cached: usage.cacheRead,
        output: usage.output,
        reasoning: usage.reasoning ?? 0,
        cost: usage.cost?.total ?? null,
      },
    };
  };
}
