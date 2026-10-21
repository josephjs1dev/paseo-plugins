import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as zlib from "node:zlib";
import { createCodexReader } from "../server/engine/harnesses/codex";
import { codexSessionRoots } from "../server/engine/harnesses/paths";
import { readerFor } from "../server/engine/harnesses/usage";

async function fixture(name: string): Promise<string> {
  return readFile(
    join(import.meta.dirname, "fixtures", "harnesses", name),
    "utf8",
  );
}

void test("readerFor maps the supported Paseo provider ids", () => {
  for (const provider of ["codex", "claude", "pi", "opencode"]) {
    assert.equal(readerFor(provider)?.provider, provider);
  }

  assert.equal(readerFor("unknown"), undefined);
});

void test("Codex paths honor CODEX_HOME", () => {
  assert.deepEqual(
    codexSessionRoots({ env: { CODEX_HOME: "/codex" }, home: "/home/test" }),
    ["/codex/sessions", "/codex/archived_sessions"],
  );
  assert.deepEqual(codexSessionRoots({ env: {}, home: "/home/test" }), [
    "/home/test/.codex/sessions",
    "/home/test/.codex/archived_sessions",
  ]);
});

void test("Codex sums cumulative deltas inside the inclusive window", async () => {
  const root = await mkdtemp(join(tmpdir(), "conductor-codex-"));

  try {
    const content = await fixture("codex.jsonl");
    const sessions = join(root, "sessions");
    const archived = join(root, "archived_sessions");
    await mkdir(sessions, { recursive: true });
    await mkdir(archived, { recursive: true });
    await writeFile(join(sessions, "rollout.jsonl"), content);
    // Archived copies of the same session must not be counted twice.
    await writeFile(join(archived, "rollout.jsonl"), content);
    const reader = createCodexReader({ env: { CODEX_HOME: root }, home: root });
    const from = Date.parse("2026-10-18T10:00:10.000Z");
    const to = Date.parse("2026-10-18T10:00:30.000Z");

    assert.deepEqual(await reader.read("session-codex", from, to), {
      input: 80,
      cached: 20,
      output: 20,
    });
    assert.deepEqual(
      await reader.read(
        "session-codex",
        Date.parse("2026-10-18T10:01:00.000Z"),
        Date.parse("2026-10-18T10:02:00.000Z"),
      ),
      { input: 0, cached: 0, output: 0 },
    );
    assert.equal(
      await reader.read(
        "missing-session",
        Date.parse("2026-10-18T10:00:00.000Z"),
        Date.parse("2026-10-18T10:00:30.000Z"),
      ),
      null,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test(
  "Codex reads compressed logs and treats a fork's first total as baseline",
  { skip: typeof zlib.zstdCompressSync !== "function" },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "conductor-codex-fork-"));

    try {
      const forked = await fixture("codex-forked.jsonl");
      const sessions = join(root, "sessions");

      await mkdir(sessions, { recursive: true });
      await writeFile(
        join(sessions, "session-codex-fork.jsonl.zst"),
        zlib.zstdCompressSync(forked),
      );

      const reader = createCodexReader({
        env: { CODEX_HOME: root },
        home: root,
      });
      const from = Date.parse("2026-10-18T10:10:00.000Z");
      const to = Date.parse("2026-10-18T10:10:20.000Z");

      assert.deepEqual(await reader.read("session-codex-fork", from, to), {
        input: 70,
        cached: 10,
        output: 20,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

void test("Codex leaves fields absent when totals omit cache reads", async () => {
  const root = await mkdtemp(join(tmpdir(), "conductor-codex-partial-"));

  try {
    const sessions = join(root, "sessions");
    await mkdir(sessions, { recursive: true });
    await writeFile(
      join(sessions, "session-codex-partial.jsonl"),
      await fixture("codex-partial.jsonl"),
    );
    const reader = createCodexReader({ env: { CODEX_HOME: root }, home: root });

    assert.deepEqual(
      await reader.read(
        "session-codex-partial",
        Date.parse("2026-10-18T10:20:00.000Z"),
        Date.parse("2026-10-18T10:20:10.000Z"),
      ),
      { output: 20 },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("Codex inspects only an unrelated log's bounded header", async () => {
  const root = await mkdtemp(join(tmpdir(), "conductor-codex-headers-"));

  try {
    const sessions = join(root, "sessions");
    await mkdir(sessions, { recursive: true });
    await writeFile(
      join(sessions, "target.jsonl"),
      await fixture("codex.jsonl"),
    );
    const unrelated = [
      { type: "session_meta", payload: { id: "other-session", cwd: "/other" } },
      { type: "session_meta", payload: { id: "session-codex", cwd: "/x" } },
      {
        timestamp: "2026-10-18T10:00:10.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 999_999,
              cached_input_tokens: 0,
              output_tokens: 999_999,
            },
          },
        },
      },
    ];
    await writeFile(
      join(sessions, "unrelated.jsonl"),
      unrelated.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
    );
    const reader = createCodexReader({ env: { CODEX_HOME: root }, home: root });

    // The unrelated body also names this session and carries huge usage. Only
    // its first record is inspected, so it must never be counted.
    assert.deepEqual(
      await reader.read(
        "session-codex",
        Date.parse("2026-10-18T10:00:10.000Z"),
        Date.parse("2026-10-18T10:00:30.000Z"),
      ),
      { input: 80, cached: 20, output: 20 },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
