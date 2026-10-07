import { createHash } from "node:crypto";
import { lstat, mkdir, opendir, rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  contextSchema,
  CONCERT_LIMITS,
  uuidSchema,
  concertSchema,
  summarizeConcert,
  type ConcertContext,
  type StoredConcert,
  type ConcertSummary,
} from "../../shared/concerts/models";
import { graphIssues } from "../../shared/concerts/graph";
import { validateExecution } from "./results";
import { exists, missing } from "../files";
import {
  ensureConcertDirectory,
  readConcertFile,
  syncConcertDirectory,
  writeConcertFile,
} from "./files";
import { ConcertError } from "./errors";

export interface ConcertStore {
  list(): Promise<{
    runs: ConcertSummary[];
    unavailable: number;
    incomplete: boolean;
  }>;
  read(id: string): Promise<{ run: StoredConcert; context: ConcertContext }>;
  create(run: StoredConcert, context: ConcertContext): Promise<StoredConcert>;
  removeLegacy(
    id: string,
    version: number,
    source: { agentId: string; workspaceId: string },
  ): Promise<void>;
  /** Delete one finished concert. Refuses active, blocked, unsettled, or stale records. */
  remove(id: string, version: number): Promise<void>;
  update(
    id: string,
    version: number,
    change: (run: StoredConcert) => StoredConcert | Promise<StoredConcert>,
  ): Promise<StoredConcert>;
}

export function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function validateEnvelope(value: unknown): StoredConcert {
  const run = concertSchema.parse(value);
  if (
    (!run.execution &&
      (run.status === "accepted") !== run.revisions.length > 0) ||
    (run.status === "draft" && run.draft === null)
  ) {
    throw new ConcertError("Concert state is inconsistent.");
  }
  validateExecution(run);
  for (const [index, revision] of run.revisions.entries()) {
    if (
      revision.number !== index + 1 ||
      revision.parent !== (index || null) ||
      !revision.graph.tasks.length ||
      graphIssues(revision.graph).length
    ) {
      throw new ConcertError("Stored graph history is invalid.");
    }
  }
  return run;
}

export function fileConcertStore(directory: string): ConcertStore {
  const runs = join(directory, "runs");
  const artifacts = join(directory, "artifacts");
  const lock = join(directory, "run-write-lock");
  const path = (id: string) => join(runs, `${uuidSchema.parse(id)}.json`);
  const initialize = async () => {
    await ensureConcertDirectory(directory);
    await ensureConcertDirectory(runs);
    await ensureConcertDirectory(artifacts);
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
          throw new ConcertError(
            "Concert storage is locked by another writer or interrupted save. Retry; if it persists, follow storage recovery in the Conductor README.",
          );
        }
        throw error;
      }
      try {
        await syncConcertDirectory(directory);
        return await action();
      } finally {
        await rmdir(lock);
        await syncConcertDirectory(directory);
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
        await readConcertFile(path(id), CONCERT_LIMITS.snapshotBytes),
      ) as unknown,
    );
    if (run.id !== id) {
      throw new ConcertError("Concert identity is inconsistent.");
    }
    const raw = await readConcertFile(
      join(artifacts, `${run.contextHash}.json`),
      CONCERT_LIMITS.contextBytes,
    );
    if (contentHash(raw) !== run.contextHash) {
      throw new ConcertError("Stored plan integrity check failed.");
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
      if (++inspected > CONCERT_LIMITS.concerts * 2) {
        incomplete = true;
        break;
      }
      if (!entry.name.endsWith(".json")) {
        continue;
      }
      const id = uuidSchema.safeParse(entry.name.slice(0, -5));
      if (!entry.isFile() || !id.success) {
        invalid++;
        continue;
      }
      if (ids.length === CONCERT_LIMITS.concerts) {
        incomplete = true;
        break;
      }
      ids.push(id.data);
    }
    return { ids, invalid, incomplete };
  };
  const save = async (run: StoredConcert) => {
    const valid = validateEnvelope(run);
    const content = JSON.stringify(valid);
    if (Buffer.byteLength(content) > CONCERT_LIMITS.snapshotBytes) {
      throw new ConcertError(
        "Concert history is full. Delete finished concerts before preparing further work.",
      );
    }
    await writeConcertFile(path(valid.id), content);
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
          throw new ConcertError(
            "Only the original source agent in this workspace can remove its legacy plan.",
          );
        }
        if (run.execution || !["draft", "accepted"].includes(run.status)) {
          throw new ConcertError(
            "Executed concerts cannot be removed by legacy cleanup.",
          );
        }
        if (run.version !== version) {
          throw new ConcertError(
            "This legacy plan changed elsewhere. Read it again before removing it.",
          );
        }
        // Keep immutable context: another record may reference the same artifact.
        await unlink(path(id));
        await syncConcertDirectory(runs);
      }),
    remove: (id, version) =>
      exclusive(async () => {
        let run: StoredConcert;
        try {
          run = (await read(id)).run;
        } catch (error) {
          if (missing(error)) {
            throw new ConcertError(
              "This concert no longer exists. Refresh the concert list.",
            );
          }
          throw error;
        }
        if (!run.execution) {
          throw new ConcertError(
            "Only finished execution concerts can be deleted.",
          );
        }
        if (run.status !== "completed" && run.status !== "failed") {
          throw new ConcertError("Only finished concerts can be deleted.");
        }
        if (
          run.execution.attempts.some(
            (attempt) =>
              attempt.state === "running" ||
              attempt.state === "blocked" ||
              (attempt.launch !== undefined && !attempt.launch.settled),
          )
        ) {
          throw new ConcertError(
            "This concert still has work in progress. Wait for every attempt to settle.",
          );
        }
        if (
          run.execution.orchestration?.phase === "planning" &&
          run.execution.orchestration.coordinatorLaunch === "pending"
        ) {
          throw new ConcertError("This concert is still planning.");
        }
        if (run.version !== version) {
          throw new ConcertError(
            "This concert changed. Refresh before deleting.",
          );
        }
        await unlink(path(id));
        await syncConcertDirectory(runs);
        // Remove the content-addressed artifact only when no remaining concert can
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
          await syncConcertDirectory(artifacts);
        }
      }),
    async list() {
      await initialize();
      const found = await scan();
      const summaries: ConcertSummary[] = [];
      let unavailable = found.invalid;
      for (const id of found.ids) {
        try {
          summaries.push(summarizeConcert((await read(id)).run));
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
          Buffer.byteLength(raw) > CONCERT_LIMITS.contextBytes ||
          contentHash(raw) !== run.contextHash
        ) {
          throw new ConcertError(
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
          throw new ConcertError(
            "This concert ID belongs to another plan. Refresh the concert list before creating another plan.",
          );
        }
        const found = await scan();
        if (
          found.incomplete ||
          found.ids.length + found.invalid >= CONCERT_LIMITS.concerts
        ) {
          throw new ConcertError(
            "Concert storage is full. Delete finished concerts before adding more.",
          );
        }
        // Context is immutable and durable before an envelope can reference it.
        const artifact = join(artifacts, `${run.contextHash}.json`);
        try {
          if (
            (await readConcertFile(artifact, CONCERT_LIMITS.contextBytes)) !==
            raw
          ) {
            throw new ConcertError("Stored context is damaged.");
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
              throw new ConcertError(
                "Context storage contains an unsupported entry.",
              );
            }
            if (++count >= CONCERT_LIMITS.concerts) {
              throw new ConcertError(
                "Context storage is full. Delete finished concerts and follow storage recovery before adding more.",
              );
            }
          }
          await writeConcertFile(artifact, raw);
        }
        return save(run);
      }),
    update: (id, version, change) =>
      exclusive(async () => {
        const { run } = await read(id);
        if (run.version !== version) {
          throw new ConcertError(
            "This concert changed elsewhere. Refresh it and review your draft before saving again.",
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
          throw new ConcertError(
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
