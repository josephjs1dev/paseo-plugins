import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createPiReader } from "../server/engine/harnesses/pi";
import { piSessionsRoot } from "../server/engine/harnesses/paths";

async function fixture(name: string): Promise<string> {
  return readFile(
    join(import.meta.dirname, "fixtures", "harnesses", name),
    "utf8",
  );
}

void test("Pi paths honor the session-directory overrides in order", () => {
  assert.equal(
    piSessionsRoot({
      env: { PI_CODING_AGENT_DIR: "/pi-agent" },
      home: "/home/test",
    }),
    "/pi-agent/sessions",
  );
  assert.equal(
    piSessionsRoot({
      env: {
        PI_CODING_AGENT_DIR: "/pi-agent",
        PI_CODING_AGENT_SESSION_DIR: "/agent-sessions",
      },
      home: "/home/test",
    }),
    "/agent-sessions",
  );
  assert.equal(
    piSessionsRoot({
      env: {
        PI_USAGE_SESSION_DIR: "/usage",
        PI_CODING_AGENT_SESSION_DIR: "/agent-sessions",
      },
      home: "/home/test",
    }),
    "/usage",
  );
  assert.equal(
    piSessionsRoot({ env: {}, home: "/home/test" }),
    "/home/test/.pi/agent/sessions",
  );
});

void test("Pi reads only the requested session and deduplicates copied entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "conductor-pi-"));

  try {
    const sessions = join(root, "sessions");
    const content = await fixture("pi.jsonl");
    await mkdir(join(sessions, "workspace"), { recursive: true });
    await mkdir(join(sessions, "copy"), { recursive: true });
    await writeFile(join(sessions, "workspace", "session-pi.jsonl"), content);
    await writeFile(join(sessions, "copy", "session-pi.jsonl"), content);

    const reader = createPiReader({
      env: { PI_USAGE_SESSION_DIR: sessions },
      home: root,
    });
    const from = Date.parse("2026-10-18T12:00:10.000Z");
    const to = Date.parse("2026-10-18T12:00:20.000Z");

    assert.deepEqual(await reader.read("session-pi", from, to), {
      input: 33,
      cached: 6,
      output: 23,
    });
    assert.deepEqual(
      await reader.read(
        "session-pi",
        Date.parse("2026-10-18T12:00:30.000Z"),
        Date.parse("2026-10-18T12:00:30.000Z"),
      ),
      { input: 2, cached: 0, output: 1 },
    );
    assert.deepEqual(
      await reader.read(
        "session-pi",
        Date.parse("2026-10-18T12:01:00.000Z"),
        Date.parse("2026-10-18T12:02:00.000Z"),
      ),
      { input: 0, cached: 0, output: 0 },
    );
    assert.equal(
      await reader.read(
        "missing-session",
        Date.parse("2026-10-18T12:00:00.000Z"),
        Date.parse("2026-10-18T12:00:30.000Z"),
      ),
      null,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("Pi leaves cache fields absent when usage omits them", async () => {
  const root = await mkdtemp(join(tmpdir(), "conductor-pi-partial-"));

  try {
    const sessions = join(root, "sessions");
    await mkdir(sessions, { recursive: true });
    await writeFile(
      join(sessions, "session-pi-partial.jsonl"),
      await fixture("pi-partial.jsonl"),
    );
    const reader = createPiReader({
      env: { PI_USAGE_SESSION_DIR: sessions },
      home: root,
    });

    assert.deepEqual(
      await reader.read(
        "session-pi-partial",
        Date.parse("2026-10-18T12:10:00.000Z"),
        Date.parse("2026-10-18T12:10:10.000Z"),
      ),
      { input: 10, output: 5 },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("Pi inspects only an unrelated log's bounded header", async () => {
  const root = await mkdtemp(join(tmpdir(), "conductor-pi-headers-"));

  try {
    const sessions = join(root, "sessions");
    await mkdir(sessions, { recursive: true });
    await writeFile(join(sessions, "target.jsonl"), await fixture("pi.jsonl"));
    const unrelated = [
      {
        type: "session",
        version: 3,
        id: "other-session",
        cwd: "/other",
        timestamp: "2026-10-18T12:00:00.000Z",
      },
      {
        type: "session",
        version: 3,
        id: "session-pi",
        cwd: "/x",
        timestamp: "2026-10-18T12:00:00.000Z",
      },
      {
        type: "message",
        id: "unrelated-usage",
        timestamp: "2026-10-18T12:00:10.000Z",
        message: {
          role: "assistant",
          provider: "openai-codex",
          model: "gpt-5",
          usage: {
            input: 999_999,
            output: 999_999,
            cacheRead: 999_999,
            cacheWrite: 999_999,
            reasoning: 999_999,
          },
        },
      },
    ];
    await writeFile(
      join(sessions, "unrelated.jsonl"),
      unrelated.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
    );
    const reader = createPiReader({
      env: { PI_USAGE_SESSION_DIR: sessions },
      home: root,
    });

    // The unrelated body also names this session and carries huge usage. Only
    // its first record is inspected, so it must never be counted.
    assert.deepEqual(
      await reader.read(
        "session-pi",
        Date.parse("2026-10-18T12:00:10.000Z"),
        Date.parse("2026-10-18T12:00:20.000Z"),
      ),
      { input: 33, cached: 6, output: 23 },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
