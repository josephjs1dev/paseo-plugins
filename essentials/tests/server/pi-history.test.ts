import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { collectPi, piHistoryDirectory } from "../../server/pi-history";
import { collectGo } from "../../server/history-sources";
import {
  createHistoryStore,
  createLocalHistoryCollector,
} from "../../server/history";
import type { HistoryRow } from "../../shared/history";
import { writeSavedHistory } from "../../server/history-files";

test("Pi resolves daemon environment session path overrides", () => {
  assert.equal(
    piHistoryDirectory({ PI_CODING_AGENT_DIR: "/pi-agent" }),
    "/pi-agent/sessions",
  );
  assert.equal(
    piHistoryDirectory({
      PI_CODING_AGENT_DIR: "/pi-agent",
      PI_CODING_AGENT_SESSION_DIR: "/pi-sessions",
    }),
    "/pi-sessions",
  );
  assert.equal(
    piHistoryDirectory({
      PI_USAGE_SESSION_DIR: "/usage",
      PI_CODING_AGENT_SESSION_DIR: "/pi-sessions",
    }),
    "/usage",
  );
});

test("Pi scans nested JSONL read-only, deduplicates copies, skips links and tolerates partial lines", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nestkit-pi-"));

  try {
    const nested = join(directory, "workspace");
    await mkdir(nested);
    const timestamp = new Date().toISOString();
    const entries = [
      { type: "session", version: 3, id: "one", cwd: "/workspace", timestamp },
      ...["openai-codex", "opencode-go"].map((provider) => ({
        type: "message",
        id: provider,
        timestamp,
        message: {
          role: "assistant",
          provider,
          model: "model-a",
          content: "private prompt",
          usage: { input: 10, output: 20, cacheRead: 5, cacheWrite: 2 },
        },
      })),
    ];
    const path = join(nested, "one.jsonl");
    const data =
      entries.map((entry) => JSON.stringify(entry)).join("\n") +
      '\n{"partial":';
    await writeFile(path, data);
    await writeFile(join(directory, "copy.jsonl"), data);
    await symlink(directory, join(nested, "loop"));
    const signal = new AbortController().signal;
    const rows = await collectPi(0, signal, [directory, nested]);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((row) => row.provider).sort(), [
      "codex",
      "opencode-go",
    ]);
    assert.equal(
      rows.reduce((sum, row) => sum + row.totals.input + row.totals.output, 0),
      74,
    );
    assert.equal(JSON.stringify(rows).includes("private prompt"), false);
    assert.equal(await readFile(path, "utf8"), data);
    assert.deepEqual(
      await collectPi(0, signal, [join(directory, "missing")]),
      [],
    );
    assert.deepEqual(
      await collectGo(join(directory, "missing.db"), 0, signal),
      [],
    );
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      collectPi(0, controller.signal, [directory]),
      /Cancelled/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function row(provider: HistoryRow["provider"], sessionId: string): HistoryRow {
  const timestamp = new Date().toISOString();

  return {
    provider,
    sessionId,
    cwd: "/workspace",
    model: "model-a",
    day: timestamp.slice(0, 10),
    lastAt: timestamp,
    totals: { input: 17, cached: 5, output: 20, reasoning: 0, cost: null },
  };
}

test("rescanning Pi backfills cached null costs and combines estimates with native usage without double-counting", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nestkit-pi-cost-"));
  const cacheDirectory = join(directory, "cache");
  const logDirectory = join(directory, "logs");
  const native = row("opencode-go", "native");
  native.totals.cost = 0.75;
  const legacy = row("opencode-go", "pi:one");
  legacy.totals = {
    input: 34,
    cached: 10,
    output: 40,
    reasoning: 0,
    cost: null,
  };
  const timestamp = legacy.lastAt;
  const store = createHistoryStore(
    cacheDirectory,
    createLocalHistoryCollector(
      async (provider) => (provider === "opencode-go" ? [native] : []),
      (since, signal) => collectPi(since, signal, [logDirectory]),
    ),
  );

  try {
    await mkdir(logDirectory);
    await writeSavedHistory(cacheDirectory, {
      version: 1,
      scannedAt: timestamp,
      rows: [native, legacy],
    });
    const entries = [
      { type: "session", id: "one", cwd: "/workspace", timestamp },
      ...[0.125, 0.375].map((total, index) => ({
        type: "message",
        id: String(index),
        timestamp,
        message: {
          role: "assistant",
          provider: "opencode-go",
          model: "model-a",
          usage: {
            input: 10,
            output: 20,
            cacheRead: 5,
            cacheWrite: 2,
            cost: { total },
          },
        },
      })),
    ];
    await writeFile(
      join(logDirectory, "one.jsonl"),
      entries.map((entry) => JSON.stringify(entry)).join("\n"),
    );
    await store.refresh();
    const result = await store.read("opencode-go", "/workspace", 7);
    assert.equal(result.warning, "");
    assert.equal(result.sessionCount, 2);
    assert.deepEqual(result.totals, {
      input: 51,
      cached: 15,
      output: 60,
      reasoning: 0,
      cost: 1.25,
    });
    assert.equal(result.workspaceTotals.cost, 1.25);
    assert.equal(result.daily[0]?.totals.cost, 1.25);
    assert.equal(result.models[0]?.totals.cost, 1.25);
    assert.equal(
      result.sessions.find((session) => session.sessionId === "pi:one")?.totals
        .cost,
      0.5,
    );
    await store.close();
    const reloaded = createHistoryStore(cacheDirectory, async () => []);

    try {
      const saved = await reloaded.read("opencode-go", "/workspace", 7);
      assert.deepEqual(saved.totals, result.totals);
      assert.equal(saved.sessionCount, 2);
    } finally {
      await reloaded.close();
    }
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("provider histories share a Pi scan and retain separate native and Pi sessions after reload", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nestkit-pi-store-"));
  let piScans = 0;
  const collect = createLocalHistoryCollector(
    async (provider) => [row(provider, "one")],
    async () => {
      piScans += 1;

      return [row("codex", "pi:one"), row("opencode-go", "pi:one")];
    },
  );
  const store = createHistoryStore(directory, collect);

  try {
    const [codex, go] = await Promise.all([
      store.read("codex", "/workspace", 7),
      store.read("opencode-go", "/workspace", 7),
    ]);
    assert.equal(piScans, 1);
    assert.equal(codex.workspaceSessionCount, 2);
    assert.equal(go.workspaceSessionCount, 2);
    assert.equal(codex.totals.input, 34);
    await store.close();
    const reloaded = createHistoryStore(
      directory,
      createLocalHistoryCollector(
        async (provider) => [row(provider, "one")],
        async () => [row("codex", "pi:one"), row("opencode-go", "pi:one")],
      ),
    );

    try {
      assert.equal(
        (await reloaded.read("codex", "/workspace", 7)).totals.input,
        34,
      );
    } finally {
      await reloaded.close();
    }
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a failed native collector preserves its cached usage while importing fresh Pi usage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nestkit-pi-partial-"));
  const initial = createHistoryStore(directory, async (provider) => [
    row(provider, "native"),
  ]);

  try {
    await initial.read("codex", "/workspace", 7);
    await initial.close();
    const store = createHistoryStore(
      directory,
      createLocalHistoryCollector(
        async () => {
          throw new Error("private failure");
        },
        async () => [row("codex", "pi:one")],
      ),
    );

    try {
      await store.refresh();
      const result = await store.read("codex", "/workspace", 7);
      assert.equal(result.workspaceSessionCount, 2);
      assert.equal(result.totals.input, 34);
      assert.match(result.warning, /previously stored/);
      assert.equal(result.warning.includes("private failure"), false);
    } finally {
      await store.close();
    }
  } finally {
    await initial.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Pi failure does not block native history and the next scan retries Pi", async () => {
  let calls = 0;
  const collect = createLocalHistoryCollector(
    async (provider) => [row(provider, "native")],
    async () => {
      calls += 1;

      if (calls === 1) {
        throw new Error("private Pi failure");
      }

      return [row("codex", "pi:one")];
    },
  );
  const signal = new AbortController().signal;
  const failed = await collect("codex", 0, signal);
  assert.ok(!Array.isArray(failed));
  assert.equal(failed.incomplete, true);
  assert.equal(failed.rows.length, 1);
  const retried = await collect("codex", 1, signal);
  assert.ok(!Array.isArray(retried));
  assert.equal(retried.incomplete, false);
  assert.equal(retried.rows.length, 2);
});
