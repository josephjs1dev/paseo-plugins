import { constants } from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
export function exists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}
export async function readJson(file: string): Promise<unknown> {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (missing(error)) {
      return undefined;
    }
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 128_000) {
      throw new Error("Conductor storage is invalid");
    }
    return JSON.parse(await handle.readFile("utf8")) as unknown;
  } finally {
    await handle.close();
  }
}
async function syncDirectory(directory: string): Promise<void> {
  // Windows does not support opening directories with fs.open; the file itself is synced.
  if (process.platform === "win32") {
    return;
  }
  const handle = await open(directory, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
export async function atomicJson(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temp, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temp, file);
    await syncDirectory(dirname(file));
  } finally {
    await unlink(temp).catch((error: unknown) => {
      if (!missing(error)) {
        throw error;
      }
    });
  }
}
/** Exclusive durable claim. An incomplete claim is intentionally never treated as absent. */
export async function claimJson(
  file: string,
  value: unknown,
): Promise<boolean> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  let handle;
  try {
    handle = await open(file, "wx", 0o600);
  } catch (error) {
    if (exists(error)) {
      return false;
    }
    throw error;
  }
  try {
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(dirname(file));
  return true;
}
