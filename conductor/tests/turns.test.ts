import assert from "node:assert/strict";
import test from "node:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { turnJournal } from "../server/agents/turns";
import { snapshot } from "../server/agents/snapshot";
import { fileStore } from "../server/agents/store";
import { agentKey } from "../server/agents/identity";
import { visibleItems } from "../shared/agents/inbox";
import { agent, runtime, testDirectory } from "./fixtures";

const idle = () =>
  agent({
    pendingPermissions: [],
    attentionReason: null,
    requiresAttention: false,
  });

await test("idle, closed, and unread attention never fabricate a turn outcome", async () => {
  const directory = await testDirectory();
  const turns = turnJournal(join(directory, "turns"));
  for (const status of ["idle", "closed"] as const) {
    const current = {
      ...idle(),
      status,
      requiresAttention: true,
      attentionReason: "finished" as const,
    };
    const result = await snapshot(
      runtime(() => current),
      fileStore(directory),
      [],
      1000,
      turns,
    );
    assert.equal(result.items[0]?.bucket, status);
    assert.equal(result.items[0]?.lastTurn, null);
    assert.equal(
      result.items.filter((item) => item.lastTurn !== null).length,
      0,
    );
  }
});

await test("recorded completion survives attention clearing, closure, and journal reload", async () => {
  const directory = await testDirectory();
  const turns = turnJournal(join(directory, "turns"));
  const current = idle();
  await turns.record(
    current.id,
    { turnId: "turn-a", kind: "completed", at: 1000 },
    async () => current,
  );
  const first = await turns.last(current);
  assert.equal(first?.outcome, "completed");
  const reloaded = turnJournal(join(directory, "turns"));
  assert.deepEqual(
    await reloaded.last({ ...current, updatedAt: new Date().toISOString() }),
    first,
  );
  const result = await snapshot(
    runtime(() => ({ ...current, status: "closed" })),
    fileStore(directory),
    [],
    2000,
    reloaded,
  );
  assert.equal(result.items[0]?.bucket, "closed");
  assert.equal(
    visibleItems(result.items, "inactive", "", undefined, 2000).length,
    1,
  );
  assert.equal(
    visibleItems(result.items, "inactive", "", undefined, 2000).length,
    1,
  );
});

await test("new turns and missed endings remain unknown instead of inheriting an old completion", async () => {
  const directory = await testDirectory();
  const turns = turnJournal(directory);
  const current = idle();
  await turns.record(
    current.id,
    { turnId: "old", kind: "completed", at: 1000 },
    async () => current,
  );
  assert.equal(await turns.last({ ...current, status: "running" }), null);
  assert.equal(
    await turns.last({
      ...current,
      lastUserMessageAt: new Date().toISOString(),
    }),
    null,
  );
  assert.equal(
    await turns.last({
      ...current,
      persistence: { provider: "codex", sessionId: "new-session" },
    }),
    null,
  );
  await turns.record(
    current.id,
    { turnId: "new", kind: "started", at: 2000 },
    async () => current,
  );
  assert.equal(await turnJournal(directory).last(current), null);
  await turns.record(
    current.id,
    { turnId: "old", kind: "completed", at: 3000 },
    async () => current,
  );
  assert.equal(await turns.last(current), null);
});

await test("canceled and failed outcomes remain distinct, including providers without turn IDs", async () => {
  const turns = turnJournal(await testDirectory());
  const current = idle();
  for (const [index, outcome] of ["canceled", "failed"].entries()) {
    assert.ok(outcome === "canceled" || outcome === "failed");
    await turns.record(
      current.id,
      { turnId: null, kind: "started", at: 1000 + index * 1000 },
      async () => current,
    );
    await turns.record(
      current.id,
      { turnId: null, kind: outcome, at: 1500 + index * 1000 },
      async () => current,
    );
    assert.equal((await turns.last(current))?.outcome, outcome);
  }
});

await test("queued hooks persist in order and duplicate hooks do not regress ended turns", async () => {
  const turns = turnJournal(await testDirectory());
  const current = idle();
  const start = turns.record(
    current.id,
    { turnId: "same", kind: "started", at: 1000 },
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return current;
    },
  );
  const end = turns.record(
    current.id,
    { turnId: "same", kind: "completed", at: 2000 },
    async () => current,
  );
  await Promise.all([start, end, turns.flush()]);
  const original = await turns.last(current);
  await turns.record(
    current.id,
    { turnId: "same", kind: "started", at: 3000 },
    async () => current,
  );
  await turns.record(
    current.id,
    { turnId: "same", kind: "completed", at: 4000 },
    async () => current,
  );
  await turns.record(
    current.id,
    { turnId: "older", kind: "failed", at: 500 },
    async () => current,
  );
  assert.deepEqual(await turns.last(current), original);
});

await test("an older hook cannot overwrite a different active turn", async () => {
  const turns = turnJournal(await testDirectory());
  const current = {
    ...idle(),
    activeTurn: { turnId: "current", startedAt: "2026-10-04T12:00:00Z" },
  };
  await turns.record(
    current.id,
    { turnId: "previous", kind: "completed", at: 1000 },
    async () => current,
  );
  assert.equal(await turns.last(idle()), null);
});

await test("closing a live session preserves outcomes when only its persisted session handle remains", async () => {
  const directory = await testDirectory();
  const turns = turnJournal(directory);
  const current = {
    ...idle(),
    runtimeInfo: { provider: "codex", sessionId: "session-1" },
  };
  await turns.record(
    current.id,
    { turnId: "one", kind: "completed", at: 1000 },
    async () => current,
  );
  const closed = { ...idle(), status: "closed" as const };
  assert.deepEqual(
    await turnJournal(directory).last(closed),
    await turns.last(current),
  );
  assert.equal((await turns.last(closed))?.outcome, "completed");
});

await test("corrupt history preserves agent coverage and exposes unknown outcomes", async () => {
  const directory = await testDirectory();
  const turns = turnJournal(directory);
  const current = idle();
  await turns.record(
    current.id,
    { turnId: "one", kind: "completed", at: 1000 },
    async () => current,
  );
  await writeFile(join(directory, `${agentKey(current.id)}.json`), "corrupt");
  const result = await snapshot(
    runtime(() => current),
    fileStore(join(directory, "metadata")),
    [],
    1000,
    turns,
  );
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0]?.lastTurn, null);
  assert.equal(result.turnHistoryIncomplete, true);
});
