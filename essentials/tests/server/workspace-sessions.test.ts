import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { PaseoAgentListResult } from "@getpaseo/client";
import {
  createWorkspaceSessions,
  type ListAgents,
} from "../../server/workspace-sessions";
import { createHistoryStore } from "../../server/history";
import { writeSavedHistory } from "../../server/history-files";
import { sessionKey } from "../../shared/history-display";
import type { HistoryRow } from "../../shared/history";
import { fakeCollectors } from "../history-fixtures";

const NOW = Date.parse("2026-10-09T12:00:00Z");
const DAY = 86_400_000;
const iso = (time: number) => new Date(time).toISOString();

interface FakeAgent {
  workspaceId?: string;
  provider: string;
  sessionId?: string;
  updatedAt?: string;
}

function agentLister(pages: FakeAgent[][]) {
  const calls: (string | undefined)[] = [];
  const list: ListAgents = (options) => {
    calls.push(options.page?.cursor);
    const index = options.page?.cursor ? Number(options.page.cursor) : 0;
    const agents = pages[index] ?? [];
    const hasMore = index + 1 < pages.length;

    // Tests only need the fields attribution reads.
    return Promise.resolve({
      requestId: "request",
      entries: agents.map((agent) => ({
        agent: {
          id: "agent",
          provider: agent.provider,
          cwd: "/workspace",
          workspaceId: agent.workspaceId,
          updatedAt: agent.updatedAt ?? iso(NOW),
          persistence: agent.sessionId
            ? { provider: agent.provider, sessionId: agent.sessionId }
            : null,
        },
      })),
      pageInfo: { nextCursor: hasMore ? String(index + 1) : null, hasMore },
    } as unknown as PaseoAgentListResult);
  };

  return { list, calls };
}

function row(sessionId: string, harness: "codex" | "claude"): HistoryRow {
  return {
    provider: harness === "codex" ? "chatgpt" : "claude",
    harness,
    sessionId,
    cwd: "/shared/checkout",
    model: null,
    day: iso(NOW - DAY).slice(0, 10),
    lastAt: iso(NOW - DAY),
    totals: { input: 100, cached: 0, output: 10, reasoning: 0, cost: null },
  };
}

test("workspaces sharing a checkout only show their own agents' sessions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-workspace-sessions-"));

  try {
    await writeSavedHistory(directory, {
      version: 3,
      scannedAt: iso(NOW),
      collectors: {
        codex: { updatedThrough: iso(NOW), incomplete: false },
        pi: { updatedThrough: iso(NOW), incomplete: false },
        opencode: { updatedThrough: iso(NOW), incomplete: false },
        claude: { updatedThrough: iso(NOW), incomplete: false },
      },
      rows: [
        row("old", "codex"),
        row("new", "codex"),
        row("terminal", "codex"),
      ],
    });
    const store = createHistoryStore(
      directory,
      fakeCollectors(() => Promise.resolve({ rows: [], incomplete: false })),
      () => NOW,
    );
    const workspaces = createWorkspaceSessions(directory, () => NOW);
    const { list } = agentLister([
      [
        { workspaceId: "wks_old", provider: "codex", sessionId: "old" },
        { workspaceId: "wks_new", provider: "codex", sessionId: "new" },
      ],
    ]);

    try {
      const attribution = await workspaces.read("wks_new", list);
      assert.equal(attribution.complete, true);
      const history = await store.read(
        "chatgpt",
        (entry) => attribution.sessions.has(sessionKey(entry)),
        7,
      );
      assert.equal(history.workspaceSessionCount, 1);
      assert.equal(history.workspaceTotals.input, 100);
      // Sessions started outside Paseo still count toward the host.
      assert.equal(history.totals.input, 300);
    } finally {
      await store.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("saved mappings outlive deleted agents and cover every page", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-workspace-sessions-"));

  try {
    const first = agentLister([
      [{ workspaceId: "wks_a", provider: "claude", sessionId: "one" }],
      [
        { workspaceId: "wks_a", provider: "pi", sessionId: "two" },
        // Unknown providers and agents without sessions are skipped.
        { workspaceId: "wks_a", provider: "custom", sessionId: "three" },
        { workspaceId: "wks_a", provider: "codex" },
        { provider: "codex", sessionId: "four" },
      ],
    ]);
    const workspaces = createWorkspaceSessions(directory, () => NOW);
    const read = await workspaces.read("wks_a", first.list);
    assert.deepEqual(first.calls, [undefined, "1"]);
    assert.deepEqual(
      [...read.sessions].sort(),
      [
        sessionKey({ harness: "claude", sessionId: "one" }),
        sessionKey({ harness: "pi", sessionId: "two" }),
      ].sort(),
    );

    const reloaded = createWorkspaceSessions(directory, () => NOW);
    const empty = agentLister([[]]);
    assert.equal((await reloaded.read("wks_a", empty.list)).sessions.size, 2);
    assert.equal((await reloaded.read("wks_b", empty.list)).sessions.size, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("listing failures fall back to saved mappings and old ones expire", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-workspace-sessions-"));
  let clock = NOW;

  try {
    const workspaces = createWorkspaceSessions(directory, () => clock);
    const seeded = agentLister([
      [
        { workspaceId: "wks_a", provider: "codex", sessionId: "recent" },
        {
          workspaceId: "wks_a",
          provider: "codex",
          sessionId: "old",
          updatedAt: iso(NOW - 80 * DAY),
        },
      ],
    ]);
    await workspaces.read("wks_a", seeded.list);

    const failing: ListAgents = () => Promise.reject(new Error("offline"));
    const fallback = await workspaces.read("wks_a", failing, true);
    assert.equal(fallback.complete, false);
    assert.equal(fallback.sessions.size, 2);

    clock = NOW + 20 * DAY;
    const empty = agentLister([[]]);
    const expired = await workspaces.read("wks_a", empty.list, true);
    assert.deepEqual(
      [...expired.sessions],
      [sessionKey({ harness: "codex", sessionId: "recent" })],
    );
    const saved = JSON.parse(
      await readFile(join(directory, "workspace-sessions.json"), "utf8"),
    ) as { sessions: unknown[] };
    assert.equal(saved.sessions.length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("reads within the sync interval reuse the last agent list", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-workspace-sessions-"));
  let clock = NOW;

  try {
    const workspaces = createWorkspaceSessions(directory, () => clock);
    const lister = agentLister([[]]);
    await workspaces.read("wks_a", lister.list);
    await workspaces.read("wks_a", lister.list);
    assert.equal(lister.calls.length, 1);
    await workspaces.read("wks_a", lister.list, true);
    assert.equal(lister.calls.length, 2);
    clock += 20_000;
    await workspaces.read("wks_a", lister.list);
    assert.equal(lister.calls.length, 3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
