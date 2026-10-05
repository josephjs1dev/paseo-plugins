import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import { historyRowSchema } from "../shared/history";
import { harnessIds, harnessSchema, type Harness } from "../shared/harnesses";

const MAX_HISTORY_BYTES = 32 * 1024 * 1024;
const collectorStateSchema = z.object({
  updatedThrough: z.string().datetime().optional(),
  incomplete: z.boolean(),
  backfillWarningAt: z.string().datetime().optional(),
});
export type CollectorState = z.infer<typeof collectorStateSchema>;
const savedHistorySchema = z.object({
  version: z.literal(2),
  scannedAt: z.string().datetime(),
  rows: z.array(historyRowSchema).max(100_000),
  collectors: z.partialRecord(harnessSchema, collectorStateSchema),
});
export type SavedHistory = z.infer<typeof savedHistorySchema>;

const legacyProviderSchema = z.enum(["codex", "opencode-go"]);
const legacyHistorySchema = z.object({
  version: z.literal(1),
  scannedAt: z.string().datetime(),
  rows: z
    .array(
      historyRowSchema
        .omit({ harness: true })
        .extend({ provider: legacyProviderSchema }),
    )
    .max(100_000),
  updatedThrough: z.string().datetime().optional(),
  warningProviders: z.array(legacyProviderSchema).max(2).optional(),
  backfillWarnings: z
    .partialRecord(legacyProviderSchema, z.string().datetime())
    .optional(),
});

const legacyProvidersByHarness = {
  codex: ["codex"],
  pi: ["codex", "opencode-go"],
  opencode: ["opencode-go"],
  claude: [],
} as const;

function migrateHistory(
  legacy: z.infer<typeof legacyHistorySchema>,
): SavedHistory {
  const migrated: SavedHistory = {
    version: 2,
    scannedAt: legacy.scannedAt,
    collectors: {},
    rows: legacy.rows.map((row) => {
      const isPi = row.sessionId.startsWith("pi:");
      let harness: Harness = row.provider === "codex" ? "codex" : "opencode";

      if (isPi) {
        harness = "pi";
      }

      return {
        ...row,
        provider: row.provider === "codex" ? "chatgpt" : "opencode-go",
        harness,
        sessionId: isPi ? row.sessionId.slice(3) : row.sessionId,
      };
    }),
  };

  for (const harness of harnessIds) {
    const providers = legacyProvidersByHarness[harness];
    const incomplete = providers.some((provider) =>
      legacy.warningProviders?.includes(provider),
    );
    const backfillWarnings = providers.flatMap((provider) => {
      const timestamp = legacy.backfillWarnings?.[provider];

      return timestamp ? [timestamp] : [];
    });
    migrated.collectors[harness] = {
      incomplete,
      ...(incomplete || backfillWarnings.length > 0
        ? { backfillWarningAt: backfillWarnings.sort()[0] ?? legacy.scannedAt }
        : {}),
    };
  }

  return migrated;
}

export async function readSavedHistory(
  directory: string,
): Promise<SavedHistory | undefined> {
  const path = join(directory, "history.json");

  try {
    const info = await lstat(path);

    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error("Invalid history file");
    }

    if (info.size > MAX_HISTORY_BYTES) {
      throw new Error("History file too large");
    }

    const contents = await readFile(path, "utf8");

    const saved = z
      .union([savedHistorySchema, legacyHistorySchema])
      .parse(JSON.parse(contents));

    return saved.version === 1 ? migrateHistory(saved) : saved;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }

    throw new Error(
      "Stored history could not be read; it was not overwritten.",
    );
  }
}

export async function writeSavedHistory(
  directory: string,
  history: SavedHistory,
  signal?: AbortSignal,
): Promise<void> {
  const validated = savedHistorySchema.parse(history);
  const path = join(directory, "history.json");
  const temporaryPath = join(
    directory,
    `history-${process.pid}-${Date.now()}.tmp`,
  );

  function checkCancelled() {
    if (signal?.aborted) {
      throw new Error("Cancelled");
    }
  }

  checkCancelled();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  checkCancelled();

  if ((await lstat(directory)).isSymbolicLink()) {
    throw new Error("Storage directory must not be a symlink");
  }

  try {
    const file = await open(temporaryPath, "wx", 0o600);

    try {
      await file.writeFile(JSON.stringify(validated));
      await file.sync();
    } finally {
      await file.close();
    }

    checkCancelled();
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}
