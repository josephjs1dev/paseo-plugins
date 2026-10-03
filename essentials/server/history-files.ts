import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import { historyRowSchema } from "../shared/history";

const MAX_HISTORY_BYTES = 32 * 1024 * 1024;
const savedHistorySchema = z.object({
  version: z.literal(1),
  scannedAt: z.string().datetime(),
  rows: z.array(historyRowSchema).max(100_000),
});

export type SavedHistory = z.infer<typeof savedHistorySchema>;

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

    return savedHistorySchema.parse(JSON.parse(contents));
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
): Promise<void> {
  const validated = savedHistorySchema.parse(history);
  const path = join(directory, "history.json");
  const temporaryPath = join(
    directory,
    `history-${process.pid}-${Date.now()}.tmp`,
  );

  await mkdir(directory, { recursive: true, mode: 0o700 });

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

    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}
