import assert from "node:assert/strict";
import test from "node:test";
import {
  EMPTY_PROFILE_STORE,
  PROFILE_LIMITS,
  conductorProfileSchema,
  profileDraftSchema,
  profileNameKey,
  profileOperationSchema,
  profileStoreSchema,
  profilesStateSchema,
  readProfileStore,
  resolveProfileRef,
  saveProfilesResultSchema,
  storeIssues,
  type ConductorProfile,
} from "../shared/symphonies/profiles";
import {
  importProfilesResultSchema,
  listProfileProviders,
  listProfiles,
  providerCatalogSchema,
  saveProfiles,
  syncActionSchema,
  syncPreview as syncPreviewRpc,
  syncPreviewEntrySchema,
  syncPreviewSchema,
  syncProfiles as syncProfilesRpc,
  syncProfilesResultSchema,
} from "../shared/symphonies/profiles-rpc";
import { attemptSchema, symphonySchema } from "../shared/symphonies/models";
import { storedSymphony } from "./symphony-fixtures";

const smallId = "11111111-1111-4111-8111-111111111111";
const bigId = "22222222-2222-4222-8222-222222222222";
const revision = "a".repeat(64);

function parsedProfile(
  overrides: Record<string, unknown> = {},
): ConductorProfile {
  return conductorProfileSchema.parse({
    id: smallId,
    name: "Small Worker",
    provider: "pi",
    ...overrides,
  });
}

void test("an empty store defaults to warn mode with no profiles", () => {
  assert.deepEqual(profileStoreSchema.parse({ version: 1 }), {
    version: 1,
    mode: "warn",
    profiles: [],
  });
  assert.deepEqual(EMPTY_PROFILE_STORE, {
    version: 1,
    mode: "warn",
    profiles: [],
  });
  assert.deepEqual(profileStoreSchema.parse(EMPTY_PROFILE_STORE), {
    version: 1,
    mode: "warn",
    profiles: [],
  });
});

void test("a profile carries launch settings, routing and instructions", () => {
  const profile = parsedProfile({
    name: "Small Worker",
    notes: "Bounded implementation.",
    model: "pi-small",
    thinkingOptionId: "low",
    modeId: "default",
    routing: { roles: ["implementation"], size: "medium" },
    instructions: "Use the frontend-design skill.",
  });
  assert.equal(profile.notes, "Bounded implementation.");
  assert.equal(profile.routing?.size, "medium");
  assert.deepEqual(profile.routing?.roles, ["implementation"]);
  assert.equal(profile.instructions, "Use the frontend-design skill.");
  assert.equal(
    parsedProfile({ routing: null }).routing,
    null,
    "routing null is an unclassified profile",
  );
});

void test("profile bounds reject oversize text, ids and counts", () => {
  const tooLong = (length: number) => "x".repeat(length);
  assert.equal(
    conductorProfileSchema.safeParse({
      id: smallId,
      name: tooLong(PROFILE_LIMITS.nameChars + 1),
      provider: "pi",
    }).success,
    false,
  );
  assert.equal(
    parsedProfile({ notes: tooLong(PROFILE_LIMITS.notesChars) }).notes.length,
    PROFILE_LIMITS.notesChars,
  );
  assert.equal(
    conductorProfileSchema.safeParse({
      id: smallId,
      name: "Small",
      provider: "pi",
      notes: tooLong(PROFILE_LIMITS.notesChars + 1),
    }).success,
    false,
  );
  assert.equal(
    conductorProfileSchema.safeParse({
      id: smallId,
      name: "Small",
      provider: "pi",
      instructions: tooLong(PROFILE_LIMITS.instructionsChars + 1),
    }).success,
    false,
  );
  assert.equal(
    conductorProfileSchema.safeParse({
      id: smallId,
      name: "Small",
      provider: "",
    }).success,
    false,
  );
  assert.equal(
    conductorProfileSchema.safeParse({
      id: "not-a-uuid",
      name: "Small",
      provider: "pi",
    }).success,
    false,
  );
  assert.equal(
    conductorProfileSchema.safeParse({
      id: smallId,
      name: "Small",
      provider: "pi",
      extra: true,
    }).success,
    false,
  );
  const profiles = Array.from(
    { length: PROFILE_LIMITS.profiles + 1 },
    (_, index) => ({
      id: `${String(index).padStart(8, "0")}-1111-4111-8111-111111111111`,
      name: `Profile ${index}`,
      provider: "pi",
    }),
  );
  assert.equal(
    profileStoreSchema.safeParse({ version: 1, profiles }).success,
    false,
  );
});

void test("store version and mode are allowlisted", () => {
  assert.equal(profileStoreSchema.safeParse({ version: 2 }).success, false);
  assert.equal(
    profileStoreSchema.safeParse({ version: 1, mode: "loud" }).success,
    false,
  );
  assert.equal(
    profileStoreSchema.safeParse({ version: 1, mode: "strict" }).success,
    true,
  );
});

void test("names are reserved, id-shaped and unique ignoring case and NFC", () => {
  assert.equal(profileNameKey("  Small Worker  "), "small worker");
  assert.equal(profileNameKey("Cafe\u0301"), profileNameKey("Caf\u00e9"));
  for (const name of ["inherit", "Inherit", "tracked", "TRACKED"]) {
    assert.equal(
      conductorProfileSchema.safeParse({
        id: smallId,
        name,
        provider: "pi",
      }).success,
      false,
      name,
    );
  }
  assert.equal(
    conductorProfileSchema.safeParse({
      id: smallId,
      name: smallId,
      provider: "pi",
    }).success,
    false,
    "a uuid-shaped name is rejected",
  );
  const duplicate = {
    version: 1 as const,
    profiles: [
      { id: smallId, name: "Small Worker", provider: "pi" },
      { id: bigId, name: "small worker", provider: "pi" },
    ],
  };
  assert.equal(profileStoreSchema.safeParse(duplicate).success, false);
  assert.deepEqual(
    storeIssues({
      profiles: [
        { id: smallId, name: "Small Worker" },
        { id: bigId, name: "small worker" },
      ],
    }),
    [
      {
        profileIndex: 1,
        field: "name",
        message: 'Profile name "small worker" is used more than once.',
      },
    ],
  );
  assert.deepEqual(
    storeIssues({
      profiles: [
        { id: smallId, name: "Alpha" },
        { id: smallId, name: "Beta" },
      ],
    }),
    [
      {
        profileIndex: 1,
        field: "id",
        message: "Profile ids must be unique.",
      },
    ],
  );
});

void test("routing keeps only roles and size and rejects extra keys", () => {
  const store = profileStoreSchema.parse({
    version: 1,
    profiles: [
      {
        id: smallId,
        name: "Small",
        provider: "pi",
        routing: { roles: ["implementation"], size: "small" },
      },
      {
        id: bigId,
        name: "Big",
        provider: "pi",
        routing: { roles: ["implementation", "review"], size: "large" },
      },
    ],
  });
  assert.equal(store.profiles[0]?.routing?.size, "small");
  assert.deepEqual(store.profiles[1]?.routing?.roles, [
    "implementation",
    "review",
  ]);
  assert.equal(
    profileStoreSchema.safeParse({
      version: 1,
      profiles: [
        {
          id: smallId,
          name: "Small",
          provider: "pi",
          routing: { roles: ["implementation"], size: "huge" },
        },
      ],
    }).success,
    false,
  );
});

void test("removed routing fields are rejected on new command input", () => {
  for (const routing of [
    { roles: ["implementation"], domains: ["frontend"] },
    { roles: ["implementation"], preferenceTier: 1 },
    { roles: ["implementation"], fallbacks: [bigId] },
    { roles: ["implementation"], excludeWhen: ["architecture"] },
  ]) {
    assert.equal(
      profileDraftSchema.safeParse({
        name: "Draft",
        provider: "pi",
        routing,
      }).success,
      false,
      JSON.stringify(routing),
    );
  }
});

void test("a legacy store loads with roles kept and size unset", () => {
  const legacy = {
    version: 1,
    mode: "warn",
    profiles: [
      {
        id: smallId,
        name: "Small",
        provider: "pi",
        routing: {
          roles: ["implementation"],
          domains: ["frontend"],
          preferenceTier: 2,
          fallbacks: [bigId],
          excludeWhen: ["architecture"],
        },
      },
      {
        id: bigId,
        name: "Big",
        provider: "pi",
        routing: { roles: ["review"], preferenceTier: 5 },
      },
    ],
  };
  const parsed = readProfileStore(legacy);
  assert.ok(parsed.success);
  assert.deepEqual(parsed.data.profiles[0]?.routing, {
    roles: ["implementation"],
  });
  assert.equal(parsed.data.profiles[0]?.routing?.size, undefined);
  assert.deepEqual(parsed.data.profiles[1]?.routing, { roles: ["review"] });
  // A key that was never a routing field still fails the strict store schema.
  assert.equal(
    readProfileStore({
      ...legacy,
      profiles: [
        {
          ...legacy.profiles[0],
          routing: { roles: ["implementation"], bogus: 1 },
        },
      ],
    }).success,
    false,
  );
});

void test("resolveProfileRef matches an id first, then a unique name", () => {
  const profiles = [
    parsedProfile({ id: smallId, name: "Small Worker" }),
    parsedProfile({ id: bigId, name: "Big Worker" }),
  ];
  assert.deepEqual(resolveProfileRef(profiles, smallId), {
    profile: profiles[0],
  });
  assert.deepEqual(resolveProfileRef(profiles, "small worker"), {
    profile: profiles[0],
  });
  assert.deepEqual(resolveProfileRef(profiles, "  BIG WORKER "), {
    profile: profiles[1],
  });
  assert.deepEqual(resolveProfileRef(profiles, "Missing"), {
    error: "unknown",
  });
  const ambiguous = [
    parsedProfile({ id: smallId, name: "Twin", notes: "first" }),
    parsedProfile({ id: bigId, name: "twin", notes: "second" }),
  ];
  assert.deepEqual(resolveProfileRef(ambiguous, "Twin"), {
    error: "ambiguous",
  });
});

void test("drafts and operations parse, with the id optional on create", () => {
  const draft = profileDraftSchema.parse({
    name: "Draft",
    provider: "pi",
  });
  assert.deepEqual(draft, {
    name: "Draft",
    notes: "",
    provider: "pi",
    routing: null,
    instructions: "",
  });
  assert.equal(
    profileDraftSchema.safeParse({ provider: "pi" }).success,
    false,
    "a name is required",
  );
  assert.equal(profileDraftSchema.parse({ ...draft, id: smallId }).id, smallId);
  assert.deepEqual(
    profileOperationSchema.parse({ kind: "mode", mode: "strict" }),
    {
      kind: "mode",
      mode: "strict",
    },
  );
  assert.equal(
    profileOperationSchema.safeParse({ kind: "mode", mode: "loud" }).success,
    false,
  );
  assert.equal(
    profileOperationSchema.safeParse({
      kind: "delete",
      id: "not-a-uuid",
    }).success,
    false,
  );
  assert.equal(
    profileOperationSchema.safeParse({ kind: "unknown" }).success,
    false,
  );
});

void test("profiles state and save results carry revisions and diagnostics", () => {
  const state = profilesStateSchema.parse({
    revision,
    catalogRevision: "b".repeat(64),
    mode: "warn",
    state: "missing",
    profiles: [],
    diagnostics: [
      {
        code: "store-missing",
        message:
          "No Conductor profiles yet; create them in Podium › Profiles. Routing mode is warn.",
      },
    ],
  });
  assert.equal(state.error, undefined);
  assert.equal(state.diagnostics[0]?.code, "store-missing");
  assert.equal(
    profilesStateSchema.safeParse({
      ...state,
      revision: "short",
    }).success,
    false,
  );
  assert.deepEqual(saveProfilesResultSchema.parse({ status: "saved", state }), {
    status: "saved",
    state,
  });
  const stale = saveProfilesResultSchema.parse({
    status: "stale",
    state,
    message: "Profiles changed since you opened them.",
  });
  assert.equal(stale.status, "stale");
  assert.equal(
    saveProfilesResultSchema.safeParse({
      status: "stale",
      state,
      message: "",
    }).success,
    false,
    "a stale message is required",
  );
});

void test("the save RPC requires an expected revision and one operation", () => {
  assert.equal(
    saveProfiles.input.safeParse({
      operation: { kind: "mode", mode: "strict" },
    }).success,
    false,
  );
  assert.equal(
    saveProfiles.input.safeParse({
      expectedRevision: revision,
      operation: {
        kind: "upsert",
        profile: { name: "Draft", provider: "pi" },
      },
    }).success,
    true,
  );
  assert.equal(
    listProfiles.input.safeParse({ unexpected: true }).success,
    false,
  );
});

void test("the provider catalog bounds providers, models and modes", () => {
  const catalog = providerCatalogSchema.parse({
    providers: [
      {
        id: "pi",
        label: "Pi",
        available: true,
        status: "ready",
        defaultModeId: "default",
        models: [
          {
            id: "pi-small",
            label: "Pi Small",
            isDefault: true,
            defaultThinkingOptionId: "low",
            thinkingOptions: [{ id: "low", label: "Low" }],
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
    ],
  });
  assert.equal(
    catalog.providers[0]?.models[0]?.thinkingOptions[0]?.isDefault,
    false,
  );
  assert.equal(catalog.providers[0]?.modes[0]?.elevated, true);
  assert.equal(
    providerCatalogSchema.safeParse({ providers: [{ id: "pi" }] }).success,
    false,
    "a provider needs its label, availability and status",
  );
  assert.deepEqual(listProfileProviders.output.parse({}), { providers: [] });
});

void test("an import result reports imported and skipped profiles", () => {
  const state = profilesStateSchema.parse({
    revision,
    catalogRevision: "b".repeat(64),
    mode: "warn",
    state: "valid",
    profiles: [],
    diagnostics: [],
  });
  const result = importProfilesResultSchema.parse({
    status: "saved",
    state,
    imported: 2,
    skipped: [{ name: "Twin", reason: "Name already exists." }],
  });
  assert.equal(result.status, "saved");
  assert.equal(result.imported, 2);
});

void test("records stored before profile snapshots still parse", () => {
  const legacy = storedSymphony();
  const parsed = symphonySchema.parse(legacy);
  assert.equal(
    parsed.revisions[0]?.score.tasks[0]?.worker.profileName,
    undefined,
  );
  assert.equal(legacy.execution.attempts[0]?.launch?.profileId, undefined);

  const oldAttempt = attemptSchema.parse({
    id: smallId,
    taskId: "work",
    agentId: "worker",
    state: "completed",
    startedAt: 1,
    endedAt: 2,
    message: null,
    report: null,
    reportHash: null,
    launch: {
      state: "started",
      profile: "default",
      generation: 0,
      prompt: "Carry out the task",
      settled: true,
    },
  });
  assert.equal(oldAttempt.launch?.profileId, undefined);
  assert.equal(oldAttempt.launch?.profileName, undefined);

  const snapshotted = attemptSchema.parse({
    ...oldAttempt,
    launch: {
      ...oldAttempt.launch,
      profileId: smallId,
      profileName: "Small Worker",
    },
  });
  assert.equal(snapshotted.launch?.profileId, smallId);
  assert.equal(snapshotted.launch?.profileName, "Small Worker");
});

void test("task and reopen workers accept a profile-name snapshot", () => {
  const withNames = storedSymphony();
  const firstRevision = withNames.revisions[0];
  assert.ok(firstRevision);
  const firstTask = firstRevision.score.tasks[0];
  assert.ok(firstTask);
  firstTask.worker = {
    role: "implementation",
    profile: smallId,
    profileName: "Small Worker",
  };
  assert.equal(
    symphonySchema.parse(withNames).revisions[0]?.score.tasks[0]?.worker
      .profileName,
    "Small Worker",
  );
});

void test("a sync preview bounds its rows and both revisions", () => {
  const row = { profileId: smallId, name: "Small Worker", action: "create" };
  const preview = syncPreviewSchema.parse({
    revision,
    paseoRevision: "b".repeat(64),
    entries: [row],
  });
  assert.equal(preview.entries[0]?.action, "create");
  assert.equal(preview.entries[0]?.paseoName, undefined);
  assert.equal(preview.entries[0]?.reason, undefined);
  assert.equal(
    syncPreviewSchema.safeParse({ ...preview, paseoRevision: "short" }).success,
    false,
  );
  assert.equal(
    syncPreviewSchema.safeParse({ ...preview, extra: true }).success,
    false,
    "unknown keys are rejected",
  );
  const tooMany = Array.from({ length: 33 }, () => row);
  assert.equal(
    syncPreviewSchema.safeParse({ ...preview, entries: tooMany }).success,
    false,
  );
  assert.equal(syncActionSchema.safeParse("delete").success, false);
  assert.equal(
    syncPreviewEntrySchema.safeParse({ ...row, action: "delete" }).success,
    false,
  );
  assert.equal(
    syncPreviewEntrySchema.safeParse({ ...row, profileId: "nope" }).success,
    false,
  );
  assert.equal(
    syncPreviewEntrySchema.safeParse({ ...row, reason: "" }).success,
    false,
    "a skip reason is non-empty when present",
  );
  assert.equal(
    syncPreviewEntrySchema.safeParse({ ...row, paseoName: "x".repeat(161) })
      .success,
    false,
  );
});

void test("sync results report counts or staleness with a fresh preview", () => {
  const preview = syncPreviewSchema.parse({
    revision,
    paseoRevision: "b".repeat(64),
    entries: [],
  });
  const saved = syncProfilesResultSchema.parse({
    status: "saved",
    preview,
    created: 1,
    updated: 2,
    unchanged: 3,
    skipped: [],
  });
  assert.equal(saved.status, "saved");
  if (saved.status !== "saved") {
    assert.fail("expected a saved result");
  }
  assert.deepEqual([saved.created, saved.updated, saved.unchanged], [1, 2, 3]);
  const defaulted = syncProfilesResultSchema.parse({
    status: "saved",
    preview,
    created: 0,
    updated: 0,
    unchanged: 0,
  });
  assert.equal(defaulted.status, "saved");
  if (defaulted.status !== "saved") {
    assert.fail("expected a saved result");
  }
  assert.deepEqual(defaulted.skipped, [], "skipped defaults to empty");
  const stale = syncProfilesResultSchema.parse({
    status: "stale",
    preview,
    message: "Profiles changed. Review and sync again.",
  });
  assert.equal(stale.status, "stale");
  assert.equal(
    syncProfilesResultSchema.safeParse({ status: "stale", preview }).success,
    false,
  );
  assert.equal(
    syncProfilesResultSchema.safeParse({
      status: "saved",
      preview,
      created: -1,
      updated: 0,
      unchanged: 0,
    }).success,
    false,
  );
});

void test("the sync RPCs require both revisions and one to 32 ids", () => {
  assert.equal(syncPreviewRpc.name, "profiles.sync-preview");
  assert.equal(syncProfilesRpc.name, "profiles.sync");
  assert.equal(syncPreviewRpc.input.safeParse({}).success, true);
  assert.equal(
    syncPreviewRpc.input.safeParse({ revision }).success,
    false,
    "the preview takes no input",
  );
  const input = {
    expectedRevision: revision,
    expectedPaseoRevision: "b".repeat(64),
    profileIds: [smallId],
  };
  assert.equal(syncProfilesRpc.input.safeParse(input).success, true);
  assert.equal(
    syncProfilesRpc.input.safeParse({ ...input, profileIds: [] }).success,
    false,
  );
  assert.equal(
    syncProfilesRpc.input.safeParse({
      ...input,
      profileIds: Array.from({ length: 33 }, () => smallId),
    }).success,
    false,
  );
  assert.equal(
    syncProfilesRpc.input.safeParse({ ...input, unexpected: true }).success,
    false,
  );
  assert.equal(
    syncProfilesRpc.input.safeParse({
      ...input,
      expectedPaseoRevision: "short",
    }).success,
    false,
  );
});
