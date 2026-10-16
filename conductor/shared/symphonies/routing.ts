import { z } from "zod";

const text = (max: number) => z.string().trim().min(1).max(max);

/** The routing role a task is dispatched under. Separate from `worker.role`. */
export const routingRoleSchema = z.enum([
  "exploration",
  "implementation",
  "planning",
  "review",
]);

/** The size automatic routing prefers: small < medium < large. */
export const routingSizeSchema = z.enum(["small", "medium", "large"]);

/** A stable profile id, generated when a Conductor profile is created. */
export const profileIdSchema = z.string().uuid();

/** The global routing enforcement mode. */
export const routingModeSchema = z.enum(["warn", "strict"]);
export type RoutingMode = z.infer<typeof routingModeSchema>;

/**
 * Conductor-owned routing additions for one Conductor profile: the roles it
 * serves and its size. A profile is classified only when it has at least one
 * role and a size.
 */
export const routingProfileSchema = z
  .object({
    roles: z.array(routingRoleSchema).max(4).default([]),
    size: routingSizeSchema.optional(),
  })
  .strict();

/** The allowed reasons a task bypassed the smaller-first route. */
export const routingOverrideCategorySchema = z.enum([
  "user-choice",
  "capability-gap",
  "observed-limitation",
  "no-eligible-profile",
]);

/** Why a task bypassed the smaller-first route; checked for concrete evidence. */
export const routingOverrideSchema = z
  .object({
    category: routingOverrideCategorySchema,
    evidence: text(1000),
  })
  .strict();

/** A command's optional routing explanation and bypass. */
export const commandRoutingSchema = z
  .object({
    reason: text(300),
    override: routingOverrideSchema.optional(),
  })
  .strict();

export const routingWarningCodeSchema = z.enum([
  "inherit",
  "unclassified-profile",
  "larger-than-eligible",
  "ineligible-profile",
  "unconfigured-model",
  "missing-reason",
  "generic-override-evidence",
  "invalid-override-category",
  "catalog-changed",
]);

export const routingWarningSchema = z
  .object({
    code: routingWarningCodeSchema,
    message: text(500),
  })
  .strict();

/** Who chose the worker: the Conductor, automatic routing, or an inherit. */
export const routingSelectedBySchema = z.enum([
  "conductor",
  "route",
  "inherit",
]);

const hash = z.string().regex(/^[a-f0-9]{64}$/);

/** The routing decision persisted on a stored task definition. */
export const taskRoutingSchema = z
  .object({
    role: routingRoleSchema,
    // Pre-size subject-match fields, accepted only so records stored before
    // profiles dropped them keep parsing. New decisions never write them.
    domains: z.array(z.string().max(60)).max(8).optional(),
    traits: z.array(z.string().max(60)).max(8).optional(),
    openDecision: text(500).optional(),
    reason: text(300),
    selectedBy: routingSelectedBySchema,
    override: routingOverrideSchema.optional(),
    catalogRevision: hash.optional(),
    warnings: z.array(routingWarningSchema).max(8).optional(),
  })
  .strict();

/** The routing decision persisted on an attempt's launch. */
export const attemptRoutingSchema = z
  .object({
    reason: text(300),
    selectedBy: routingSelectedBySchema,
    override: routingOverrideSchema.optional(),
  })
  .strict();

export type RoutingRole = z.infer<typeof routingRoleSchema>;
export type RoutingSize = z.infer<typeof routingSizeSchema>;
export type RoutingProfile = z.infer<typeof routingProfileSchema>;
export type RoutingOverrideCategory = z.infer<
  typeof routingOverrideCategorySchema
>;
export type RoutingOverride = z.infer<typeof routingOverrideSchema>;
export type CommandRouting = z.infer<typeof commandRoutingSchema>;
export type RoutingWarningCode = z.infer<typeof routingWarningCodeSchema>;
export type RoutingWarning = z.infer<typeof routingWarningSchema>;
export type RoutingSelectedBy = z.infer<typeof routingSelectedBySchema>;
export type TaskRouting = z.infer<typeof taskRoutingSchema>;
export type AttemptRouting = z.infer<typeof attemptRoutingSchema>;

const SIZE_RANK: Record<RoutingSize, number> = {
  small: 0,
  medium: 1,
  large: 2,
};

/** Ranks a profile size so routing can order smallest first. */
export function routingSizeRank(size: RoutingSize): number {
  return SIZE_RANK[size];
}

/**
 * True when a profile has both a role and a size, so automatic routing may
 * select it. A profile missing either reads as unclassified in the catalog.
 */
export function isClassifiedRouting(
  routing: RoutingProfile | null | undefined,
): routing is RoutingProfile & { size: RoutingSize } {
  return (
    routing !== null &&
    routing !== undefined &&
    routing.roles.length > 0 &&
    routing.size !== undefined
  );
}

/**
 * A worker selection: a configured profile or an inline provider/model. Kept
 * runtime-neutral here so routing.ts imports no command or model schema.
 */
export interface WorkerChoice {
  profile?: string;
  provider?: string;
  model?: string;
  thinkingOptionId?: string;
}

/** An eligible profile in preference order, with the short reason it fits. */
export interface RouteCandidate {
  profileId: string;
  name: string;
  provider: string;
  model?: string;
  size: RoutingSize;
  reason: string;
}

/** A profile and the requirement that eliminated it from the route. */
export interface RouteExclusion {
  profileId: string;
  name: string;
  requirement: "classification" | "role" | "availability" | "permission";
  reason: string;
}

/** A non-blocking problem observed while loading the Conductor profiles. */
export const routingDiagnosticSchema = z
  .object({
    code: z.enum(["store-missing", "store-invalid", "unclassified-profile"]),
    profileId: profileIdSchema.optional(),
    message: text(500),
  })
  .strict();
export type RoutingDiagnostic = z.infer<typeof routingDiagnosticSchema>;

export interface RouteResult {
  revision: string;
  mode: RoutingMode;
  intent: { role: RoutingRole };
  selected: RouteCandidate | null;
  alternatives: RouteCandidate[];
  excluded: RouteExclusion[];
  reasons: string[];
  explicit?: {
    choice: WorkerChoice;
    warnings: RoutingWarning[];
    errors: string[];
  };
  diagnostics: RoutingDiagnostic[];
}

export interface CatalogProfile {
  id: string;
  name: string;
  notes: string;
  provider: string;
  model?: string;
  modeId?: string;
  thinkingOptionId?: string;
  hasInstructions: boolean;
  classification: "classified" | "unclassified";
  routing: RoutingProfile | null;
}

export interface ProfilesResult {
  profiles: CatalogProfile[];
  revision: string;
  mode: RoutingMode;
  unclassified: string[];
  diagnostics: RoutingDiagnostic[];
}

/**
 * The routing role a task is routed under. An explicit role wins; otherwise a
 * review maps to review, a task with writes to implementation, and the rest to
 * exploration.
 */
export function routingRoleFor(task: {
  role?: RoutingRole;
  review?: boolean;
  writes: readonly string[];
}): RoutingRole {
  if (task.role !== undefined) {
    return task.role;
  }
  if (task.review === true) {
    return "review";
  }
  return task.writes.length > 0 ? "implementation" : "exploration";
}

/**
 * The provider selection ("provider/model") from a serialized
 * AgentLaunchConfig, or null when it is missing or unparseable. Used to
 * describe the Conductor's own launch settings without trusting the string.
 */
export function launchSelection(config?: string): string | null {
  if (config === undefined) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(config);
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    const provider = (parsed as { provider?: unknown }).provider;
    return typeof provider === "string" ? provider : null;
  } catch {
    return null;
  }
}
