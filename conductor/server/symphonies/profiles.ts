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
  SyncPreview,
  SyncPreviewEntry,
  SyncProfilesResult,
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
  /** Plans exporting the Conductor profiles without writing anything. */
  syncPreview(): Promise<SyncPreview>;
  /**
   * Exports the selected Conductor profiles to the daemon's Paseo agent
   * profiles. Writing is refused when either side changed since the preview.
   */
  syncToPaseo(
    expectedRevision: string,
    expectedPaseoRevision: string,
    profileIds: readonly string[],
  ): Promise<SyncProfilesResult>;
}

/**
 * One raw Paseo agent profile entry. The entry stays loose so icon, color,
 * feature values and fields Conductor does not know survive an export.
 */
export type PaseoProfileRecord = {
  id: string;
  name: string;
  provider: string;
  icon?: string | undefined;
  color?: string | undefined;
  model?: string | undefined;
  modeId?: string | undefined;
  thinkingOptionId?: string | undefined;
  featureValues?: Record<string, unknown> | undefined;
  notes?: string | undefined;
  [field: string]: unknown;
};

/** Reads and replaces the daemon's Paseo agent profile list. */
export interface PaseoProfilesPort {
  read(): Promise<PaseoProfileRecord[]>;
  write(next: readonly PaseoProfileRecord[]): Promise<PaseoProfileRecord[]>;
}

/** The message an export returns when either side changed since the preview. */
export const STALE_SYNC_MESSAGE = "Profiles changed. Review and sync again.";

/** The message a rejected patch returns when the daemon dropped the write. */
export const SYNC_NOT_SAVED_MESSAGE =
  "This Paseo daemon did not save agent profiles. Update Paseo and retry.";

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

/** The Paseo fields Conductor owns; every other field is preserved verbatim. */
interface ExportedProfile {
  readonly name: string;
  readonly provider: string;
  readonly model: string | undefined;
  readonly modeId: string | undefined;
  readonly thinkingOptionId: string | undefined;
  readonly notes: string | undefined;
}

function exportedProfile(profile: ConductorProfile): ExportedProfile {
  return {
    name: profile.name,
    provider: profile.provider,
    model: profile.model,
    modeId: profile.modeId,
    thinkingOptionId: profile.thinkingOptionId,
    notes: profile.notes === "" ? undefined : profile.notes,
  };
}

/** Treats an empty Paseo value as absent so a no-op edit does not write. */
function present(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === "" ? undefined : value;
}

/**
 * True when every exported field already equals the Conductor value exactly.
 * A stored optional field that is present but blank differs from an unset one,
 * so the row updates and the export removes it (and verification fails if the
 * daemon keeps it).
 */
function sameExported(
  record: PaseoProfileRecord,
  exported: ExportedProfile,
): boolean {
  return (
    record.name === exported.name &&
    record.provider === exported.provider &&
    record.model === exported.model &&
    record.modeId === exported.modeId &&
    record.thinkingOptionId === exported.thinkingOptionId &&
    record.notes === exported.notes
  );
}

/**
 * Builds the Paseo entry to write: the exported fields are set (or removed
 * when unset), and every other field, known or unknown, is kept unchanged.
 */
function withExported(
  record: PaseoProfileRecord,
  exported: ExportedProfile,
): PaseoProfileRecord {
  const next: PaseoProfileRecord = {
    ...record,
    name: exported.name,
    provider: exported.provider,
  };
  if (exported.model === undefined) {
    delete next.model;
  } else {
    next.model = exported.model;
  }
  if (exported.modeId === undefined) {
    delete next.modeId;
  } else {
    next.modeId = exported.modeId;
  }
  if (exported.thinkingOptionId === undefined) {
    delete next.thinkingOptionId;
  } else {
    next.thinkingOptionId = exported.thinkingOptionId;
  }
  if (exported.notes === undefined) {
    delete next.notes;
  } else {
    next.notes = exported.notes;
  }
  return next;
}

/** One planned export row, with the Conductor profile and Paseo entry behind it. */
export interface PaseoSyncPlanEntry {
  /** The client-facing preview row. */
  readonly preview: SyncPreviewEntry;
  /** The Conductor profile this row plans for. */
  readonly profile: ConductorProfile;
  /** The Paseo entry to write; null when the row writes nothing. */
  readonly next: PaseoProfileRecord | null;
}

function skipEntry(
  profile: ConductorProfile,
  reason: string,
): PaseoSyncPlanEntry {
  return {
    preview: {
      profileId: profile.id,
      name: clampText(profile.name, 160),
      action: "skip",
      reason: clampText(reason, 300),
    },
    profile,
    next: null,
  };
}

/** The matched Paseo name, omitted when the entry's name is blank. */
function paseoNameField(record: PaseoProfileRecord): { paseoName?: string } {
  const name = present(record.name);
  return name === undefined ? {} : { paseoName: clampText(name, 160) };
}

/** Why a name fallback cannot use a Paseo profile another row already owns. */
export const SYNC_TARGET_ALIAS_REASON =
  "Another Conductor profile already syncs to this Paseo profile.";

/**
 * Plans one export row per Conductor profile. A Paseo profile is matched by
 * the Conductor id first, then by a unique case-insensitive name; otherwise the
 * row creates a Paseo profile with the Conductor id. A duplicate name or a
 * rename onto another Paseo profile's name is skipped.
 *
 * Target collisions are resolved over the whole store before any row is
 * planned, so the preview and the sync agree regardless of source order and no
 * two rows ever target the same Paseo profile: an id match always wins, and a
 * name fallback that would land on an entry another Conductor profile already
 * matches is skipped instead.
 */
export function planPaseoSync(
  conductor: readonly ConductorProfile[],
  paseo: readonly PaseoProfileRecord[],
): PaseoSyncPlanEntry[] {
  const byId = new Map<string, PaseoProfileRecord>();
  const idTargets = new Set<string>();
  for (const profile of conductor) {
    const record = paseo.find((entry) => entry.id === profile.id);
    if (record) {
      byId.set(profile.id, record);
      idTargets.add(record.id);
    }
  }
  const candidatesOf = new Map<string, PaseoProfileRecord[]>();
  // Profile ids that name-match each Paseo entry, so an entry several rows
  // name-match is claimed by more than one and neither may use it.
  const nameClaimants = new Map<string, Set<string>>();
  for (const profile of conductor) {
    if (byId.has(profile.id)) {
      continue;
    }
    const key = profileNameKey(profile.name);
    const candidates = paseo.filter(
      (entry) => profileNameKey(entry.name) === key,
    );
    candidatesOf.set(profile.id, candidates);
    for (const candidate of candidates) {
      const claimants = nameClaimants.get(candidate.id) ?? new Set<string>();
      claimants.add(profile.id);
      nameClaimants.set(candidate.id, claimants);
    }
  }
  return conductor.map((profile) => {
    const exported = exportedProfile(profile);
    let matched = byId.get(profile.id);
    if (!matched) {
      const candidates = candidatesOf.get(profile.id) ?? [];
      // Ambiguity is judged over every Paseo entry with this name, before
      // reservations: a name two entries share stays ambiguous even when one
      // of them is another profile's id target, and is never silently narrowed
      // to the other entry.
      if (candidates.length > 1) {
        return skipEntry(profile, "Several Paseo profiles share this name.");
      }
      const [candidate] = candidates;
      if (candidate) {
        const reserved =
          idTargets.has(candidate.id) ||
          (nameClaimants.get(candidate.id)?.size ?? 0) > 1;
        if (reserved) {
          return skipEntry(profile, SYNC_TARGET_ALIAS_REASON);
        }
        matched = candidate;
      }
    }
    if (!matched) {
      return {
        preview: {
          profileId: profile.id,
          name: clampText(profile.name, 160),
          action: "create",
        },
        profile,
        next: withExported(
          {
            id: profile.id,
            name: profile.name,
            provider: profile.provider,
          },
          exported,
        ),
      };
    }
    const renaming =
      profileNameKey(matched.name) !== profileNameKey(profile.name);
    const clash =
      renaming &&
      paseo.some(
        (entry) =>
          entry.id !== matched.id &&
          profileNameKey(entry.name) === profileNameKey(profile.name),
      );
    if (clash) {
      return skipEntry(
        profile,
        `Another Paseo profile is already named "${profile.name}".`,
      );
    }
    if (sameExported(matched, exported)) {
      return {
        preview: {
          profileId: profile.id,
          name: clampText(profile.name, 160),
          action: "unchanged",
          ...paseoNameField(matched),
        },
        profile,
        next: null,
      };
    }
    return {
      preview: {
        profileId: profile.id,
        name: clampText(profile.name, 160),
        action: "update",
        ...paseoNameField(matched),
      },
      profile,
      next: withExported(matched, exported),
    };
  });
}

/** The full Paseo list to write plus the counts the dialog reports. */
export interface PaseoSyncOutcome {
  readonly list: PaseoProfileRecord[];
  /** The rows that actually write a Paseo entry. */
  readonly written: PaseoSyncPlanEntry[];
  readonly created: number;
  readonly updated: number;
  readonly unchanged: number;
  readonly skipped: ImportSkip[];
}

/**
 * Applies a plan to the Paseo list for the selected Conductor profiles only.
 * Unselected and unmatched Paseo entries keep their values and order.
 */
export function applyPaseoSync(
  plan: readonly PaseoSyncPlanEntry[],
  selectedIds: readonly string[],
  paseo: readonly PaseoProfileRecord[],
): PaseoSyncOutcome {
  const selected = new Set(selectedIds);
  const list = [...paseo];
  const written: PaseoSyncPlanEntry[] = [];
  const skipped: ImportSkip[] = [];
  let created = 0;
  let updated = 0;
  let unchanged = 0;
  for (const entry of plan) {
    if (!selected.has(entry.profile.id)) {
      continue;
    }
    if (entry.preview.action === "skip") {
      skipped.push({
        name: clampText(entry.profile.name, 160),
        reason: entry.preview.reason ?? "This profile cannot be synced.",
      });
      continue;
    }
    const next = entry.next;
    if (entry.preview.action === "unchanged" || next === null) {
      unchanged += 1;
      continue;
    }
    const index = list.findIndex((record) => record.id === next.id);
    if (index === -1) {
      list.push(next);
      created += 1;
    } else {
      list[index] = next;
      updated += 1;
    }
    written.push(entry);
  }
  return { list, written, created, updated, unchanged, skipped };
}

/** The preview the dialog redraws from. */
function syncPreviewOf(
  catalog: ProfilesCatalog,
  paseo: readonly PaseoProfileRecord[],
): SyncPreview {
  return {
    revision: catalog.revision,
    paseoRevision: digest(paseo),
    entries: planPaseoSync(catalog.profiles, paseo).map(
      (entry) => entry.preview,
    ),
  };
}

/**
 * Fails when the patch returned a list without the values Conductor wrote.
 * `sameExported` compares stored values exactly, so a daemon that kept a field
 * the export removed (including a present-but-blank one) is a dropped write.
 */
function verifySynced(
  outcome: PaseoSyncOutcome,
  saved: readonly PaseoProfileRecord[],
): void {
  for (const entry of outcome.written) {
    const next = entry.next;
    const stored =
      next === null ? undefined : saved.find((record) => record.id === next.id);
    if (!stored || !sameExported(stored, exportedProfile(entry.profile))) {
      throw new SymphonyError(SYNC_NOT_SAVED_MESSAGE);
    }
  }
}

/**
 * Builds the Conductor profile store reader/writer. Reads never follow symlinks
 * and reject a file past the size cap; writes are atomic and serialized, and a
 * save whose expected revision is stale is rejected without writing.
 */
export function profileStoreSource(
  path: string | null,
  paseoProfiles?: () => Promise<readonly AgentProfile[]>,
  paseoPort?: () => PaseoProfilesPort,
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

  const requirePaseoPort = (): PaseoProfilesPort => {
    if (!paseoPort) {
      throw new SymphonyError("Paseo profiles are unavailable.");
    }
    return paseoPort();
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
    syncPreview: () =>
      serialize(async () => {
        const current = await load();
        const paseo = await requirePaseoPort().read();
        return syncPreviewOf(current, paseo);
      }),
    syncToPaseo: (expectedRevision, expectedPaseoRevision, profileIds) =>
      serialize(() =>
        withFilesystemLock(async () => {
          const current = await load();
          const port = requirePaseoPort();
          const paseo = await port.read();
          const known = new Set(current.profiles.map((profile) => profile.id));
          // A selected id the store no longer has is stale even if the
          // revision somehow matches, so a vanished row is never a silent
          // no-op.
          if (
            current.revision !== expectedRevision ||
            digest(paseo) !== expectedPaseoRevision ||
            profileIds.some((id) => !known.has(id))
          ) {
            return {
              status: "stale",
              preview: syncPreviewOf(current, paseo),
              message: STALE_SYNC_MESSAGE,
            };
          }
          const outcome = applyPaseoSync(
            planPaseoSync(current.profiles, paseo),
            profileIds,
            paseo,
          );
          if (outcome.written.length === 0) {
            return {
              status: "saved",
              preview: syncPreviewOf(current, paseo),
              created: 0,
              updated: 0,
              unchanged: outcome.unchanged,
              skipped: outcome.skipped,
            };
          }
          const saved = await port.write(outcome.list);
          verifySynced(outcome, saved);
          return {
            status: "saved",
            preview: syncPreviewOf(current, saved),
            created: outcome.created,
            updated: outcome.updated,
            unchanged: outcome.unchanged,
            skipped: outcome.skipped,
          };
        }),
      ),
  };
}

/** The profile store file name, re-exported so callers join one constant. */
export { PROFILES_FILE };
