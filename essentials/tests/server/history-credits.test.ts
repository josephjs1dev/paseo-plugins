import { fakeCollectors } from "../history-fixtures";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createHistoryStore } from "../../server/history";
import {
  readSavedHistory,
  writeSavedHistory,
} from "../../server/history-files";
import { readHistory, type HistoryRow } from "../../shared/history";

test("history derives credits for older cached rows across days, models, sessions, and scopes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-history-credits-"));
  const timestamp = new Date(Date.now() - 86_400_000).toISOString();
  const known: HistoryRow = {
    provider: "chatgpt",
    harness: "codex",
    sessionId: "one",
    model: "gpt-6.1-sol",
    cwd: "/workspace",
    day: timestamp.slice(0, 10),
    lastAt: timestamp,
    totals: {
      input: 1_000_000,
      cached: 500_000,
      output: 100_000,
      reasoning: 50_000,
      cost: null,
    },
  };
  const unknown: HistoryRow = {
    ...known,
    sessionId: "other",
    model: "codex-auto-review",
    cwd: "/other",
  };

  try {
    await writeSavedHistory(directory, {
      version: 3,
      collectors: {},
      scannedAt: timestamp,
      rows: [known, unknown],
    });
    const store = createHistoryStore(
      directory,
      fakeCollectors(async () => ({ rows: [], incomplete: false })),
    );

    try {
      const workspace = await store.read("chatgpt", "/workspace", 7);
      assert.equal(workspace.workspaceTotals.creditEstimate?.amount, 51.25);
      assert.equal(
        workspace.workspaceDaily[0]?.totals.creditEstimate?.amount,
        51.25,
      );
      assert.equal(workspace.models[0]?.totals.creditEstimate?.amount, 51.25);
      assert.equal(workspace.sessions[0]?.totals.creditEstimate?.amount, 51.25);
      assert.equal(
        workspace.sessions[0]?.models[0]?.totals.creditEstimate?.amount,
        51.25,
      );
      const host = await store.read("chatgpt", "/workspace", 7, 0, "host");
      assert.deepEqual(host.totals.creditEstimate, {
        amount: 51.25,
        pricedTokens: 1_100_000,
        unpricedTokens: 1_100_000,
      });
      assert.equal(
        host.models.find((model) => model.model === "codex-auto-review")?.totals
          .creditEstimate?.amount,
        null,
      );
      assert.equal(readHistory.output.safeParse(host).success, true);
      assert.equal(host.totals.cost, null);
      const saved = await readSavedHistory(directory);
      assert.deepEqual(saved?.rows, [known, unknown]);
    } finally {
      await store.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
