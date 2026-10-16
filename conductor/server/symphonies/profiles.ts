import { createHash, randomUUID } from "node:crypto";
import { mkdir, rmdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { AgentProfile } from "../../shared/agents/agent";
import {
  EMPTY_PROFILE_STORE,
  PROFILES_FILE,
  PROFILE_LIMITS,
  STALE_SAVE_MESSAGE,
  conductorProfileSchema,
  profileNameKey,
  profileNameSchema,
  profileStoreSchema,
  readProfileStore,
  type ConductorProfile,
  type ProfileOperation,
  type ProfileStore,
  type ProfilesState,
  type SaveProfilesResult,
} from "../../shared/symphonies/profiles";
import type {
  ImportProfilesResult,
  ImportSkip,
} from "../../shared/symphonies/profiles-rpc";
import {
  isClassifiedRouting,
  type RoutingDiagnostic,
  type RoutingMode,
} from "../../shared/symphonies/routing";
import { atomicJson, exists, readBoundedText } from "../files";
import { SymphonyError } from "./errors";

/** A parsed profile store plus the revisions and diagnostics derived from it. */
export interface ProfilesCatalog {
  state: "missing" | "valid" | "invalid";
  error?: string;
  mode: RoutingMode;
  profiles: ConductorProfile[];
  /** The whole-store digest for optimistic concurrency. */
  revision: string;
  /** The routing-relevant digest, ignoring notes and instructions. */
  catalogRevision: string;
  diagnostics: RoutingDiagnostic[];
}

/** Reads and mutates the Conductor-owned worker profile store. */
export interface ProfilesSource {
  path: string | null;
  load(): Promise<ProfilesCatalog>;
  save(
    expectedRevision: string,
    operation: ProfileOperation,
  ): Promise<SaveProfilesResult>;
  importFromPaseo(expectedRevision: string): Promise<ImportProfilesResult>;
}

/** Recursively sorts object keys so a content hash ignores key order. */
export function canonicalJson(value: unknown): string {
  const sortValue = (entry: unknown): unknown => {
    if (Array.isArray(entry)) {
      return entry.map(sortValue);
    }
    if (entry && typeof entry === "object") {
      const source = entry as Record<string, unknown>;
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(source).sort()) {
        sorted[key] = sortValue(source[key]);
      }
      return sorted;
    }
    return entry;
  };
  return JSON.stringify(sortValue(value));
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function storeRevision(store: ProfileStore): string {
  return digest(store);
}

/** The distinct revision an unreadable (symlink, non-file or oversize) store gets. */
const UNREADABLE_REVISION = digest("unreadable");

/** The distinct revision one invalid raw store content gets, per the plan. */
function invalidRevision(raw: string): string {
  return digest(`invalid\n${raw}`);
}

/**
 * Hashes the fields routing and launching read: load state, mode, identity,
 * launch settings and routing. Editing notes or instructions does not
 * invalidate a routing decision, so it does not change this digest. A missing
 * or invalid store has no profiles, so its content-derived `revision`
 * distinguishes different raw contents.
 */
function catalogRevisionOf(
  state: ProfilesCatalog["state"],
  mode: RoutingMode,
  profiles: readonly ConductorProfile[],
  revision: string,
): string {
  return digest({
    state,
    mode,
    profiles: profiles
      .map((profile) => ({
        id: profile.id,
        name: profile.name,
        provider: profile.provider,
        model: profile.model ?? null,
        modeId: profile.modeId ?? null,
        thinkingOptionId: profile.thinkingOptionId ?? null,
        routing: profile.routing,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    ...(state === "valid" ? {} : { revision }),
  });
}

function diagnosticsFor(
  store: ProfileStore,
  state: ProfilesCatalog["state"],
  error: string | undefined,
): RoutingDiagnostic[] {
  const diagnostics: RoutingDiagnostic[] = [];
  if (state === "missing") {
    diagnostics.push({
      code: "store-missing",
      message:
        "No Conductor profiles yet; create them in Podium › Profiles. Routing mode is warn.",
    });
  }
  if (state === "invalid") {
    diagnostics.push({
      code: "store-invalid",
      message: error ?? "profiles.json is invalid.",
    });
  }
  if (state === "valid") {
    for (const profile of store.profiles) {
      if (!isClassifiedRouting(profile.routing)) {
        diagnostics.push({
          code: "unclassified-profile",
          profileId: profile.id,
          message: `Profile "${profile.name}" needs a role and a size before routing can pick it.`,
        });
      }
    }
  }
  return diagnostics;
}

function catalogOf(
  store: ProfileStore,
  state: ProfilesCatalog["state"],
  options: { error?: string; revision?: string } = {},
): ProfilesCatalog {
  const revision = options.revision ?? storeRevision(store);
  const profiles = state === "valid" ? store.profiles : [];
  return {
    state,
    ...(options.error !== undefined ? { error: options.error } : {}),
    mode: store.mode,
    profiles,
    revision,
    catalogRevision: catalogRevisionOf(state, store.mode, profiles, revision),
    diagnostics: diagnosticsFor(store, state, options.error),
  };
}

/** The client-facing projection of a loaded catalog. */
export function profilesState(catalog: ProfilesCatalog): ProfilesState {
  return {
    revision: catalog.revision,
    catalogRevision: catalog.catalogRevision,
    mode: catalog.mode,
    state: catalog.state,
    ...(catalog.error !== undefined ? { error: catalog.error } : {}),
    profiles: catalog.profiles,
    diagnostics: catalog.diagnostics,
  };
}

function issueMessage(
  label: string,
  error: {
    issues: readonly { path: readonly PropertyKey[]; message: string }[];
  },
): string {
  const issue = error.issues[0];
  const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
  return `${label}: ${where}${issue?.message ?? "invalid value."}`;
}

function storeFromCatalog(catalog: ProfilesCatalog): ProfileStore {
  return {
    version: 1,
    mode: catalog.mode,
    profiles: catalog.profiles,
  };
}

/** The result of applying one profile operation, before validation or writing. */
type OperationResult =
  | { ok: true; store: ProfileStore; profileId?: string }
  | { ok: false; message: string };

function applyOperation(
  store: ProfileStore,
  operation: ProfileOperation,
): OperationResult {
  if (operation.kind === "mode") {
    return { ok: true, store: { ...store, mode: operation.mode } };
  }
  if (operation.kind === "delete") {
    if (!store.profiles.some((profile) => profile.id === operation.id)) {
      return {
        ok: false,
        message: "Profile ID no longer exists. Reload profiles.",
      };
    }
    const profiles = store.profiles.filter(
      (profile) => profile.id !== operation.id,
    );
    return { ok: true, store: { ...store, profiles } };
  }
  const draft = operation.profile;
  const id = draft.id ?? randomUUID();
  const index = store.profiles.findIndex((profile) => profile.id === id);
  const key = profileNameKey(draft.name);
  const clash = store.profiles.find(
    (profile, position) =>
      position !== index && profileNameKey(profile.name) === key,
  );
  if (clash) {
    return {
      ok: false,
      message: `A profile named "${draft.name}" already exists.`,
    };
  }
  const profile = conductorProfileSchema.parse({ ...draft, id });
  const profiles =
    index === -1
      ? [...store.profiles, profile]
      : store.profiles.map((current, position) =>
          position === index ? profile : current,
        );
  if (profiles.length > PROFILE_LIMITS.profiles) {
    return {
      ok: false,
      message: `Conductor keeps at most ${PROFILE_LIMITS.profiles} profiles.`,
    };
  }
  return { ok: true, store: { ...store, profiles }, profileId: id };
}

function clampText(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

/**
 * Builds the Conductor profile store reader/writer. Reads never follow symlinks
 * and reject a file past the size cap; writes are atomic and serialized, and a
 * save whose expected revision is stale is rejected without writing.
 */
export function profileStoreSource(
  path: string | null,
  paseoProfiles?: () => Promise<readonly AgentProfile[]>,
): ProfilesSource {
  const load = async (): Promise<ProfilesCatalog> => {
    if (path === null) {
      return catalogOf(EMPTY_PROFILE_STORE, "missing");
    }
    let raw: string | undefined;
    try {
      raw = await readBoundedText(path, PROFILE_LIMITS.storeBytes);
    } catch {
      return catalogOf(EMPTY_PROFILE_STORE, "invalid", {
        error:
          "profiles.json could not be read. It may be a symlink or larger than the size limit.",
        revision: UNREADABLE_REVISION,
      });
    }
    if (raw === undefined) {
      return catalogOf(EMPTY_PROFILE_STORE, "missing");
    }
    const revision = invalidRevision(raw);
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      return catalogOf(EMPTY_PROFILE_STORE, "invalid", {
        error: "profiles.json is not valid JSON.",
        revision,
      });
    }
    const parsed = readProfileStore(value);
    if (!parsed.success) {
      return catalogOf(EMPTY_PROFILE_STORE, "invalid", {
        error: issueMessage("profiles.json", parsed.error),
        revision,
      });
    }
    return catalogOf(parsed.data, "valid");
  };

  let queue: Promise<unknown> = Promise.resolve();
  const serialize = <T>(action: () => Promise<T>): Promise<T> => {
    const pending = queue.then(action, action);
    queue = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  };

  // A namespace lock shared by every process using this Conductor directory,
  // following the SymphonyStore pattern. The in-process queue serializes one
  // instance; this fences separate installations or plugin runtimes that share
  // the same file.
  const lockPath = path === null ? null : `${path}.lock`;
  const withFilesystemLock = async <T>(
    action: () => Promise<T>,
  ): Promise<T> => {
    if (lockPath === null) {
      return action();
    }
    await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
    let acquired = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        await mkdir(lockPath, { mode: 0o700 });
        acquired = true;
        break;
      } catch (error) {
        if (!exists(error)) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    if (!acquired) {
      throw new SymphonyError(
        "Conductor profiles are being saved by another process. Retry.",
      );
    }
    try {
      return await action();
    } finally {
      await rmdir(lockPath);
    }
  };

  const persist = async (store: ProfileStore): Promise<ProfilesCatalog> => {
    if (path === null) {
      throw new SymphonyError("Conductor profile storage is unavailable.");
    }
    const encoded = JSON.stringify(store);
    if (Buffer.byteLength(encoded) > PROFILE_LIMITS.storeBytes) {
      throw new SymphonyError(
        "Conductor profile storage is full. Delete a profile before saving.",
      );
    }
    await atomicJson(path, store);
    return catalogOf(store, "valid");
  };

  return {
    path,
    load,
    save: (expectedRevision, operation) =>
      serialize(() =>
        withFilesystemLock(async () => {
          const current = await load();
          if (current.revision !== expectedRevision) {
            return {
              status: "stale",
              state: profilesState(current),
              message: STALE_SAVE_MESSAGE,
            };
          }
          const outcome = applyOperation(storeFromCatalog(current), operation);
          if (!outcome.ok) {
            throw new SymphonyError(outcome.message);
          }
          const validated = profileStoreSchema.safeParse(outcome.store);
          if (!validated.success) {
            throw new SymphonyError(
              issueMessage("Conductor profiles", validated.error),
            );
          }
          const catalog = await persist(validated.data);
          return {
            status: "saved",
            state: profilesState(catalog),
            ...(outcome.profileId ? { profileId: outcome.profileId } : {}),
          };
        }),
      ),
    importFromPaseo: (expectedRevision) =>
      serialize(() =>
        withFilesystemLock(async () => {
          const current = await load();
          if (current.revision !== expectedRevision) {
            return {
              status: "stale",
              state: profilesState(current),
              message: STALE_SAVE_MESSAGE,
            };
          }
          const peers = paseoProfiles ? await paseoProfiles() : [];
          const skipped: ImportSkip[] = [];
          const names = new Set(
            current.profiles.map((profile) => profileNameKey(profile.name)),
          );
          const profiles = [...current.profiles];
          let imported = 0;
          for (const peer of peers) {
            const reason = (message: string) => {
              skipped.push({
                name: clampText(peer.name ?? "Unnamed", 160),
                reason: clampText(message, 300),
              });
            };
            if (profiles.length >= PROFILE_LIMITS.profiles) {
              reason("Conductor profile limit reached.");
              continue;
            }
            const candidate = profileNameSchema.safeParse(peer.name ?? "");
            if (!candidate.success) {
              reason(
                candidate.error.issues[0]?.message ??
                  "The profile name is invalid.",
              );
              continue;
            }
            const name = candidate.data;
            const key = profileNameKey(name);
            if (names.has(key)) {
              reason("A profile with this name already exists.");
              continue;
            }
            const provider = (peer.provider ?? "").trim();
            if (!provider) {
              reason("The Paseo profile has no provider.");
              continue;
            }
            profiles.push(
              conductorProfileSchema.parse({
                id: randomUUID(),
                name,
                notes: clampText(peer.notes ?? "", PROFILE_LIMITS.notesChars),
                provider: clampText(provider, 80),
                ...(peer.model ? { model: clampText(peer.model, 160) } : {}),
                ...(peer.modeId ? { modeId: clampText(peer.modeId, 80) } : {}),
                ...(peer.thinkingOptionId
                  ? { thinkingOptionId: clampText(peer.thinkingOptionId, 80) }
                  : {}),
                routing: null,
                instructions: "",
              }),
            );
            names.add(key);
            imported += 1;
          }
          if (imported === 0) {
            return {
              status: "saved",
              state: profilesState(current),
              imported: 0,
              skipped,
            };
          }
          const catalog = await persist({
            ...storeFromCatalog(current),
            profiles,
          });
          return {
            status: "saved",
            state: profilesState(catalog),
            imported,
            skipped,
          };
        }),
      ),
  };
}

/** The profile store file name, re-exported so callers join one constant. */
export { PROFILES_FILE };
