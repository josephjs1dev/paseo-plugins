import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  collectUsageHistory,
  quotaCapability,
  usageCollectors,
} from "../../server/collectors";
import { createHistoryStore } from "../../server/history";
import { readSavedHistory } from "../../server/history-files";
import { harnessIds, type Harness } from "../../shared/harnesses";
import { historyCollectionSchema, type HistoryRow } from "../../shared/history";
import { readUsage } from "../../shared/usage";
import { fakeCollectors } from "../history-fixtures";

const NOW = Date.parse("2026-10-03T12:00:00Z");
const DAY = 86_400_000;
const iso = (time: number) => new Date(time).toISOString();
const row = (
  harness: Harness,
  provider: HistoryRow["provider"],
): HistoryRow => ({
  provider,
  harness,
  sessionId: "one",
  cwd: "/workspace",
  model: "gpt-6.1-sol",
  day: iso(NOW).slice(0, 10),
  lastAt: iso(NOW),
  totals: { input: 10, cached: 0, output: 20, reasoning: 0, cost: null },
});

test("all registered harnesses return the common schema without native installations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-collectors-"));
  const overrides = {
    CODEX_HOME: directory,
    CLAUDE_USAGE_PROJECTS_DIR: directory,
    PI_USAGE_SESSION_DIR: directory,
    OPENCODE_USAGE_DB: join(directory, "missing.db"),
  };
  const saved = new Map(
    Object.keys(overrides).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, overrides);

  try {
    for (const harness of harnessIds) {
      const result = await collectUsageHistory(usageCollectors[harness], {
        since: 0,
        signal: new AbortController().signal,
      });
      assert.deepEqual(result, { rows: [], incomplete: false });
      assert.equal(historyCollectionSchema.safeParse(result).success, true);
      assert.equal(usageCollectors[harness].harness, harness);
    }

    assert.equal(quotaCapability("chatgpt"), usageCollectors.codex.quota);
    assert.equal(
      quotaCapability("opencode-go"),
      usageCollectors.opencode.quota,
    );
    assert.equal(usageCollectors.pi.quota, undefined);
    const cancelled = new AbortController();
    cancelled.abort();

    for (const collector of Object.values(usageCollectors)) {
      await assert.rejects(
        collectUsageHistory(collector, { since: 0, signal: cancelled.signal }),
        /Cancelled/,
      );
    }

    await writeFile(overrides.OPENCODE_USAGE_DB, "invalid SQLite data");
    assert.deepEqual(
      await collectUsageHistory(usageCollectors.opencode, {
        since: 0,
        signal: new AbortController().signal,
      }),
      { rows: [], incomplete: true },
    );
    assert.equal(
      readUsage.input.safeParse({ provider: "codex" }).success,
      false,
    );
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }

    await rm(directory, { recursive: true, force: true });
  }
});

test("collector output validation rejects invalid tokens and undeclared attribution", async () => {
  for (const invalid of [
    row("pi", "chatgpt"),
    row("codex", "opencode-go"),
    {
      ...row("codex", "chatgpt"),
      totals: { ...row("codex", "chatgpt").totals, input: -1 },
    },
  ]) {
    await assert.rejects(
      collectUsageHistory(
        {
          ...usageCollectors.codex,
          collectHistory: async () => ({ rows: [invalid], incomplete: false }),
        },
        { since: 0, signal: new AbortController().signal },
      ),
    );
  }
});

test("Pi failure warns both providers while native collectors advance independently and recovery retries its gap", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "paseo-collector-checkpoints-"),
  );
  let clock = NOW;
  let failPi = false;
  const windows = new Map<Harness, (number | undefined)[]>();
  const store = createHistoryStore(
    directory,
    fakeCollectors(async (harness, _since, _signal, modifiedSince) => {
      const recorded = windows.get(harness) ?? [];
      recorded.push(modifiedSince);
      windows.set(harness, recorded);

      if (harness === "pi" && failPi) {
        throw new Error("private failure");
      }

      const rows =
        harness === "pi"
          ? [row("pi", "chatgpt"), row("pi", "opencode-go")]
          : [
              row(
                harness,
                (
                  {
                    codex: "chatgpt",
                    claude: "claude",
                    opencode: "opencode-go",
                    pi: "chatgpt",
                  } as const
                )[harness],
              ),
            ];

      return { rows, incomplete: false };
    }),
    () => clock,
  );

  try {
    await store.refresh();
    failPi = true;
    clock += 3 * DAY;
    await store.refresh();
    const failed = await readSavedHistory(directory);
    assert.equal(failed?.collectors.pi?.updatedThrough, iso(NOW));
    assert.equal(failed?.collectors.codex?.updatedThrough, iso(clock));
    assert.equal(failed?.collectors.opencode?.updatedThrough, iso(clock));

    for (const provider of ["chatgpt", "opencode-go"] as const) {
      const result = await store.read(provider, "/workspace", 7);
      assert.equal(result.sessionCount, 2);
      assert.match(result.warning, /previously stored/);
      assert.ok(!result.warning.includes("private"));
    }

    failPi = false;
    clock += DAY;
    await store.refresh();
    assert.equal(windows.get("pi")?.[2], NOW - 1000);
    assert.equal(windows.get("codex")?.[2], clock - DAY - 1000);
    const recovered = await readSavedHistory(directory);
    assert.equal(recovered?.collectors.pi?.updatedThrough, iso(clock));
    assert.equal((await store.read("chatgpt", "/workspace", 7)).warning, "");
    assert.equal(
      (await store.read("opencode-go", "/workspace", 7)).warning,
      "",
    );
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("legacy cache migration preserves source-less records, strips one Pi prefix, and starts full harness scans", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-collector-migration-"));
  const path = join(directory, "history.json");
  const legacy = {
    version: 1,
    scannedAt: iso(NOW),
    updatedThrough: iso(NOW),
    warningProviders: ["opencode-go"],
    backfillWarnings: { codex: iso(NOW - DAY) },
    rows: [
      row("codex", "chatgpt"),
      row("pi", "chatgpt"),
      row("opencode", "opencode-go"),
      { ...row("pi", "opencode-go"), sessionId: "pi:source" },
    ].map(({ harness, ...record }) => ({
      ...record,
      provider: record.provider === "chatgpt" ? "codex" : record.provider,
      sessionId: harness === "pi" ? `pi:${record.sessionId}` : record.sessionId,
    })),
  };
  const content = JSON.stringify(legacy);
  await writeFile(path, content);
  const windows: {
    harness: Harness;
    since: number;
    modified: number | undefined;
  }[] = [];
  const store = createHistoryStore(
    directory,
    fakeCollectors(async (harness, since, _signal, modified) => {
      windows.push({ harness, since, modified });

      return { rows: [], incomplete: false };
    }),
    () => NOW,
  );

  try {
    const migrated = await readSavedHistory(directory);
    assert.equal(await readFile(path, "utf8"), content);
    assert.equal(migrated?.version, 2);
    assert.equal(migrated?.rows.length, 4);
    assert.equal(migrated?.rows[1]?.sessionId, "one");
    assert.equal(migrated?.rows[3]?.sessionId, "pi:source");
    assert.equal(migrated?.collectors.pi?.incomplete, true);
    assert.equal(migrated?.collectors.codex?.backfillWarningAt, iso(NOW - DAY));
    assert.ok(
      harnessIds.every(
        (harness) =>
          migrated?.collectors[harness]?.updatedThrough === undefined,
      ),
    );
    await store.refresh();
    assert.equal(windows.length, harnessIds.length);
    assert.ok(
      windows.every(
        (window) =>
          window.since === NOW - 90 * DAY && window.modified === window.since,
      ),
    );
    const saved = await readSavedHistory(directory);
    const sortRows = (rows: HistoryRow[] = []) =>
      [...rows].sort(
        (a, b) =>
          a.harness.localeCompare(b.harness) ||
          a.provider.localeCompare(b.provider) ||
          a.sessionId.localeCompare(b.sessionId),
      );
    assert.deepEqual(sortRows(saved?.rows), sortRows(migrated?.rows));
    assert.equal(
      (await store.read("chatgpt", "/workspace", 7)).sessionCount,
      2,
    );
    assert.equal(
      (await store.read("opencode-go", "/workspace", 7)).sessionCount,
      2,
    );
    assert.ok(
      harnessIds.every(
        (harness) => saved?.collectors[harness]?.updatedThrough === iso(NOW),
      ),
    );
    await store.close();
    const reloaded = createHistoryStore(
      directory,
      fakeCollectors(async () => {
        throw new Error("must use cache");
      }),
      () => NOW,
    );

    try {
      assert.equal(
        (await reloaded.read("chatgpt", "/workspace", 7)).sessionCount,
        2,
      );
    } finally {
      await reloaded.close();
    }
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("invalid legacy and v2 schemas remain untouched", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "paseo-collector-invalid-cache-"),
  );

  try {
    for (const invalid of [
      {
        version: 1,
        scannedAt: iso(NOW),
        rows: [{ ...row("codex", "chatgpt"), provider: "unknown" }],
      },
      {
        version: 2,
        scannedAt: iso(NOW),
        rows: [row("codex", "chatgpt")],
        collectors: { unknown: { incomplete: false } },
      },
    ]) {
      const path = join(directory, "history.json"),
        content = JSON.stringify(invalid);
      await writeFile(path, content);
      await assert.rejects(readSavedHistory(directory), /not overwritten/);
      assert.equal(await readFile(path, "utf8"), content);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
