import { createHash } from "node:crypto";
import { lstat, mkdir, opendir, rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  contextSchema,
  RUN_LIMITS,
  runIdSchema,
  runSchema,
  summarizeRun,
  type RunContext,
  type StoredRun,
  type RunSummary,
} from "../shared/run-models";
import { graphIssues } from "../shared/run-graph";
import { validateExecution } from "./run-results";
import { exists, missing } from "./files";
import {
  ensureRunDirectory,
  readRunFile,
  RunError,
  syncRunDirectory,
  writeRunFile,
} from "./run-files";

export interface RunStore {
  list(): Promise<{
    runs: RunSummary[];
    unavailable: number;
    incomplete: boolean;
  }>;
  read(id: string): Promise<{ run: StoredRun; context: RunContext }>;
  create(run: StoredRun, context: RunContext): Promise<StoredRun>;
  removeLegacy(
    id: string,
    version: number,
    source: { agentId: string; workspaceId: string },
  ): Promise<void>;
  /** Delete one finished execution run. Refuses active, blocked, unsettled, or stale records. */
  remove(id: string, version: number): Promise<void>;
  update(
    id: string,
    version: number,
    change: (run: StoredRun) => StoredRun | Promise<StoredRun>,
  ): Promise<StoredRun>;
}

export function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function validateEnvelope(value: unknown): StoredRun {
  const run = runSchema.parse(value);
  if (
    (!run.execution &&
      (run.status === "accepted") !== run.revisions.length > 0) ||
    (run.status === "draft" && run.draft === null)
  ) {
    throw new RunError("Run state is inconsistent.");
  }
  validateExecution(run);
  for (const [index, revision] of run.revisions.entries()) {
    if (
      revision.number !== index + 1 ||
      revision.parent !== (index || null) ||
      !revision.graph.tasks.length ||
      graphIssues(revision.graph).length
    ) {
      throw new RunError("Stored graph history is invalid.");
    }
  }
  return run;
}

export function fileRunStore(directory: string): RunStore {
  const runs = join(directory, "runs");
  const artifacts = join(directory, "artifacts");
  const lock = join(directory, "run-write-lock");
  const path = (id: string) => join(runs, `${runIdSchema.parse(id)}.json`);
  const initialize = async () => {
    await ensureRunDirectory(directory);
    await ensureRunDirectory(runs);
    await ensureRunDirectory(artifacts);
  };
  // Serialization within an installation; mkdir additionally fences other installations/processes.
  // Never steal an orphan lock based on time/PID: an uncertain writer must stay fenced.
  let queue = Promise.resolve();
  const exclusive = <T>(action: () => Promise<T>): Promise<T> => {
    const pending = queue.then(async () => {
      await initialize();
      try {
        await mkdir(lock, { mode: 0o700 });
      } catch (error) {
        if (exists(error)) {
          throw new RunError(
            "Run storage is locked by another writer or interrupted save. Retry; if it persists, follow storage recovery in the Conductor README.",
          );
        }
        throw error;
      }
      try {
        await syncRunDirectory(directory);
        return await action();
      } finally {
        await rmdir(lock);
        await syncRunDirectory(directory);
      }
    });
    queue = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  };
  const read = async (id: string) => {
    await initialize();
    const run = validateEnvelope(
      JSON.parse(
        await readRunFile(path(id), RUN_LIMITS.snapshotBytes),
      ) as unknown,
    );
    if (run.id !== id) {
      throw new RunError("Run identity is inconsistent.");
    }
    const raw = await readRunFile(
      join(artifacts, `${run.contextHash}.json`),
      RUN_LIMITS.contextBytes,
    );
    if (contentHash(raw) !== run.contextHash) {
      throw new RunError("Stored plan integrity check failed.");
    }
    return { run, context: contextSchema.parse(JSON.parse(raw) as unknown) };
  };
  const scan = async () => {
    const ids: string[] = [];
    let invalid = 0;
    let incomplete = false;
    const entries = await opendir(runs);
    let inspected = 0;
    for await (const entry of entries) {
      if (++inspected > RUN_LIMITS.runs * 2) {
        incomplete = true;
        break;
      }
      if (!entry.name.endsWith(".json")) {
        continue;
      }
      const id = runIdSchema.safeParse(entry.name.slice(0, -5));
      if (!entry.isFile() || !id.success) {
        invalid++;
        continue;
      }
      if (ids.length === RUN_LIMITS.runs) {
        incomplete = true;
        break;
      }
      ids.push(id.data);
    }
    return { ids, invalid, incomplete };
  };
  const save = async (run: StoredRun) => {
    const valid = validateEnvelope(run);
    const content = JSON.stringify(valid);
    if (Buffer.byteLength(content) > RUN_LIMITS.snapshotBytes) {
      throw new RunError(
        "Run history is full. Delete finished runs before preparing further work.",
      );
    }
    await writeRunFile(path(valid.id), content);
    return valid;
  };
  return {
    read,
    removeLegacy: (id, version, source) =>
      exclusive(async () => {
        const { run } = await read(id);
        if (
          run.source.agentId !== source.agentId ||
          run.source.workspaceId !== source.workspaceId
        ) {
          throw new RunError(
            "Only the original source agent in this workspace can remove its legacy plan.",
          );
        }
        if (run.execution || !["draft", "accepted"].includes(run.status)) {
          throw new RunError(
            "Execution runs cannot be removed by legacy cleanup.",
          );
        }
        if (run.version !== version) {
          throw new RunError(
            "This legacy plan changed elsewhere. Read it again before removing it.",
          );
        }
        // Keep immutable context: another record may reference the same artifact.
        await unlink(path(id));
        await syncRunDirectory(runs);
      }),
    remove: (id, version) =>
      exclusive(async () => {
        let run: StoredRun;
        try {
          run = (await read(id)).run;
        } catch (error) {
          if (missing(error)) {
            throw new RunError(
              "This run no longer exists. Refresh the run list.",
            );
          }
          throw error;
        }
        if (!run.execution) {
          throw new RunError("Only finished execution runs can be deleted.");
        }
        if (run.status !== "completed" && run.status !== "failed") {
          throw new RunError("Only finished runs can be deleted.");
        }
        if (
          run.execution.attempts.some(
            (attempt) =>
              attempt.state === "running" ||
              attempt.state === "blocked" ||
              (attempt.launch !== undefined && !attempt.launch.settled),
          )
        ) {
          throw new RunError(
            "This run still has work in progress. Wait for every attempt to settle.",
          );
        }
        if (
          run.execution.orchestration?.phase === "planning" &&
          run.execution.orchestration.coordinatorLaunch === "pending"
        ) {
          throw new RunError("This run is still planning.");
        }
        if (run.version !== version) {
          throw new RunError("This run changed. Refresh before deleting.");
        }
        await unlink(path(id));
        await syncRunDirectory(runs);
        // Remove the content-addressed artifact only when no remaining run can
        // reference it. An unreadable or partially scanned record keeps it.
        const found = await scan();
        let provablyUnreferenced = !found.incomplete && found.invalid === 0;
        for (const other of found.ids) {
          if (other === id) {
            continue;
          }
          try {
            if ((await read(other)).run.contextHash === run.contextHash) {
              provablyUnreferenced = false;
              break;
            }
          } catch {
            provablyUnreferenced = false;
          }
        }
        if (provablyUnreferenced) {
          try {
            await unlink(join(artifacts, `${run.contextHash}.json`));
          } catch (error) {
            if (!missing(error)) {
              throw error;
            }
          }
          await syncRunDirectory(artifacts);
        }
      }),
    async list() {
      await initialize();
      const found = await scan();
      const summaries: RunSummary[] = [];
      let unavailable = found.invalid;
      for (const id of found.ids) {
        try {
          summaries.push(summarizeRun((await read(id)).run));
        } catch {
          unavailable++;
        }
      }
      return {
        runs: summaries.sort(
          (a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id),
        ),
        unavailable,
        incomplete: found.incomplete,
      };
    },
    create: (run, context) =>
      exclusive(async () => {
        const raw = JSON.stringify(contextSchema.parse(context));
        if (
          Buffer.byteLength(raw) > RUN_LIMITS.contextBytes ||
          contentHash(raw) !== run.contextHash
        ) {
          throw new RunError(
            "Selected plan exceeds the context limit or has an invalid digest.",
          );
        }
        let existing = true;
        try {
          await lstat(path(run.id));
        } catch (error) {
          if (!missing(error)) {
            throw error;
          }
          existing = false;
        }
        if (existing) {
          const prior = (await read(run.id)).run;
          if (prior.requestHash === run.requestHash) {
            return prior;
          }
          throw new RunError(
            "This run ID belongs to another plan. Refresh the run list before creating another plan.",
          );
        }
        const found = await scan();
        if (
          found.incomplete ||
          found.ids.length + found.invalid >= RUN_LIMITS.runs
        ) {
          throw new RunError(
            "Run storage is full. Delete finished runs before adding more.",
          );
        }
        // Context is immutable and durable before an envelope can reference it.
        const artifact = join(artifacts, `${run.contextHash}.json`);
        try {
          if ((await readRunFile(artifact, RUN_LIMITS.contextBytes)) !== raw) {
            throw new RunError("Stored context is damaged.");
          }
        } catch (error) {
          if (!missing(error)) {
            throw error;
          }
          // Failed creates can leave orphan artifacts. Count them too; never silently prune.
          const entries = await opendir(artifacts);
          let count = 0;
          for await (const entry of entries) {
            if (!entry.isFile()) {
              throw new RunError(
                "Context storage contains an unsupported entry.",
              );
            }
            if (++count >= RUN_LIMITS.runs) {
              throw new RunError(
                "Context storage is full. Delete finished runs and follow storage recovery before adding more.",
              );
            }
          }
          await writeRunFile(artifact, raw);
        }
        return save(run);
      }),
    update: (id, version, change) =>
      exclusive(async () => {
        const { run } = await read(id);
        if (run.version !== version) {
          throw new RunError(
            "This run changed elsewhere. Refresh it and review your draft before saving again.",
          );
        }
        const next = await change(structuredClone(run));
        if (JSON.stringify(next) === JSON.stringify(run)) {
          return run;
        }
        if (
          next.id !== run.id ||
          next.contextHash !== run.contextHash ||
          next.requestHash !== run.requestHash ||
          JSON.stringify(next.source) !== JSON.stringify(run.source) ||
          JSON.stringify(next.revisions.slice(0, run.revisions.length)) !==
            JSON.stringify(run.revisions)
        ) {
          throw new RunError(
            "Accepted history and captured context cannot be rewritten.",
          );
        }
        return save({
          ...next,
          version: run.version + 1,
          updatedAt: Date.now(),
        });
      }),
  };
}
