import assert from "node:assert/strict";
import {
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  PROFILES_FILE,
  PROFILE_LIMITS,
  profileStoreSchema,
  resolveProfileRef,
  type ConductorProfile,
  type ProfileDraft,
} from "../shared/symphonies/profiles";
import { SymphonyError } from "../server/symphonies/errors";
import {
  profileStoreSource,
  profilesState,
} from "../server/symphonies/profiles";
import { readBoundedHandle } from "../server/files";
import { providerCatalog } from "../server/paseo/provider-catalog";
import type { PaseoApi } from "../server/paseo/types";

async function directory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "conductor-profiles-"));
}

const draft = (
  name: string,
  extra: Partial<ProfileDraft> = {},
): ProfileDraft => ({
  name,
  provider: "pi",
  notes: "",
  routing: null,
  instructions: "",
  ...extra,
});

function source(path: string | null) {
  return profileStoreSource(path);
}

void test("a missing store is an empty warn store with a diagnostic", async () => {
  const dir = await directory();
  try {
    const store = await source(join(dir, PROFILES_FILE)).load();
    assert.equal(store.state, "missing");
    assert.equal(store.mode, "warn");
    assert.deepEqual(store.profiles, []);
    assert.deepEqual(
      store.diagnostics.map((entry) => entry.code),
      ["store-missing"],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("save creates, updates, deletes and sets the mode durably", async () => {
  const dir = await directory();
  const path = join(dir, PROFILES_FILE);
  try {
    const store = source(path);
    const created = await store.save((await store.load()).revision, {
      kind: "upsert",
      profile: draft("Small Worker", { model: "pi-small" }),
    });
    assert.equal(created.status, "saved");
    const profileId = created.status === "saved" ? created.profileId : null;
    assert.ok(profileId);
    const onDisk = profileStoreSchema.parse(
      JSON.parse(await readFile(path, "utf8")) as unknown,
    );
    assert.deepEqual(
      onDisk.profiles.map((profile) => profile.name),
      ["Small Worker"],
    );
    assert.equal(onDisk.profiles[0]?.model, "pi-small");

    const updated = await store.save(created.state.revision, {
      kind: "upsert",
      profile: draft("Small Worker", { id: profileId, notes: "Renamed" }),
    });
    assert.equal(updated.status, "saved");
    assert.equal(updated.state.profiles[0]?.notes, "Renamed");

    const strict = await store.save(updated.state.revision, {
      kind: "mode",
      mode: "strict",
    });
    assert.equal(strict.status, "saved");
    assert.equal((await store.load()).mode, "strict");

    const deleted = await store.save(strict.state.revision, {
      kind: "delete",
      id: profileId,
    });
    assert.equal(deleted.status, "saved");
    assert.deepEqual(deleted.state.profiles, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("a stale save is rejected without writing", async () => {
  const dir = await directory();
  const path = join(dir, PROFILES_FILE);
  try {
    const store = source(path);
    const first = await store.load();
    const saved = await store.save(first.revision, {
      kind: "upsert",
      profile: draft("One"),
    });
    assert.equal(saved.status, "saved");
    const stale = await store.save(first.revision, {
      kind: "upsert",
      profile: draft("Two"),
    });
    assert.equal(stale.status, "stale");
    assert.match(stale.message, /Profiles changed since/);
    assert.deepEqual(
      (await store.load()).profiles.map((profile) => profile.name),
      ["One"],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("an atomic save leaves no temp file behind", async () => {
  const dir = await directory();
  const path = join(dir, PROFILES_FILE);
  try {
    const store = source(path);
    await store.save((await store.load()).revision, {
      kind: "upsert",
      profile: draft("Atomic"),
    });
    const entries = await readdir(dir);
    assert.deepEqual(entries.sort(), [PROFILES_FILE]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("invalid, oversized and non-JSON stores load as invalid", async () => {
  const dir = await directory();
  const path = join(dir, PROFILES_FILE);
  try {
    const store = source(path);
    await writeFile(path, "{not json");
    const invalid = await store.load();
    assert.equal(invalid.state, "invalid");
    assert.match(invalid.error ?? "", /not valid JSON/);
    assert.deepEqual(invalid.profiles, []);

    await writeFile(path, JSON.stringify({ version: 2 }));
    const badVersion = await store.load();
    assert.equal(badVersion.state, "invalid");

    await writeFile(path, "x".repeat(PROFILE_LIMITS.storeBytes + 1));
    const oversized = await store.load();
    assert.equal(oversized.state, "invalid");
    assert.match(oversized.error ?? "", /larger than the size limit/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("a symlinked store is refused rather than followed", async () => {
  const dir = await directory();
  const target = join(dir, "target.json");
  const path = join(dir, PROFILES_FILE);
  try {
    await writeFile(
      target,
      JSON.stringify({
        version: 1,
        mode: "warn",
        profiles: [
          {
            id: "11111111-1111-4111-8111-111111111111",
            name: "X",
            provider: "pi",
          },
        ],
      }),
    );
    try {
      await symlink(target, path);
    } catch {
      return; // The platform does not permit symlink creation; nothing to assert.
    }
    const loaded = await source(path).load();
    assert.equal(loaded.state, "invalid");
    assert.deepEqual(loaded.profiles, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("cross-profile validation rejects duplicate names", async () => {
  const dir = await directory();
  const path = join(dir, PROFILES_FILE);
  try {
    const store = source(path);
    const first = await store.save((await store.load()).revision, {
      kind: "upsert",
      profile: draft("Twin"),
    });
    await assert.rejects(
      store.save(first.state.revision, {
        kind: "upsert",
        profile: draft("twin"),
      }),
      (error: unknown) =>
        error instanceof SymphonyError && /already exists/.test(error.message),
    );
    assert.deepEqual((await store.load()).profiles.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("a legacy profiles.json loads and saves in the new shape", async () => {
  const dir = await directory();
  const path = join(dir, PROFILES_FILE);
  try {
    const legacyId = "11111111-1111-4111-8111-111111111111";
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        mode: "warn",
        profiles: [
          {
            id: legacyId,
            name: "Small",
            provider: "pi",
            routing: {
              roles: ["implementation"],
              domains: ["frontend"],
              preferenceTier: 3,
              fallbacks: [],
              excludeWhen: [],
            },
          },
        ],
      }),
    );
    const store = source(path);
    const loaded = await store.load();
    assert.equal(loaded.state, "valid");
    assert.deepEqual(loaded.profiles[0]?.routing, {
      roles: ["implementation"],
    });
    assert.equal(loaded.profiles[0]?.routing?.size, undefined);
    const saved = await store.save(loaded.revision, {
      kind: "upsert",
      profile: draft("Small", {
        id: legacyId,
        routing: { roles: ["implementation"], size: "small" },
      }),
    });
    assert.equal(saved.status, "saved");
    const onDisk = JSON.parse(await readFile(path, "utf8")) as {
      profiles: { routing: Record<string, unknown> }[];
    };
    assert.deepEqual(onDisk.profiles[0]?.routing, {
      roles: ["implementation"],
      size: "small",
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("deleting an unknown profile id is refused", async () => {
  const dir = await directory();
  const path = join(dir, PROFILES_FILE);
  try {
    const store = source(path);
    await assert.rejects(
      store.save((await store.load()).revision, {
        kind: "delete",
        id: "11111111-1111-4111-8111-111111111111",
      }),
      (error: unknown) =>
        error instanceof SymphonyError &&
        /no longer exists/.test(error.message),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("profile resolution matches an id first, then a unique name", async () => {
  const dir = await directory();
  const path = join(dir, PROFILES_FILE);
  try {
    const store = source(path);
    const first = await store.save((await store.load()).revision, {
      kind: "upsert",
      profile: draft("Small Worker"),
    });
    assert.equal(first.status, "saved");
    const id = first.status === "saved" ? first.profileId : null;
    assert.ok(id);
    const saved = await store.save(first.state.revision, {
      kind: "upsert",
      profile: draft("Big Worker"),
    });
    assert.equal(saved.status, "saved");
    const profiles = (await store.load()).profiles;
    assert.deepEqual(resolveProfileRef(profiles, id), { profile: profiles[0] });
    assert.deepEqual(resolveProfileRef(profiles, "small worker"), {
      profile: profiles[0],
    });
    assert.deepEqual(resolveProfileRef(profiles, "  BIG WORKER "), {
      profile: profiles[1],
    });
    assert.deepEqual(resolveProfileRef(profiles, "Missing"), {
      error: "unknown",
    });
    const twins: ConductorProfile[] = [
      profiles[0] as ConductorProfile,
      { ...(profiles[0] as ConductorProfile), id: profiles[1]?.id ?? id },
    ];
    assert.deepEqual(resolveProfileRef(twins, "Small Worker"), {
      error: "ambiguous",
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("import copies Paseo profiles once and skips collisions", async () => {
  const dir = await directory();
  const path = join(dir, PROFILES_FILE);
  try {
    const store = source(path);
    const imported = await store.importFromPaseo((await store.load()).revision);
    assert.equal(imported.status, "saved");
    assert.equal(imported.imported, 0);
    assert.deepEqual(imported.skipped, []);

    const withPaseo = profileStoreSource(path, async () => [
      {
        id: "paseo-1",
        name: "Reviewer",
        provider: "codex",
        model: "gpt-review",
        modeId: "auto-review",
        thinkingOptionId: "high",
        notes: "Reviews only",
      },
      { id: "paseo-2", name: "inherit", provider: "pi" },
      { id: "paseo-3", name: "Reviewer", provider: "pi" },
    ]);
    const first = await withPaseo.importFromPaseo(
      (await withPaseo.load()).revision,
    );
    assert.equal(first.status, "saved");
    assert.equal(first.imported, 1);
    assert.equal(first.skipped.length, 2);
    assert.equal(first.state.profiles[0]?.name, "Reviewer");
    assert.equal(first.state.profiles[0]?.model, "gpt-review");
    assert.equal(first.state.profiles[0]?.routing, null);
    assert.equal(first.state.profiles[0]?.instructions, "");

    const second = await withPaseo.importFromPaseo(first.state.revision);
    assert.equal(second.status, "saved");
    assert.equal(second.imported, 0);
    assert.equal(second.skipped.length, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("the store state carries both revisions and never leaks instructions", async () => {
  const dir = await directory();
  const path = join(dir, PROFILES_FILE);
  try {
    const store = source(path);
    const saved = await store.save((await store.load()).revision, {
      kind: "upsert",
      profile: draft("Small", { instructions: "Use the skill." }),
    });
    assert.equal(saved.status, "saved");
    const state = profilesState(await store.load());
    assert.equal(state.revision.length, 64);
    assert.equal(state.catalogRevision.length, 64);
    assert.equal(state.profiles[0]?.instructions, "Use the skill.");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("two instances cannot lose an acknowledged save", async () => {
  const dir = await directory();
  const path = join(dir, PROFILES_FILE);
  try {
    const first = source(path);
    const second = source(path);
    const initial = await first.load();
    const [left, right] = await Promise.all([
      first.save(initial.revision, { kind: "upsert", profile: draft("One") }),
      second.save(initial.revision, { kind: "upsert", profile: draft("Two") }),
    ]);
    assert.deepEqual([left.status, right.status].sort(), ["saved", "stale"]);
    const onDisk = profileStoreSchema.parse(
      JSON.parse(await readFile(path, "utf8")) as unknown,
    );
    const savedName = left.status === "saved" ? "One" : "Two";
    assert.deepEqual(
      onDisk.profiles.map((profile) => profile.name),
      [savedName],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("missing, unreadable and each invalid content get distinct revisions", async () => {
  const dir = await directory();
  const path = join(dir, PROFILES_FILE);
  try {
    const store = source(path);
    const missing = await store.load();
    assert.equal(missing.state, "missing");

    // Missing -> a different invalid content is stale.
    await writeFile(path, "{one");
    const invalidOne = await store.load();
    assert.equal(invalidOne.state, "invalid");
    assert.notEqual(invalidOne.revision, missing.revision);
    const staleFromMissing = await store.save(missing.revision, {
      kind: "upsert",
      profile: draft("One"),
    });
    assert.equal(staleFromMissing.status, "stale");
    assert.equal(await readFile(path, "utf8"), "{one");

    // One invalid content -> a different invalid content is stale.
    await writeFile(path, "{two");
    const invalidTwo = await store.load();
    assert.equal(invalidTwo.state, "invalid");
    assert.notEqual(invalidTwo.revision, invalidOne.revision);
    const staleFromInvalid = await store.save(invalidOne.revision, {
      kind: "upsert",
      profile: draft("Two"),
    });
    assert.equal(staleFromInvalid.status, "stale");
    assert.equal(await readFile(path, "utf8"), "{two");

    // A valid empty store has the missing revision but not the invalid one.
    await writeFile(
      path,
      JSON.stringify({ version: 1, mode: "warn", profiles: [] }),
    );
    const validEmpty = await store.load();
    assert.equal(validEmpty.state, "valid");
    assert.equal(validEmpty.revision, missing.revision);
    assert.notEqual(validEmpty.revision, invalidTwo.revision);
    const staleFromSecondInvalid = await store.save(invalidTwo.revision, {
      kind: "upsert",
      profile: draft("Three"),
    });
    assert.equal(staleFromSecondInvalid.status, "stale");

    // An unreadable (oversize) store gets its own revision.
    await writeFile(path, "x".repeat(PROFILE_LIMITS.storeBytes + 1));
    const unreadable = await store.load();
    assert.equal(unreadable.state, "invalid");
    assert.notEqual(unreadable.revision, missing.revision);
    assert.notEqual(unreadable.revision, invalidOne.revision);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("a store that grows after the size check is rejected", async () => {
  const dir = await directory();
  const path = join(dir, PROFILES_FILE);
  try {
    await writeFile(path, "0123456789abcdef");
    const handle = await open(path, "r");
    try {
      assert.equal((await handle.stat()).size, 16);
      // The file grows between the caller's stat and the bounded read.
      await writeFile(path, `0123456789abcdef${"Z".repeat(114)}`);
      await assert.rejects(readBoundedHandle(handle, 16), /storage is invalid/);
    } finally {
      await handle.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function catalogFor(entries: unknown[]) {
  const paseo = {
    providers: { snapshot: async () => ({ entries }) },
  } as unknown as PaseoApi;
  return providerCatalog(paseo);
}

void test("the provider catalog honors enabled and status for availability", async () => {
  const catalog = await catalogFor([
    { provider: "ready", label: "Ready", enabled: true, status: "ready" },
    {
      provider: "disabled",
      label: "Disabled",
      enabled: false,
      status: "ready",
    },
    { provider: "loading", label: "Loading", enabled: true, status: "loading" },
    {
      provider: "error",
      label: "Error",
      enabled: true,
      status: "error",
      error: "boom",
    },
  ]);
  const byId = Object.fromEntries(
    catalog.providers.map((provider) => [provider.id, provider]),
  );
  assert.equal(byId.ready?.available, true);
  assert.equal(byId.disabled?.available, false);
  assert.equal(byId.loading?.available, false);
  assert.equal(byId.error?.available, false);
  assert.equal(byId.error?.error, "boom");
});

void test("the provider catalog maps models, thinking options and elevated modes", async () => {
  const catalog = await catalogFor([
    {
      provider: "pi",
      label: "Pi",
      enabled: true,
      status: "ready",
      defaultModeId: "auto",
      models: [
        {
          id: "m",
          label: "M",
          isDefault: true,
          defaultThinkingOptionId: "low",
          thinkingOptions: [{ id: "low", label: "Low", isDefault: true }],
        },
        { id: "hidden", label: "Hidden", isSelectable: false },
      ],
      modes: [
        { id: "full-access", label: "Full access" },
        { id: "auto", label: "Auto" },
      ],
    },
  ]);
  const entry = catalog.providers[0];
  assert.equal(entry?.defaultModeId, "auto");
  assert.deepEqual(
    entry?.models.map((model) => model.id),
    ["m"],
  );
  assert.equal(entry?.models[0]?.defaultThinkingOptionId, "low");
  assert.deepEqual(entry?.models[0]?.thinkingOptions, [
    { id: "low", label: "Low", isDefault: true },
  ]);
  assert.deepEqual(
    entry?.modes.map((mode) => [mode.id, mode.elevated]),
    [
      ["full-access", true],
      ["auto", false],
    ],
  );
});
