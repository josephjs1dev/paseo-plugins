import assert from "node:assert/strict";
import { test } from "node:test";

import { createPiHistoryParser } from "../../shared/history-parsers";

const timestamp = "2026-09-25T10:00:00.000Z";
const header = {
  type: "session",
  version: 3,
  id: "one",
  cwd: "/workspace",
  timestamp,
};
const usage = {
  input: 10,
  output: 20,
  cacheRead: 5,
  cacheWrite: 2,
  reasoning: 3,
  totalTokens: 37,
  cost: { total: 0.125 },
};

function message(id: string, provider = "openai-codex", model = "model-a") {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp,
    message: {
      role: "assistant",
      provider,
      model,
      usage,
      content: [{ type: "text", text: "private response" }],
      stopReason: "stop",
    },
  };
}

function parser(since = 0, seen = new Set<string>()) {
  const parse = createPiHistoryParser(since, seen);
  const read = (entry: unknown) => parse(JSON.stringify(entry));
  read(header);

  return read;
}

test("Pi attributes each request by provider and model, with cache and reasoning counted once", () => {
  const read = parser();
  const codex = read(message("first"));
  const go = read(message("second", "opencode-go", "model-go"));
  const nextCodex = read(message("third"));
  assert.equal(codex?.provider, "chatgpt");
  assert.equal(codex?.sessionId, "one");
  assert.equal(go?.provider, "opencode-go");
  assert.equal(go?.model, "model-go");
  assert.deepEqual(codex?.totals, {
    input: 17,
    cached: 5,
    output: 20,
    reasoning: 3,
    cost: 0.125,
  });
  assert.deepEqual(go?.totals, codex?.totals);
  assert.deepEqual(nextCodex?.totals, codex?.totals);
  assert.equal(JSON.stringify(codex).includes("private response"), false);
});

test("Pi preserves zero estimates and keeps absent or invalid costs unknown without losing tokens", () => {
  for (const [cost, expected] of [
    [{ total: 0 }, 0],
    [undefined, null],
    [null, null],
    [{}, null],
    [{ total: null }, null],
    [{ total: -1 }, null],
    [{ total: "0.125" }, null],
    [0.125, null],
  ]) {
    const entry = message("cost", "opencode-go");
    const row = parser()({
      ...entry,
      message: { ...entry.message, usage: { ...usage, cost } },
    });
    assert.equal(row?.totals.input, 17);
    assert.equal(row?.totals.output, 20);
    assert.equal(row?.totals.cost, expected);
  }
});

test("Pi ignores other providers, user/tool messages and context token counts", () => {
  const read = parser();
  assert.equal(read(message("zen", "opencode")), undefined);
  assert.equal(read(message("api", "openai")), undefined);
  assert.equal(read(message("other", "anthropic")), undefined);
  assert.equal(
    read({ ...message("user"), message: { role: "user", content: "private" } }),
    undefined,
  );
  assert.equal(
    read({ ...message("tool"), message: { role: "toolResult", usage } }),
    undefined,
  );
  assert.equal(
    read({
      type: "compaction",
      id: "context",
      timestamp,
      tokensBefore: 100_000,
    }),
    undefined,
  );
});

test("Pi duplicate entries and copied session files count once", () => {
  const seen = new Set<string>();
  const read = parser(0, seen);
  assert.ok(read(message("first")));
  assert.equal(read(message("first")), undefined);
  assert.equal(parser(0, seen)(message("first")), undefined);
  assert.ok(read(message("second")));
});

test("Pi forks exclude inherited usage even when the parent file is absent", () => {
  const read = parser();
  read({
    ...header,
    id: "fork",
    timestamp: "2026-09-25T11:00:00Z",
    parentSession: "/unread-parent.jsonl",
  });
  assert.equal(read(message("inherited")), undefined);
  const fresh = read({
    ...message("fresh"),
    timestamp: "2026-09-25T11:01:00Z",
  });
  assert.equal(fresh?.sessionId, "fork");
  assert.equal(fresh?.totals.input, 17);
});

test("Pi dates use UTC and retention filters individual messages", () => {
  const read = parser(Date.parse("2026-09-25T12:00:00Z"));
  assert.equal(read(message("old")), undefined);
  const row = read({
    ...message("new"),
    timestamp: "2026-09-26T00:30:00+02:00",
  });
  assert.equal(row?.day, "2026-09-25");
  assert.equal(row?.lastAt, "2026-09-25T22:30:00.000Z");
});

test("Pi handles old usage without a reasoning breakdown and rejects invalid counts", () => {
  const read = parser();
  const entry = message("old-format");
  const oldUsage = { ...usage, reasoning: undefined };
  const row = read({
    ...entry,
    message: { ...entry.message, usage: oldUsage },
  });
  assert.equal(row?.totals.reasoning, 0);
  assert.throws(() =>
    read({
      ...entry,
      message: { ...entry.message, usage: { ...usage, input: -1 } },
    }),
  );
  const parse = createPiHistoryParser(0, new Set());
  assert.equal(parse('{"partial":'), undefined);
  assert.throws(() => parse("x".repeat(2 * 1024 * 1024 + 1)), /limit/);
});

test("Pi counts explicit usage and built-in summary calls when usage is recorded", () => {
  const read = parser();
  read({ type: "model_change", provider: "opencode-go", modelId: "model-go" });
  const compact = read({
    type: "compaction",
    id: "compact",
    timestamp,
    usage,
    tokensBefore: 100_000,
  });
  assert.equal(compact?.provider, "opencode-go");
  assert.equal(compact?.totals.input, 17);
  assert.equal(compact?.totals.cost, 0.125);
  const extra = read({
    type: "usage",
    id: "warm",
    timestamp,
    provider: "openai-codex",
    model: "model-a",
    usage,
  });
  assert.equal(extra?.provider, "chatgpt");
  assert.equal(extra?.totals.cost, 0.125);
  assert.equal(
    read({
      type: "branch_summary",
      id: "hook",
      timestamp,
      fromHook: true,
      usage,
    }),
    undefined,
  );
  const branch = read({
    type: "branch_summary",
    id: "branch",
    timestamp,
    usage,
  });
  assert.equal(branch?.totals.cost, 0.125);
});

test("Pi preserves source session IDs up to the shared 160-character limit", () => {
  const id = "s".repeat(160);
  const parse = createPiHistoryParser(0, new Set());
  parse(JSON.stringify({ ...header, id }));
  const result = parse(JSON.stringify(message("entry")));
  assert.equal(result?.sessionId, id);
  assert.equal(result?.harness, "pi");
  assert.throws(() => parse(JSON.stringify({ ...header, id: id + "s" })));
});
