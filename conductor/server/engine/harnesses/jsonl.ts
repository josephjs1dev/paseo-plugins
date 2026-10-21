import { open, readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import * as zlib from "node:zlib";

const MAX_FILES = 5_000;
const MAX_FILE_BYTES = 128 * 1024 * 1024;
const MAX_LINE_CHARS = 2 * 1024 * 1024;
const MAX_DEPTH = 6;
const HEADER_BYTES = 16 * 1024;

export interface JsonlFile {
  readonly path: string;
  readonly mtimeMs: number;
}

/**
 * Lists unlinked JSONL and Zstandard-compressed JSONL files below `root`,
 * newest first. A plain log takes precedence over a compressed sibling because
 * an interrupted compression must not hide the live transcript.
 */
export async function listJsonlFiles(root: string): Promise<JsonlFile[]> {
  const plain: JsonlFile[] = [];
  const compressed: JsonlFile[] = [];

  async function walk(directory: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH || plain.length + compressed.length >= MAX_FILES) {
      return;
    }

    let entries;

    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (plain.length + compressed.length >= MAX_FILES) {
        return;
      }

      if (entry.isDirectory()) {
        await walk(join(directory, entry.name), depth + 1);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const isPlain = entry.name.endsWith(".jsonl");
      const isCompressed = entry.name.endsWith(".jsonl.zst");

      if (!isPlain && !isCompressed) {
        continue;
      }

      const path = join(directory, entry.name);
      let info;

      try {
        info = await stat(path);
      } catch {
        continue;
      }

      if (!info.isFile() || info.size > MAX_FILE_BYTES) {
        continue;
      }

      const file = { path, mtimeMs: info.mtimeMs };

      if (isPlain) {
        plain.push(file);
      } else {
        compressed.push(file);
      }
    }
  }

  await walk(root, 0);
  const plainPaths = new Set(plain.map((file) => file.path));
  const files = [...plain];

  for (const file of compressed) {
    if (!plainPaths.has(file.path.slice(0, -".zst".length))) {
      files.push(file);
    }
  }

  files.sort(
    (left, right) =>
      right.mtimeMs - left.mtimeMs || left.path.localeCompare(right.path),
  );

  return files;
}

/** The session-file name without its JSONL or Zstandard suffix. */
export function jsonlFileStem(path: string): string {
  return basename(path).replace(/\.jsonl(?:\.zst)?$/u, "");
}

/** True when a transcript filename ends with the session id as a component. */
export function jsonlFileNamesSession(
  path: string,
  sessionId: string,
): boolean {
  const stem = jsonlFileStem(path);

  return (
    stem === sessionId ||
    stem.endsWith(`-${sessionId}`) ||
    stem.endsWith(`_${sessionId}`)
  );
}

/**
 * Reads only the first JSONL record, from a bounded prefix of a plain log.
 * Header discovery must not load or parse unrelated conversation bodies.
 */
export async function readJsonlFirstRecord(
  path: string,
  maxBytes = HEADER_BYTES,
): Promise<unknown> {
  if (path.endsWith(".jsonl.zst")) {
    return undefined;
  }

  let file;

  try {
    file = await open(path, "r");
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await file.read(buffer, 0, maxBytes, 0);

    if (bytesRead === 0) {
      return undefined;
    }

    const text = buffer.toString("utf8", 0, bytesRead);
    const newline = text.indexOf("\n");

    if (newline === -1 && bytesRead === maxBytes) {
      return undefined;
    }

    const line = (newline === -1 ? text : text.slice(0, newline))
      .replace(/^\uFEFF/u, "")
      .replace(/\r$/u, "");

    if (!line) {
      return undefined;
    }

    try {
      return JSON.parse(line) as unknown;
    } catch {
      return undefined;
    }
  } catch {
    return undefined;
  } finally {
    try {
      await file?.close();
    } catch {
      // A failed close must not replace the header result.
    }
  }
}

/**
 * Reads JSONL records without changing the source log. Invalid or oversized
 * lines are skipped because a live transcript may end with a partial record.
 */
export async function readJsonlRecords(
  path: string,
): Promise<unknown[] | undefined> {
  let data: Buffer;

  try {
    data = await readFile(path);
  } catch {
    return undefined;
  }

  let text: string;

  if (path.endsWith(".jsonl.zst")) {
    if (typeof zlib.zstdDecompressSync !== "function") {
      return undefined;
    }

    try {
      text = zlib
        .zstdDecompressSync(data, {
          maxOutputLength: MAX_FILE_BYTES,
        })
        .toString("utf8");
    } catch {
      return undefined;
    }
  } else {
    text = data.toString("utf8");
  }

  const records: unknown[] = [];

  for (const line of text.split("\n")) {
    if (!line || line.length > MAX_LINE_CHARS) {
      continue;
    }

    try {
      records.push(JSON.parse(line.replace(/\r$/, "")) as unknown);
    } catch {
      // Another process may still be appending the final line.
    }
  }

  return records;
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function asText(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** A non-negative integer token count or timestamp, never a fractional value. */
export function asCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

/** Parses an ISO timestamp or an epoch-millisecond number. */
export function asInstant(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? value : undefined;
  }

  if (typeof value !== "string") {
    return undefined;
  }

  const instant = Date.parse(value);

  return Number.isFinite(instant) ? instant : undefined;
}
