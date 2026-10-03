import { fakeCollectors } from "../history-fixtures";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as zlib from "node:zlib";
import { collectCodex } from "../../server/history-sources";
import { createHistoryStore } from "../../server/history";
import { writeSavedHistory } from "../../server/history-files";
import type { HistoryRow } from "../../shared/history";

function log(id: string, timestamp: string, input: number) {
  return (
    [
      { type: "session_meta", payload: { id, cwd: "/workspace" } },
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
      .map((item) => JSON.stringify(item))
      .join("\n") + "\n"
  );
}

test("a bounded scan imports yesterday first and retains older saved usage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-history-budget-"));
  const now = Date.now();
  const yesterday = new Date(now - 86_400_000).toISOString();
  const older = new Date(now - 3 * 86_400_000).toISOString();
  const recentLog = log("recent", yesterday, 100);

  try {
    // Filenames deliberately disagree with modification order.
    const oldPath = join(directory, "z-old.jsonl");
    const newPath = join(directory, "a-recent.jsonl");
    await writeFile(oldPath, log("old", older, 500));
    await writeFile(newPath, recentLog);
    await utimes(oldPath, new Date(older), new Date(older));
    await utimes(newPath, new Date(yesterday), new Date(yesterday));
    const result = await collectCodex(
      [directory],
      0,
      new AbortController().signal,
      {
        maxScanBytes: Buffer.byteLength(recentLog),
      },
    );
    assert.equal(result.incomplete, true);
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0]?.sessionId, "recent");
    assert.equal(result.rows[0]?.totals.input, 100);

    const cached: HistoryRow = {
      provider: "chatgpt",
      harness: "codex",
      sessionId: "old",
      cwd: "/workspace",
      model: null,
      day: older.slice(0, 10),
      lastAt: older,
      totals: { input: 500, cached: 0, output: 20, reasoning: 0, cost: null },
    };
    const storage = join(directory, "store");
    await writeSavedHistory(storage, {
      version: 2,
      collectors: {},
      scannedAt: older,
      rows: [
        cached,
        {
          ...cached,
          sessionId: "recent",
          day: yesterday.slice(0, 10),
          lastAt: yesterday,
        },
      ],
    });
    const store = createHistoryStore(
      storage,
      fakeCollectors(async (harness) =>
        harness === "codex" ? result : { rows: [], incomplete: false },
      ),
    );

    try {
      await store.refresh();
      const history = await store.read("chatgpt", "/workspace", 7);
      assert.equal(history.workspaceTotals.input, 600);
      assert.equal(history.workspaceSessionCount, 2);
      assert.equal(
        history.workspaceDaily.find((day) => day.day === yesterday.slice(0, 10))
          ?.totals.input,
        100,
      );
      assert.match(history.warning, /previously stored/);
    } finally {
      await store.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  "a corrupt compressed log cannot discard good logs or poison copy deduplication",
  { skip: typeof zlib.zstdCompressSync !== "function" },
  async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "paseo-history-corrupt-copy-"),
    );
    const now = Date.now();
    const timestamp = new Date(now).toISOString();
    const validLog = log("same-session", timestamp, 100);

    try {
      const invalidPath = join(directory, "recent.jsonl.zst");
      // Force multiple compressed input chunks before a checksum failure.
      const padding =
        JSON.stringify({
          type: "response_item",
          payload: randomBytes(100_000).toString("base64"),
        }) + "\n";
      const compressed = zlib.zstdCompressSync(validLog + padding, {
        params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 },
      });
      assert.ok(compressed.length > 64 * 1024);
      compressed[compressed.length - 1] =
        (compressed[compressed.length - 1] ?? 0) ^ 0xff;
      await writeFile(invalidPath, compressed);
      const validPath = join(directory, "older-copy.jsonl");
      await writeFile(validPath, validLog);
      await utimes(validPath, new Date(now - 1000), new Date(now - 1000));
      const result = await collectCodex(
        [directory],
        0,
        new AbortController().signal,
      );
      assert.equal(result.incomplete, true);
      assert.equal(result.rows.length, 1);
      assert.equal(result.rows[0]?.totals.input, 100);
      assert.equal(result.rows[0]?.totals.output, 20);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
