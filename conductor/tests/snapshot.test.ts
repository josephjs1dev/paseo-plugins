import assert from "node:assert/strict";
import { test } from "node:test";
import { fileStore } from "../server/agents/store";
import { snapshot } from "../server/agents/snapshot";
import { agentKey } from "../server/agents/identity";
import { visibleItems, ageLabel } from "../shared/agents/inbox";
import { snapshotSchema } from "../shared/agents/models";
import { agent, question, runtime, testDirectory } from "./fixtures";
import { InboxSession } from "../client/podium/session";

async function store() {
  return fileStore(await testDirectory());
}
await test("the default attention queue combines questions, approvals, failures, and reminders with consistent snoozing", async () => {
  const storage = await store();
  const idle = {
    pendingPermissions: [],
    requiresAttention: false,
    attentionReason: null,
  };
  const agents = [
    agent({ id: "question" }),
    agent({ id: "approval", pendingPermissions: [question({ kind: "tool" })] }),
    agent({ id: "permission", pendingPermissions: [] }),
    agent({ ...idle, id: "failed", status: "error" }),
    agent({ ...idle, id: "reminder" }),
    agent({ ...idle, id: "running", status: "running" }),
    agent({ ...idle, id: "idle" }),
    agent({ id: "closed", status: "closed" }),
  ];
  await storage.annotate({
    key: agentKey("reminder"),
    until: null,
    marked: true,
  });
  const host = runtime(() => null, {
    agents: async () => ({ entries: agents, next: null }),
  });
  const initial = await snapshot(host, storage, [], 1000);
  const filter = new InboxSession().getSnapshot().filter;
  assert.equal(filter, "attention");
  const attention = visibleItems(initial.items, filter, "", undefined, 1000);
  assert.deepEqual(attention.map((item) => item.agentId).sort(), [
    "approval",
    "failed",
    "permission",
    "question",
    "reminder",
  ]);
  for (const item of attention) {
    await storage.annotate({ key: item.key, until: 2000, marked: item.marked });
  }
  const snoozed = await snapshot(host, storage, [], 1500);
  assert.equal(
    visibleItems(snoozed.items, filter, "", undefined, 1500).length,
    0,
  );
  assert.equal(
    visibleItems(snoozed.items, filter, "", undefined, 1500, true).length,
    5,
  );
  assert.equal(
    visibleItems(snoozed.items, filter, "", undefined, 2001).length,
    5,
  );
  assert.equal(
    visibleItems(snoozed.items, "all", "", undefined, 1500).length,
    8,
  );
});
await test("one agent with multiple requests exposes each exact request; errors retain precedence", async () => {
  const current = agent({
    status: "error",
    pendingPermissions: [question(), question({ id: "another" })],
  });
  const result = await snapshot(
    runtime(() => current),
    await store(),
    [],
  );
  snapshotSchema.parse(result);
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0]?.bucket, "failed");
  assert.notEqual(result.items[0]?.key, result.items[1]?.key);
  assert.equal(
    visibleItems(result.items, "attention", "", undefined, Date.now()).length,
    2,
  );
});
await test("truncated directories preserve known pending agents through direct inspection", async () => {
  let inspections = 0;
  const result = await snapshot(
    runtime(() => agent(), {
      agents: async () => ({ entries: [], next: "repeating-cursor" }),
      inspect: async () => {
        inspections++;
        return agent();
      },
    }),
    await store(),
    ["agent-1"],
  );
  assert.equal(result.incomplete, true);
  assert.equal(result.items.length, 1);
  assert.equal(inspections, 1);
});
await test("workspace failures preserve agent requests and explicitly mark names incomplete", async () => {
  const result = await snapshot(
    runtime(() => agent(), {
      workspaces: async () => {
        throw new Error("workspace directory unavailable");
      },
    }),
    await store(),
    [],
  );
  assert.equal(result.workspaceIncomplete, true);
  assert.equal(result.items.length, 1);
});
await test("inspection failures are never interpreted as resolution", async () => {
  await assert.rejects(
    snapshot(
      runtime(() => null, {
        inspect: async () => {
          throw new Error("offline");
        },
      }),
      await store(),
      ["agent-1"],
    ),
  );
});
await test("snooze is request-specific, expires, and manual reminders persist independently", async () => {
  const storage = await store();
  const host = runtime(() => agent());
  const initial = await snapshot(host, storage, [], 1000);
  const item = initial.items[0];
  assert.ok(item);
  await storage.annotate({ key: item.key, until: 2000, marked: false });
  const next = await snapshot(host, storage, [], 1500);
  assert.equal(
    visibleItems(next.items, "attention", "", undefined, 1500).length,
    0,
  );
  assert.equal(
    visibleItems(next.items, "attention", "", undefined, 1500, true).length,
    1,
  );
  assert.equal(visibleItems(next.items, "all", "", undefined, 1500).length, 1);
  assert.equal(
    visibleItems(next.items, "attention", "", undefined, 2001).length,
    1,
  );
  await storage.annotate({
    key: agentKey("agent-1"),
    until: null,
    marked: true,
  });
  const idle = await snapshot(
    runtime(() =>
      agent({
        pendingPermissions: [],
        attentionReason: null,
        requiresAttention: false,
      }),
    ),
    storage,
    [],
  );
  assert.equal(idle.items[0]?.marked, true);
  assert.equal(idle.items[0]?.bucket, "waiting");
});
await test("archived agents are excluded; idle is not fabricated as finished", async () => {
  assert.equal(
    (
      await snapshot(
        runtime(() => agent({ archivedAt: new Date().toISOString() })),
        await store(),
        [],
      )
    ).items.length,
    0,
  );
  const result = await snapshot(
    runtime(() =>
      agent({
        pendingPermissions: [],
        requiresAttention: false,
        attentionReason: null,
      }),
    ),
    await store(),
    [],
  );
  assert.equal(result.items[0]?.bucket, "idle");
  assert.equal(result.items[0]?.title, "API worker");
});
await test("drafts survive selecting another request and remain bound to their original key", async () => {
  const result = await snapshot(
    runtime(() =>
      agent({ pendingPermissions: [question(), question({ id: "two" })] }),
    ),
    await store(),
    [],
  );
  const first = result.items[0];
  const second = result.items[1];
  assert.ok(first);
  assert.ok(second);
  const session = new InboxSession();
  session.select(first);
  session.draft(first.key, {
    kind: "answers",
    answers: [{ selected: [], text: "Keep this draft" }],
  });
  session.select(second);
  session.select(first);
  assert.deepEqual(session.getSnapshot().drafts[first.key], {
    kind: "answers",
    answers: [{ selected: [], text: "Keep this draft" }],
  });
  assert.notDeepEqual(
    session.getSnapshot().drafts[second.key],
    session.getSnapshot().drafts[first.key],
  );
});
await test("age calculation handles invalid and future timestamps without misleading negative ages", () => {
  assert.equal(ageLabel("invalid", Date.now()), "Unknown age");
  assert.equal(
    ageLabel("2026-10-05T00:00:00Z", Date.parse("2026-10-04T00:00:00Z")),
    "Just now",
  );
});

await test("initial load discovers existing agents across pages without prior registration", async () => {
  const existing = Array.from({ length: 205 }, (_, index) =>
    agent({
      id: `existing-${index}`,
      pendingPermissions: index === 204 ? [question()] : [],
      status: index === 0 ? "running" : "idle",
      attentionReason: null,
      requiresAttention: false,
    }),
  );
  const host = runtime(() => null, {
    agents: async (cursor) => ({
      entries: cursor ? existing.slice(200) : existing.slice(0, 200),
      next: cursor ? null : "next-page",
    }),
  });
  const result = await snapshot(host, await store(), []);
  assert.equal(new Set(result.items.map((item) => item.agentId)).size, 205);
  assert.equal(result.incomplete, false);
  assert.equal(
    visibleItems(result.items, "attention", "", undefined, Date.now())[0]
      ?.agentId,
    "existing-204",
  );
  assert.equal(
    visibleItems(result.items, "running", "", undefined, Date.now()).length,
    1,
  );
  assert.equal(
    visibleItems(result.items, "inactive", "", undefined, Date.now()).length,
    203,
  );
});
