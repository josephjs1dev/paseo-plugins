import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import {
  profileIdSchema,
  profileOperationSchema,
  profilesStateSchema,
  revisionSchema,
  saveProfilesResultSchema,
} from "./profiles";

const label = (max: number) => z.string().trim().min(1).max(max);

/** One selectable thinking option for a model. */
export const thinkingOptionSchema = z
  .object({
    id: label(80),
    label: label(200),
    isDefault: z.boolean().default(false),
  })
  .strict();

/** One selectable model on a provider, with its thinking options. */
export const providerModelSchema = z
  .object({
    id: label(160),
    label: label(200),
    isDefault: z.boolean().default(false),
    defaultThinkingOptionId: label(80).optional(),
    thinkingOptions: z.array(thinkingOptionSchema).max(20).default([]),
  })
  .strict();

/** One permission mode a provider exposes for a task agent. */
export const providerModeSchema = z
  .object({
    id: label(80),
    label: label(200),
    description: z.string().trim().max(500).optional(),
    /** Elevated modes are only usable when the Conductor itself runs elevated. */
    elevated: z.boolean().default(false),
  })
  .strict();

/** One provider with its availability, models and modes. */
export const providerEntrySchema = z
  .object({
    id: label(80),
    label: label(200),
    available: z.boolean(),
    status: z.enum(["ready", "loading", "error", "unavailable"]),
    error: z.string().trim().max(500).optional(),
    defaultModeId: label(80).nullable(),
    models: z.array(providerModelSchema).max(200).default([]),
    modes: z.array(providerModeSchema).max(20).default([]),
  })
  .strict();

/** The provider/model/mode/thinking catalog the Podium pickers read. */
export const providerCatalogSchema = z
  .object({
    providers: z.array(providerEntrySchema).max(32).default([]),
  })
  .strict();

/** One Paseo profile the import skipped, with the reason it was skipped. */
export const importSkipSchema = z
  .object({ name: z.string().max(160), reason: label(300) })
  .strict();

/** What a sync would do to one Conductor profile. */
export const syncActionSchema = z.enum([
  "create",
  "update",
  "unchanged",
  "skip",
]);

/** One planned export row for a Conductor profile. */
export const syncPreviewEntrySchema = z
  .object({
    profileId: profileIdSchema,
    name: label(160),
    action: syncActionSchema,
    /** The matched Paseo profile's name when action is update/unchanged. */
    paseoName: label(160).optional(),
    /** Why the row is skipped; set only when action is "skip". */
    reason: label(300).optional(),
  })
  .strict();

/** What an export would do now, bound to the revisions it was planned from. */
export const syncPreviewSchema = z
  .object({
    /** The Conductor store revision the preview was computed from. */
    revision: revisionSchema,
    /** The digest of the Paseo agent profile list it was computed from. */
    paseoRevision: revisionSchema,
    entries: z.array(syncPreviewEntrySchema).max(32),
  })
  .strict();

/** An export either committed and reports counts or was rejected stale. */
export const syncProfilesResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("saved"),
      preview: syncPreviewSchema,
      created: z.number().int().nonnegative(),
      updated: z.number().int().nonnegative(),
      unchanged: z.number().int().nonnegative(),
      skipped: z.array(importSkipSchema).max(64).default([]),
    })
    .strict(),
  z
    .object({
      status: z.literal("stale"),
      preview: syncPreviewSchema,
      message: label(300),
    })
    .strict(),
]);

/** An import either committed and reports imported/skipped or was rejected stale. */
export const importProfilesResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("saved"),
      state: profilesStateSchema,
      imported: z.number().int().nonnegative(),
      skipped: z.array(importSkipSchema).max(64).default([]),
    })
    .strict(),
  z
    .object({
      status: z.literal("stale"),
      state: profilesStateSchema,
      message: label(300),
    })
    .strict(),
]);

export type ThinkingOption = z.infer<typeof thinkingOptionSchema>;
export type ProviderModel = z.infer<typeof providerModelSchema>;
export type ProviderMode = z.infer<typeof providerModeSchema>;
export type ProviderEntry = z.infer<typeof providerEntrySchema>;
export type ProviderCatalog = z.infer<typeof providerCatalogSchema>;
export type ImportSkip = z.infer<typeof importSkipSchema>;
export type ImportProfilesResult = z.infer<typeof importProfilesResultSchema>;
export type SyncAction = z.infer<typeof syncActionSchema>;
export type SyncPreviewEntry = z.infer<typeof syncPreviewEntrySchema>;
export type SyncPreview = z.infer<typeof syncPreviewSchema>;
export type SyncProfilesResult = z.infer<typeof syncProfilesResultSchema>;

/** The Conductor worker profiles, their mode, revisions and diagnostics. */
export const listProfiles = defineRpc({
  name: "profiles.list",
  input: z.object({}).strict(),
  output: profilesStateSchema,
});

/** Creates, replaces, deletes a profile, or sets the global routing mode. */
export const saveProfiles = defineRpc({
  name: "profiles.save",
  input: z
    .object({
      expectedRevision: revisionSchema,
      operation: profileOperationSchema,
    })
    .strict(),
  output: saveProfilesResultSchema,
});

/** The available providers, models, thinking options and permission modes. */
export const listProfileProviders = defineRpc({
  name: "profiles.providers",
  input: z.object({}).strict(),
  output: providerCatalogSchema,
});

/** Copies Paseo agent profiles once into unclassified Conductor profiles. */
export const importPaseoProfiles = defineRpc({
  name: "profiles.import",
  input: z.object({ expectedRevision: revisionSchema }).strict(),
  output: importProfilesResultSchema,
});

/** Plans exporting Conductor profiles to Paseo agent profiles without writing. */
export const syncPreview = defineRpc({
  // The SDK accepts only lowercase RPC method segments, so this is not
  // "profiles.syncPreview".
  name: "profiles.sync-preview",
  input: z.object({}).strict(),
  output: syncPreviewSchema,
});

/** Exports the selected Conductor profiles to Paseo agent profiles. */
export const syncProfiles = defineRpc({
  name: "profiles.sync",
  input: z
    .object({
      expectedRevision: revisionSchema,
      expectedPaseoRevision: revisionSchema,
      profileIds: z.array(profileIdSchema).min(1).max(32),
    })
    .strict(),
  output: syncProfilesResultSchema,
});
