import assert from "node:assert/strict";
import test from "node:test";
import { archiveInactive, archiveKey } from "../server/archive";
import { agent, runtime } from "./fixtures";

const inactive = () =>
  agent({
    pendingPermissions: [],
    attentionReason: null,
    requiresAttention: false,
  });
await test("an inactive leaf can be archived once; repeated calls are already archived", async () => {
  let current = inactive();
  let calls = 0;
  const key = archiveKey(current);
  assert.ok(key);
  const host = runtime(() => current, {
    archive: async () => {
      calls++;
      current = { ...current, archivedAt: new Date().toISOString() };
    },
  });
  const input = { agentId: current.id, key };
  assert.deepEqual(await archiveInactive(host, input), { status: "archived" });
  assert.deepEqual(await archiveInactive(host, input), { status: "archived" });
  assert.equal(calls, 1);
});
await test("a fresh inactivity and fingerprint check rejects changed, running, or waiting agents", async () => {
  const old = inactive();
  const key = archiveKey(old);
  assert.ok(key);
  const variants = [
    { ...old, status: "running" as const },
    { ...old, updatedAt: "2026-10-05T00:00:00Z" },
    agent(),
    { ...old, activeTurn: { turnId: "new", startedAt: null } },
    { ...old, persistence: { provider: "codex", sessionId: "replacement" } },
  ];
  for (const current of variants) {
    let calls = 0;
    const result = await archiveInactive(
      runtime(() => current, {
        archive: async () => {
          calls++;
        },
      }),
      { agentId: old.id, key },
    );
    assert.equal(result.status, "stale");
    assert.equal(calls, 0);
  }
});
await test("any unarchived child blocks parent archive, even across workspaces", async () => {
  const parent = inactive();
  const key = archiveKey(parent);
  assert.ok(key);
  const child = agent({
    id: "child",
    workspaceId: "another-worktree",
    labels: { "paseo.parent-agent-id": parent.id },
  });
  let calls = 0;
  const host = runtime(() => parent, {
    agents: async () => ({ entries: [parent, child], next: null }),
    archive: async () => {
      calls++;
    },
  });
  assert.equal(
    (await archiveInactive(host, { agentId: parent.id, key })).status,
    "has_children",
  );
  assert.equal(calls, 0);
});
await test("incomplete directories and uncertain archive acknowledgments fail conservatively", async () => {
  const current = inactive();
  const key = archiveKey(current);
  assert.ok(key);
  let calls = 0;
  const input = { agentId: current.id, key };
  const incomplete = runtime(() => current, {
    agents: async () => ({ entries: [current], next: "repeat" }),
    archive: async () => {
      calls++;
    },
  });
  assert.equal((await archiveInactive(incomplete, input)).status, "incomplete");
  assert.equal(calls, 0);
  const uncertain = runtime(() => current, {
    archive: async () => {
      calls++;
      throw new Error("lost acknowledgment");
    },
  });
  assert.equal((await archiveInactive(uncertain, input)).status, "unknown");
  assert.equal(calls, 1);
});
