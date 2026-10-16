import assert from "node:assert/strict";
import test from "node:test";
import {
  isGenericEvidence,
  resolveCommandTaskRouting,
  route,
  validateChoice,
} from "../server/symphonies/routing";
import type { ProfilesCatalog } from "../server/symphonies/profiles";
import type { ConductorProfile } from "../shared/symphonies/profiles";
import type {
  RouteResult,
  RoutingMode,
  RoutingProfile,
  RoutingRole,
} from "../shared/symphonies/routing";

const profile = (
  id: string,
  overrides: Partial<ConductorProfile> = {},
): ConductorProfile => ({
  id,
  name: id,
  notes: `${id} notes`,
  provider: "fake",
  routing: null,
  instructions: "",
  ...overrides,
});

function catalog(
  profiles: ConductorProfile[],
  routes: Record<string, Partial<RoutingProfile>> = {},
  mode: RoutingMode = "warn",
  revision = "a".repeat(64),
): ProfilesCatalog {
  return {
    state: "valid",
    mode,
    profiles: profiles.map((entry) => {
      const routing = routes[entry.id];
      return {
        ...entry,
        routing: routing
          ? {
              roles: routing.roles ?? ["implementation"],
              ...(routing.size !== undefined ? { size: routing.size } : {}),
            }
          : null,
      };
    }),
    revision,
    catalogRevision: revision,
    diagnostics: [],
  };
}

function intent(role: RoutingRole = "implementation"): { role: RoutingRole } {
  return { role };
}

function selection(result: RouteResult): string | null {
  return result.selected?.profileId ?? null;
}

void test("selection orders by size, then store order, then id", () => {
  const result = route(
    catalog(
      [
        profile("large"),
        profile("small-first"),
        profile("medium"),
        profile("small-second"),
      ],
      {
        large: { size: "large" },
        "small-first": { size: "small" },
        medium: { size: "medium" },
        "small-second": { size: "small" },
      },
    ),
    {
      intent: intent(),
      parentModeId: undefined,
      availableProviders: null,
    },
  );
  assert.equal(selection(result), "small-first");
  assert.deepEqual(
    result.alternatives.map((entry) => entry.profileId),
    ["small-second", "medium", "large"],
  );
  assert.match(result.reasons[0] ?? "", /smallest eligible implementation/);
});

void test("a profile missing a role or a size is never selected", () => {
  const result = route(
    catalog([profile("no-size"), profile("no-role"), profile("sized")], {
      "no-size": { roles: ["implementation"] },
      "no-role": { roles: [], size: "small" },
      sized: { roles: ["implementation"], size: "medium" },
    }),
    {
      intent: intent(),
      parentModeId: undefined,
      availableProviders: null,
    },
  );
  assert.equal(selection(result), "sized");
  for (const id of ["no-size", "no-role"]) {
    const exclusion = result.excluded.find((entry) => entry.profileId === id);
    assert.equal(exclusion?.requirement, "classification");
    assert.match(exclusion?.reason ?? "", /Unclassified/);
  }
});

void test("a profile with a null routing is unclassified", () => {
  const result = route(
    catalog([profile("untuned"), profile("sized")], {
      sized: { size: "small" },
    }),
    {
      intent: intent(),
      parentModeId: undefined,
      availableProviders: null,
    },
  );
  assert.equal(selection(result), "sized");
  assert.equal(
    result.excluded.find((entry) => entry.profileId === "untuned")?.requirement,
    "classification",
  );
});

void test("role, availability and permission eliminate candidates", () => {
  const result = route(
    catalog(
      [
        profile("reviewer", { modeId: "auto-review" }),
        profile("offline", { provider: "remote" }),
        profile("elevated", { modeId: "full-access" }),
        profile("safe"),
      ],
      {
        reviewer: { roles: ["review"], size: "small" },
        offline: { size: "small" },
        elevated: { size: "small" },
        safe: { size: "medium" },
      },
    ),
    {
      intent: intent(),
      parentModeId: "auto",
      availableProviders: new Set(["fake"]),
    },
  );
  const requirements = Object.fromEntries(
    result.excluded.map((entry) => [entry.profileId, entry.requirement]),
  );
  assert.equal(requirements.reviewer, "role");
  assert.equal(requirements.offline, "availability");
  assert.equal(requirements.elevated, "permission");
  assert.equal(selection(result), "safe");
});

void test("warn mode reports every worker-choice issue, strict rejects it", () => {
  const base = catalog([profile("small"), profile("big"), profile("general")], {
    small: { size: "small" },
    big: { size: "large" },
    general: { size: "medium" },
  });
  const result = route(base, {
    intent: intent(),
    parentModeId: undefined,
    availableProviders: null,
  });
  const strict = {
    ...base,
    mode: "strict" as const,
  };

  const larger = validateChoice({
    taskId: "work",
    choice: { kind: "profile", ref: "big" },
    reason: "Picked a larger profile",
    route: result,
    catalog: base,
    mode: "warn",
  });
  assert.deepEqual(
    larger.warnings.map((warning) => warning.code),
    ["larger-than-eligible"],
  );
  assert.deepEqual(larger.errors, []);
  const strictLarger = validateChoice({
    taskId: "work",
    choice: { kind: "profile", ref: "big" },
    reason: "Picked a larger profile",
    route: result,
    catalog: strict,
    mode: "strict",
  });
  assert.equal(strictLarger.errors.length, 1);
  assert.match(strictLarger.errors[0] ?? "", /larger than eligible/);

  const unknown = validateChoice({
    taskId: "work",
    choice: { kind: "profile", ref: "ghost" },
    reason: "Because",
    route: result,
    catalog: strict,
    mode: "strict",
  });
  assert.deepEqual(unknown.errors, ["Unknown worker profile: ghost"]);

  const missingReason = validateChoice({
    taskId: "work",
    choice: { kind: "profile", ref: "small" },
    route: result,
    catalog: strict,
    mode: "strict",
  });
  assert.match(missingReason.errors[0] ?? "", /needs routing.reason/);

  const inherit = validateChoice({
    taskId: "work",
    choice: { kind: "inherit" },
    reason: "The user asked for the Conductor's settings",
    route: result,
    catalog: strict,
    mode: "strict",
  });
  assert.match(inherit.errors[0] ?? "", /inherits the Conductor's settings/);

  const inline = validateChoice({
    taskId: "work",
    choice: { kind: "inline", provider: "fake", model: "custom" },
    reason: "The user asked for it",
    route: result,
    catalog: base,
    mode: "warn",
  });
  assert.equal(inline.warnings[0]?.code, "unconfigured-model");
});

void test("a valid override covers a larger choice in strict mode", () => {
  const base = catalog([profile("small"), profile("big")], {
    small: { size: "small" },
    big: { size: "large" },
  });
  const result = route(base, {
    intent: intent(),
    parentModeId: undefined,
    availableProviders: null,
  });
  for (const category of [
    "user-choice",
    "capability-gap",
    "observed-limitation",
  ] as const) {
    const validation = validateChoice({
      taskId: "work",
      choice: { kind: "profile", ref: "big" },
      reason: "A specific reason",
      override: {
        category,
        evidence: `The user described this concrete ${category} on the task.`,
      },
      route: result,
      catalog: { ...base, mode: "strict" },
      mode: "strict",
    });
    assert.deepEqual(validation.errors, [], category);
  }
});

void test("no-eligible-profile works only when the policy selected nothing", () => {
  const empty = catalog([profile("big")], {
    big: { roles: ["review"], size: "small" },
  });
  const result = route(empty, {
    intent: intent(),
    parentModeId: undefined,
    availableProviders: null,
  });
  assert.equal(result.selected, null);
  const strict = {
    ...empty,
    mode: "strict" as const,
  };
  const valid = validateChoice({
    taskId: "work",
    choice: { kind: "inline", provider: "fake", model: "custom" },
    reason: "No configured worker covers this task",
    override: {
      category: "no-eligible-profile",
      evidence: "Every configured profile excludes this role and domain.",
    },
    route: result,
    catalog: strict,
    mode: "strict",
  });
  assert.deepEqual(valid.errors, []);

  // An explicit inherit accepts the same no-eligible-profile override.
  const inherit = validateChoice({
    taskId: "work",
    choice: { kind: "inherit" },
    reason: "No configured worker covers this task",
    override: {
      category: "no-eligible-profile",
      evidence: "Every configured profile excludes this role and domain.",
    },
    route: result,
    catalog: strict,
    mode: "strict",
  });
  assert.deepEqual(inherit.errors, []);

  // Omitting worker fields with no eligible profile is rejected in both modes
  // and cannot be waved through by an override.
  for (const mode of ["warn", "strict"] as const) {
    const resolved = resolveCommandTaskRouting({
      catalog: { ...empty, mode },
      task: {
        id: "work",
        role: "implementation",
        writes: ["src"],
        routing: {
          reason: "No configured worker covers this task",
          override: {
            category: "no-eligible-profile",
            evidence: "Every configured profile excludes this role and domain.",
          },
        },
      },
      parentModeId: undefined,
      availableProviders: null,
    });
    assert.ok(
      resolved.errors.some((error) =>
        /no eligible configured profile/.test(error),
      ),
      mode,
    );
  }

  const selected = route(
    catalog([profile("small")], { small: { size: "small" } }),
    {
      intent: intent(),
      parentModeId: undefined,
      availableProviders: null,
    },
  );
  const misuse = validateChoice({
    taskId: "work",
    choice: { kind: "inline", provider: "fake", model: "custom" },
    reason: "Picked it anyway",
    override: {
      category: "no-eligible-profile",
      evidence: "Claimed no profile was eligible even though one was.",
    },
    route: selected,
    catalog: { ...empty, mode: "strict" },
    mode: "strict",
  });
  assert.ok(
    misuse.errors.some((error) => /no-eligible-profile is invalid/.test(error)),
  );
});

void test("generic override evidence is rejected", () => {
  assert.equal(isGenericEvidence("needs quality"), true);
  assert.equal(isGenericEvidence("better model for this task"), true);
  assert.equal(isGenericEvidence("requires excellent quality"), true);
  assert.equal(isGenericEvidence("complex and important work"), true);
  assert.equal(
    isGenericEvidence("This task requires excellent quality."),
    true,
  );
  // Hyphenated and punctuated quality claims stay generic after normalization.
  assert.equal(
    isGenericEvidence("This task requires high-quality work."),
    true,
  );
  assert.equal(
    isGenericEvidence("This task requires excellent-quality work."),
    true,
  );
  assert.equal(isGenericEvidence("This task requires top-notch work."), true);
  assert.equal(
    isGenericEvidence("This task requires well-crafted work."),
    true,
  );
  assert.equal(
    isGenericEvidence("This task requires top-notch, well-crafted work."),
    true,
  );
  assert.equal(
    isGenericEvidence(
      "The smaller worker failed the same contract check twice after a bounded retry.",
    ),
    false,
  );
  assert.equal(
    isGenericEvidence(
      "The user asked for the Planner profile by name in their message.",
    ),
    false,
  );
  // Real file and code references count as concrete.
  assert.equal(
    isGenericEvidence("The check failed at src/api.ts:41 in the contract."),
    false,
  );
  assert.equal(
    isGenericEvidence("The worker threw `TypeError` while parsing it."),
    false,
  );
  const base = catalog([profile("small"), profile("big")], {
    small: { size: "small" },
    big: { size: "large" },
  });
  const result = route(base, {
    intent: intent(),
    parentModeId: undefined,
    availableProviders: null,
  });
  for (const evidence of [
    "needs quality",
    "requires excellent quality",
    "complex and important work",
    "This task requires high-quality work.",
    "This task requires excellent-quality work.",
    "This task requires top-notch work.",
    "This task requires well-crafted work.",
  ]) {
    const validation = validateChoice({
      taskId: "work",
      choice: { kind: "profile", ref: "big" },
      reason: "Needs a stronger model",
      override: { category: "capability-gap", evidence },
      route: result,
      catalog: { ...base, mode: "strict" },
      mode: "strict",
    });
    assert.ok(
      validation.errors.some((error) => /evidence is generic/.test(error)),
      evidence,
    );
  }
});

void test("the route preview validates an explicit choice", () => {
  const base = catalog([profile("small"), profile("big")], {
    small: { size: "small" },
    big: { size: "large" },
  });
  const result = route(base, {
    intent: intent(),
    parentModeId: undefined,
    availableProviders: null,
    explicit: { profile: "big" },
  });
  assert.equal(selection(result), "small");
  assert.deepEqual(result.explicit?.choice, { profile: "big" });
  assert.equal(result.explicit?.warnings[0]?.code, "larger-than-eligible");
  assert.ok(
    !result.explicit?.warnings.some(
      (warning) => warning.code === "missing-reason",
    ),
    "a route preview must not emit missing-reason",
  );
});

void test("resolved task routing snapshots the chosen profile name", () => {
  const base = catalog([profile("small"), profile("big")], {
    small: { size: "small" },
    big: { size: "large" },
  });
  const explicit = resolveCommandTaskRouting({
    catalog: base,
    task: { id: "work", profile: "big", writes: ["src"] },
    parentModeId: undefined,
    availableProviders: null,
  });
  assert.deepEqual(explicit.profile, { id: "big", name: "big" });
  assert.equal(explicit.errors.length, 0);

  const auto = resolveCommandTaskRouting({
    catalog: base,
    task: { id: "work", writes: ["src"] },
    parentModeId: undefined,
    availableProviders: null,
  });
  assert.deepEqual(auto.profile, { id: "small", name: "small" });

  // An inline or inherit choice has no profile snapshot.
  const inline = resolveCommandTaskRouting({
    catalog: base,
    task: { id: "work", provider: "fake", model: "custom" },
    parentModeId: undefined,
    availableProviders: null,
  });
  assert.equal(inline.profile, undefined);
});
