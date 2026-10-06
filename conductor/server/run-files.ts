import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { missing } from "./files";

export class RunError extends Error {}

export async function ensureRunDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (!(await lstat(path)).isDirectory()) {
    throw new RunError("Run storage must use real directories.");
  }
}

export async function readRunFile(
  path: string,
  limit: number,
): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) {
      throw new RunError("Run storage exceeds its size limit or is invalid.");
    }
    // Read at most limit + 1 even if a file grows after stat.
    const buffer = Buffer.alloc(limit + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        buffer.length - offset,
        null,
      );
      if (!bytesRead) {
        break;
      }
      offset += bytesRead;
    }
    if (offset > limit) {
      throw new RunError("Run storage exceeds its size limit.");
    }
    return buffer.subarray(0, offset).toString("utf8");
  } finally {
    await handle.close();
  }
}

export async function syncRunDirectory(path: string): Promise<void> {
  // This release stores plans only. Windows directory durability is not a dispatch guarantee.
  if (process.platform === "win32") {
    return;
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Publish one complete envelope; callers hold the namespace write lock. */
export async function writeRunFile(
  path: string,
  content: string,
): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    await syncRunDirectory(dirname(path));
  } finally {
    await unlink(temporary).catch((error: unknown) => {
      if (!missing(error)) {
        throw error;
      }
    });
  }
}
