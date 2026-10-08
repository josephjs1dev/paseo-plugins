import assert from "node:assert/strict";
import test from "node:test";
import { queueGroups } from "../shared/agents/hierarchy";
import { visibleItems } from "../shared/agents/attention";
import { snapshot } from "../server/agents/snapshot";
import { fileStore } from "../server/agents/store";
import { domainAgent, runtime, testDirectory } from "./fixtures";

async function family() {
  const parent = domainAgent({
    id: "a",
    title: "Conductor A",
    status: "running",
    pendingPermissions: [],
    attentionReason: null,
    requiresAttention: false,
  });
  const child = domainAgent({
    id: "b",
    title: "Task agent B",
    workspaceId: "other-workspace",
    labels: { "paseo.parent-agent-id": "a" },
  });
  const data = await snapshot(
    runtime(() => parent, {
      agents: async () => ({ entries: [child, parent], next: null }),
    }),
    fileStore(await testDirectory()),
    [],
  );
  return data.items;
}
await test("children nest under visible parents across concerts, with each request once", async () => {
  const items = await family();
  assert.equal(
    items.find((item) => item.agentId === "b")?.parentAgentTitle,
    "Conductor A",
  );
  assert.equal(items.find((item) => item.agentId === "a")?.childAgentCount, 1);
  const child = items.find((item) => item.agentId === "b");
  assert.ok(child);
  const groups = queueGroups(
    [
      ...items,
      { ...child, key: "f".repeat(64), requestId: "another-question" },
    ],
    "concert",
  );
  assert.deepEqual(
    groups.flatMap((group) =>
      group.entries.map(({ item, depth }) => [item.agentId, depth]),
    ),
    [
      ["a", 0],
      ["b", 1],
      ["b", 1],
    ],
  );
});
await test("a waiting child remains visible when a running parent is filtered out", async () => {
  const items = await family();
  const attention = visibleItems(items, "attention", "", undefined, Date.now());
  const rows = queueGroups(attention, "project").flatMap(
    (group) => group.entries,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.depth, 0);
  assert.equal(rows[0]?.item.parentAgentTitle, "Conductor A");
});
await test("missing parents and cycles cannot drop or duplicate agents", async () => {
  const items = await family();
  const cycle = items.map((item) => ({
    ...item,
    parentAgentId: item.agentId === "a" ? "b" : "a",
  }));
  assert.equal(
    queueGroups(cycle, "project").flatMap((group) => group.entries).length,
    2,
  );
  const missing = items.map((item) => ({
    ...item,
    parentAgentId: "unavailable",
  }));
  assert.equal(
    queueGroups(missing, "concert").flatMap((group) => group.entries).length,
    2,
  );
});

await test("a waiting child's priority lifts its parent above unrelated inactive agents", async () => {
  const items = await family();
  const parent = items.find((item) => item.agentId === "a");
  const child = items.find((item) => item.agentId === "b");
  assert.ok(parent);
  assert.ok(child);
  const inactive = {
    ...parent,
    key: "e".repeat(64),
    agentId: "unrelated",
    bucket: "idle" as const,
  };
  const groups = queueGroups([child, inactive, parent], "project");
  assert.deepEqual(
    groups.flatMap((group) => group.entries.map(({ item }) => item.agentId)),
    ["a", "b", "unrelated"],
  );
});
