import type {
  PaseoAgentListOptions,
  PaseoAgentListResult,
} from "@getpaseo/client";
import { z } from "zod";
import { harnessSchema } from "../shared/harnesses";
import { sessionKey } from "../shared/history-display";
import { readStorageFile, writeStorageFile } from "./history-files";

const FILE_NAME = "workspace-sessions.json";
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_SESSIONS = 50_000;
const MAX_PAGES = 100;
const PAGE_SIZE = 200;
const RETENTION_MS = 90 * 86_400_000;
const SYNC_INTERVAL_MS = 15_000;

const workspaceSessionSchema = z.object({
  workspaceId: z.string().min(1).max(160),
  harness: harnessSchema,
  sessionId: z.string().min(1).max(160),
  seenAt: z.string().datetime(),
});
type WorkspaceSession = z.infer<typeof workspaceSessionSchema>;

const savedSessionsSchema = z.object({
  version: z.literal(1),
  sessions: z.array(workspaceSessionSchema).max(MAX_SESSIONS),
});

// Only the fields used for attribution; other agent data is ignored.
const agentEntrySchema = z.object({
  agent: z.object({
    workspaceId: z.string().min(1).max(160).optional(),
    provider: z.string(),
    updatedAt: z.string(),
    persistence: z
      .object({ provider: z.string(), sessionId: z.string().min(1).max(160) })
      .nullable()
      .optional(),
  }),
});

export type ListAgents = (
  options: PaseoAgentListOptions,
) => Promise<PaseoAgentListResult>;

function agentSession(entry: unknown, fallbackAt: string) {
  const parsed = agentEntrySchema.safeParse(entry);

  if (!parsed.success) {
    return;
  }

  const { workspaceId, persistence, provider, updatedAt } = parsed.data.agent;
  const harness = harnessSchema.safeParse(persistence?.provider ?? provider);

  if (!workspaceId || !persistence || !harness.success) {
    return;
  }

  const seenAt = Number.isNaN(Date.parse(updatedAt))
    ? fallbackAt
    : new Date(updatedAt).toISOString();

  return {
    workspaceId,
    harness: harness.data,
    sessionId: persistence.sessionId,
    seenAt,
  };
}

/**
 * Remembers which provider sessions Paseo agents ran in each workspace.
 * Mappings outlive deleted agents so retained history stays attributed.
 */
export function createWorkspaceSessions(
  directory: string,
  now: () => number = Date.now,
) {
  const sessions = new Map<string, WorkspaceSession>();
  let hydration: Promise<void> | undefined;
  let pending: Promise<void> | undefined;
  let nextSync = 0;
  // Set until changed mappings are saved, so a failed write is retried.
  let dirty = false;

  const keyOf = (session: WorkspaceSession) =>
    JSON.stringify([session.workspaceId, session.harness, session.sessionId]);

  async function hydrate() {
    hydration ??= (async () => {
      try {
        const contents = await readStorageFile(
          directory,
          FILE_NAME,
          MAX_FILE_BYTES,
        );

        if (contents !== undefined) {
          const saved = savedSessionsSchema.parse(JSON.parse(contents));

          for (const session of saved.sessions) {
            sessions.set(keyOf(session), session);
          }
        }
      } catch {
        // An unreadable file is rebuilt from the agents Paseo still knows.
      }
    })();
    await hydration;
  }

  async function sync(listAgents: ListAgents) {
    const syncedAt = new Date(now()).toISOString();
    let cursor: string | undefined;

    for (let page = 0; page < MAX_PAGES; page++) {
      const result = await listAgents({
        filter: { includeArchived: true },
        page: { limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) },
      });

      for (const entry of result.entries) {
        const session = agentSession(entry, syncedAt);

        if (!session) {
          continue;
        }

        const key = keyOf(session);
        const previous = sessions.get(key);

        if (!previous || previous.seenAt < session.seenAt) {
          sessions.set(key, session);
          dirty = true;
        }
      }

      cursor = result.pageInfo.nextCursor ?? undefined;

      if (!result.pageInfo.hasMore || !cursor) {
        break;
      }
    }

    const cutoff = new Date(now() - RETENTION_MS).toISOString();

    for (const [key, session] of sessions) {
      if (session.seenAt < cutoff) {
        sessions.delete(key);
        dirty = true;
      }
    }

    if (dirty) {
      const kept = [...sessions.values()]
        .sort((left, right) => right.seenAt.localeCompare(left.seenAt))
        .slice(0, MAX_SESSIONS);
      await writeStorageFile(
        directory,
        FILE_NAME,
        JSON.stringify(
          savedSessionsSchema.parse({ version: 1, sessions: kept }),
        ),
      );
      dirty = false;
    }
  }

  return {
    /**
     * Returns session keys (see `sessionKey`) for the workspace. `complete` is
     * false when the agent list could not be read and saved mappings were used.
     */
    async read(
      workspaceId: string,
      listAgents: ListAgents,
      forceSync = false,
    ): Promise<{ sessions: Set<string>; complete: boolean }> {
      await hydrate();
      let complete = true;

      if (forceSync || now() >= nextSync) {
        pending ??= sync(listAgents).finally(() => {
          pending = undefined;
        });
      }

      try {
        await pending;
        nextSync = now() + SYNC_INTERVAL_MS;
      } catch {
        complete = false;
      }

      const keys = new Set<string>();

      for (const session of sessions.values()) {
        if (session.workspaceId === workspaceId) {
          keys.add(sessionKey(session));
        }
      }

      return { sessions: keys, complete };
    },
  };
}
