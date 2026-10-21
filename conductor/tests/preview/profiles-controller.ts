import {
  EMPTY_PROFILE_STORE,
  conductorProfileSchema,
  profileDraftSchema,
  profileNameKey,
  profileStoreSchema,
  STALE_SAVE_MESSAGE,
  type ConductorProfile,
  type ProfileOperation,
  type ProfileStore,
  type ProfilesState,
  type SaveProfilesResult,
} from "../../shared/symphonies/profiles";
import {
  providerCatalogSchema,
  type ImportSkip,
  type ProviderCatalog,
} from "../../shared/symphonies/profiles-rpc";
import type {
  ImportProfilesResult,
  SyncPreview,
  SyncPreviewEntry,
  SyncProfilesResult,
} from "../../shared/symphonies/profiles-rpc";
import { isClassifiedRouting } from "../../shared/symphonies/routing";

/**
 * One shared preview engine for the profiles store: the same revision,
 * staleness and replacement rules the daemon enforces, in memory. The stub
 * hook (profiles.ts) drives it through ProfilesData; the plugin-client fake
 * (plugin-client.tsx) drives it through the real RPC shapes, so both traces
 * in these browser tests run over the same mutation semantics.
 */

/** Deterministic store ids the browser tests can spell out in assertions. */
const FAST_ID = "f1000000-0000-4000-8000-000000000001";
const REVIEW_ID = "f1000000-0000-4000-8000-000000000002";
const HELPER_ID = "f1000000-0000-4000-8000-000000000003";
const LEGACY_ID = "f1000000-0000-4000-8000-000000000004";
const CLAUDE_ID = "f1000000-0000-4000-8000-000000000005";
const CODEX_ID = "f1000000-0000-4000-8000-000000000006";
const PI_ID = "f1000000-0000-4000-8000-000000000007";
const MISTRAL_ID = "f1000000-0000-4000-8000-000000000008";

const fixtureProfile = (
  id: string,
  values: Omit<ConductorProfile, "id">,
): ConductorProfile => ({ id, ...values });

const FAST_PROFILE = fixtureProfile(FAST_ID, {
  name: "Fast responder",
  notes: "Small, quick tasks and lookups.",
  provider: "anthropic",
  model: "claude-sonnet-4-5",
  thinkingOptionId: "standard",
  modeId: "acceptEdits",
  routing: { roles: ["implementation", "exploration"], size: "small" },
  instructions:
    "Run the focused tests before reporting done. Skill names: use the paseo skill for harness questions.",
});

const REVIEW_PROFILE = fixtureProfile(REVIEW_ID, {
  name: "Deep reviewer",
  notes: "Read-only review passes with extended thinking.",
  provider: "anthropic",
  model: "claude-opus-4-6",
  thinkingOptionId: "extended",
  modeId: "read-only",
  routing: { roles: ["review", "planning"], size: "large" },
  instructions: "Cite file and line numbers for every finding.",
});

/** An unclassified profile on an unavailable provider. */
const HELPER_PROFILE = fixtureProfile(HELPER_ID, {
  name: "Unrouted helper",
  notes: "Launched only by explicit worker choice.",
  provider: "ollama",
  model: "local-model",
  routing: null,
  instructions: "",
});

/**
 * A profile written by the pre-size store: roles survive the legacy read,
 * the size was never a field, and nothing may be inferred from the tier.
 */
const LEGACY_PROFILE = fixtureProfile(LEGACY_ID, {
  name: "Legacy router",
  notes: "Loaded from an older store: roles kept, size unset.",
  provider: "openai",
  model: "gpt-5",
  routing: { roles: ["planning"] },
  instructions: "",
});

/** One profile per harness mark: bundled assets, drawn, and the monogram. */
const CLAUDE_PROFILE = fixtureProfile(CLAUDE_ID, {
  name: "Claude planner",
  notes: "Plans and coordinates work across tasks.",
  provider: "claude",
  model: "claude-opus-5-5",
  thinkingOptionId: "medium",
  modeId: "read-only",
  routing: { roles: ["planning"], size: "medium" },
  instructions: "",
});

const CODEX_PROFILE = fixtureProfile(CODEX_ID, {
  name: "Codex runner",
  notes: "Runs the long implementation passes.",
  provider: "codex",
  model: "codex-max",
  modeId: "full-access",
  routing: { roles: ["implementation"], size: "large" },
  instructions: "",
});

const PI_PROFILE = fixtureProfile(PI_ID, {
  name: "Pi explorer",
  notes: "Explores the codebase and reports findings.",
  provider: "pi",
  model: "pi-5",
  thinkingOptionId: "standard",
  modeId: "read-only",
  routing: { roles: ["exploration"], size: "small" },
  instructions: "",
});

/** A provider the catalog does not know: raw ids and a monogram mark. */
const MISTRAL_PROFILE = fixtureProfile(MISTRAL_ID, {
  name: "Mistral oddball",
  notes: "Launched only by explicit worker choice.",
  provider: "mistral",
  model: "mistral-large-3",
  modeId: "full-access",
  routing: { roles: ["review"], size: "medium" },
  instructions: "",
});

const INITIAL_STORE = profileStoreSchema.parse({
  version: 1,
  mode: "warn",
  profiles: [
    FAST_PROFILE,
    REVIEW_PROFILE,
    HELPER_PROFILE,
    LEGACY_PROFILE,
    CLAUDE_PROFILE,
    CODEX_PROFILE,
    PI_PROFILE,
    MISTRAL_PROFILE,
  ],
});

/** The provider/model/mode catalog the editor pickers read, parsed like the RPC. */
export const FIXTURE_PROVIDERS: ProviderCatalog = providerCatalogSchema.parse({
  providers: [
    {
      id: "anthropic",
      label: "Anthropic",
      available: true,
      status: "ready",
      defaultModeId: "acceptEdits",
      models: [
        {
          id: "claude-sonnet-4-5",
          label: "Claude Sonnet 4.5",
          isDefault: true,
          defaultThinkingOptionId: "standard",
          thinkingOptions: [
            { id: "standard", label: "Standard", isDefault: true },
            { id: "extended", label: "Extended", isDefault: false },
          ],
        },
        {
          id: "claude-opus-4-6",
          label: "Claude Opus 4.6",
          isDefault: false,
          thinkingOptions: [
            { id: "standard", label: "Standard", isDefault: false },
            { id: "extended", label: "Extended", isDefault: true },
          ],
        },
      ],
      modes: [
        {
          id: "read-only",
          label: "Read only",
          description: "Cannot write files.",
          elevated: false,
        },
        {
          id: "acceptEdits",
          label: "Accept edits",
          description: "Edits files without asking.",
          elevated: false,
        },
        {
          id: "full-access",
          label: "Full access",
          description: "Runs every command.",
          elevated: true,
        },
      ],
    },
    {
      id: "openai",
      label: "OpenAI",
      available: true,
      status: "ready",
      defaultModeId: "read-only",
      models: [
        {
          id: "gpt-5",
          label: "GPT-5",
          isDefault: true,
          thinkingOptions: [],
        },
      ],
      modes: [
        {
          id: "read-only",
          label: "Read only",
          elevated: false,
        },
      ],
    },
    {
      id: "ollama",
      label: "Ollama local",
      available: false,
      status: "unavailable",
      error: "Not reachable.",
      defaultModeId: null,
      models: [
        {
          id: "local-model",
          label: "Local model",
          isDefault: true,
          thinkingOptions: [],
        },
      ],
      modes: [],
    },
    {
      id: "claude",
      label: "Claude",
      available: true,
      status: "ready",
      defaultModeId: "read-only",
      models: [
        {
          id: "claude-opus-5-5",
          label: "Opus 5.5",
          isDefault: true,
          thinkingOptions: [{ id: "medium", label: "Medium", isDefault: true }],
        },
      ],
      modes: [
        {
          id: "read-only",
          label: "Read only",
          elevated: false,
        },
      ],
    },
    {
      id: "codex",
      label: "Codex",
      available: true,
      status: "ready",
      defaultModeId: "full-access",
      models: [
        {
          id: "codex-max",
          label: "Codex Max",
          isDefault: true,
          thinkingOptions: [],
        },
      ],
      modes: [
        {
          id: "full-access",
          label: "Full access",
          elevated: true,
        },
      ],
    },
    {
      id: "pi",
      label: "Pi",
      available: true,
      status: "ready",
      defaultModeId: "read-only",
      models: [
        {
          id: "pi-5",
          label: "Pi 5",
          isDefault: true,
          thinkingOptions: [
            { id: "standard", label: "Standard", isDefault: true },
          ],
        },
      ],
      modes: [
        {
          id: "read-only",
          label: "Read only",
          elevated: false,
        },
      ],
    },
  ],
});

/**
 * One raw Paseo agent profile entry in the preview daemon config. The entry
 * stays loose so icon, color, feature values and unknown fields can survive
 * an export, like server's PaseoProfileRecord.
 */
type PreviewPaseoProfile = {
  id: string;
  name: string;
  provider: string;
  [field: string]: unknown;
};

const PASEO_DOCS_ID = "e2000000-0000-4000-8000-000000000001";
const PASEO_MIGRATION_ID = "e2000000-0000-4000-8000-000000000002";

/**
 * The Paseo agent profiles the one-time import copies and the export writes
 * to. The extras (icon, color) are deliberately preserved across a sync, so
 * the browser tests can assert the raw-entry behavior too.
 */
/**
 * The message the export returns when either side changed since the preview;
 * mirrors STALE_SYNC_MESSAGE on the server.
 */
const STALE_SYNC_MESSAGE = "Profiles changed. Review and sync again.";

const PASEO_PROFILES: PreviewPaseoProfile[] = [
  {
    id: PASEO_DOCS_ID,
    name: "Docs writer",
    notes: "Writes and reviews user documentation.",
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    modeId: "read-only",
    icon: "PenTool",
    color: "#512BD4",
  },
  {
    id: PASEO_MIGRATION_ID,
    name: "Migration runner",
    notes: "Runs the long migrations.",
    provider: "openai",
    model: "gpt-5",
    modeId: "full-access",
  },
];

/** Deterministic stand-in for the server's whole-store hash: stable per seq. */
function storeRevision(seq: number): string {
  const hex = (value: number): string =>
    (value >>> 0).toString(16).padStart(8, "0");
  return `${hex(seq)}${hex(seq * 2654435761)}${hex(seq * 1013904223)}${hex(
    seq * 1103515245,
  )}${hex(seq * 2147483647)}${hex(seq * 22695477)}${hex(
    seq * 65537,
  )}${hex(seq * 40503)}`.slice(0, 64);
}

/** Recursively sorts object keys so a content hash ignores key order, mirroring the server. */
function canonicalJson(value: unknown): string {
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

/**
 * Deterministic stand-in for the server's sha256(canonicalJson(list)) digest:
 * eight seeded FNV-1a words over the canonical JSON, enough to distinguish
 * Paseo list states without webCrypto in unit-like flows.
 */
function paseoRevisionOf(values: readonly PreviewPaseoProfile[]): string {
  const json = canonicalJson(values);
  let hex = "";
  for (let seed = 0; seed < 8; seed += 1) {
    let hash = (0x811c9dc5 ^ Math.imul(seed + 1, 0x9e3779b9)) >>> 0;
    for (let index = 0; index < json.length; index += 1) {
      hash ^= json.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    hex += hash.toString(16).padStart(8, "0");
  }
  return hex;
}

/** Treats an empty or non-string value as absent, like the server's `present`. */
function present(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/**
 * The exported fields (name/provider/model/modeId/thinkingOptionId/notes)
 * Conductor owns; every other Paseo field is preserved verbatim.
 */
interface ExportedPaseoFields {
  readonly name: string;
  readonly provider: string;
  readonly model: string | undefined;
  readonly modeId: string | undefined;
  readonly thinkingOptionId: string | undefined;
  readonly notes: string | undefined;
}

function exportedFields(profile: ConductorProfile): ExportedPaseoFields {
  return {
    name: profile.name,
    provider: profile.provider,
    model: profile.model,
    modeId: profile.modeId,
    thinkingOptionId: profile.thinkingOptionId,
    notes: profile.notes === "" ? undefined : profile.notes,
  };
}

/**
 * True when every exported field already equals the Conductor value exactly.
 * A stored optional field that is present but blank differs from an unset
 * one, so the row updates and the export removes it.
 */
function sameExported(
  record: PreviewPaseoProfile,
  exported: ExportedPaseoFields,
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
 * when unset), and every other field — icon, color, feature values, unknown
 * — is kept unchanged.
 */
function withExportedFields(
  record: PreviewPaseoProfile,
  exported: ExportedPaseoFields,
): PreviewPaseoProfile {
  const next: PreviewPaseoProfile = {
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

function diagnosticsFor(
  profiles: readonly ConductorProfile[],
): ProfilesState["diagnostics"] {
  return profiles
    .filter((profile) => !isClassifiedRouting(profile.routing))
    .map((profile) => ({
      code: "unclassified-profile" as const,
      profileId: profile.id,
      message: `Profile "${profile.name}" has no routing classification.`,
    }));
}

function stateFor(
  store: ProfileStore,
  seq: number,
  invalidError?: string | null,
): ProfilesState {
  const revision = storeRevision(seq);
  if (invalidError) {
    return {
      revision,
      catalogRevision: revision,
      mode: store.mode,
      state: "invalid",
      error: invalidError,
      profiles: [],
      diagnostics: [],
    };
  }
  return {
    revision,
    catalogRevision: storeRevision(seq * 7 + 1),
    mode: store.mode,
    state: "valid",
    profiles: store.profiles,
    diagnostics: diagnosticsFor(store.profiles),
  };
}

let createdCount = 0;

/** `crypto.randomUUID` when present, else a deterministic preview uuid. */
function newProfileId(): string {
  const globalCrypto = (
    globalThis as { crypto?: { randomUUID?: () => string } }
  ).crypto;
  if (globalCrypto?.randomUUID) {
    return globalCrypto.randomUUID();
  }
  createdCount += 1;
  return `c0ffee00-0000-4000-8000-${String(createdCount).padStart(12, "0")}`;
}

export interface PreviewProfilesOptions {
  /** Start with no profiles at all. */
  empty?: boolean;
  /** Every mutation returns the stale result, like a raced-out editor. */
  stale?: boolean;
  /** Start with an invalid store the next matching save replaces. */
  invalid?: boolean;
  /** Leave the provider catalog unloaded for the editor pickers. */
  noProviders?: boolean;
}

export class PreviewProfilesController {
  private readonly options: PreviewProfilesOptions;
  private seq: number;
  private store: ProfileStore;
  private invalidError: string | null;
  private paseo: PreviewPaseoProfile[];

  constructor(options: PreviewProfilesOptions = {}) {
    this.options = options;
    this.seq = 1;
    this.invalidError = options.invalid
      ? "profiles.json is not valid JSON."
      : null;
    this.store = options.empty
      ? { version: 1, mode: "warn", profiles: [] }
      : INITIAL_STORE;
    this.paseo = PASEO_PROFILES.map((record) => ({ ...record }));
  }

  /** The revision migrations compare against; advanced on every write. */
  revision(): string {
    return storeRevision(this.seq);
  }

  state(): ProfilesState {
    return stateFor(this.store, this.seq, this.invalidError);
  }

  providers(): ProviderCatalog | undefined {
    return this.options.noProviders ? undefined : FIXTURE_PROVIDERS;
  }

  /** The current Paseo agent profile list (copies). */
  paseoList(): PreviewPaseoProfile[] {
    return this.paseo.map((record) => ({ ...record }));
  }

  list(): ProfilesState {
    return this.state();
  }

  /** The stale result shape both the save and import result unions accept. */
  private staleResult(): {
    status: "stale";
    state: ProfilesState;
    message: string;
  } {
    return {
      status: "stale",
      state: this.state(),
      message: STALE_SAVE_MESSAGE,
    };
  }

  /** Another client saves straight to the store, advancing the revision. */
  otherClientSaves(name: string, changes: { instructions?: string }): void {
    const target = this.store.profiles.find(
      (profile) => profileNameKey(profile.name) === profileNameKey(name),
    );
    if (!target) {
      throw new Error(`No preview profile named "${name}".`);
    }
    this.store = {
      ...this.store,
      profiles: this.store.profiles.map((profile) =>
        profile.id === target.id
          ? {
              ...profile,
              ...(changes.instructions !== undefined
                ? { instructions: changes.instructions }
                : {}),
            }
          : profile,
      ),
    };
    this.seq += 1;
  }

  async save(
    expectedRevision: string,
    operation: ProfileOperation,
  ): Promise<SaveProfilesResult> {
    if (this.options.stale || this.revision() !== expectedRevision) {
      return this.staleResult();
    }
    // An invalid store is replaced: the operation applies to an empty store,
    // exactly like the daemon's replacement behavior.
    const base = this.invalidError !== null ? EMPTY_PROFILE_STORE : this.store;
    let candidate: ProfileStore;
    let profileIdHint: string | undefined;
    if (operation.kind === "upsert") {
      const parsed = profileDraftSchema.safeParse(operation.profile);
      if (!parsed.success) {
        throw new Error(
          parsed.error.issues[0]?.message ?? "The profile is not valid.",
        );
      }
      const profile = parsed.data;
      const key = profileNameKey(profile.name);
      const clash = base.profiles.find(
        (other) =>
          profileNameKey(other.name) === key && other.id !== profile.id,
      );
      if (clash) {
        throw new Error(`A profile named "${clash.name}" already exists.`);
      }
      if (profile.id && !base.profiles.some((p) => p.id === profile.id)) {
        throw new Error("Profile ID no longer exists. Reload profiles.");
      }
      candidate = {
        ...base,
        mode: base.mode,
        profiles: profile.id
          ? base.profiles.map((other) =>
              other.id === profile.id
                ? conductorProfileSchema.parse(profile)
                : other,
            )
          : [
              ...base.profiles,
              conductorProfileSchema.parse({
                ...profile,
                id: newProfileId(),
              }),
            ],
      };
      profileIdHint = profile.id;
    } else if (operation.kind === "delete") {
      if (!base.profiles.some((profile) => profile.id === operation.id)) {
        throw new Error("Profile ID no longer exists. Reload profiles.");
      }
      candidate = {
        ...base,
        profiles: base.profiles.filter(
          (profile) => profile.id !== operation.id,
        ),
      };
    } else {
      candidate = { ...base, mode: operation.mode };
      // The preview keeps the mode write briefly pending, mirroring the
      // daemon's round trip, so tests can observe the busy-disabled toggle.
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    this.store = candidate;
    this.seq += 1;
    this.invalidError = null;
    const result: SaveProfilesResult = {
      status: "saved",
      state: stateFor(this.store, this.seq),
    };
    if (profileIdHint !== undefined && operation.kind === "upsert") {
      return { ...result, profileId: profileIdHint };
    }
    return result;
  }

  async importFromPaseo(
    expectedRevision: string,
  ): Promise<ImportProfilesResult> {
    if (this.options.stale || this.revision() !== expectedRevision) {
      return this.staleResult();
    }
    const base = this.invalidError !== null ? EMPTY_PROFILE_STORE : this.store;
    const imported: ConductorProfile[] = [];
    const skipped: { name: string; reason: string }[] = [];
    for (const paseo of PASEO_PROFILES) {
      const clash = base.profiles.some(
        (profile) =>
          profileNameKey(profile.name) === profileNameKey(paseo.name),
      );
      const capReached = base.profiles.length + imported.length >= 32;
      if (clash) {
        skipped.push({
          name: paseo.name,
          reason: `A profile named "${paseo.name}" already exists.`,
        });
        continue;
      }
      if (capReached) {
        skipped.push({
          name: paseo.name,
          reason: "Conductor keeps at most 32 profiles.",
        });
        continue;
      }
      imported.push(
        conductorProfileSchema.parse({
          id: newProfileId(),
          name: paseo.name,
          notes: paseo.notes,
          provider: paseo.provider,
          model: paseo.model,
          modeId: paseo.modeId,
          routing: null,
          instructions: "",
        }),
      );
    }
    this.store = { ...base, profiles: [...base.profiles, ...imported] };
    this.seq += 1;
    this.invalidError = null;
    return {
      status: "saved",
      state: stateFor(this.store, this.seq),
      imported: imported.length,
      skipped,
    };
  }

  /**
   * Plans one export row per Conductor profile, running the same match and
   * field rules the server enforces. A Paseo profile is matched by the
   * Conductor id first, then by a unique case-insensitive name; otherwise the
   * row creates a Paseo profile with the Conductor id. Duplicate names,
   * rename clashes and target collisions skip; unchanged rows write nothing.
   *
   * Target collisions are resolved over the whole store before any row is
   * planned, so preview and sync agree regardless of source order and no two
   * rows ever target the same Paseo profile: an id match always wins, and a
   * name fallback that would land on an entry another Conductor profile
   * already matches is skipped instead.
   */
  private planSync(): {
    preview: SyncPreviewEntry;
    next: PreviewPaseoProfile | null;
  }[] {
    const profiles = this.store.profiles;
    const byId = new Map<string, PreviewPaseoProfile>();
    const idTargets = new Set<string>();
    for (const profile of profiles) {
      const record = this.paseo.find((entry) => entry.id === profile.id);
      if (record) {
        byId.set(profile.id, record);
        idTargets.add(record.id);
      }
    }
    const candidatesOf = new Map<string, PreviewPaseoProfile[]>();
    // Profile ids that name-match each Paseo entry, so an entry several rows
    // name-match is claimed by more than one and neither may use it.
    const nameClaimants = new Map<string, Set<string>>();
    for (const profile of profiles) {
      if (byId.has(profile.id)) {
        continue;
      }
      const key = profileNameKey(profile.name);
      const candidates = this.paseo.filter(
        (record) => profileNameKey(record.name) === key,
      );
      candidatesOf.set(profile.id, candidates);
      for (const candidate of candidates) {
        const claimants = nameClaimants.get(candidate.id) ?? new Set<string>();
        claimants.add(profile.id);
        nameClaimants.set(candidate.id, claimants);
      }
    }
    const aliasSkip =
      "Another Conductor profile already syncs to this Paseo profile.";
    return profiles.map((profile) => {
      const exported = exportedFields(profile);
      const base = { profileId: profile.id, name: profile.name };
      let matched = byId.get(profile.id);
      if (!matched) {
        const candidates = candidatesOf.get(profile.id) ?? [];
        // Ambiguity is judged over every Paseo entry with this name, before
        // reservations: a name two entries share stays ambiguous even when
        // one of them is another profile's id target, and is never silently
        // narrowed to the other entry.
        if (candidates.length > 1) {
          return {
            preview: {
              ...base,
              action: "skip",
              reason: "Several Paseo profiles share this name.",
            },
            next: null,
          } as const;
        }
        const [candidate] = candidates;
        if (candidate) {
          const reserved =
            idTargets.has(candidate.id) ||
            (nameClaimants.get(candidate.id)?.size ?? 0) > 1;
          if (reserved) {
            return {
              preview: { ...base, action: "skip", reason: aliasSkip },
              next: null,
            } as const;
          }
          matched = candidate;
        }
      }
      if (!matched) {
        return {
          preview: { ...base, action: "create" },
          next: withExportedFields(
            { id: profile.id, name: profile.name, provider: profile.provider },
            exported,
          ),
        } as const;
      }
      const clash =
        profileNameKey(matched.name) !== profileNameKey(profile.name) &&
        this.paseo.some(
          (other) =>
            other.id !== matched.id &&
            profileNameKey(other.name) === profileNameKey(profile.name),
        );
      if (clash) {
        return {
          preview: {
            ...base,
            action: "skip",
            reason: `Another Paseo profile is already named "${profile.name}".`,
          },
          next: null,
        } as const;
      }
      const matchedName = present(matched.name);
      const paseoName =
        matchedName === undefined ? {} : { paseoName: matchedName };
      if (sameExported(matched, exported)) {
        return {
          preview: { ...base, action: "unchanged", ...paseoName },
          next: null,
        } as const;
      }
      return {
        preview: { ...base, action: "update", ...paseoName },
        next: withExportedFields(matched, exported),
      } as const;
    });
  }

  /** The preview the dialog loads: current plan bound to both revisions. */
  async syncPreview(): Promise<SyncPreview> {
    return {
      revision: this.revision(),
      paseoRevision: paseoRevisionOf(this.paseo),
      entries: this.planSync().map((entry) => entry.preview),
    };
  }

  /**
   * Exports the selected profiles, refusing when either side changed since
   * the preview; stale writes nothing and returns the fresh plan.
   */
  async syncToPaseo(
    expectedRevision: string,
    expectedPaseoRevision: string,
    profileIds: readonly string[],
  ): Promise<SyncProfilesResult> {
    if (
      this.options.stale ||
      this.revision() !== expectedRevision ||
      paseoRevisionOf(this.paseo) !== expectedPaseoRevision
    ) {
      const preview = await this.syncPreview();
      return { status: "stale", preview, message: STALE_SYNC_MESSAGE };
    }
    const selected = new Set(profileIds);
    const list = [...this.paseo];
    const skipped: ImportSkip[] = [];
    let created = 0;
    let updated = 0;
    let unchanged = 0;
    for (const entry of this.planSync()) {
      if (!selected.has(entry.preview.profileId)) {
        continue;
      }
      if (entry.preview.action === "skip") {
        skipped.push({
          name: entry.preview.name,
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
    }
    this.paseo = list;
    const preview = await this.syncPreview();
    return { status: "saved", preview, created, updated, unchanged, skipped };
  }
}
