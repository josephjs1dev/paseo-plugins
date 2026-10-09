import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  changesRuntime,
  diffWriteFingerprints,
  parseStatusEntries,
  recordChangedPaths,
  type WriteFingerprint,
} from "../server/symphonies/changes";
import {
  attemptSchema,
  observedPathSchema,
  SYMPHONY_LIMITS,
} from "../shared/symphonies/models";
import { testDirectory } from "./fixtures";

const execute = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<void> {
  await execute("git", ["-c", "core.fsmonitor=false", ...args], {
    cwd,
    timeout: 5000,
    maxBuffer: 1_000_000,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
}

/** A committed Git checkout with one tracked file under `src`. */
async function repository(): Promise<string> {
  const directory = await testDirectory();
  await git(directory, ["init", "-q"]);
  await git(directory, ["config", "user.email", "test@example.com"]);
  await git(directory, ["config", "user.name", "Test"]);
  await mkdir(join(directory, "src"), { recursive: true });
  await writeFile(join(directory, "src", "a.ts"), "export const a = 1;\n");
  await git(directory, ["add", "."]);
  await git(directory, ["commit", "-q", "-m", "initial"]);
  return directory;
}

void test("a changed-path diff excludes unchanged paths and sorts the rest", () => {
  const start: WriteFingerprint = {
    paths: [
      { path: "src/keep.ts", hash: "same" },
      { path: "src/old.ts", hash: "before" },
    ],
  };
  const settle: WriteFingerprint = {
    paths: [
      { path: "src/keep.ts", hash: "same" },
      { path: "src/old.ts", hash: "after" },
      { path: "src/new.ts", hash: "new" },
    ],
  };
  assert.deepEqual(diffWriteFingerprints(start, settle), {
    changedPaths: ["src/new.ts", "src/old.ts"],
    changedPathsTruncated: false,
  });
});

void test("a changed-path diff caps the stored list and marks truncation", () => {
  const settle: WriteFingerprint = {
    paths: Array.from({ length: 60 }, (_, index) => ({
      path: `src/file-${String(index).padStart(2, "0")}.ts`,
      hash: `v${index}`,
    })),
  };
  const diff = diffWriteFingerprints({ paths: [] }, settle);
  assert.equal(diff?.changedPaths.length, SYMPHONY_LIMITS.changedPaths);
  assert.equal(diff?.changedPathsTruncated, true);
});

void test("an unknown observation yields no changed paths", () => {
  const settle: WriteFingerprint = { paths: [{ path: "src/a.ts", hash: "x" }] };
  assert.equal(diffWriteFingerprints(null, settle), null);
  assert.equal(diffWriteFingerprints({ paths: [] }, null), null);
  assert.equal(diffWriteFingerprints(undefined, undefined), null);
});

void test("git status records keep both sides of a rename", () => {
  assert.deepEqual(
    parseStatusEntries(" M src/a.ts\0?? src/b.ts\0R  src/new.ts\0src/old.ts\0"),
    [
      { code: " M", path: "src/a.ts" },
      { code: "??", path: "src/b.ts" },
      { code: "R ", path: "src/new.ts" },
      { code: "R ", path: "src/old.ts" },
    ],
  );
});

void test("observed paths allow file-name characters but reject traversal", () => {
  assert.equal(observedPathSchema.safeParse("src/[id]/page.ts").success, true);
  assert.equal(observedPathSchema.safeParse("a*b?c:d{e}.ts").success, true);
  assert.equal(observedPathSchema.safeParse("../secret").success, false);
  assert.equal(observedPathSchema.safeParse("/etc/passwd").success, false);
  assert.equal(observedPathSchema.safeParse("a//b").success, false);
  assert.equal(observedPathSchema.safeParse("a/./b").success, false);
  assert.equal(observedPathSchema.safeParse("bad\u0000name").success, false);
});

void test("observed paths keep leading and trailing spaces instead of trimming", () => {
  // A space is a real file-name character, so parsing must not normalize it.
  assert.equal(observedPathSchema.parse("src/note.ts "), "src/note.ts ");
  assert.equal(observedPathSchema.parse(" note.ts"), " note.ts");
  assert.equal(observedPathSchema.safeParse("").success, false);
});

void test("an attempt accepts a bracketed changed path", () => {
  const parsed = attemptSchema.parse({
    id: randomUUID(),
    taskId: "work",
    agentId: "worker-1",
    state: "blocked",
    startedAt: 1,
    endedAt: 2,
    message: null,
    report: null,
    reportHash: null,
    changedPaths: ["src/[id]/page.ts"],
  });
  assert.deepEqual(parsed.changedPaths, ["src/[id]/page.ts"]);
});

void test("a trailing-space file name is not trimmed into a phantom change", async () => {
  const directory = await repository();
  const runtime = changesRuntime();
  await writeFile(join(directory, "src", "note.ts "), "export {};\n");
  const baseline = await runtime.fingerprint(directory, ["src"]);
  assert.deepEqual(
    baseline?.paths.map((entry) => entry.path),
    ["src/note.ts "],
  );
  // Storing and reloading the attempt must preserve the observed name; the
  // schema used to trim it, so the baseline and the settle observation no
  // longer matched and the path was reported twice.
  const stored = attemptSchema.parse({
    id: randomUUID(),
    taskId: "work",
    agentId: "worker-1",
    state: "blocked",
    startedAt: 1,
    endedAt: 2,
    message: null,
    report: null,
    reportHash: null,
    writeFingerprint: baseline?.paths,
  });
  assert.deepEqual(
    stored.writeFingerprint?.map((entry) => entry.path),
    ["src/note.ts "],
  );
  // An otherwise unchanged block observes no change at all.
  assert.deepEqual(
    await recordChangedPaths(
      runtime,
      directory,
      ["src"],
      stored.writeFingerprint,
    ),
    { changedPaths: [], changedPathsTruncated: false },
  );
});

void test("a non-Git checkout has no write fingerprint", async () => {
  const directory = await testDirectory();
  assert.equal(await changesRuntime().fingerprint(directory, ["."]), null);
});

void test("write-scope fingerprints ignore pre-existing changes and detect new ones", async () => {
  const directory = await repository();
  const runtime = changesRuntime();
  assert.deepEqual(await runtime.fingerprint(directory, ["src"]), {
    paths: [],
  });
  // A pre-existing dirty file is the baseline; it is not reported as changed.
  await writeFile(join(directory, "src", "a.ts"), "export const a = 2;\n");
  const baseline = (await runtime.fingerprint(directory, ["src"]))?.paths;
  assert.ok(baseline);
  assert.deepEqual(
    await recordChangedPaths(runtime, directory, ["src"], baseline),
    { changedPaths: [], changedPathsTruncated: false },
  );
  // A second edit after the baseline is reported.
  await writeFile(join(directory, "src", "a.ts"), "export const a = 3;\n");
  const changed = await recordChangedPaths(
    runtime,
    directory,
    ["src"],
    baseline,
  );
  assert.deepEqual(changed, {
    changedPaths: ["src/a.ts"],
    changedPathsTruncated: false,
  });
  // An untracked file inside the scope appears only at settle.
  await writeFile(join(directory, "src", "b.ts"), "export const b = 1;\n");
  const added = await recordChangedPaths(runtime, directory, ["src"], baseline);
  assert.equal(added?.changedPaths.includes("src/b.ts"), true);
});

void test("an edit to an already-untracked file is detected", async () => {
  const directory = await repository();
  const runtime = changesRuntime();
  const untracked = join(directory, "src", "draft.ts");
  await writeFile(untracked, "export const draft = 1;\n");
  const baseline = (await runtime.fingerprint(directory, ["src"]))?.paths;
  assert.ok(baseline);
  // Git does not diff untracked files, so only a content hash sees this edit.
  await writeFile(untracked, "export const draft = 2;\n");
  assert.deepEqual(
    await recordChangedPaths(runtime, directory, ["src"], baseline),
    { changedPaths: ["src/draft.ts"], changedPathsTruncated: false },
  );
});

void test("a bracketed file name is observed and passes the attempt schema", async () => {
  const directory = await repository();
  const runtime = changesRuntime();
  await mkdir(join(directory, "src", "[id]"), { recursive: true });
  await writeFile(join(directory, "src", "[id]", "page.ts"), "export {};\n");
  const changed = await runtime.fingerprint(directory, ["src"]);
  assert.deepEqual(
    changed?.paths.map((entry) => entry.path),
    ["src/[id]/page.ts"],
  );
  // The observed path is a valid changed path on a stored attempt.
  const observed = changed?.paths[0]?.path;
  assert.ok(observed);
  assert.equal(observedPathSchema.safeParse(observed).success, true);
  assert.deepEqual(
    attemptSchema.parse({
      id: randomUUID(),
      taskId: "work",
      agentId: "worker-1",
      state: "blocked",
      startedAt: 1,
      endedAt: 2,
      message: null,
      report: null,
      reportHash: null,
      changedPaths: [observed],
    }).changedPaths,
    ["src/[id]/page.ts"],
  );
});

void test("a checkout nested in a repository stores checkout-relative paths", async () => {
  const directory = await repository();
  const checkout = join(directory, "src");
  const runtime = changesRuntime();
  const baseline = (await runtime.fingerprint(checkout, ["."]))?.paths;
  assert.deepEqual(baseline, []);
  await writeFile(join(checkout, "a.ts"), "export const a = 2;\n");
  assert.deepEqual(
    await recordChangedPaths(runtime, checkout, ["."], baseline),
    { changedPaths: ["a.ts"], changedPathsTruncated: false },
  );
});

void test("a rename keeps both the old and new checkout-relative paths", async () => {
  const directory = await repository();
  const runtime = changesRuntime();
  const baseline = (await runtime.fingerprint(directory, ["src"]))?.paths;
  assert.deepEqual(baseline, []);
  await git(directory, ["mv", "src/a.ts", "src/moved.ts"]);
  assert.deepEqual(
    await recordChangedPaths(runtime, directory, ["src"], baseline),
    {
      changedPaths: ["src/a.ts", "src/moved.ts"],
      changedPathsTruncated: false,
    },
  );
});

void test("more than the fingerprint entry cap returns an unknown observation", async () => {
  const directory = await repository();
  await Promise.all(
    Array.from({ length: SYMPHONY_LIMITS.fingerprintPaths + 1 }, (_, index) =>
      writeFile(
        join(directory, "src", `dirty-${String(index).padStart(3, "0")}.ts`),
        "export {};\n",
      ),
    ),
  );
  assert.equal(await changesRuntime().fingerprint(directory, ["src"]), null);
});
