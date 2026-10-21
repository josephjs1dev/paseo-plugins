import { stat } from "node:fs/promises";
import type { AttemptUsage } from "../../../shared/symphonies/models";
import { asCount, asInstant, asRecord, asText } from "./jsonl";
import type { HarnessPathOptions } from "./paths";
import { opencodeDatabasePath } from "./paths";
import { addUsage, createUsageTotals, finishUsage } from "./tokens";
import type { UsageReader } from "./usage";

type TableName = "message" | "session_message";
type SqliteDatabase = InstanceType<typeof import("node:sqlite").DatabaseSync>;

function tableNames(database: SqliteDatabase): Set<string> {
  return new Set(
    database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => asText(row.name))
      .filter((name): name is string => name !== undefined),
  );
}

function tableColumns(database: SqliteDatabase, table: TableName): Set<string> {
  return new Set(
    database
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((row) => asText(row.name))
      .filter((name): name is string => name !== undefined),
  );
}

function hasSession(
  database: SqliteDatabase,
  table: TableName,
  sessionId: string,
): boolean {
  return (
    database
      .prepare(`SELECT 1 AS present FROM ${table} WHERE session_id = ? LIMIT 1`)
      .get(sessionId) !== undefined
  );
}

function parseData(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "string") {
    return asRecord(value);
  }

  try {
    return asRecord(JSON.parse(value) as unknown);
  } catch {
    return undefined;
  }
}

function isAssistant(
  table: TableName,
  row: Record<string, unknown>,
  data: Record<string, unknown>,
): boolean {
  if (table === "session_message") {
    const type = asText(row.type);

    if (type !== undefined) {
      return type === "assistant";
    }
  }

  return data.role === "assistant";
}

/**
 * Reads OpenCode's SQLite messages for one session, across every model
 * provider. The modern `session_message` table wins over the migrated legacy
 * `message` table so one row is never counted twice.
 */
export function createOpenCodeReader(
  options: HarnessPathOptions = {},
): UsageReader {
  return {
    provider: "opencode",
    async read(
      sessionId: string,
      from: number,
      to: number,
    ): Promise<AttemptUsage | null> {
      let sqlite;

      try {
        // A runtime without node:sqlite disables only OpenCode usage.
        sqlite = await import("node:sqlite");
      } catch {
        return null;
      }

      const databasePath = opencodeDatabasePath(options);

      try {
        const info = await stat(databasePath);

        if (!info.isFile()) {
          return null;
        }
      } catch {
        return null;
      }

      const { DatabaseSync } = sqlite;
      let database: SqliteDatabase | undefined;
      const totals = createUsageTotals();

      try {
        database = new DatabaseSync(databasePath, {
          readOnly: true,
          enableForeignKeyConstraints: false,
        });
        database.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 2000;");

        const tables = tableNames(database);
        let selected: TableName | undefined;

        for (const table of ["session_message", "message"] as const) {
          if (!tables.has(table)) {
            continue;
          }

          const columns = tableColumns(database, table);

          if (
            !columns.has("session_id") ||
            !columns.has("time_created") ||
            !columns.has("data")
          ) {
            continue;
          }

          if (hasSession(database, table, sessionId)) {
            selected = table;
            break;
          }
        }

        if (!selected) {
          return null;
        }

        const columns = tableColumns(database, selected);
        const hasType = selected === "session_message" && columns.has("type");
        const rows = database
          .prepare(
            `SELECT ${hasType ? "type, " : ""}time_created, data FROM ${selected} WHERE session_id = ?`,
          )
          .all(sessionId);

        for (const row of rows) {
          const data = parseData(row.data);

          if (!data || !isAssistant(selected, row, data)) {
            continue;
          }

          const tokens = asRecord(data.tokens);
          const timestamp = asInstant(row.time_created);

          if (!tokens || timestamp === undefined) {
            continue;
          }

          if (timestamp < from || timestamp > to) {
            continue;
          }

          const cache = asRecord(tokens.cache);
          const input = asCount(tokens.input);
          const cached = asCount(cache?.read);
          const output = asCount(tokens.output);

          addUsage(totals, {
            ...(input === undefined
              ? {}
              : { input: input + (asCount(cache?.write) ?? 0) }),
            ...(cached === undefined ? {} : { cached }),
            ...(output === undefined
              ? {}
              : { output: output + (asCount(tokens.reasoning) ?? 0) }),
          });
        }

        return finishUsage(totals);
      } catch {
        return null;
      } finally {
        try {
          database?.close();
        } catch {
          // A failed close must not replace the usage result.
        }
      }
    },
  };
}
