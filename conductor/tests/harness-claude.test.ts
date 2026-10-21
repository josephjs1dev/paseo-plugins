import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createClaudeReader } from "../server/engine/harnesses/claude";
import { claudeProjectsRoot } from "../server/engine/harnesses/paths";

async function fixture(name: string): Promise<string> {
  return readFile(
    join(import.meta.dirname, "fixtures", "harnesses", name),
    "utf8",
  );
}

void test("Claude paths honor CLAUDE_CONFIG_DIR", () => {
  assert.equal(
    claudeProjectsRoot({
      env: { CLAUDE_CONFIG_DIR: "/claude" },
      home: "/home/test",
    }),
    "/claude/projects",
  );
  assert.equal(
    claudeProjectsRoot({ env: {}, home: "/home/test" }),
    "/home/test/.claude/projects",
  );
});

void test("Claude deduplicates streamed responses and ignores subagents", async () => {
  const root = await mkdtemp(join(tmpdir(), "conductor-claude-"));

  try {
    const project = join(root, "projects", "-workspace");
    const parent = join(project, "session-claude.jsonl");
    const subagents = join(project, "session-claude", "subagents");
    await mkdir(subagents, { recursive: true });
    await writeFile(parent, await fixture("claude.jsonl"));
    await writeFile(
      join(subagents, "agent-child.jsonl"),
      await fixture("claude-subagent.jsonl"),
    );

    const reader = createClaudeReader({
      env: { CLAUDE_CONFIG_DIR: root },
      home: root,
    });
    const from = Date.parse("2026-10-18T11:00:00.000Z");
    const to = Date.parse("2026-10-18T11:00:20.000Z");

    // req-1 appears twice; only its final snapshot is counted.
    assert.deepEqual(await reader.read("session-claude", from, to), {
      input: 17,
      cached: 16,
      output: 12,
    });
    assert.deepEqual(
      await reader.read(
        "session-claude",
        Date.parse("2026-10-18T11:00:40.000Z"),
        Date.parse("2026-10-18T11:00:40.000Z"),
      ),
      { input: 4, cached: 2, output: 5 },
    );
    assert.deepEqual(
      await reader.read(
        "session-claude",
        Date.parse("2026-10-18T11:01:00.000Z"),
        Date.parse("2026-10-18T11:02:00.000Z"),
      ),
      { input: 0, cached: 0, output: 0 },
    );
    assert.equal(
      await reader.read(
        "missing-session",
        Date.parse("2026-10-18T11:00:00.000Z"),
        Date.parse("2026-10-18T11:00:20.000Z"),
      ),
      null,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("Claude never falls back to an unrelated transcript body", async () => {
  const root = await mkdtemp(join(tmpdir(), "conductor-claude-headers-"));

  try {
    const other = join(root, "projects", "other");
    await mkdir(other, { recursive: true });
    await writeFile(
      join(other, "other.jsonl"),
      await fixture("claude-unrelated.jsonl"),
    );
    const reader = createClaudeReader({
      env: { CLAUDE_CONFIG_DIR: root },
      home: root,
    });

    // The record names the requested session, but its file is not that
    // session's transcript, so it must not be opened or counted.
    assert.equal(
      await reader.read(
        "session-claude-unrelated",
        Date.parse("2026-10-18T11:00:00.000Z"),
        Date.parse("2026-10-18T11:00:30.000Z"),
      ),
      null,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
