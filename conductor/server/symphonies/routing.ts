import {
  isClassifiedRouting,
  routingRoleFor,
  routingSizeRank,
  type CatalogProfile,
  type CommandRouting,
  type ProfilesResult,
  type RouteCandidate,
  type RouteExclusion,
  type RouteResult,
  type RoutingMode,
  type RoutingOverride,
  type RoutingProfile,
  type RoutingRole,
  type RoutingSize,
  type RoutingWarning,
  type TaskRouting,
  type WorkerChoice,
} from "../../shared/symphonies/routing";
import {
  resolveProfileRef,
  type ConductorProfile,
} from "../../shared/symphonies/profiles";
import {
  PROFILES_FILE,
  canonicalJson,
  profileStoreSource,
  type ProfilesCatalog,
  type ProfilesCatalog as RoutingCatalog,
  type ProfilesSource,
} from "./profiles";
import { modeIssue } from "./workers";

export {
  PROFILES_FILE,
  canonicalJson,
  profileStoreSource as routingCatalogSource,
};
export type {
  ProfilesCatalog as RoutingCatalog,
  ProfilesSource as RoutingCatalogSource,
};

/** The Conductor profile view the `profiles` command returns. */
export function catalogView(catalog: RoutingCatalog): ProfilesResult {
  const unclassified: string[] = [];
  const profiles: CatalogProfile[] = catalog.profiles.map((profile) => {
    const classified = isClassifiedRouting(profile.routing);
    if (!classified) {
      unclassified.push(profile.id);
    }
    return {
      id: profile.id,
      name: profile.name,
      notes: profile.notes,
      provider: profile.provider,
      ...(profile.model ? { model: profile.model } : {}),
      ...(profile.modeId ? { modeId: profile.modeId } : {}),
      ...(profile.thinkingOptionId
        ? { thinkingOptionId: profile.thinkingOptionId }
        : {}),
      hasInstructions: profile.instructions.length > 0,
      classification: classified ? "classified" : "unclassified",
      routing: profile.routing,
    };
  });
  return {
    profiles,
    revision: catalog.catalogRevision,
    mode: catalog.mode,
    unclassified,
    diagnostics: catalog.diagnostics,
  };
}

export interface RouteIntent {
  role: RoutingRole;
}

export interface RouteOptions {
  intent: RouteIntent;
  /** The Conductor's own permission mode; undefined skips the check. */
  parentModeId?: string | null | undefined;
  /** Available provider ids, or null when availability is unknown. */
  availableProviders: Set<string> | null;
  /** A requested worker choice to validate alongside the policy pick. */
  explicit?: WorkerChoice | undefined;
}

/**
 * The smaller-first routing policy. Pure: it reads the loaded catalog only and
 * never consults a model name, price, or parameter count. Eligible profiles are
 * ordered by size (small < medium < large), then by the user's store order,
 * then by id for a stable tie-break.
 */
export function route(
  catalog: RoutingCatalog,
  options: RouteOptions,
): RouteResult {
  const { intent, parentModeId, availableProviders } = options;
  const excluded: RouteExclusion[] = [];
  const eligible: Array<{
    profile: ConductorProfile;
    routing: RoutingProfile & { size: RoutingSize };
    order: number;
  }> = [];
  catalog.profiles.forEach((profile, order) => {
    const routing = profile.routing;
    if (!isClassifiedRouting(routing)) {
      excluded.push({
        profileId: profile.id,
        name: profile.name,
        requirement: "classification",
        reason: "Unclassified; set at least one role and a size.",
      });
      return;
    }
    if (!routing.roles.includes(intent.role)) {
      excluded.push({
        profileId: profile.id,
        name: profile.name,
        requirement: "role",
        reason: `Roles ${routing.roles.join(", ")} exclude ${intent.role}.`,
      });
      return;
    }
    if (availableProviders && !availableProviders.has(profile.provider)) {
      excluded.push({
        profileId: profile.id,
        name: profile.name,
        requirement: "availability",
        reason: `Provider ${profile.provider} is unavailable.`,
      });
      return;
    }
    if (parentModeId !== undefined) {
      const issue = modeIssue(profile.modeId, parentModeId);
      if (issue) {
        excluded.push({
          profileId: profile.id,
          name: profile.name,
          requirement: "permission",
          reason: issue,
        });
        return;
      }
    }
    eligible.push({ profile, routing, order });
  });
  eligible.sort((a, b) => {
    const bySize =
      routingSizeRank(a.routing.size) - routingSizeRank(b.routing.size);
    if (bySize !== 0) {
      return bySize;
    }
    if (a.order !== b.order) {
      return a.order - b.order;
    }
    return a.profile.id.localeCompare(b.profile.id);
  });
  const selectedProfile = eligible[0];
  const toCandidate = (entry: (typeof eligible)[number]): RouteCandidate => ({
    profileId: entry.profile.id,
    name: entry.profile.name,
    provider: entry.profile.provider,
    ...(entry.profile.model ? { model: entry.profile.model } : {}),
    size: entry.routing.size,
    reason: `Matches ${intent.role} (size ${entry.routing.size}).`,
  });
  const selected = selectedProfile ? toCandidate(selectedProfile) : null;
  const alternatives: RouteCandidate[] = eligible
    .filter((entry) => entry.profile.id !== selectedProfile?.profile.id)
    .map(toCandidate);
  const reasons = selectedProfile
    ? [
        `${selectedProfile.profile.name} is the smallest eligible ${intent.role} profile (size ${selectedProfile.routing.size}).`,
      ]
    : [
        `No eligible configured profile for ${intent.role}. Set an explicit profile, provider/model, or profile "inherit" with routing.reason.`,
      ];
  const result: RouteResult = {
    revision: catalog.catalogRevision,
    mode: catalog.mode,
    intent: { role: intent.role },
    selected,
    alternatives,
    excluded,
    reasons,
    diagnostics: catalog.diagnostics,
  };
  if (options.explicit) {
    const validation = validateChoice({
      taskId: "route",
      choice: choiceKind(options.explicit),
      // A preview has no task reason; it must not emit a missing-reason issue.
      reason: "Route preview.",
      route: result,
      catalog,
      mode: catalog.mode,
    });
    result.explicit = {
      choice: options.explicit,
      warnings: validation.warnings,
      errors: validation.errors,
    };
  }
  return result;
}

export type ChoiceKind =
  | { kind: "profile"; ref: string }
  | {
      kind: "inline";
      provider?: string;
      model?: string;
      thinkingOptionId?: string;
    }
  | { kind: "inherit" };

/** The choice kind for a raw worker choice, treating "inherit" as its opt-in. */
export function choiceKind(choice: WorkerChoice): ChoiceKind {
  if (choice.profile === "inherit") {
    return { kind: "inherit" };
  }
  if (choice.profile) {
    return { kind: "profile", ref: choice.profile };
  }
  return {
    kind: "inline",
    ...(choice.provider !== undefined ? { provider: choice.provider } : {}),
    ...(choice.model !== undefined ? { model: choice.model } : {}),
    ...(choice.thinkingOptionId !== undefined
      ? { thinkingOptionId: choice.thinkingOptionId }
      : {}),
  };
}

const GENERIC_WORDS = new Set([
  // Generic need/quality/complexity claims.
  "need",
  "needs",
  "needed",
  "require",
  "requires",
  "required",
  "requirement",
  "requirements",
  "want",
  "wants",
  "wanted",
  "must",
  "should",
  "better",
  "best",
  "more",
  "most",
  "higher",
  "highest",
  "high",
  "low",
  "lower",
  "great",
  "good",
  "strong",
  "stronger",
  "strongest",
  "weak",
  "weaker",
  "smarter",
  "smart",
  "faster",
  "fast",
  "slower",
  "capable",
  "capability",
  "capabilities",
  "able",
  "ability",
  "powerful",
  "robust",
  "reliable",
  "accurate",
  "precise",
  "effective",
  "efficient",
  "quality",
  "excellence",
  "excellent",
  "outstanding",
  "superior",
  "exceptional",
  "premium",
  "advanced",
  "sophisticated",
  "nuanced",
  "complex",
  "complexity",
  "complicated",
  "difficult",
  "challenging",
  "demanding",
  "rigorous",
  "thorough",
  "careful",
  "deep",
  "skilled",
  "expert",
  "senior",
  "experienced",
  "professional",
  "mature",
  "proven",
  "solid",
  "sound",
  "important",
  "importance",
  "critical",
  "crucial",
  "essential",
  "vital",
  "significant",
  "substantial",
  "major",
  "minor",
  "serious",
  "severe",
  "hard",
  "easy",
  "simple",
  "trivial",
  "basic",
  "general",
  "craftsmanship",
  "finesse",
  "polish",
  "elegance",
  "ingenuity",
  "insight",
  "judgment",
  "intelligence",
  "wisdom",
  "talent",
  "skill",
  "expertise",
  // Hyphenated and compound quality claims, split into their parts so
  // "high-quality", "top-notch" and "well-crafted" stay generic.
  "well",
  "crafted",
  "top",
  "notch",
  "world",
  "class",
  "grade",
  "tier",
  "polished",
  "refined",
  "elegant",
  "seamless",
  "smooth",
  "flawless",
  "masterful",
  "skillful",
  "seasoned",
  "talented",
  "gifted",
  "brilliant",
  "stellar",
  "superb",
  "terrific",
  "fantastic",
  "amazing",
  "wonderful",
  "impressive",
  "remarkable",
  "extraordinary",
  "phenomenal",
  "magnificent",
  "premier",
  "elite",
  "rate",
  "state",
  "art",
  "cutting",
  "edge",
  "battle",
  "tested",
  "heavy",
  "duty",
  "enterprise",
  "production",
  "performance",
  "suited",
  "fine",
  "grained",
  "deeply",
  "truly",
  "genuinely",
  "exceptionally",
  "remarkably",
  "incredibly",
  "absolutely",
  "utterly",
  // Generic nouns, verbs and filler.
  "model",
  "models",
  "llm",
  "agent",
  "task",
  "job",
  "project",
  "work",
  "thing",
  "stuff",
  "situation",
  "case",
  "scenario",
  "context",
  "problem",
  "issue",
  "solution",
  "approach",
  "method",
  "way",
  "manner",
  "level",
  "degree",
  "amount",
  "extent",
  "kind",
  "type",
  "sort",
  "aspect",
  "part",
  "area",
  "field",
  "domain",
  "subject",
  "matter",
  "content",
  "output",
  "result",
  "outcome",
  "goal",
  "objective",
  "purpose",
  "reason",
  "why",
  "because",
  "so",
  "thus",
  "hence",
  "therefore",
  "also",
  "too",
  "very",
  "really",
  "quite",
  "extremely",
  "highly",
  "especially",
  "particularly",
  "notably",
  "simply",
  "just",
  "only",
  "even",
  "still",
  "yet",
  "however",
  "although",
  "though",
  "while",
  "whereas",
  "since",
  "as",
  "if",
  "then",
  "than",
  "that",
  "which",
  "who",
  "whom",
  "whose",
  "what",
  "when",
  "where",
  "how",
  "whether",
  "this",
  "these",
  "those",
  "it",
  "its",
  "the",
  "a",
  "an",
  "and",
  "or",
  "but",
  "for",
  "of",
  "to",
  "in",
  "on",
  "at",
  "by",
  "with",
  "without",
  "from",
  "into",
  "over",
  "under",
  "above",
  "below",
  "between",
  "among",
  "during",
  "before",
  "after",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "has",
  "have",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "shall",
  "may",
  "might",
  "can",
  "could",
  "not",
  "no",
  "yes",
  "all",
  "any",
  "some",
  "few",
  "many",
  "much",
  "each",
  "every",
  "both",
  "either",
  "neither",
  "other",
  "another",
  "such",
  "same",
  "different",
  "new",
  "old",
  "current",
  "existing",
  "previous",
  "first",
  "second",
  "next",
  "last",
  "one",
  "two",
  "three",
  "zero",
]);

/** A backticked code identifier, such as `run()` or `foo.ts`. */
const BACKTICKED = /`[^`]+`/;

/**
 * True when the evidence names a real file or code reference: a backticked
 * identifier, a path containing `/`, or a file name with an extension. Plain
 * punctuation inside an ordinary adjective (`high-quality`) does not count.
 */
function hasCodeReference(evidence: string): boolean {
  if (BACKTICKED.test(evidence)) {
    return true;
  }
  return evidence.split(/\s+/).some((token) => {
    const clean = token.replace(/^[^A-Za-z0-9._/-]+|[^A-Za-z0-9._/-]+$/g, "");
    return clean.includes("/") || /\.[A-Za-z0-9]{1,6}$/.test(clean);
  });
}

/**
 * True when override evidence is too short or is only a generic quality,
 * complexity or importance claim with nothing checkable named. Hyphenated and
 * punctuated words are normalized before the generic-phrase test, and only
 * real file/code references count as a code token. Concrete evidence names a
 * specific capability, failure, file, check or user statement.
 */
export function isGenericEvidence(evidence: string): boolean {
  const trimmed = evidence.trim();
  if (trimmed.length < 20) {
    return true;
  }
  const words = trimmed
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (words.length > 0 && words.every((word) => GENERIC_WORDS.has(word))) {
    return true;
  }
  if (/[0-9]/.test(trimmed)) {
    return false;
  }
  if (hasCodeReference(trimmed)) {
    return false;
  }
  const rawTokens = trimmed.split(/\s+/).filter(Boolean);
  if (
    rawTokens.some(
      (token, index) =>
        index > 0 && /^[A-Z]/.test(token.replace(/^[^A-Za-z]+/, "")),
    )
  ) {
    return false;
  }
  return !words.some((word) => word.length >= 6 && !GENERIC_WORDS.has(word));
}

export interface ChoiceValidation {
  warnings: RoutingWarning[];
  errors: string[];
}

export interface ValidateChoiceOptions {
  taskId: string;
  choice: ChoiceKind;
  reason?: string | undefined;
  override?: RoutingOverride | undefined;
  route: RouteResult;
  catalog: RoutingCatalog;
  mode: RoutingMode;
}

/**
 * The single worker-choice validation used by define, loop, dispatch and the
 * read-only route preview. Warn mode reports every issue; strict mode rejects
 * a worker-choice issue unless a valid, specific override covers it.
 */
export function validateChoice(
  options: ValidateChoiceOptions,
): ChoiceValidation {
  const {
    taskId,
    choice,
    reason,
    override,
    route: result,
    catalog,
    mode,
  } = options;
  const warnings: RoutingWarning[] = [];
  const errors: string[] = [];
  const selected = result.selected;
  const warn = (code: RoutingWarning["code"], body: string) =>
    warnings.push({ code, message: `Task "${taskId}" ${body}` });
  const addIssue = (code: RoutingWarning["code"], body: string) => {
    if (mode === "warn") {
      warn(code, body);
    } else {
      errors.push(
        `Task "${taskId}" routing: ${body} Add routing.override {category, evidence} or choose an eligible profile.`,
      );
    }
  };
  const addAlwaysError = (code: RoutingWarning["code"], body: string) => {
    if (mode === "warn") {
      warn(code, body);
    } else {
      errors.push(`Task "${taskId}" ${body}`);
    }
  };
  const genericOverride = override
    ? isGenericEvidence(override.evidence)
    : false;
  const invalidOverrideCategory =
    override?.category === "no-eligible-profile" && selected !== null;
  const validOverride =
    override !== undefined && !genericOverride && !invalidOverrideCategory;

  // A profile choice names a configured profile. Unknown or ambiguous refs are
  // resolved before eligibility checks.
  let profileId: string | null = null;
  if (choice.kind === "profile") {
    const resolution = resolveProfileRef(catalog.profiles, choice.ref);
    if ("profile" in resolution) {
      profileId = resolution.profile.id;
    } else {
      const message =
        resolution.error === "unknown"
          ? `Unknown worker profile: ${choice.ref}`
          : `Ambiguous worker profile: ${choice.ref}`;
      if (mode === "strict") {
        errors.push(message);
      } else {
        warn(
          "ineligible-profile",
          `profile "${choice.ref}" is not a configured Conductor profile.`,
        );
      }
      profileId = null;
    }
  }

  // At most one worker-choice issue, matching how `route` picks a single cause.
  let workerIssue: { code: RoutingWarning["code"]; body: string } | null = null;
  if (choice.kind === "inherit") {
    workerIssue = {
      code: "inherit",
      body: "inherits the Conductor's settings without a configured profile.",
    };
  } else if (profileId) {
    const resolved = catalog.profiles.find((entry) => entry.id === profileId);
    const routing = resolved?.routing;
    if (!isClassifiedRouting(routing)) {
      workerIssue = {
        code: "unclassified-profile",
        body: `profile "${resolved?.name ?? profileId}" is unclassified.`,
      };
    } else {
      const exclusion = result.excluded.find(
        (entry) => entry.profileId === profileId,
      );
      if (exclusion) {
        workerIssue = {
          code: "ineligible-profile",
          body: `profile "${profileId}" is not eligible: ${exclusion.reason}`,
        };
      } else if (
        selected &&
        routingSizeRank(routing.size) > routingSizeRank(selected.size)
      ) {
        workerIssue = {
          code: "larger-than-eligible",
          body: `profile "${profileId}" (size ${routing.size}) is larger than eligible profile "${selected.profileId}" (size ${selected.size}).`,
        };
      }
    }
  } else if (choice.kind === "inline") {
    workerIssue = {
      code: "unconfigured-model",
      body: `inline model "${choice.provider ?? "conductor"}/${choice.model ?? "default"}" is not a configured profile.`,
    };
  }
  // An explicit inherit is a normal worker choice: warn mode reports it and
  // strict mode rejects it unless a valid override covers it.
  if (workerIssue) {
    if (mode === "warn") {
      warn(workerIssue.code, workerIssue.body);
    } else if (!validOverride) {
      addIssue(workerIssue.code, workerIssue.body);
    }
  }

  // Every explicit Conductor choice needs a reason.
  if (reason === undefined || reason.trim().length === 0) {
    addAlwaysError(
      "missing-reason",
      "needs routing.reason for its worker choice.",
    );
  }

  if (override) {
    if (genericOverride) {
      addAlwaysError(
        "generic-override-evidence",
        "override evidence is generic; name the concrete capability gap, observed failure or user statement.",
      );
    }
    if (invalidOverrideCategory) {
      addAlwaysError(
        "invalid-override-category",
        `override category no-eligible-profile is invalid: route selected "${selected?.profileId}".`,
      );
    }
  }
  return { warnings, errors };
}

/** A command task's routing-relevant fields. Kept structural to avoid imports. */
export interface RoutableTask {
  id: string;
  role?: RoutingRole | undefined;
  openDecision?: string | undefined;
  review?: boolean | undefined;
  writes?: readonly string[] | undefined;
  profile?: string | undefined;
  provider?: string | undefined;
  model?: string | undefined;
  thinkingOptionId?: string | undefined;
  routing?: CommandRouting | undefined;
}

export interface ResolvedTaskRouting {
  /** The launch worker choice: a profile id, inline fields, or "inherit". */
  choice: WorkerChoice;
  /** The stored routing decision. */
  routing: TaskRouting;
  warnings: RoutingWarning[];
  errors: string[];
  /** The resolved Conductor profile, snapshotted as a display name. */
  profile?: { id: string; name: string } | undefined;
}

function compact<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T;
}

function hasWorkerSource(task: RoutableTask): boolean {
  return Boolean(
    task.profile || task.provider || task.model || task.thinkingOptionId,
  );
}

/**
 * Resolves one command task to a launch worker choice and a stored routing
 * decision. Explicit fields stay authoritative; otherwise the policy pick is
 * used, or an error when no eligible profile exists.
 */
export function resolveCommandTaskRouting(options: {
  catalog: RoutingCatalog;
  task: RoutableTask;
  parentModeId?: string | null | undefined;
  availableProviders: Set<string> | null;
}): ResolvedTaskRouting {
  const { catalog, task, parentModeId, availableProviders } = options;
  const role = routingRoleFor({
    ...(task.role !== undefined ? { role: task.role } : {}),
    ...(task.review !== undefined ? { review: task.review } : {}),
    writes: task.writes ?? [],
  });
  const intent: RouteIntent = { role };
  const result = route(catalog, {
    intent,
    parentModeId,
    availableProviders,
  });
  const base = {
    role,
    ...(task.openDecision ? { openDecision: task.openDecision } : {}),
  };
  if (hasWorkerSource(task)) {
    const choice: WorkerChoice = compact({
      ...(task.profile !== undefined ? { profile: task.profile } : {}),
      ...(task.provider !== undefined ? { provider: task.provider } : {}),
      ...(task.model !== undefined ? { model: task.model } : {}),
      ...(task.thinkingOptionId !== undefined
        ? { thinkingOptionId: task.thinkingOptionId }
        : {}),
    });
    const validation = validateChoice({
      taskId: task.id,
      choice: choiceKind(choice),
      ...(task.routing?.reason !== undefined
        ? { reason: task.routing.reason }
        : {}),
      ...(task.routing?.override !== undefined
        ? { override: task.routing.override }
        : {}),
      route: result,
      catalog,
      mode: catalog.mode,
    });
    const resolvedProfile =
      choice.profile && choice.profile !== "inherit"
        ? (() => {
            const resolution = resolveProfileRef(
              catalog.profiles,
              choice.profile ?? "",
            );
            return "profile" in resolution
              ? { id: resolution.profile.id, name: resolution.profile.name }
              : undefined;
          })()
        : undefined;
    return {
      choice,
      routing: {
        ...base,
        reason: task.routing?.reason ?? "No selection reason given.",
        selectedBy: "conductor",
        ...(task.routing?.override ? { override: task.routing.override } : {}),
        catalogRevision: catalog.catalogRevision,
        ...(validation.warnings.length
          ? { warnings: validation.warnings }
          : {}),
      },
      warnings: validation.warnings,
      errors: validation.errors,
      ...(resolvedProfile ? { profile: resolvedProfile } : {}),
    };
  }
  if (result.selected) {
    return {
      choice: { profile: result.selected.profileId },
      routing: {
        ...base,
        reason: (task.routing?.reason ?? result.reasons[0] ?? "").slice(0, 300),
        selectedBy: "route",
        catalogRevision: catalog.catalogRevision,
      },
      warnings: [],
      errors: [],
      profile: {
        id: result.selected.profileId,
        name: result.selected.name,
      },
    };
  }
  // Omitted worker fields are never silently inherited. Without an eligible
  // profile the caller must choose a profile, an inline model, or an explicit
  // profile "inherit" with routing.reason (normal override rules apply). This
  // rejects in both warn and strict mode.
  return {
    choice: { profile: "inherit" },
    routing: {
      ...base,
      reason: (task.routing?.reason ?? result.reasons[0] ?? "").slice(0, 300),
      selectedBy: "inherit",
      ...(task.routing?.override ? { override: task.routing.override } : {}),
      catalogRevision: catalog.catalogRevision,
    },
    warnings: [],
    errors: [
      `Task "${task.id}" has no eligible configured profile. Set an explicit profile, provider/model, or profile "inherit" with routing.reason.`,
    ],
  };
}
