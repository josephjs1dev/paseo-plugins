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

import { collectPi, piHistoryDirectory } from "../../server/collectors/pi";
import { collectOpenCode } from "../../server/history-sources";
import { createHistoryStore } from "../../server/history";
import type { HistoryRow } from "../../shared/history";
import { fakeCollectors, inDirectory } from "../history-fixtures";

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
    const { rows } = await collectPi(0, signal, [directory, nested]);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((row) => row.provider).sort(), [
      "chatgpt",
      "opencode-go",
    ]);
    assert.equal(
      rows.reduce((sum, row) => sum + row.totals.input + row.totals.output, 0),
      74,
    );
    assert.equal(JSON.stringify(rows).includes("private prompt"), false);
    assert.equal(await readFile(path, "utf8"), data);
    assert.deepEqual(await collectPi(0, signal, [join(directory, "missing")]), {
      rows: [],
      incomplete: false,
    });
    assert.deepEqual(
      await collectOpenCode(join(directory, "missing.db"), 0, signal),
      { rows: [], incomplete: false },
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

function row(
  provider: HistoryRow["provider"],
  harness: HistoryRow["harness"],
  sessionId = "one",
): HistoryRow {
  const timestamp = new Date().toISOString();

  return {
    provider,
    harness,
    sessionId,
    cwd: "/workspace",
    model: "model-a",
    day: timestamp.slice(0, 10),
    lastAt: timestamp,
    totals: { input: 17, cached: 5, output: 20, reasoning: 0, cost: null },
  };
}

test("rescanning migrated Pi usage updates costs without double-counting native sessions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-pi-cost-"));
  const cacheDirectory = join(directory, "cache");
  const logDirectory = join(directory, "logs");
  const native = row("opencode-go", "opencode");
  native.totals.cost = 0.75;
  const legacy = row("opencode-go", "pi");
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
    fakeCollectors(async (harness, since, signal) => {
      if (harness === "pi") {
        return collectPi(since, signal, [logDirectory]);
      }

      return {
        rows: harness === "opencode" ? [native] : [],
        incomplete: false,
      };
    }),
  );

  try {
    await mkdir(cacheDirectory);
    await writeFile(
      join(cacheDirectory, "history.json"),
      JSON.stringify({
        version: 1,
        scannedAt: timestamp,
        rows: [native, { ...legacy, sessionId: "pi:one" }].map(
          ({ harness: _harness, ...record }) => record,
        ),
      }),
    );
    await mkdir(logDirectory);
    await writeFile(
      join(logDirectory, "one.jsonl"),
      [
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
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n"),
    );
    await store.refresh();
    const result = await store.read(
      "opencode-go",
      inDirectory("/workspace"),
      7,
    );
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
      result.sessions.find((session) => session.harness === "pi")?.totals.cost,
      0.5,
    );
    await store.close();
    const reloaded = createHistoryStore(
      cacheDirectory,
      fakeCollectors(async () => ({ rows: [], incomplete: false })),
    );

    try {
      const saved = await reloaded.read(
        "opencode-go",
        inDirectory("/workspace"),
        7,
      );
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

test("both provider views share a Pi collector scan and retain harness identity after reload", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-pi-store-"));
  let piScans = 0;
  const collectors = fakeCollectors(async (harness) => {
    if (harness === "pi") {
      piScans++;

      return {
        rows: [row("chatgpt", "pi"), row("opencode-go", "pi")],
        incomplete: false,
      };
    }

    return {
      rows: [
        row(
          (
            {
              codex: "chatgpt",
              claude: "claude",
              opencode: "opencode-go",
              pi: "chatgpt",
            } as const
          )[harness],
          harness,
        ),
      ],
      incomplete: false,
    };
  });
  const store = createHistoryStore(directory, collectors);

  try {
    const [chatgpt, go] = await Promise.all([
      store.read("chatgpt", inDirectory("/workspace"), 7),
      store.read("opencode-go", inDirectory("/workspace"), 7),
    ]);
    assert.equal(piScans, 1);
    assert.equal(chatgpt.workspaceSessionCount, 2);
    assert.equal(go.workspaceSessionCount, 2);
    assert.equal(chatgpt.totals.input, 34);
    assert.deepEqual(
      new Set(chatgpt.sessions.map((s) => s.harness)),
      new Set(["codex", "pi"]),
    );
    assert.ok(chatgpt.sessions.every((s) => s.sessionId === "one"));
    await store.refresh();
    assert.equal(piScans, 2);
    assert.equal(
      (await store.read("chatgpt", inDirectory("/workspace"), 7)).totals.input,
      34,
    );
    await store.close();
    const reloaded = createHistoryStore(directory, collectors);

    try {
      assert.equal(
        (await reloaded.read("chatgpt", inDirectory("/workspace"), 7))
          .sessionCount,
        2,
      );
      assert.equal(piScans, 2);
    } finally {
      await reloaded.close();
    }
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a failed native collector preserves its cached usage while importing fresh Pi usage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-pi-partial-"));
  let failNative = false;
  const store = createHistoryStore(
    directory,
    fakeCollectors(async (harness) => {
      if (harness === "codex" && failNative) {
        throw new Error("private failure");
      }

      if (harness === "codex") {
        return { rows: [row("chatgpt", "codex")], incomplete: false };
      }

      return {
        rows: harness === "pi" && failNative ? [row("chatgpt", "pi")] : [],
        incomplete: false,
      };
    }),
  );

  try {
    await store.refresh();
    failNative = true;
    await store.refresh();
    const result = await store.read("chatgpt", inDirectory("/workspace"), 7);
    assert.equal(result.workspaceSessionCount, 2);
    assert.equal(result.totals.input, 34);
    assert.match(result.warning, /previously stored/);
    assert.ok(!result.warning.includes("private failure"));
    assert.equal(
      (await store.read("opencode-go", inDirectory("/workspace"), 7)).warning,
      "",
    );
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("incomplete Pi scans retain complete sibling files without committing malformed snapshots", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-pi-incomplete-"));
  const timestamp = new Date().toISOString();
  const content = [
    { type: "session", id: "one", cwd: "/workspace", timestamp },
    {
      type: "message",
      id: "entry",
      timestamp,
      message: {
        role: "assistant",
        provider: "openai-codex",
        model: "model-a",
        usage: { input: 10, output: 20 },
      },
    },
  ]
    .map((entry) => JSON.stringify(entry))
    .join("\n");

  try {
    const good = join(directory, "good.jsonl");
    await writeFile(good, content);
    await writeFile(
      join(directory, "bad.jsonl"),
      content +
        "\n" +
        JSON.stringify({
          type: "session",
          id: "",
          cwd: "/workspace",
          timestamp,
        }),
    );
    const result = await collectPi(0, new AbortController().signal, [
      directory,
    ]);
    assert.equal(result.incomplete, true);
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0]?.totals.input, 10);
    assert.equal(result.rows[0]?.harness, "pi");
    assert.equal(await readFile(good, "utf8"), content);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
