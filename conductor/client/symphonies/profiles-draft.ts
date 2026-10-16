/**
 * Editor-side form state and validation for a Conductor worker profile.
 * Pure data with no React imports, like routing.ts: the editor consumes the
 * field-error map directly and turns a validated form into a save operation.
 * The server re-validates everything; this module only keeps obvious mistakes
 * out of the request and gives each field a readable inline message.
 */
import {
  PROFILE_LIMITS,
  profileDraftSchema,
  profileNameKey,
  profileNameSchema,
  type ConductorProfile,
  type ProfileDraft,
} from "../../shared/symphonies/profiles";
import {
  routingSizeSchema,
  type RoutingRole,
  type RoutingSize,
} from "../../shared/symphonies/routing";

/**
 * Whether the profile participates in automatic routing. Routing keeps only
 * roles and size; the profile notes ("When to use") carry the human guidance
 * the Conductor matches subject matter with.
 */
export type ProfileForm = {
  /** Absent for a created or duplicated profile; the server assigns the id. */
  id: string | undefined;
  name: string;
  notes: string;
  provider: string;
  /** Raw input; an empty string means unset. */
  model: string;
  thinkingOptionId: string;
  modeId: string;
  /** The roles this profile may serve; at least one plus a size classifies it. */
  roles: RoutingRole[];
  /** The size routing prefers; "" when unset. Never inferred from anything. */
  size: string;
  instructions: string;
};

/** A fresh draft: nothing is assumed about the user's intent, so no routing. */
export function newProfileForm(): ProfileForm {
  return {
    id: undefined,
    name: "",
    notes: "",
    provider: "",
    model: "",
    thinkingOptionId: "",
    modeId: "",
    roles: [],
    size: "",
    instructions: "",
  };
}

/** A duplicate starts as a new profile with a copy-suffixed name. */
export function duplicateProfileForm(profile: ConductorProfile): ProfileForm {
  return {
    ...profileFormFor(profile),
    id: undefined,
    name: `${profile.name} (copy)`.slice(0, PROFILE_LIMITS.nameChars),
  };
}

export function profileFormFor(profile: ConductorProfile): ProfileForm {
  return {
    id: profile.id,
    name: profile.name,
    notes: profile.notes,
    provider: profile.provider,
    model: profile.model ?? "",
    thinkingOptionId: profile.thinkingOptionId ?? "",
    modeId: profile.modeId ?? "",
    roles: [...(profile.routing?.roles ?? [])],
    size: profile.routing?.size ?? "",
    instructions: profile.instructions,
  };
}

/** The role choices and their order in the editor. */
export const PROFILE_ROLES: readonly RoutingRole[] = [
  "exploration",
  "implementation",
  "planning",
  "review",
];

/** The size choices and their order in the editor. */
export const PROFILE_SIZES: readonly RoutingSize[] = [
  "small",
  "medium",
  "large",
];

/**
 * A canonical form fingerprint for change detection: the editor's Save stays
 * disabled until the draft differs from what it was opened with. Role order
 * is not meaningful to routing, so it is sorted away here.
 */
export function profileFormKey(form: ProfileForm): string {
  return JSON.stringify({
    id: form.id,
    name: form.name,
    notes: form.notes,
    provider: form.provider,
    model: form.model,
    thinkingOptionId: form.thinkingOptionId,
    modeId: form.modeId,
    roles: [...form.roles].sort(),
    size: form.size,
    instructions: form.instructions,
  });
}

/** Field keys used in the error map; `profile-error-${field}` testIDs. */
export type ProfileField =
  | "name"
  | "notes"
  | "provider"
  | "model"
  | "thinkingOptionId"
  | "modeId"
  | "roles"
  | "size"
  | "instructions";

export type ProfileFormErrors = Partial<Record<ProfileField, string>>;

const FIELD_LIMIT_MESSAGE: Partial<Record<ProfileField, string>> = {
  notes: "Notes are limited to 1000 characters.",
  instructions: "Instructions are limited to 4000 characters.",
};

function limitOf(field: ProfileField): number | undefined {
  switch (field) {
    case "name":
      return PROFILE_LIMITS.nameChars;
    case "notes":
      return PROFILE_LIMITS.notesChars;
    case "instructions":
      return PROFILE_LIMITS.instructionsChars;
    case "provider":
      return 80;
    case "model":
      return 160;
    case "thinkingOptionId":
    case "modeId":
      return 80;
    default:
      return undefined;
  }
}

/**
 * Validates the form against the profile schema plus the cross-profile
 * invariants the store keeps (unique names). Roles and size are warned about
 * on the profile card, not rejected: an unclassified profile is legitimate.
 */
export function validateProfileForm(
  form: ProfileForm,
  profiles: readonly ConductorProfile[],
): ProfileFormErrors {
  const errors: ProfileFormErrors = {};
  const checkText = (field: ProfileField, value: string) => {
    const limit = limitOf(field);
    const message = FIELD_LIMIT_MESSAGE[field];
    if (limit !== undefined && value.trim().length > limit) {
      errors[field] = message ?? `Limited to ${limit} characters.`;
    }
  };
  // The name is judged by the store's own name schema, so the reserved
  // words and id-shaped names the store rejects surface inline, not as a
  // generic save error.
  const nameCheck = profileNameSchema.safeParse(form.name);
  if (!nameCheck.success) {
    errors.name = nameCheck.error.issues[0]?.message ?? "Enter a name.";
  } else {
    checkText("name", form.name);
    const key = profileNameKey(form.name);
    const duplicate = profiles.find(
      (profile) =>
        profileNameKey(profile.name) === key &&
        (form.id === undefined || profile.id !== form.id),
    );
    if (duplicate) {
      errors.name = `A profile named "${duplicate.name}" already exists.`;
    }
  }
  checkText("notes", form.notes);
  if (form.provider.trim() === "") {
    errors.provider = "Choose or enter a provider.";
  } else {
    checkText("provider", form.provider);
  }
  checkText("model", form.model);
  checkText("thinkingOptionId", form.thinkingOptionId);
  checkText("modeId", form.modeId);
  checkText("instructions", form.instructions);
  // Roles and size come only from the toggle chips and segmented control, so
  // they are always valid choices; the profile draft schema re-checks them.
  return errors;
}

/** The chosen size, or undefined when no size is set or it is not valid. */
export function profileSizeValue(form: ProfileForm): RoutingSize | undefined {
  const check = routingSizeSchema.safeParse(form.size);
  if (form.size === "" || !check.success) {
    return undefined;
  }
  return check.data;
}

/** Builds a schema-shaped draft; call only when `validateProfileForm` is clean. */
export function profileDraftFromForm(form: ProfileForm): ProfileDraft {
  const size = profileSizeValue(form);
  const routing =
    form.roles.length === 0 && size === undefined
      ? null
      : {
          roles: [...form.roles],
          ...(size === undefined ? {} : { size }),
        };
  const draft: ProfileDraft = {
    ...(form.id !== undefined ? { id: form.id } : {}),
    name: form.name.trim(),
    notes: form.notes.trim(),
    provider: form.provider.trim(),
    model: form.model.trim() || undefined,
    thinkingOptionId: form.thinkingOptionId.trim() || undefined,
    modeId: form.modeId.trim() || undefined,
    routing,
    instructions: form.instructions.trim(),
  };
  // The draft schema is the single shape authority; a successful parse
  // guarantees the draft carries only the fields the store accepts.
  const parsed = profileDraftSchema.safeParse(draft);
  if (!parsed.success) {
    throw new Error(
      `The profile has a problem: ${parsed.error.issues[0]?.message ?? "invalid value."}`,
    );
  }
  return parsed.data;
}
