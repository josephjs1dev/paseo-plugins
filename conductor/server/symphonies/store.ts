import { createHash } from "node:crypto";
import { lstat, mkdir, opendir, rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  contextSchema,
  SYMPHONY_LIMITS,
  uuidSchema,
  symphonySchema,
  summarizeSymphony,
  type SymphonyContext,
  type StoredSymphony,
  type SymphonySummary,
} from "../../shared/symphonies/models";
import { scoreIssues } from "../../shared/symphonies/score";
import { validateExecution } from "./results";
import { exists, missing } from "../files";
import {
  ensureSymphonyDirectory,
  readSymphonyFile,
  syncSymphonyDirectory,
  writeSymphonyFile,
} from "./files";
import { SymphonyError } from "./errors";

export interface SymphonyStore {
  list(): Promise<{
    symphonies: SymphonySummary[];
    unavailable: number;
    incomplete: boolean;
  }>;
  read(
    id: string,
  ): Promise<{ symphony: StoredSymphony; context: SymphonyContext }>;
  create(
    symphony: StoredSymphony,
    context: SymphonyContext,
  ): Promise<StoredSymphony>;
  /** Delete one finished symphony. Refuses active, blocked, unsettled, or stale records. */
  remove(id: string, version: number): Promise<void>;
  update(
    id: string,
    version: number,
    change: (
      symphony: StoredSymphony,
    ) => StoredSymphony | Promise<StoredSymphony>,
  ): Promise<StoredSymphony>;
}

export function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function validateEnvelope(value: unknown): StoredSymphony {
  const symphony = symphonySchema.parse(value);
  validateExecution(symphony);
  for (const [index, revision] of symphony.revisions.entries()) {
    if (
      revision.number !== index + 1 ||
      revision.parent !== (index || null) ||
      !revision.score.tasks.length ||
      scoreIssues(revision.score).length
    ) {
      throw new SymphonyError("Stored score history is invalid.");
    }
  }
  return symphony;
}

export function fileSymphonyStore(directory: string): SymphonyStore {
  const symphonies = join(directory, "symphonies");
  const artifacts = join(directory, "artifacts");
  const lock = join(directory, "symphony-write-lock");
  const path = (id: string) => join(symphonies, `${uuidSchema.parse(id)}.json`);
  const initialize = async () => {
    await ensureSymphonyDirectory(directory);
    await ensureSymphonyDirectory(symphonies);
    await ensureSymphonyDirectory(artifacts);
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
          throw new SymphonyError(
            "Symphony storage is locked by another writer or interrupted save. Retry; if it persists, follow storage recovery in the Conductor README.",
          );
        }
        throw error;
      }
      try {
        await syncSymphonyDirectory(directory);
        return await action();
      } finally {
        await rmdir(lock);
        await syncSymphonyDirectory(directory);
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
    const symphony = validateEnvelope(
      JSON.parse(
        await readSymphonyFile(path(id), SYMPHONY_LIMITS.snapshotBytes),
      ) as unknown,
    );
    if (symphony.id !== id) {
      throw new SymphonyError("Symphony identity is inconsistent.");
    }
    const raw = await readSymphonyFile(
      join(artifacts, `${symphony.contextHash}.json`),
      SYMPHONY_LIMITS.contextBytes,
    );
    if (contentHash(raw) !== symphony.contextHash) {
      throw new SymphonyError("Stored plan integrity check failed.");
    }
    return {
      symphony,
      context: contextSchema.parse(JSON.parse(raw) as unknown),
    };
  };
  const scan = async () => {
    const ids: string[] = [];
    let invalid = 0;
    let incomplete = false;
    const entries = await opendir(symphonies);
    let inspected = 0;
    for await (const entry of entries) {
      if (++inspected > SYMPHONY_LIMITS.symphonies * 2) {
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
      if (ids.length === SYMPHONY_LIMITS.symphonies) {
        incomplete = true;
        break;
      }
      ids.push(id.data);
    }
    return { ids, invalid, incomplete };
  };
  const save = async (symphony: StoredSymphony) => {
    const valid = validateEnvelope(symphony);
    const content = JSON.stringify(valid);
    if (Buffer.byteLength(content) > SYMPHONY_LIMITS.snapshotBytes) {
      throw new SymphonyError(
        "Symphony history is full. Delete finished symphonies before preparing further work.",
      );
    }
    await writeSymphonyFile(path(valid.id), content);
    return valid;
  };
  return {
    read,
    remove: (id, version) =>
      exclusive(async () => {
        let symphony: StoredSymphony;
        try {
          symphony = (await read(id)).symphony;
        } catch (error) {
          if (missing(error)) {
            throw new SymphonyError(
              "This symphony no longer exists. Refresh the symphony list.",
            );
          }
          throw error;
        }
        if (symphony.status !== "completed" && symphony.status !== "failed") {
          throw new SymphonyError("Only finished symphonies can be deleted.");
        }
        if (
          symphony.execution.attempts.some(
            (attempt) =>
              attempt.state === "running" ||
              attempt.state === "blocked" ||
              (attempt.launch !== undefined && !attempt.launch.settled),
          )
        ) {
          throw new SymphonyError(
            "This symphony still has work in progress. Wait for every attempt to settle.",
          );
        }
        if (
          symphony.execution.conducting?.phase === "planning" &&
          symphony.execution.conducting.conductorLaunch === "pending"
        ) {
          throw new SymphonyError("This symphony is still planning.");
        }
        if (symphony.version !== version) {
          throw new SymphonyError(
            "This symphony changed. Refresh before deleting.",
          );
        }
        await unlink(path(id));
        await syncSymphonyDirectory(symphonies);
        // Remove the content-addressed artifact only when no remaining symphony can
        // reference it. An unreadable or partially scanned record keeps it.
        const found = await scan();
        let provablyUnreferenced = !found.incomplete && found.invalid === 0;
        for (const other of found.ids) {
          if (other === id) {
            continue;
          }
          try {
            if (
              (await read(other)).symphony.contextHash === symphony.contextHash
            ) {
              provablyUnreferenced = false;
              break;
            }
          } catch {
            provablyUnreferenced = false;
          }
        }
        if (provablyUnreferenced) {
          try {
            await unlink(join(artifacts, `${symphony.contextHash}.json`));
          } catch (error) {
            if (!missing(error)) {
              throw error;
            }
          }
          await syncSymphonyDirectory(artifacts);
        }
      }),
    async list() {
      await initialize();
      const found = await scan();
      const summaries: SymphonySummary[] = [];
      let unavailable = found.invalid;
      for (const id of found.ids) {
        try {
          summaries.push(summarizeSymphony((await read(id)).symphony));
        } catch {
          unavailable++;
        }
      }
      return {
        symphonies: summaries.sort(
          (a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id),
        ),
        unavailable,
        incomplete: found.incomplete,
      };
    },
    create: (symphony, context) =>
      exclusive(async () => {
        const raw = JSON.stringify(contextSchema.parse(context));
        if (
          Buffer.byteLength(raw) > SYMPHONY_LIMITS.contextBytes ||
          contentHash(raw) !== symphony.contextHash
        ) {
          throw new SymphonyError(
            "Selected plan exceeds the context limit or has an invalid digest.",
          );
        }
        let existing = true;
        try {
          await lstat(path(symphony.id));
        } catch (error) {
          if (!missing(error)) {
            throw error;
          }
          existing = false;
        }
        if (existing) {
          const prior = (await read(symphony.id)).symphony;
          if (prior.requestHash === symphony.requestHash) {
            return prior;
          }
          throw new SymphonyError(
            "This symphony ID belongs to another plan. Refresh the symphony list before creating another plan.",
          );
        }
        const found = await scan();
        if (
          found.incomplete ||
          found.ids.length + found.invalid >= SYMPHONY_LIMITS.symphonies
        ) {
          throw new SymphonyError(
            "Symphony storage is full. Delete finished symphonies before adding more.",
          );
        }
        // Context is immutable and durable before an envelope can reference it.
        const artifact = join(artifacts, `${symphony.contextHash}.json`);
        try {
          if (
            (await readSymphonyFile(artifact, SYMPHONY_LIMITS.contextBytes)) !==
            raw
          ) {
            throw new SymphonyError("Stored context is damaged.");
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
              throw new SymphonyError(
                "Context storage contains an unsupported entry.",
              );
            }
            if (++count >= SYMPHONY_LIMITS.symphonies) {
              throw new SymphonyError(
                "Context storage is full. Delete finished symphonies and follow storage recovery before adding more.",
              );
            }
          }
          await writeSymphonyFile(artifact, raw);
        }
        return save(symphony);
      }),
    update: (id, version, change) =>
      exclusive(async () => {
        const { symphony } = await read(id);
        if (symphony.version !== version) {
          throw new SymphonyError(
            "This symphony changed elsewhere. Refresh it and retry the change.",
          );
        }
        const next = await change(structuredClone(symphony));
        if (JSON.stringify(next) === JSON.stringify(symphony)) {
          return symphony;
        }
        if (
          next.id !== symphony.id ||
          next.contextHash !== symphony.contextHash ||
          next.requestHash !== symphony.requestHash ||
          JSON.stringify(next.source) !== JSON.stringify(symphony.source) ||
          JSON.stringify(next.revisions.slice(0, symphony.revisions.length)) !==
            JSON.stringify(symphony.revisions)
        ) {
          throw new SymphonyError(
            "Accepted history and captured context cannot be rewritten.",
          );
        }
        return save({
          ...next,
          version: symphony.version + 1,
          updatedAt: Date.now(),
        });
      }),
  };
}
