import {
  addTotals,
  emptyTotals,
  type HistoryRow,
  type HistoryScope,
  type Totals,
} from "./history";
import type { Provider } from "./providers";
import type { Harness } from "./harnesses";
import { sessionKey } from "./history-display";

interface SessionSummary {
  harness: Harness;
  sessionId: string;
  cwd: string;
  lastAt: string;
  totals: Totals;
  models: Map<string | null, Totals>;
}

interface SummaryOptions {
  provider: Provider;
  firstDay: string;
  lastDay?: string;
  sessionOffset?: number;
  scope?: HistoryScope;
  /** Whether a row belongs to the selected workspace. */
  matchesWorkspace: (row: HistoryRow) => boolean;
}

export function aggregateRows(rows: readonly HistoryRow[]): HistoryRow[] {
  const grouped = new Map<string, HistoryRow>();

  for (const row of rows) {
    const key = JSON.stringify([
      row.provider,
      row.harness,
      row.sessionId,
      row.day,
      row.model ?? null,
    ]);
    const previous = grouped.get(key);

    if (!previous) {
      grouped.set(key, row);
      continue;
    }

    grouped.set(key, {
      ...row,
      cwd: previous.lastAt > row.lastAt ? previous.cwd : row.cwd,
      lastAt: latestTimestamp(previous.lastAt, row.lastAt),
      totals: addTotals(previous.totals, row.totals),
    });
  }

  return [...grouped.values()];
}

/** Fresh daily totals replace earlier snapshots rather than being added again. */
export function mergeHistoryRows(
  previous: readonly HistoryRow[],
  fresh: readonly HistoryRow[],
  since: number,
): HistoryRow[] {
  const merged = new Map<string, HistoryRow>();
  const refreshedDays = new Set(
    fresh.map((row) =>
      JSON.stringify([row.provider, row.harness, row.sessionId, row.day]),
    ),
  );

  for (const row of previous) {
    // Replace the entire day's snapshot when models are added or re-attributed.
    // Otherwise legacy unknown-model rows would double-count freshly parsed rows.
    if (
      Date.parse(row.lastAt) < since ||
      refreshedDays.has(
        JSON.stringify([row.provider, row.harness, row.sessionId, row.day]),
      )
    ) {
      continue;
    }

    merged.set(
      JSON.stringify([
        row.provider,
        row.harness,
        row.sessionId,
        row.day,
        row.model ?? null,
      ]),
      row,
    );
  }

  for (const row of fresh) {
    if (Date.parse(row.lastAt) < since) {
      continue;
    }

    const key = JSON.stringify([
      row.provider,
      row.harness,
      row.sessionId,
      row.day,
      row.model ?? null,
    ]);
    merged.set(key, row);
  }

  return [...merged.values()];
}

export function summarizeHistory(
  rows: readonly HistoryRow[],
  options: SummaryOptions,
) {
  const daily = new Map<string, Totals>();
  const workspaceDaily = new Map<string, Totals>();
  const workspace = createScopeSummary();
  const selected = options.scope === "host" ? createScopeSummary() : workspace;
  let totals = emptyTotals();
  let workspaceTotals = emptyTotals();

  for (const row of rows) {
    if (
      row.provider !== options.provider ||
      row.day < options.firstDay ||
      (options.lastDay && row.day > options.lastDay)
    ) {
      continue;
    }

    totals = addTotals(totals, row.totals);
    daily.set(
      row.day,
      addTotals(daily.get(row.day) ?? emptyTotals(), row.totals),
    );

    if (options.scope === "host") {
      addScopeRow(selected, row);
    }

    if (options.matchesWorkspace(row)) {
      workspaceTotals = addTotals(workspaceTotals, row.totals);
      workspaceDaily.set(
        row.day,
        addTotals(workspaceDaily.get(row.day) ?? emptyTotals(), row.totals),
      );
      addScopeRow(workspace, row);
    }
  }

  return {
    totals,
    workspaceTotals,
    workspaceSessionCount: workspace.sessions.size,
    workspaceModels: summarizeModels(workspace),
    sessionCount: selected.sessions.size,
    models: summarizeModels(selected),
    workspaceDaily: [...workspaceDaily]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([day, totals]) => ({ day, totals })),
    daily: [...daily]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([day, totals]) => ({ day, totals })),
    sessions: [...selected.sessions.values()]
      .sort(
        (left, right) =>
          right.lastAt.localeCompare(left.lastAt) ||
          sessionKey(left).localeCompare(sessionKey(right)),
      )
      .slice(options.sessionOffset ?? 0, (options.sessionOffset ?? 0) + 20)
      .map((session) => ({
        ...session,
        models: [...session.models].map(([model, totals]) => ({
          model,
          totals,
        })),
      })),
  };
}

function latestTimestamp(left: string, right: string): string {
  return left > right ? left : right;
}

function createScopeSummary() {
  return {
    sessions: new Map<string, SessionSummary>(),
    models: new Map<string | null, { totals: Totals; sessions: Set<string> }>(),
  };
}

function addScopeRow(
  summary: ReturnType<typeof createScopeSummary>,
  row: HistoryRow,
) {
  const previous = summary.sessions.get(sessionKey(row));
  const model = row.model ?? null;
  const sessionModels = previous?.models ?? new Map<string | null, Totals>();
  sessionModels.set(
    model,
    addTotals(sessionModels.get(model) ?? emptyTotals(), row.totals),
  );
  const modelSummary = summary.models.get(model) ?? {
    totals: emptyTotals(),
    sessions: new Set<string>(),
  };
  modelSummary.totals = addTotals(modelSummary.totals, row.totals);
  modelSummary.sessions.add(sessionKey(row));
  summary.models.set(model, modelSummary);
  summary.sessions.set(sessionKey(row), {
    harness: row.harness,
    sessionId: row.sessionId,
    cwd: previous && previous.lastAt > row.lastAt ? previous.cwd : row.cwd,
    lastAt: latestTimestamp(previous?.lastAt ?? row.lastAt, row.lastAt),
    totals: addTotals(previous?.totals ?? emptyTotals(), row.totals),
    models: sessionModels,
  });
}

function summarizeModels(summary: ReturnType<typeof createScopeSummary>) {
  return [...summary.models]
    .map(([model, entry]) => ({
      model,
      totals: entry.totals,
      sessionCount: entry.sessions.size,
    }))
    .sort(
      (left, right) =>
        right.totals.input +
        right.totals.output -
        left.totals.input -
        left.totals.output,
    );
}
