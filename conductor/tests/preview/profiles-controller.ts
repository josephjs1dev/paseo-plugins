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
  type ProviderCatalog,
} from "../../shared/symphonies/profiles-rpc";
import type { ImportProfilesResult } from "../../shared/symphonies/profiles-rpc";
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

const INITIAL_STORE = profileStoreSchema.parse({
  version: 1,
  mode: "warn",
  profiles: [FAST_PROFILE, REVIEW_PROFILE, HELPER_PROFILE, LEGACY_PROFILE],
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
  ],
});

/** The Paseo agent profiles the one-time import copies once. */
const PASEO_PROFILES = [
  {
    name: "Docs writer",
    notes: "Writes and reviews user documentation.",
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    modeId: "read-only",
  },
  {
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

  constructor(options: PreviewProfilesOptions = {}) {
    this.options = options;
    this.seq = 1;
    this.invalidError = options.invalid
      ? "profiles.json is not valid JSON."
      : null;
    this.store = options.empty
      ? { version: 1, mode: "warn", profiles: [] }
      : INITIAL_STORE;
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
}
