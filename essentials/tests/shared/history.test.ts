import assert from "node:assert/strict";
import { test } from "node:test";

import {
  addTotals,
  emptyTotals,
  readHistory,
  type HistoryRow,
} from "../../shared/history";
import {
  aggregateRows,
  mergeHistoryRows,
  summarizeHistory,
} from "../../shared/history-analysis";

const row: HistoryRow = {
  provider: "codex",
  sessionId: "session-one",
  cwd: "/workspace",
  day: "2026-09-25",
  lastAt: "2026-09-25T10:00:00.000Z",
  totals: { input: 100, cached: 10, output: 20, reasoning: 5, cost: null },
};

test("rescanning replaces daily snapshots while retaining other sessions", () => {
  const otherSession = { ...row, sessionId: "session-two" };
  const expired = {
    ...row,
    sessionId: "expired",
    lastAt: "2026-01-01T00:00:00.000Z",
  };
  const fresh = { ...row, totals: { ...row.totals, input: 150 } };

  const result = mergeHistoryRows(
    [row, otherSession, expired],
    [fresh],
    Date.parse("2026-09-01"),
  );

  assert.equal(result.length, 2);
  assert.equal(
    result.find((entry) => entry.sessionId === row.sessionId)?.totals.input,
    150,
  );
});

test("daily aggregation preserves unknown cost and the newest observation", () => {
  const later = {
    ...row,
    cwd: "/latest-directory",
    lastAt: "2026-09-25T11:00:00.000Z",
    totals: { ...row.totals, cost: 1 },
  };
  const [combined] = aggregateRows([later, row]);

  assert.equal(combined?.totals.input, 200);
  assert.equal(combined?.totals.cost, null);
  assert.equal(combined?.lastAt, later.lastAt);
  assert.equal(combined?.cwd, later.cwd);
});

test("summaries filter providers and dates while matching workspace sessions separately", () => {
  const rows: HistoryRow[] = [
    row,
    { ...row, sessionId: "elsewhere", cwd: "/other" },
    { ...row, provider: "opencode-go" },
    { ...row, day: "2026-09-01" },
  ];

  const summary = summarizeHistory(rows, {
    provider: "codex",
    firstDay: "2026-09-20",
    matchesWorkspace: (directory) => directory === "/workspace",
  });

  assert.equal(summary.totals.input, 200);
  assert.equal(summary.daily.length, 1);
  assert.equal(summary.sessions.length, 1);
  assert.equal(summary.sessions[0]?.totals.input, 100);
  assert.equal(summary.workspaceTotals.input, 100);
  assert.equal(summary.workspaceDaily[0]?.totals.input, 100);
  assert.equal(summary.workspaceSessionCount, 1);
});

test("workspace costs include every matching session before the recent-list limit", () => {
  const rows = Array.from({ length: 25 }, (_, index) => ({
    ...row,
    sessionId: `session-${index}`,
    totals: { ...row.totals, cost: 0.25 },
  }));
  rows.push({
    ...row,
    sessionId: "elsewhere",
    cwd: "/other",
    totals: { ...row.totals, cost: 100 },
  });
  const summary = summarizeHistory(rows, {
    provider: "codex",
    firstDay: "2026-09-20",
    matchesWorkspace: (directory) => directory === "/workspace",
  });

  assert.equal(summary.sessions.length, 20);
  assert.equal(summary.workspaceSessionCount, 25);
  assert.equal(summary.workspaceTotals.cost, 6.25);
  assert.equal(summary.workspaceDaily[0]?.totals.cost, 6.25);
  assert.equal(summary.totals.cost, 106.25);
});

test("missing workspace costs remain unknown while a different workspace stays complete", () => {
  const summary = summarizeHistory(
    [
      row,
      { ...row, sessionId: "known", totals: { ...row.totals, cost: 2 } },
      { ...row, cwd: "/other", totals: { ...row.totals, cost: 5 } },
    ],
    {
      provider: "codex",
      firstDay: "2026-09-20",
      matchesWorkspace: (directory) => directory === "/other",
    },
  );

  assert.equal(summary.totals.cost, null);
  assert.equal(summary.workspaceTotals.cost, 5);
  assert.equal(summary.workspaceSessionCount, 1);
});

test("model breakdowns preserve switching sessions and pagination does not truncate totals", () => {
  const rows = Array.from({ length: 25 }, (_, index) => ({
    ...row,
    sessionId: `s-${index}`,
    model: "model-a",
  }));
  rows.push({ ...row, sessionId: "s-0", model: "model-b" });
  const summary = summarizeHistory(rows, {
    provider: "codex",
    firstDay: "2026-09-20",
    sessionOffset: 20,
    matchesWorkspace: () => true,
  });
  assert.equal(summary.workspaceSessionCount, 25);
  assert.equal(summary.sessions.length, 5);
  assert.equal(summary.workspaceTotals.input, 2600);
  assert.equal(
    summary.workspaceModels.find((entry) => entry.model === "model-a")
      ?.sessionCount,
    25,
  );
  assert.equal(
    summary.workspaceModels.find((entry) => entry.model === "model-b")?.totals
      .input,
    100,
  );
  const firstPage = summarizeHistory(rows, {
    provider: "codex",
    firstDay: "2026-09-20",
    matchesWorkspace: () => true,
  });
  assert.equal(firstPage.sessions[0]?.models.length, 2);
  assert.equal(firstPage.sessions[0]?.totals.input, 200);
});

test("model-aware daily snapshots replace legacy rows without double-counting", () => {
  const fresh = aggregateRows([
    { ...row, model: "model-a", totals: { ...row.totals, input: 40 } },
    { ...row, model: "model-b", totals: { ...row.totals, input: 60 } },
  ]);
  assert.equal(fresh.length, 2);
  const merged = mergeHistoryRows([row], fresh, 0);
  assert.equal(merged.length, 2);
  assert.equal(
    merged.reduce((sum, entry) => sum + entry.totals.input, 0),
    100,
  );
  assert.deepEqual(mergeHistoryRows(merged, fresh, 0), merged);
  assert.deepEqual(mergeHistoryRows(merged, [], 0), merged);
});

for (const provider of ["codex", "opencode-go"] as const) {
  test(`${provider}: host scope includes native and Pi sessions when the owning workspace is empty`, () => {
    const rows: HistoryRow[] = Array.from({ length: 25 }, (_, index) => ({
      ...row,
      provider,
      sessionId:
        (index % 2 ? "pi:" : "") + `s-${String(index).padStart(2, "0")}`,
      cwd: index % 2 ? "/other/worktree" : "/other/project",
      model: "model-a",
    }));
    const switching = rows[0]!;
    rows.push({
      ...switching,
      model: "model-b",
      cwd: "/latest",
      lastAt: "2026-09-25T11:00:00.000Z",
    });
    rows.push({
      ...switching,
      model: null,
      lastAt: "2026-09-25T09:00:00.000Z",
    });
    const options = {
      provider,
      firstDay: "2026-09-20",
      lastDay: "2026-09-25",
      matchesWorkspace: (cwd: string) => cwd === "/workspace",
    };
    const excluded: HistoryRow[] = [
      {
        ...switching,
        provider: provider === "codex" ? "opencode-go" : "codex",
      },
      { ...switching, sessionId: "expired", day: "2026-09-01" },
      { ...switching, sessionId: "future", day: "2026-09-26" },
    ];
    const workspace = summarizeHistory([...rows, ...excluded], options);
    assert.equal(workspace.sessionCount, 0);
    assert.deepEqual(workspace.sessions, []);
    assert.deepEqual(workspace.models, []);
    const host = summarizeHistory([...rows, ...excluded], {
      ...options,
      scope: "host",
    });
    const second = summarizeHistory([...rows, ...excluded], {
      ...options,
      scope: "host",
      sessionOffset: 20,
    });
    assert.equal(host.sessionCount, 25);
    assert.equal(host.workspaceSessionCount, 0);
    assert.deepEqual(host.workspaceModels, []);
    assert.deepEqual(host.workspaceTotals, emptyTotals());
    assert.equal(host.sessions.length, 20);
    assert.equal(second.sessions.length, 5);
    assert.deepEqual(second.models, host.models);
    assert.equal(second.sessionCount, 25);
    const sessions = [...host.sessions, ...second.sessions];
    assert.equal(
      new Set(sessions.map((session) => session.sessionId)).size,
      25,
    );
    assert.deepEqual(
      sessions.map((session) => session.sessionId),
      [
        switching.sessionId,
        ...rows
          .slice(1, 25)
          .map((entry) => entry.sessionId)
          .sort(),
      ],
    );
    assert.deepEqual(
      sessions.reduce(
        (totals, entry) => addTotals(totals, entry.totals),
        emptyTotals(),
      ),
      host.totals,
    );
    assert.deepEqual(
      host.models.reduce(
        (totals, entry) => addTotals(totals, entry.totals),
        emptyTotals(),
      ),
      host.totals,
    );
    assert.equal(host.totals.input, 2700);
    assert.equal(host.totals.cost, null);
    assert.equal(
      host.models.find((entry) => entry.model === "model-a")?.sessionCount,
      25,
    );
    assert.equal(
      host.models.find((entry) => entry.model === "model-b")?.sessionCount,
      1,
    );
    assert.equal(
      host.models.find((entry) => entry.model === null)?.sessionCount,
      1,
    );
    assert.equal(host.sessions[0]?.models.length, 3);
    assert.equal(host.sessions[0]?.cwd, "/latest");
    assert.ok(sessions.some((session) => session.cwd === "/other/worktree"));
    assert.ok(sessions.some((session) => session.cwd === "/other/project"));
    const matched = summarizeHistory(rows, {
      ...options,
      scope: "host",
      matchesWorkspace: (cwd) => cwd === "/other/project",
    });
    const defaultScope = summarizeHistory(rows, {
      ...options,
      matchesWorkspace: (cwd) => cwd === "/other/project",
    });
    assert.deepEqual(defaultScope.models, matched.workspaceModels);
    assert.equal(defaultScope.sessionCount, matched.workspaceSessionCount);
    assert.deepEqual(
      defaultScope.models.reduce(
        (totals, entry) => addTotals(totals, entry.totals),
        emptyTotals(),
      ),
      matched.workspaceTotals,
    );
    assert.deepEqual(
      defaultScope.sessions.reduce(
        (totals, entry) => addTotals(totals, entry.totals),
        emptyTotals(),
      ),
      matched.workspaceTotals,
    );
  });
}

test("history RPC defaults scope and validates scoped responses and bounded directories", () => {
  const input = { provider: "codex", workspaceId: "workspace", days: 7 };
  assert.equal(readHistory.input.parse(input).scope, "workspace");
  assert.equal(
    readHistory.input.parse({ ...input, scope: "host" }).scope,
    "host",
  );
  assert.equal(
    readHistory.input.safeParse({ ...input, scope: "all" }).success,
    false,
  );
  const response = {
    ...summarizeHistory([row], {
      provider: "codex",
      firstDay: row.day,
      scope: "host",
      matchesWorkspace: () => false,
    }),
    scannedAt: row.lastAt,
    periodEnd: row.day,
    warning: "",
  };
  assert.equal(readHistory.output.safeParse(response).success, true);

  for (const sessionCount of [-1, 0.5]) {
    assert.equal(
      readHistory.output.safeParse({ ...response, sessionCount }).success,
      false,
    );
  }

  assert.equal(
    readHistory.output.safeParse({
      ...response,
      sessions: [{ ...response.sessions[0], cwd: "x".repeat(4097) }],
    }).success,
    false,
  );
  assert.equal(
    readHistory.output.safeParse({
      ...response,
      models: undefined,
      sessionCount: undefined,
    }).success,
    false,
  );
});
