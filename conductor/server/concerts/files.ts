import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { missing } from "../files";

import { ConcertError } from "./errors";

export async function ensureConcertDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (!(await lstat(path)).isDirectory()) {
    throw new ConcertError("Concert storage must use real directories.");
  }
}

export async function readConcertFile(
  path: string,
  limit: number,
): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) {
      throw new ConcertError(
        "Concert storage exceeds its size limit or is invalid.",
      );
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
      throw new ConcertError("Concert storage exceeds its size limit.");
    }
    return buffer.subarray(0, offset).toString("utf8");
  } finally {
    await handle.close();
  }
}

export async function syncConcertDirectory(path: string): Promise<void> {
  // Windows directory durability is not a dispatch guarantee.
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
export async function writeConcertFile(
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
    await syncConcertDirectory(dirname(path));
  } finally {
    await unlink(temporary).catch((error: unknown) => {
      if (!missing(error)) {
        throw error;
      }
    });
  }
}
