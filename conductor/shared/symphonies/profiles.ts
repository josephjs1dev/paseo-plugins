import { z } from "zod";
import {
  profileIdSchema,
  routingDiagnosticSchema,
  routingModeSchema,
  routingProfileSchema,
} from "./routing";

export { profileIdSchema, routingModeSchema };

/** The Conductor-owned worker profile store, beside the symphony storage. */
export const PROFILES_FILE = "profiles.json";

export const PROFILE_LIMITS = {
  profiles: 32,
  nameChars: 80,
  notesChars: 1000,
  instructionsChars: 4000,
  storeBytes: 400_000,
} as const;

/** The store revision and catalog revision are SHA-256 hex digests. */
export const revisionSchema = z.string().regex(/^[a-f0-9]{64}$/);

const text = (max: number) => z.string().trim().min(1).max(max);

/**
 * The case- and Unicode-normalized form used to compare profile names, so two
 * names that differ only by case or a canonical decomposition collide.
 */
export function profileNameKey(name: string): string {
  return name.trim().normalize("NFC").toLowerCase();
}

const RESERVED_NAMES = new Set(["inherit", "tracked"]);

/**
 * A profile name is a human label, not a worker-choice source. It rejects the
 * inline worker sentinels and any name that could be mistaken for a profile id.
 */
export const profileNameSchema = z
  .string()
  .trim()
  .min(1, "Enter a name.")
  .max(PROFILE_LIMITS.nameChars)
  .refine(
    (name) => !RESERVED_NAMES.has(profileNameKey(name)),
    '"inherit" and "tracked" are reserved.',
  )
  .refine(
    (name) => !profileIdSchema.safeParse(name).success,
    "Use a name that is not a profile id.",
  );

/**
 * One Conductor worker profile: the launch settings, optional routing
 * additions and the free-text instructions delivered to its task agents.
 */
export const conductorProfileSchema = z
  .object({
    id: profileIdSchema,
    name: profileNameSchema,
    notes: z
      .string()
      .trim()
      .max(PROFILE_LIMITS.notesChars, "Notes are limited to 1000 characters.")
      .default(""),
    provider: text(80),
    model: text(160).optional(),
    thinkingOptionId: text(80).optional(),
    modeId: text(80).optional(),
    routing: routingProfileSchema.nullable().default(null),
    instructions: z
      .string()
      .trim()
      .max(
        PROFILE_LIMITS.instructionsChars,
        "Instructions are limited to 4000 characters.",
      )
      .default(""),
  })
  .strict();

/** A storage problem `storeIssues` reports for a parsed profile store. */
export interface StoreIssue {
  readonly profileIndex?: number;
  readonly field: string;
  readonly message: string;
}

/** The profile fields `storeIssues` needs, so it stays free of store typing. */
export interface ProfileIssueInput {
  readonly id: string;
  readonly name: string;
}

/**
 * The cross-profile invariants Zod cannot express per field: unique ids and
 * unique names.
 */
export function storeIssues(store: {
  readonly profiles: readonly ProfileIssueInput[];
}): StoreIssue[] {
  const issues: StoreIssue[] = [];
  const ids = new Set<string>();
  const names = new Set<string>();
  store.profiles.forEach((profile, index) => {
    if (ids.has(profile.id)) {
      issues.push({
        profileIndex: index,
        field: "id",
        message: "Profile ids must be unique.",
      });
    }
    ids.add(profile.id);
    const key = profileNameKey(profile.name);
    if (names.has(key)) {
      issues.push({
        profileIndex: index,
        field: "name",
        message: `Profile name "${profile.name}" is used more than once.`,
      });
    }
    names.add(key);
  });
  return issues;
}

/**
 * The on-disk `profiles.json` shape. A missing file is treated as
 * `EMPTY_PROFILE_STORE`; the array order is the user's list order.
 */
export const profileStoreSchema = z
  .object({
    version: z.literal(1),
    mode: routingModeSchema.default("warn"),
    profiles: z
      .array(conductorProfileSchema)
      .max(
        PROFILE_LIMITS.profiles,
        `Conductor keeps at most ${PROFILE_LIMITS.profiles} profiles.`,
      )
      .default([]),
  })
  .strict()
  .superRefine((store, ctx) => {
    for (const issue of storeIssues(store)) {
      ctx.addIssue({
        code: "custom",
        message: issue.message,
        path:
          issue.profileIndex === undefined
            ? [issue.field]
            : ["profiles", issue.profileIndex, issue.field],
      });
    }
  });

/** The pre-size routing keys a previous Conductor wrote to profiles.json. */
const LEGACY_ROUTING_KEYS = new Set([
  "domains",
  "preferenceTier",
  "fallbacks",
  "excludeWhen",
]);

/**
 * Drops the pre-size routing keys (`domains`, `preferenceTier`, `fallbacks`,
 * `excludeWhen`) from a store written before profiles kept only roles and size.
 * Roles are kept and `size` stays unset; a size is never derived from a tier or
 * a model name. Any other unknown key still fails the strict store schema.
 */
export function normalizeLegacyProfileStore(value: unknown): unknown {
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const store = value as Record<string, unknown>;
  const profiles = store.profiles as unknown[] | undefined;
  if (!Array.isArray(profiles)) {
    return value;
  }
  return {
    ...store,
    profiles: profiles.map((profile) => {
      if (typeof profile !== "object" || profile === null) {
        return profile;
      }
      const record = profile as Record<string, unknown>;
      const routing = record.routing;
      if (typeof routing !== "object" || routing === null) {
        return record;
      }
      const normalized = Object.fromEntries(
        Object.entries(routing).filter(
          ([key]) => !LEGACY_ROUTING_KEYS.has(key),
        ),
      );
      return { ...record, routing: normalized };
    }),
  };
}

/**
 * Parses a profile store, accepting the pre-size routing keys on read and
 * dropping them. Saves always write the new roles + size shape.
 */
export function readProfileStore(value: unknown) {
  return profileStoreSchema.safeParse(normalizeLegacyProfileStore(value));
}

/** A profile a save may create or replace; `id` is absent when creating. */
export const profileDraftSchema = conductorProfileSchema
  .omit({ id: true })
  .extend({ id: profileIdSchema.optional() })
  .strict();

/** One save operation: replace a profile, delete one, or set the mode. */
export const profileOperationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("upsert"), profile: profileDraftSchema }).strict(),
  z.object({ kind: z.literal("delete"), id: profileIdSchema }).strict(),
  z.object({ kind: z.literal("mode"), mode: routingModeSchema }).strict(),
]);

/** The profiles list plus its revisions, mode, load state and diagnostics. */
export const profilesStateSchema = z
  .object({
    revision: revisionSchema,
    catalogRevision: revisionSchema,
    mode: routingModeSchema,
    state: z.enum(["missing", "valid", "invalid"]),
    error: z.string().trim().max(500).optional(),
    profiles: z.array(conductorProfileSchema).max(PROFILE_LIMITS.profiles),
    diagnostics: z.array(routingDiagnosticSchema).max(40),
  })
  .strict();

/** A save either committed and returns the new state or was rejected stale. */
export const saveProfilesResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("saved"),
      state: profilesStateSchema,
      profileId: profileIdSchema.optional(),
    })
    .strict(),
  z
    .object({
      status: z.literal("stale"),
      state: profilesStateSchema,
      message: text(300),
    })
    .strict(),
]);

/** The message a rejected stale save returns to the Podium editor. */
export const STALE_SAVE_MESSAGE =
  "Profiles changed since you opened them. Your edits are kept; review the latest profiles, then save again.";

export type ConductorProfile = z.infer<typeof conductorProfileSchema>;
export type ProfileStore = z.infer<typeof profileStoreSchema>;
export type ProfileDraft = z.infer<typeof profileDraftSchema>;
export type ProfileOperation = z.infer<typeof profileOperationSchema>;
export type ProfilesState = z.infer<typeof profilesStateSchema>;
export type SaveProfilesResult = z.infer<typeof saveProfilesResultSchema>;

export const EMPTY_PROFILE_STORE: ProfileStore = {
  version: 1,
  mode: "warn",
  profiles: [],
};

export type ProfileResolution =
  | { readonly profile: ConductorProfile }
  | { readonly error: "unknown" | "ambiguous" };

/**
 * Resolves a task agent's profile reference against the Conductor store: an
 * exact id wins, then a case- and Unicode-insensitive unique name. An empty
 * store and an unmatched reference are indistinguishable, both `unknown`.
 */
export function resolveProfileRef(
  profiles: readonly ConductorProfile[],
  ref: string,
): ProfileResolution {
  const byId = profiles.find((profile) => profile.id === ref);
  if (byId) {
    return { profile: byId };
  }
  const key = profileNameKey(ref);
  const matches = profiles.filter(
    (profile) => profileNameKey(profile.name) === key,
  );
  if (matches.length === 0) {
    return { error: "unknown" };
  }
  if (matches.length > 1) {
    return { error: "ambiguous" };
  }
  const match = matches[0];
  if (!match) {
    return { error: "unknown" };
  }
  return { profile: match };
}
