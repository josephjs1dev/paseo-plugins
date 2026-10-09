import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  observedPathSchema,
  SYMPHONY_LIMITS,
} from "../../shared/symphonies/models";
import { contentHash } from "./store";

const execute = promisify(execFile);

/** Regular-file bytes hashed in one observation before falling back to stat. */
const CONTENT_BUDGET_BYTES = 32 * 1024 * 1024;

/** One path's write-scope state at a checkout observation. */
export interface PathFingerprint {
  path: string;
  hash: string;
}

/** The bounded per-path state of one attempt's write scope. */
export interface WriteFingerprint {
  paths: PathFingerprint[];
}

/** The write paths an attempt changed, ready to store on the attempt. */
export interface ChangedPaths {
  changedPaths: string[];
  changedPathsTruncated: boolean;
}

/**
 * Captures checkout state for an attempt's write scope. Implementations return
 * null when the observation is impossible, such as a non-Git checkout or a
 * timed-out Git call, so callers store nothing instead of guessing.
 */
export interface SymphonyChangesRuntime {
  fingerprint(
    checkout: string,
    writes: readonly string[],
  ): Promise<WriteFingerprint | null>;
}

interface StatusEntry {
  code: string;
  path: string;
}

/**
 * Parses `git status --porcelain=v1 -z` records. A rename or copy emits the new
 * path first, then the original path as a separate NUL-terminated record with
 * no status prefix; both sides are kept so a move is visible from either end.
 */
export function parseStatusEntries(output: string): StatusEntry[] {
  const entries: StatusEntry[] = [];
  const records = output.split("\0");
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record || record.length < 4) {
      continue;
    }
    const code = record.slice(0, 2);
    entries.push({ code, path: record.slice(3) });
    if (code.includes("R") || code.includes("C")) {
      const original = records[index + 1];
      index += 1;
      if (original) {
        entries.push({ code, path: original });
      }
    }
  }
  return entries;
}

/**
 * The changed write-scope paths between two observations: a path whose state
 * hash differs, including one observed only at settle or only at start. The
 * stored list is capped, with `changedPathsTruncated` marking an overflow.
 * Null when either observation is unknown.
 */
export function diffWriteFingerprints(
  start: WriteFingerprint | null | undefined,
  settle: WriteFingerprint | null | undefined,
): ChangedPaths | null {
  if (!start || !settle) {
    return null;
  }
  const before = new Map(start.paths.map((entry) => [entry.path, entry.hash]));
  const after = new Map(settle.paths.map((entry) => [entry.path, entry.hash]));
  const changedPaths: string[] = [];
  let changedPathsTruncated = false;
  for (const path of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    if (before.get(path) === after.get(path)) {
      continue;
    }
    if (changedPaths.length >= SYMPHONY_LIMITS.changedPaths) {
      changedPathsTruncated = true;
      break;
    }
    changedPaths.push(path);
  }
  return { changedPaths, changedPathsTruncated };
}

/**
 * Diffs a stored launch baseline against a fresh settle observation. Null when
 * fingerprinting is unavailable or the attempt never recorded a baseline.
 */
export async function recordChangedPaths(
  changes: Partial<SymphonyChangesRuntime> | undefined,
  checkout: string,
  writes: readonly string[],
  baseline: readonly PathFingerprint[] | undefined,
): Promise<ChangedPaths | null> {
  if (!changes?.fingerprint || !baseline) {
    return null;
  }
  const settle = await changes.fingerprint(checkout, writes);
  return diffWriteFingerprints({ paths: [...baseline] }, settle);
}

/** A human-readable kind for a non-file, non-symlink checkout entry. */
function fileType(stats: Stats): string {
  if (stats.isDirectory()) {
    return "directory";
  }
  if (stats.isFIFO()) {
    return "fifo";
  }
  if (stats.isSocket()) {
    return "socket";
  }
  if (stats.isBlockDevice()) {
    return "blockdevice";
  }
  if (stats.isCharacterDevice()) {
    return "chardevice";
  }
  return "unknown";
}

/**
 * Hashes one checkout-relative path's state. Absent paths and special file
 * types keep a stable token; symlink targets and regular files are hashed so a
 * content edit is visible even when neither Git nor mtime reports it. Files are
 * hashed until `budget` is spent, then tracked by size and mtime. Hashes stay
 * under the stored 128-character bound.
 */
async function pathHash(
  checkout: string,
  path: string,
  budget: { hashed: number },
): Promise<string> {
  const full = join(checkout, path);
  let stats: Stats;
  try {
    stats = await lstat(full);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "absent";
    }
    throw error;
  }
  if (stats.isSymbolicLink()) {
    return contentHash(`symlink:${await readlink(full)}`);
  }
  if (stats.isFile()) {
    if (budget.hashed + stats.size > CONTENT_BUDGET_BYTES) {
      return contentHash(`stat:${stats.size}:${stats.mtimeMs}`);
    }
    const bytes = await readFile(full);
    budget.hashed += bytes.byteLength;
    return createHash("sha256").update(bytes).digest("hex");
  }
  return fileType(stats);
}

/**
 * Strips the checkout's repository prefix from a porcelain path. Porcelain
 * paths are repository-root-relative; stored paths are checkout-relative. Null
 * when the path lies outside the checkout.
 */
function stripPrefix(prefix: string, path: string): string | null {
  if (!prefix) {
    return path;
  }
  if (!path.startsWith(prefix)) {
    return null;
  }
  return path.slice(prefix.length) || null;
}

/**
 * Git-backed write-scope fingerprinting with the same options and timeouts as
 * placement capture. One `git status` names the dirty paths under the write
 * scope, both sides of a rename or copy included; each checkout-relative path
 * is then hashed by content. Literal pathspecs keep names with `[ ]`, `*`, `?`
 * or `:` intact. Null on any Git failure, an invalid path, or more than
 * `fingerprintPaths` entries, so a partial observation is never stored.
 */
export function changesRuntime(): SymphonyChangesRuntime {
  const git = async (checkout: string, args: string[]) =>
    (
      await execute(
        "git",
        ["--literal-pathspecs", "-c", "core.fsmonitor=false", ...args],
        {
          cwd: checkout,
          timeout: 5000,
          maxBuffer: 1_000_000,
          env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
        },
      )
    ).stdout;
  return {
    async fingerprint(checkout, writes) {
      if (!writes.length) {
        return { paths: [] };
      }
      try {
        const prefix = (
          await git(checkout, ["rev-parse", "--show-prefix"])
        ).replace(/\r?\n$/, "");
        const status = await git(checkout, [
          "status",
          "--porcelain=v1",
          "-z",
          "--untracked-files=all",
          "--",
          ...writes,
        ]);
        const entries = parseStatusEntries(status);
        if (entries.length > SYMPHONY_LIMITS.fingerprintPaths) {
          return null;
        }
        const paths: PathFingerprint[] = [];
        const budget = { hashed: 0 };
        for (const entry of entries) {
          const path = stripPrefix(prefix, entry.path);
          if (!path || !observedPathSchema.safeParse(path).success) {
            return null;
          }
          paths.push({ path, hash: await pathHash(checkout, path, budget) });
        }
        return { paths };
      } catch {
        // A non-Git checkout or a failed observation stays explicitly unknown.
        return null;
      }
    },
  };
}
