import { fakeCollectors, inDirectory } from "../history-fixtures";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as zlib from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { collectCodex, collectOpenCode } from "../../server/history-sources";
import { createHistoryStore } from "../../server/history";
import { readHistory, type HistoryRow } from "../../shared/history";

function codexLog(sessionId: string, input: number, timestamp: string) {
  return (
    [
      { type: "session_meta", payload: { id: sessionId, cwd: "/workspace" } },
      { type: "turn_context", payload: { model: "model-codex" } },
      {
        timestamp,
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: { input_tokens: input, output_tokens: 20 },
          },
        },
      },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n") + "\n"
  );
}

test(
  "compressed Codex logs recover yesterday's tokens from active and archived history",
  { skip: typeof zlib.zstdCompressSync !== "function" },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "paseo-codex-compressed-"));
    const timestamp = new Date(Date.now() - 86_400_000).toISOString();
    const active = join(
      directory,
      "sessions",
      ...timestamp.slice(0, 10).split("-"),
    );
    const archived = join(directory, "archived_sessions");

    try {
      await mkdir(active, { recursive: true });
      await mkdir(archived);
      const data = zlib.zstdCompressSync(codexLog("yesterday", 100, timestamp));
      const path = join(active, "rollout.jsonl.zst");
      const copy = join(archived, "archived.jsonl.zst");
      await writeFile(path, data);
      await writeFile(copy, data);
      const { rows } = await collectCodex(
        [join(directory, "sessions"), archived],
        0,
        new AbortController().signal,
      );
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.day, timestamp.slice(0, 10));
      assert.equal(rows[0]?.totals.input, 100);
      assert.equal(rows[0]?.totals.output, 20);
      assert.equal(rows[0]?.model, "model-codex");
      assert.deepEqual(await readFile(path), data);
      assert.deepEqual(await readFile(copy), data);
      const store = createHistoryStore(
        join(directory, "store"),
        fakeCollectors(async (harness) => ({
          rows: harness === "codex" ? rows : [],
          incomplete: false,
        })),
      );

      try {
        const result = await store.read(
          "chatgpt",
          inDirectory("/workspace"),
          7,
        );
        assert.equal(result.workspaceDaily[0]?.day, timestamp.slice(0, 10));
        assert.equal(result.workspaceTotals.input, 100);
        assert.equal(result.warning, "");
        assert.equal(readHistory.output.safeParse(result).success, true);
      } finally {
        await store.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "plain Codex logs take precedence over stale compressed siblings",
  { skip: typeof zlib.zstdCompressSync !== "function" },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "paseo-codex-siblings-"));
    const timestamp = new Date().toISOString();

    try {
      await writeFile(
        join(directory, "rollout.jsonl"),
        codexLog("plain", 100, timestamp),
      );
      await writeFile(
        join(directory, "rollout.jsonl.zst"),
        zlib.zstdCompressSync(codexLog("stale", 999, timestamp)),
      );
      const { rows } = await collectCodex(
        [directory],
        0,
        new AbortController().signal,
      );
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.sessionId, "plain");
      assert.equal(rows[0]?.totals.input, 100);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("Codex cumulative log events become daily deltas, not repeated session totals", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nestkit-codex-history-"));

  try {
    const event = (timestamp: string, input: number, output: number) => ({
      timestamp,
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: input,
            cached_input_tokens: 0,
            output_tokens: output,
            reasoning_output_tokens: 0,
          },
        },
      },
    });
    const entries = [
      {
        type: "session_meta",
        payload: { id: "session-one", cwd: "/workspace" },
      },
      { type: "turn_context", payload: { model: "model-a" } },
      event("2026-09-24T23:00:00Z", 100, 20),
      event("2026-09-24T23:00:01Z", 100, 20),
      { type: "turn_context", payload: { model: "model-b" } },
      event("2026-09-25T01:00:00Z", 150, 35),
      { type: "response_item", payload: { content: "private prompt" } },
    ];
    await writeFile(
      join(directory, "a.jsonl"),
      entries.map((row) => JSON.stringify(row)).join("\n") + '\n{"partial":',
    );
    const { rows } = await collectCodex(
      [directory],
      0,
      new AbortController().signal,
    );
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.totals.input, 100);
    assert.equal(rows[0]?.model, "model-a");
    assert.equal(rows[1]?.model, "model-b");
    assert.equal(rows[1]?.totals.input, 50);
    assert.equal(rows[1]?.totals.output, 15);
    assert.equal(rows[1]?.totals.cost, null);
    assert.equal(JSON.stringify(rows).includes("private prompt"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("OpenCode v1 and v2 history is read-only, provider-filtered, and migration-deduplicated", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nestkit-go-history-"));
  const path = join(directory, "opencode.db");
  const db = new DatabaseSync(path);

  try {
    db.exec(
      "CREATE TABLE session (id TEXT, directory TEXT); CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT); CREATE TABLE session_message (id TEXT, session_id TEXT, time_created INTEGER, type TEXT, data TEXT);",
    );
    db.prepare("INSERT INTO session VALUES (?, ?)").run("one", "/workspace");
    const data = {
      role: "assistant",
      providerID: "opencode-go",
      modelID: "model-go",
      model: { providerID: "opencode-go", modelID: "model-go" },
      tokens: {
        input: 10,
        output: 20,
        reasoning: 3,
        cache: { read: 5, write: 2 },
      },
      cost: 0.125,
      content: "private content",
    };
    db.prepare("INSERT INTO message VALUES (?, ?, ?, ?)").run(
      "old",
      "one",
      Date.now(),
      JSON.stringify(data),
    );
    db.prepare("INSERT INTO session_message VALUES (?, ?, ?, ?, ?)").run(
      "new",
      "one",
      Date.now(),
      "assistant",
      JSON.stringify(data),
    );
    db.prepare("INSERT INTO message VALUES (?, ?, ?, ?)").run(
      "other",
      "one",
      Date.now(),
      JSON.stringify({ ...data, providerID: "anthropic" }),
    );
    db.close();
    const before = await readFile(path);
    const { rows } = await collectOpenCode(
      path,
      0,
      new AbortController().signal,
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.totals.input, 17);
    assert.equal(rows[0]?.totals.output, 23);
    assert.equal(rows[0]?.totals.cost, 0.125);
    assert.equal(rows[0]?.model, "model-go");
    assert.equal(JSON.stringify(rows).includes("private content"), false);
    assert.deepEqual(await readFile(path), before);
  } finally {
    try {
      db.close();
    } catch {
      /* Already closed. */
    }

    await rm(directory, { recursive: true, force: true });
  }
});

test("history survives reload, filters workspace sessions, and retains data after source failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nestkit-history-store-"));
  const now = new Date().toISOString();
  const row: HistoryRow = {
    provider: "chatgpt",
    harness: "codex",
    sessionId: "one",
    model: "model-a",
    cwd: "/workspace",
    day: now.slice(0, 10),
    lastAt: now,
    totals: { input: 100, cached: 10, output: 25, reasoning: 2, cost: null },
  };

  try {
    const store = createHistoryStore(
      directory,
      fakeCollectors(async (harness) => ({
        rows:
          harness === "codex"
            ? [row, { ...row, sessionId: "two", cwd: "/other" }]
            : [],
        incomplete: false,
      })),
    );
    const result = await store.read("chatgpt", inDirectory("/workspace"), 7);
    assert.equal(result.sessions.length, 1);
    assert.equal(result.totals.input, 200);
    assert.equal(result.totals.cost, null);
    assert.equal(result.workspaceTotals.input, 100);
    assert.equal(result.workspaceSessionCount, 1);
    assert.equal(result.workspaceModels[0]?.model, "model-a");
    assert.equal(
      (await stat(join(directory, "history.json"))).mode & 0o777,
      0o600,
    );
    await store.close();
    const reloaded = createHistoryStore(
      directory,
      fakeCollectors(async () => {
        throw new Error("private source failure");
      }),
    );
    await reloaded.refresh();
    const stale = await reloaded.read("chatgpt", inDirectory("/workspace"), 30);
    assert.equal(stale.totals.input, 200);
    assert.equal(stale.workspaceTotals.input, 100);
    assert.equal(stale.workspaceDaily[0]?.totals.input, 100);
    assert.equal(stale.workspaceModels[0]?.model, "model-a");
    assert.match(stale.warning, /previously stored data/);
    assert.equal(stale.warning.includes("private source failure"), false);
    await reloaded.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("provider and workspace readers share scans and cached local history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nestkit-history-cache-"));
  const collected: string[] = [];
  const store = createHistoryStore(
    directory,
    fakeCollectors(async (harness) => {
      collected.push(harness);

      return { rows: [], incomplete: false };
    }),
  );

  try {
    await Promise.all([
      store.read("chatgpt", inDirectory("/workspace"), 7),
      store.read("opencode-go", inDirectory("/workspace"), 30),
      store.read("chatgpt", inDirectory("/other"), 90),
    ]);
    assert.deepEqual(collected.sort(), ["claude", "codex", "opencode", "pi"]);
    await store.read("chatgpt", inDirectory("/workspace"), 30, 20);
    assert.equal(collected.length, 4);
    const saved = JSON.parse(
      await readFile(join(directory, "history.json"), "utf8"),
    ) as { rows: unknown[] };
    assert.deepEqual(saved.rows, []);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("corrupt stored history is preserved", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nestkit-history-corrupt-"));

  try {
    await writeFile(join(directory, "history.json"), "broken data");
    const store = createHistoryStore(
      directory,
      fakeCollectors(async () => ({ rows: [], incomplete: false })),
    );
    await assert.rejects(
      store.read("chatgpt", inDirectory("/workspace"), 7),
      /not overwritten/,
    );
    assert.equal(
      await readFile(join(directory, "history.json"), "utf8"),
      "broken data",
    );
    await store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("scopes and pages share source scans, retain rows and warnings, and satisfy the RPC", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nestkit-history-scopes-"));
  const now = new Date().toISOString();
  const collected: string[] = [];
  const rows: HistoryRow[] = Array.from({ length: 25 }, (_, index) => ({
    provider: "opencode-go",
    harness: index % 2 ? "pi" : "opencode",
    sessionId: String(index),
    model: "model-go",
    cwd: index % 2 ? "/other/worktree" : "/other/project",
    day: now.slice(0, 10),
    lastAt: now,
    totals: { input: 100, cached: 10, output: 25, reasoning: 2, cost: 0.5 },
  }));
  const store = createHistoryStore(
    directory,
    fakeCollectors(async (harness) => {
      collected.push(harness);

      return {
        rows: rows.filter((row) => row.harness === harness),
        incomplete: harness === "opencode",
      };
    }),
  );

  try {
    const [workspace, host, second] = await Promise.all([
      store.read("opencode-go", inDirectory("/workspace"), 7),
      store.read("opencode-go", inDirectory("/workspace"), 7, 0, "host"),
      store.read("opencode-go", inDirectory("/workspace"), 7, 20, "host"),
    ]);
    assert.deepEqual(collected.sort(), [
      "claude",
      "codex",
      "opencode",
      "opencode",
      "pi",
    ]);
    assert.equal(workspace.sessionCount, 0);
    assert.equal(host.sessionCount, 25);
    assert.equal(host.sessions.length, 20);
    assert.equal(second.sessions.length, 5);
    assert.equal(host.models[0]?.sessionCount, 25);
    assert.equal(host.models[0]?.totals.cost, 12.5);
    assert.equal(host.workspaceSessionCount, 0);
    assert.equal(host.warning, second.warning);
    assert.equal(host.warning, workspace.warning);
    assert.match(host.warning, /previously stored data/);

    for (const response of [workspace, host, second]) {
      assert.equal(readHistory.output.safeParse(response).success, true);
    }

    const before = await readFile(join(directory, "history.json"), "utf8");
    const matched = await store.read(
      "opencode-go",
      inDirectory("/other/project/."),
      30,
      0,
      "workspace",
    );
    assert.equal(matched.sessionCount, 13);
    assert.equal(
      (await store.read("opencode-go", inDirectory("/other"), 90)).sessionCount,
      0,
    );
    assert.equal(
      (await store.read("chatgpt", inDirectory("/workspace"), 7, 0, "host"))
        .sessionCount,
      0,
    );
    assert.equal(collected.length, 5);
    assert.equal(
      await readFile(join(directory, "history.json"), "utf8"),
      before,
    );
    assert.deepEqual(
      (JSON.parse(before) as { rows: HistoryRow[] }).rows.sort(
        (a, b) => Number(a.sessionId) - Number(b.sessionId),
      ),
      rows,
    );
    await store.close();
    const reloaded = createHistoryStore(
      directory,
      fakeCollectors(async () => {
        throw new Error("source failure");
      }),
    );

    try {
      const stale = await reloaded.read(
        "opencode-go",
        inDirectory("/workspace"),
        7,
        20,
        "host",
      );
      assert.equal(stale.sessionCount, 25);
      assert.equal(stale.sessions.length, 5);
      assert.equal(stale.warning, host.warning);
      assert.equal(readHistory.output.safeParse(stale).success, true);
    } finally {
      await reloaded.close();
    }
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
