import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import type { HistoryRow, HistoryCollection } from "../shared/history";
import { aggregateRows } from "../shared/history-analysis";
import {
  createCodexHistoryParser,
  parseGoHistoryRow,
} from "../shared/history-parsers";
import { readHistoryLines } from "./history-log";

const MAX_LOG_FILES = 5_000;
const MAX_SCAN_BYTES = 512 * 1024 * 1024;
const MAX_LOG_BYTES = 128 * 1024 * 1024;
const MAX_DATABASE_ROWS = 100_000;

interface ScanLimits {
  maxScanBytes?: number;
  modifiedSince?: number;
  groupFile?: (path: string) => string;
}

type HistoryLineParser = ((line: string) => HistoryRow | undefined) & {
  finish?: () => HistoryRow[];
};

type CreateParser = (since: number, seen: Set<string>) => HistoryLineParser;

export function collectCodex(
  roots: string[],
  since: number,
  signal: AbortSignal,
  limits?: ScanLimits,
): Promise<HistoryCollection> {
  return scanJsonl(roots, since, signal, createCodexHistoryParser, limits);
}

export function collectJsonl(
  roots: string[],
  since: number,
  signal: AbortSignal,
  createParser: CreateParser,
  modifiedSince?: number,
  groupFile?: (path: string) => string,
): Promise<HistoryCollection> {
  return scanJsonl(roots, since, signal, createParser, {
    ...(modifiedSince === undefined ? {} : { modifiedSince }),
    ...(groupFile ? { groupFile } : {}),
  });
}

/** Import complete logs newest-first; skipped logs keep their saved snapshots. */
async function scanJsonl(
  roots: string[],
  since: number,
  signal: AbortSignal,
  createParser: CreateParser,
  limits: ScanLimits = {},
): Promise<HistoryCollection> {
  const rows: HistoryRow[] = [];
  const files: { path: string; size: number; modified: number }[] = [];
  let seen = new Set<string>();
  let incomplete = false;
  let byteCount = 0;
  const maxScanBytes = Math.min(
    limits.maxScanBytes ?? MAX_SCAN_BYTES,
    MAX_SCAN_BYTES,
  );

  function checkCancelled() {
    if (signal.aborted) {
      throw new Error("Cancelled");
    }
  }

  async function walk(directory: string, depth: number): Promise<void> {
    checkCancelled();

    if (depth > 5) {
      incomplete = true;

      return;
    }

    let entries;

    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        incomplete = true;
      }

      return;
    }

    const plainFiles = new Set(
      entries.filter((entry) => entry.isFile()).map((entry) => entry.name),
    );
    entries.sort((left, right) => right.name.localeCompare(left.name));

    for (const entry of entries) {
      checkCancelled();

      if (files.length >= MAX_LOG_FILES) {
        incomplete = true;

        return;
      }

      const path = join(directory, entry.name);

      if (entry.isDirectory()) {
        await walk(path, depth + 1);
        continue;
      }

      const compressed = entry.name.endsWith(".jsonl.zst");

      if (
        !entry.isFile() ||
        (!entry.name.endsWith(".jsonl") && !compressed) ||
        (compressed && plainFiles.has(entry.name.slice(0, -4)))
      ) {
        continue;
      }

      try {
        const info = await stat(path);

        if (
          limits.groupFile ||
          info.mtimeMs >= (limits.modifiedSince ?? since)
        ) {
          files.push({ path, size: info.size, modified: info.mtimeMs });
        }
      } catch {
        incomplete = true;
      }
    }
  }

  for (const root of roots) {
    await walk(root, 0);
  }

  files.sort(
    (left, right) =>
      right.modified - left.modified || left.path.localeCompare(right.path),
  );

  // Claude parent and subagent logs share daily session totals. If one changes,
  // reread the whole group so a partial snapshot cannot replace cached totals.
  const groupFile = limits.groupFile;
  const changedGroups = groupFile
    ? new Set(
        files
          .filter((file) => file.modified >= (limits.modifiedSince ?? since))
          .map((file) => groupFile(file.path)),
      )
    : undefined;

  const groups = new Map<string, typeof files>();

  for (const file of files) {
    const group = groupFile?.(file.path) ?? file.path;

    if (groupFile && !changedGroups?.has(group)) {
      continue;
    }

    const members = groups.get(group) ?? [];
    members.push(file);
    groups.set(group, members);
  }

  for (const members of groups.values()) {
    checkCancelled();
    // Commit an entire session group only after every sibling file succeeds.
    // Failed groups cannot overwrite cached totals or poison copy deduplication.
    const groupSeen = new Set(seen);
    const fresh: HistoryRow[] = [];

    try {
      for (const file of members) {
        if (file.size > MAX_LOG_BYTES || file.size > maxScanBytes - byteCount) {
          throw new Error("History scan limit reached");
        }

        const parseLine = createParser(since, groupSeen);

        for await (const line of readHistoryLines(file.path, {
          signal,
          maxBytes: Math.min(MAX_LOG_BYTES, maxScanBytes - byteCount),
          onBytesRead: (size) => {
            byteCount += size;
          },
        })) {
          const row = parseLine(line);

          if (row) {
            fresh.push(row);
          }
        }

        fresh.push(...(parseLine.finish?.() ?? []));
      }

      rows.push(...fresh);
      seen = groupSeen;
    } catch {
      checkCancelled();
      incomplete = true;
    }
  }

  return { rows: aggregateRows(rows), incomplete };
}

export async function collectOpenCode(
  databasePath: string,
  since: number,
  signal: AbortSignal,
  modifiedSince?: number,
): Promise<HistoryCollection> {
  if (signal.aborted) {
    throw new Error("Cancelled");
  }

  try {
    await stat(databasePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { rows: [], incomplete: false };
    }

    throw error;
  }

  // Load lazily so quota buttons still work without node:sqlite support.
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(databasePath, {
    readOnly: true,
    enableForeignKeyConstraints: false,
  });

  try {
    database.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 2000;");

    const tables = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name);

    if (!tables.includes("message") && !tables.includes("session_message")) {
      throw new Error("Unsupported OpenCode database");
    }

    const rows: HistoryRow[] = [];
    const modernSessions = new Set<string>();
    const changes: string[] = [];
    const changedParams: number[] = [];

    if (modifiedSince !== undefined) {
      // Reread the retained snapshot of each updated session, not just its new
      // messages. Replacing a day's aggregate with a partial day loses usage.
      for (const table of ["session_message", "message"] as const) {
        if (!tables.includes(table)) {
          continue;
        }

        const columns = database.prepare(`PRAGMA table_info(${table})`).all();
        const hasUpdated = columns.some(
          (column) => column.name === "time_updated",
        );
        changes.push(
          `SELECT session_id FROM ${table} WHERE time_created >= ?${hasUpdated ? " OR time_updated >= ?" : ""}`,
        );
        changedParams.push(modifiedSince);

        if (hasUpdated) {
          changedParams.push(modifiedSince);
        }
      }
    }

    for (const table of ["session_message", "message"] as const) {
      if (!tables.includes(table)) {
        continue;
      }

      const result = database
        .prepare(goUsageQuery(table, changes.join(" UNION ")))
        .iterate(since, "opencode-go", ...changedParams);
      let rowCount = 0;

      for (const raw of result) {
        if (signal.aborted) {
          throw new Error("Cancelled");
        }

        rowCount += 1;

        if (rowCount > MAX_DATABASE_ROWS) {
          throw new Error("History scan limit reached");
        }

        const row = parseGoHistoryRow(raw);

        if (table === "message" && modernSessions.has(row.sessionId)) {
          continue;
        }

        if (table === "session_message") {
          modernSessions.add(row.sessionId);
        }

        rows.push(row);
      }
    }

    return { rows: aggregateRows(rows), incomplete: false };
  } finally {
    database.close();
  }
}

function goUsageQuery(
  table: "session_message" | "message",
  changedSessions: string,
): string {
  const providerPath =
    table === "session_message" ? "$.model.providerID" : "$.providerID";
  const assistantFilter =
    table === "session_message"
      ? "m.type = 'assistant'"
      : "json_extract(m.data, '$.role') = 'assistant'";
  const modelPath =
    table === "session_message" ? "$.model.modelID" : "$.modelID";

  // SQL structure comes from a fixed allowlist. Data values are bound separately.
  return `
    SELECT
      m.session_id,
      json_extract(m.data, '${modelPath}') AS model,
      s.directory,
      m.time_created,
      json_extract(m.data, '$.tokens.input') AS input,
      json_extract(m.data, '$.tokens.output') AS output,
      coalesce(json_extract(m.data, '$.tokens.reasoning'), 0) AS reasoning,
      coalesce(json_extract(m.data, '$.tokens.cache.read'), 0) AS cached,
      coalesce(json_extract(m.data, '$.tokens.cache.write'), 0) AS written,
      json_extract(m.data, '$.cost') AS cost
    FROM ${table} m
    JOIN session s ON s.id = m.session_id
    WHERE m.time_created >= ?
      AND ${assistantFilter}
      AND json_extract(m.data, '${providerPath}') = ?
      AND json_extract(m.data, '$.tokens') IS NOT NULL
      ${changedSessions ? `AND m.session_id IN (${changedSessions})` : ""}
    LIMIT ${MAX_DATABASE_ROWS + 1}
  `;
}
