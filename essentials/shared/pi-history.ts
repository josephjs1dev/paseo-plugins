import { z } from "zod";

import type { HistoryRow } from "./history";
import type { Provider } from "./usage";

const count = z.number().finite().nonnegative();
const timestamp = z.string().datetime({ offset: true });
const headerSchema = z.object({
  type: z.literal("session"),
  id: z.string().min(1).max(157),
  cwd: z.string().max(4096),
  timestamp,
  parentSession: z.string().max(4096).optional(),
});
const modelSchema = z.object({
  provider: z.string().max(160),
  model: z.string().min(1).max(160),
});
const usageSchema = z.object({
  input: count,
  output: count,
  cacheRead: count.default(0),
  cacheWrite: count.default(0),
  reasoning: count.optional(),
  // Missing or malformed estimates must not discard otherwise valid tokens.
  cost: z.object({ total: count }).nullish().catch(null),
});
const entrySchema = z.object({
  id: z.string().min(1).max(160),
  timestamp,
});
const messageSchema = modelSchema.extend({
  role: z.literal("assistant"),
  usage: usageSchema,
});

function providerId(provider: string): Provider | undefined {
  if (provider === "openai-codex") {
    return "codex";
  }

  if (provider === "opencode-go") {
    return "opencode-go";
  }
}

/** Pi usage is per request, unlike Codex's cumulative token counters. */
export function createPiHistoryParser(since: number, seen: Set<string>) {
  let session: z.infer<typeof headerSchema> | undefined;
  let model: z.infer<typeof modelSchema> | undefined;

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
      session = headerSchema.parse(data);
      model = undefined;

      return;
    }

    if (!session) {
      return;
    }

    if (data.type === "model_change") {
      const parsed = modelSchema.safeParse({
        provider: data.provider,
        model: data.modelId,
      });
      model = parsed.success ? parsed.data : undefined;

      return;
    }

    let usage: z.infer<typeof usageSchema>;
    let attribution: z.infer<typeof modelSchema>;

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

      const messageModel = modelSchema.parse(message);
      model = messageModel;

      if (!providerId(messageModel.provider)) {
        return;
      }

      const parsed = messageSchema.parse(message);
      attribution = parsed;
      usage = parsed.usage;
      model = attribution;
    } else if (data.type === "usage") {
      attribution = modelSchema.parse(data);

      if (!providerId(attribution.provider)) {
        return;
      }

      usage = usageSchema.parse(data.usage);
    } else if (
      (data.type === "compaction" || data.type === "branch_summary") &&
      data.usage !== undefined
    ) {
      // Built-in summary calls use the active model. Extension calls may use another.
      if (data.fromHook === true || !model) {
        return;
      }

      attribution = model;
      usage = usageSchema.parse(data.usage);
    } else {
      return;
    }

    const provider = providerId(attribution.provider);

    if (!provider) {
      return;
    }

    const entry = entrySchema.parse(data);
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
      // Namespacing also keeps old cached native session IDs compatible.
      sessionId: `pi:${session.id}`,
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
