import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";

import type { HistoryRow } from "../shared/history";
import { aggregateRows } from "../shared/history-analysis";
import {
  createCodexHistoryParser,
  parseGoHistoryRow,
} from "../shared/history-parsers";

const MAX_LOG_FILES = 5_000;
const MAX_SCAN_BYTES = 512 * 1024 * 1024;
const MAX_LOG_BYTES = 128 * 1024 * 1024;
const MAX_DATABASE_ROWS = 100_000;

export async function collectCodex(
  roots: string[],
  since: number,
  signal: AbortSignal,
): Promise<HistoryRow[]> {
  return collectJsonl(roots, since, signal, createCodexHistoryParser);
}

export async function collectJsonl(
  roots: string[],
  since: number,
  signal: AbortSignal,
  createParser: (
    since: number,
    seen: Set<string>,
  ) => (line: string) => HistoryRow | undefined,
): Promise<HistoryRow[]> {
  const rows: HistoryRow[] = [];
  const seen = new Set<string>();
  let fileCount = 0;
  let byteCount = 0;

  async function walk(directory: string, depth: number): Promise<void> {
    if (depth > 5) {
      return;
    }

    let entries;

    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }

      throw error;
    }

    for (const entry of entries) {
      if (signal.aborted) {
        throw new Error("Cancelled");
      }

      const path = join(directory, entry.name);

      if (entry.isDirectory()) {
        await walk(path, depth + 1);
        continue;
      }

      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
        continue;
      }

      const info = await stat(path);

      if (info.mtimeMs < since) {
        continue;
      }

      fileCount += 1;
      byteCount += info.size;

      if (
        fileCount > MAX_LOG_FILES ||
        byteCount > MAX_SCAN_BYTES ||
        info.size > MAX_LOG_BYTES
      ) {
        throw new Error("History scan limit reached");
      }

      const parseLine = createParser(since, seen);
      const stream = createReadStream(path, { encoding: "utf8", signal });
      const lines = createInterface({ input: stream, crlfDelay: Infinity });

      try {
        for await (const line of lines) {
          const row = parseLine(line);

          if (row) {
            rows.push(row);
          }
        }
      } finally {
        lines.close();
        stream.destroy();
      }
    }
  }

  for (const root of roots) {
    await walk(root, 0);
  }

  return aggregateRows(rows);
}

export async function collectGo(
  databasePath: string,
  since: number,
  signal: AbortSignal,
): Promise<HistoryRow[]> {
  try {
    await stat(databasePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
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

    for (const table of ["session_message", "message"] as const) {
      if (!tables.includes(table)) {
        continue;
      }

      const result = database
        .prepare(goUsageQuery(table))
        .iterate(since, "opencode-go");
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

    return aggregateRows(rows);
  } finally {
    database.close();
  }
}

function goUsageQuery(table: "session_message" | "message"): string {
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
    LIMIT ${MAX_DATABASE_ROWS + 1}
  `;
}
