import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createClaudeHistoryParser } from "../../shared/history-parsers";
import {
  collectClaude,
  claudeHistoryDirectory,
} from "../../server/collectors/claude";
import { createHistoryStore } from "../../server/history";
import { writeSavedHistory } from "../../server/history-files";
import { fakeCollectors, inDirectory } from "../history-fixtures";
import { readHistory } from "../../shared/history";

const NOW = Date.parse("2026-10-05T12:00:00Z");
const DAY = 86_400_000;
const signal = () => new AbortController().signal;
const tokens = {
  input_tokens: 10,
  cache_read_input_tokens: 5,
  cache_creation_input_tokens: 2,
  output_tokens: 20,
};
function record(id = "first", output = 20, sessionId = "session-one") {
  return {
    type: "assistant",
    sessionId,
    cwd: "/workspace",
    timestamp: new Date(NOW).toISOString(),
    requestId: `req-${id}`,
    message: {
      id: `msg-${id}`,
      model: "claude-sonnet-4-5",
      usage: { ...tokens, output_tokens: output },
      content: [{ type: "text", text: "private-response" }],
    },
  };
}

const jsonl = (...records: unknown[]) =>
  records.map((entry) => JSON.stringify(entry)).join("\n") + "\n";

test("Claude emits final response snapshots with cache writes and reads included in input", () => {
  const parser = createClaudeHistoryParser(0, new Set());
  const read = (entry: unknown) => parser(JSON.stringify(entry));
  read({ type: "user", message: { content: "private-user" } });
  read({
    ...record("synthetic"),
    message: { model: "<synthetic>", usage: tokens },
  });
  read(record("first", 1));
  read(record("first", 25));
  read(record("second", 10));
  assert.equal(parser('{"partial":'), undefined);
  const rows = parser.finish();
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.provider, "claude");
  assert.equal(rows[0]?.harness, "claude");
  assert.equal(rows[0]?.sessionId, "session-one");
  assert.equal(rows[0]?.model, "claude-sonnet-4-5");
  const { cost, ...counts } = rows[0]?.totals ?? {};
  assert.deepEqual(counts, {
    input: 17,
    cached: 5,
    output: 25,
    reasoning: 0,
  });
  assert.ok(Math.abs((cost ?? 0) - 0.000414) < 1e-12);
  assert.ok(!JSON.stringify(rows).includes("private"));
});

test("Claude deduplicates copied requests, preserves distinct request IDs, and scopes missing IDs to sessions", () => {
  const seen = new Set<string>();
  const parser = createClaudeHistoryParser(0, seen);
  parser(jsonl(record()).trim());
  parser(JSON.stringify({ ...record(), requestId: "another-request" }));
  assert.equal(parser.finish().length, 2);
  const copy = createClaudeHistoryParser(0, seen);
  copy(JSON.stringify(record()));
  assert.deepEqual(copy.finish(), []);
  const fallback = createClaudeHistoryParser(0, new Set());
  fallback(JSON.stringify({ ...record(), requestId: undefined }));
  fallback(JSON.stringify({ ...record(), requestId: undefined }));
  fallback(
    JSON.stringify({
      ...record("first", 20, "other-session"),
      requestId: undefined,
    }),
  );
  assert.equal(fallback.finish().length, 2);
});

test("Claude keeps UTC request days stable across streamed updates and filters retention", () => {
  const parser = createClaudeHistoryParser(NOW - DAY, new Set());
  parser(
    JSON.stringify({
      ...record("old"),
      timestamp: new Date(NOW - 2 * DAY).toISOString(),
    }),
  );
  parser(
    JSON.stringify({ ...record(), timestamp: "2026-10-05T01:59:00+02:00" }),
  );
  parser(
    JSON.stringify({
      ...record("first", 40),
      timestamp: "2026-10-05T02:01:00+02:00",
    }),
  );
  const rows = parser.finish();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.day, "2026-10-04");
  assert.equal(rows[0]?.lastAt, "2026-10-05T00:01:00.000Z");
  assert.equal(rows[0]?.totals.output, 40);
  assert.throws(() => parser("x".repeat(2 * 1024 * 1024 + 1)), /limit/);

  for (const invalid of [-1, "10", null]) {
    assert.throws(() =>
      createClaudeHistoryParser(
        0,
        new Set(),
      )(
        JSON.stringify({
          ...record(),
          message: {
            ...record().message,
            usage: { ...tokens, input_tokens: invalid },
          },
        }),
      ),
    );
  }
});

test("Claude scans parent and subagent snapshots together, skips symlinks, and never changes source logs", async () => {
  const root = await mkdtemp(join(tmpdir(), "paseo-claude-history-"));
  const parent = join(root, "session-one.jsonl");
  const children = join(root, "session-one", "subagents");
  const child = join(children, "agent-child.jsonl");
  const content = jsonl(record());

  try {
    await mkdir(children, { recursive: true });
    await writeFile(parent, content);
    await writeFile(child, jsonl(record("child", 3)));
    await writeFile(
      join(root, "session-two.jsonl"),
      jsonl(record("other", 10, "session-two")),
    );
    await symlink(parent, join(root, "link.jsonl"));
    const first = await collectClaude(NOW - DAY, signal(), [root]);
    assert.equal(first.incomplete, false);
    assert.equal(first.rows.length, 2);
    assert.equal(
      first.rows.find((row) => row.sessionId === "session-one")?.totals.output,
      23,
    );
    await utimes(parent, new Date(NOW - DAY), new Date(NOW - DAY));
    await utimes(
      join(root, "session-two.jsonl"),
      new Date(NOW - DAY),
      new Date(NOW - DAY),
    );
    await writeFile(child, jsonl(record("child", 30)));
    await utimes(child, new Date(NOW), new Date(NOW));
    const fresh = await collectClaude(
      NOW - 2 * DAY,
      signal(),
      [root],
      NOW - 1000,
    );
    assert.equal(fresh.rows.length, 1);
    assert.equal(fresh.rows[0]?.totals.output, 50);
    assert.equal(await readFile(parent, "utf8"), content);
    const cancelled = new AbortController();
    cancelled.abort();
    await assert.rejects(
      collectClaude(0, cancelled.signal, [root]),
      /Cancelled/,
    );
    assert.deepEqual(
      await collectClaude(0, signal(), [join(root, "missing")]),
      { rows: [], incomplete: false },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude history is available without quota login and preserves cached sessions when a sibling file is malformed", async () => {
  const root = await mkdtemp(join(tmpdir(), "paseo-claude-store-"));
  const projects = join(root, "projects");
  const directory = join(root, "cache");
  const children = join(projects, "session-one", "subagents");
  let firstScan: number | undefined;
  const collectors = fakeCollectors(
    async (harness, since, abort, modifiedSince) => {
      if (harness !== "claude") {
        return { rows: [], incomplete: false };
      }

      firstScan ??= modifiedSince;

      return collectClaude(since, abort, [projects], modifiedSince);
    },
  );
  const store = createHistoryStore(directory, collectors, () => NOW);

  try {
    await mkdir(children, { recursive: true });
    await writeFile(join(projects, "session-one.jsonl"), jsonl(record()));
    await writeFile(
      join(children, "agent-child.jsonl"),
      jsonl(record("child", 3)),
    );
    await writeFile(
      join(projects, "session-two.jsonl"),
      jsonl({
        ...record("other", 10, "session-two"),
        cwd: "/another-workspace",
      }),
    );
    const prior = {
      updatedThrough: new Date(NOW).toISOString(),
      incomplete: false,
    };
    await writeSavedHistory(directory, {
      version: 3,
      scannedAt: new Date(NOW).toISOString(),
      rows: [],
      collectors: { codex: prior, pi: prior, opencode: prior },
    });
    await store.refresh();
    assert.equal(firstScan, NOW - 90 * DAY);
    const workspace = await store.read("claude", inDirectory("/workspace"), 7);
    const host = await store.read(
      "claude",
      inDirectory("/workspace"),
      30,
      0,
      "host",
    );
    assert.equal(workspace.workspaceSessionCount, 1);
    assert.equal(workspace.workspaceTotals.output, 23);
    assert.equal(host.sessionCount, 2);
    assert.equal(host.totals.output, 33);
    assert.equal(readHistory.output.safeParse(workspace).success, true);
    await writeFile(
      join(children, "agent-child.jsonl"),
      jsonl({
        ...record("child"),
        message: {
          ...record().message,
          usage: { ...tokens, output_tokens: -1 },
        },
      }),
    );
    await store.refresh();
    const partial = await store.read("claude", inDirectory("/workspace"), 7);
    assert.equal(partial.workspaceTotals.output, 23);
    assert.match(partial.warning, /previously stored/);
    await store.close();
    const reloaded = createHistoryStore(
      directory,
      fakeCollectors(async () => ({ rows: [], incomplete: false })),
      () => NOW,
    );

    try {
      assert.equal(
        (await reloaded.read("claude", inDirectory("/workspace"), 7))
          .workspaceTotals.output,
        23,
      );
    } finally {
      await reloaded.close();
    }
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude history location honors the selected daemon profile", () => {
  assert.equal(
    claudeHistoryDirectory({ CLAUDE_CONFIG_DIR: "/profile" }),
    "/profile/projects",
  );
  assert.equal(
    claudeHistoryDirectory({
      CLAUDE_CONFIG_DIR: "/profile",
      CLAUDE_USAGE_PROJECTS_DIR: "/records",
    }),
    "/records",
  );
});
