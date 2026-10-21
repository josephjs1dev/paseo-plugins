import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createOpenCodeReader } from "../server/engine/harnesses/opencode";
import { opencodeDatabasePath } from "../server/engine/harnesses/paths";

const T0 = Date.parse("2026-10-18T13:00:00.000Z");
const T1 = Date.parse("2026-10-18T13:00:10.000Z");
const T2 = Date.parse("2026-10-18T13:00:20.000Z");
const T3 = Date.parse("2026-10-18T13:00:30.000Z");

interface MessageData {
  readonly role: string;
  readonly providerID?: string;
  readonly tokens?: {
    readonly input?: number;
    readonly output?: number;
    readonly reasoning?: number;
    readonly cache?: { readonly read?: number; readonly write?: number };
  };
}

function data(patch: MessageData): string {
  return JSON.stringify({
    providerID: "test-provider",
    modelID: "test-model",
    ...patch,
  });
}

function createDatabase(path: string): void {
  const database = new DatabaseSync(path);

  try {
    database.exec(`
      CREATE TABLE session (id TEXT, directory TEXT);
      CREATE TABLE message (
        id TEXT,
        session_id TEXT,
        time_created INTEGER,
        data TEXT
      );
      CREATE TABLE session_message (
        id TEXT,
        session_id TEXT,
        time_created INTEGER,
        type TEXT,
        data TEXT
      );
    `);
    const insertMessage = database.prepare(
      "INSERT INTO message VALUES (?, ?, ?, ?)",
    );
    const insertSessionMessage = database.prepare(
      "INSERT INTO session_message VALUES (?, ?, ?, ?, ?)",
    );

    insertMessage.run(
      "legacy-for-modern",
      "session-modern",
      T1,
      data({
        role: "assistant",
        tokens: { input: 10_000, output: 10_000 },
      }),
    );
    insertSessionMessage.run(
      "modern-user",
      "session-modern",
      T1,
      "user",
      data({ role: "user", tokens: { input: 10_000, output: 10_000 } }),
    );
    insertSessionMessage.run(
      "modern-anthropic",
      "session-modern",
      T1,
      "assistant",
      data({
        role: "assistant",
        providerID: "anthropic",
        tokens: {
          input: 10,
          output: 20,
          reasoning: 3,
          cache: { read: 5, write: 2 },
        },
      }),
    );
    insertSessionMessage.run(
      "modern-opencode",
      "session-modern",
      T2,
      "assistant",
      data({
        role: "assistant",
        providerID: "opencode-go",
        tokens: {
          input: 1,
          output: 2,
          reasoning: 1,
          cache: { read: 0, write: 1 },
        },
      }),
    );
    insertSessionMessage.run(
      "modern-outside",
      "session-modern",
      T3,
      "assistant",
      data({
        role: "assistant",
        tokens: { input: 100, output: 100 },
      }),
    );
    insertSessionMessage.run(
      "modern-before",
      "session-modern",
      T0,
      "assistant",
      data({
        role: "assistant",
        tokens: { input: 50, output: 50 },
      }),
    );
    insertSessionMessage.run(
      "modern-partial",
      "session-partial",
      T1,
      "assistant",
      data({ role: "assistant", tokens: { output: 10 } }),
    );
    insertMessage.run(
      "legacy-assistant",
      "session-legacy",
      T1,
      data({
        role: "assistant",
        providerID: "openai",
        tokens: {
          input: 5,
          output: 7,
          reasoning: 2,
          cache: { read: 1, write: 3 },
        },
      }),
    );
    insertMessage.run(
      "legacy-user",
      "session-legacy",
      T2,
      data({ role: "user", tokens: { input: 1_000, output: 1_000 } }),
    );
  } finally {
    database.close();
  }
}

void test("OpenCode paths honor XDG_DATA_HOME", () => {
  assert.equal(
    opencodeDatabasePath({
      env: { XDG_DATA_HOME: "/data" },
      home: "/home/test",
    }),
    "/data/opencode/opencode.db",
  );
  assert.equal(
    opencodeDatabasePath({ env: {}, home: "/home/test" }),
    "/home/test/.local/share/opencode/opencode.db",
  );
});

void test("OpenCode sums all providers and prefers the modern message table", async () => {
  const root = await mkdtemp(join(tmpdir(), "conductor-opencode-"));
  const databasePath = join(root, "opencode", "opencode.db");

  try {
    await mkdir(join(root, "opencode"));
    createDatabase(databasePath);
    const reader = createOpenCodeReader({
      env: { XDG_DATA_HOME: root },
      home: root,
    });

    assert.deepEqual(await reader.read("session-modern", T1, T2), {
      input: 14,
      cached: 5,
      output: 26,
    });
    assert.deepEqual(await reader.read("session-legacy", T1, T1), {
      input: 8,
      cached: 1,
      output: 9,
    });
    assert.deepEqual(await reader.read("session-modern", T3, T3), {
      input: 100,
      output: 100,
    });
    assert.deepEqual(await reader.read("session-partial", T1, T1), {
      output: 10,
    });
    assert.deepEqual(await reader.read("session-modern", T2 + 1, T2 + 2), {
      input: 0,
      cached: 0,
      output: 0,
    });
    assert.equal(await reader.read("missing-session", T1, T2), null);
    assert.equal(
      await createOpenCodeReader({
        env: { XDG_DATA_HOME: join(root, "missing") },
        home: root,
      }).read("session-modern", T1, T2),
      null,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
