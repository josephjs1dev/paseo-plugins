import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { collectCodex, collectGo } from "../../server/history-sources";
import { collectPi } from "../../server/pi-history";

const NOW = Date.now();
const DAY = 86_400_000;
const iso = (time: number) => new Date(time).toISOString();

test("Codex filters updated files but reads full retained counters and leaves old logs untouched", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-codex-incremental-"));

  try {
    const event = (time: number, input: number, output: number) => ({
      timestamp: iso(time),
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: { input_tokens: input, output_tokens: output },
        },
      },
    });
    const path = join(directory, "updated.jsonl");
    const contents = [
      { type: "session_meta", payload: { id: "one", cwd: "/workspace" } },
      event(NOW - 3 * DAY, 100, 20),
      event(NOW, 150, 30),
    ]
      .map((x) => JSON.stringify(x))
      .join("\n");
    await writeFile(path, contents);
    const untouched = join(directory, "untouched.jsonl.zst");
    await writeFile(untouched, "invalid compressed data");
    await utimes(untouched, new Date(NOW - 2 * DAY), new Date(NOW - 2 * DAY));
    const result = await collectCodex(
      [directory],
      NOW - 90 * DAY,
      new AbortController().signal,
      { modifiedSince: NOW - DAY },
    );
    assert.equal(result.incomplete, false);
    assert.equal(result.rows.length, 2);
    assert.equal(
      result.rows.find((r) => r.day === iso(NOW - 3 * DAY).slice(0, 10))?.totals
        .input,
      100,
    );
    assert.equal(
      result.rows.find((r) => r.day === iso(NOW).slice(0, 10))?.totals.input,
      50,
    );
    assert.equal(await readFile(path, "utf8"), contents);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Pi updated-file scans retain every message in that session snapshot", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-pi-incremental-"));

  try {
    const message = (id: string, time: number) => ({
      type: "message",
      id,
      timestamp: iso(time),
      message: {
        role: "assistant",
        provider: "openai-codex",
        model: "gpt-6.1-sol",
        usage: { input: 10, output: 20 },
      },
    });
    await writeFile(
      join(directory, "updated.jsonl"),
      [
        {
          type: "session",
          id: "one",
          cwd: "/workspace",
          timestamp: iso(NOW - 3 * DAY),
        },
        message("old", NOW - 3 * DAY),
        message("new", NOW),
      ]
        .map((x) => JSON.stringify(x))
        .join("\n"),
    );
    const rows = await collectPi(
      NOW - 90 * DAY,
      new AbortController().signal,
      [directory],
      NOW - DAY,
    );
    assert.equal(rows.length, 2);
    assert.equal(
      rows.reduce((n, r) => n + r.totals.input, 0),
      20,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("OpenCode incremental scans use updated sessions and preserve canonical v2 snapshots", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-go-incremental-"));
  const path = join(directory, "opencode.db");
  const db = new DatabaseSync(path);

  try {
    db.exec(
      "CREATE TABLE session(id TEXT,directory TEXT); CREATE TABLE message(session_id TEXT,time_created INTEGER,time_updated INTEGER,data TEXT); CREATE TABLE session_message(session_id TEXT,time_created INTEGER,time_updated INTEGER,type TEXT,data TEXT);",
    );

    for (const id of ["one", "untouched"]) {
      db.prepare("INSERT INTO session VALUES (?,?)").run(id, "/workspace");
    }

    const data = {
      role: "assistant",
      providerID: "opencode-go",
      modelID: "model-a",
      model: { providerID: "opencode-go", modelID: "model-a" },
      tokens: {
        input: 10,
        output: 20,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      cost: 0.125,
    };

    for (const id of ["one", "one", "untouched"]) {
      db.prepare("INSERT INTO session_message VALUES (?,?,?,?,?)").run(
        id,
        NOW - 2 * DAY,
        NOW - 2 * DAY,
        "assistant",
        JSON.stringify(data),
      );
    }

    // Only the legacy copy was touched; the complete canonical v2 session still wins.
    db.prepare("INSERT INTO message VALUES (?,?,?,?)").run(
      "one",
      NOW - 2 * DAY,
      NOW,
      JSON.stringify({ ...data, tokens: { ...data.tokens, input: 999 } }),
    );
    db.close();
    const before = await readFile(path);
    const rows = await collectGo(
      path,
      NOW - 90 * DAY,
      new AbortController().signal,
      NOW - DAY,
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.sessionId, "one");
    assert.equal(rows[0]?.totals.input, 20);
    assert.equal(rows[0]?.totals.output, 40);
    assert.equal(rows[0]?.totals.cost, 0.25);
    assert.deepEqual(await readFile(path), before);
  } finally {
    try {
      db.close();
    } catch {}

    await rm(directory, { recursive: true, force: true });
  }
});

test("legacy OpenCode schemas without update timestamps still return complete touched sessions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-go-created-"));
  const path = join(directory, "opencode.db");
  const db = new DatabaseSync(path);

  try {
    db.exec(
      "CREATE TABLE session(id TEXT,directory TEXT);CREATE TABLE message(session_id TEXT,time_created INTEGER,data TEXT);",
    );
    db.prepare("INSERT INTO session VALUES (?,?)").run("one", "/workspace");
    const data = {
      role: "assistant",
      providerID: "opencode-go",
      modelID: "model-a",
      tokens: {
        input: 10,
        output: 20,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      cost: 0,
    };

    for (const time of [NOW - 2 * DAY, NOW]) {
      db.prepare("INSERT INTO message VALUES (?,?,?)").run(
        "one",
        time,
        JSON.stringify(data),
      );
    }

    db.close();
    const rows = await collectGo(
      path,
      NOW - 90 * DAY,
      new AbortController().signal,
      NOW - DAY,
    );
    assert.equal(rows.length, 2);
    assert.equal(
      rows.reduce((total, row) => total + row.totals.input, 0),
      20,
    );
  } finally {
    try {
      db.close();
    } catch {}

    await rm(directory, { recursive: true, force: true });
  }
});
