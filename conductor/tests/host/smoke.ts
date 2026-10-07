import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
// Integration harness only: plugin production code uses the public PaseoApi.
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { createPaseoApi } from "@getpaseo/client";
import { snapshotSchema, answerResultSchema } from "../../shared/agents/models";
import { observeDirectory } from "../../client/paseo/observation";

const endpoint = process.env.CONDUCTOR_TEST_URL;
if (!endpoint || !/^ws:\/\/127\.0\.0\.1:\d+\/ws$/.test(endpoint)) {
  throw new Error(
    "Set CONDUCTOR_TEST_URL to the disposable local test daemon WebSocket URL.",
  );
}
const client = new DaemonClient({
  url: endpoint,
  clientId: "conductor-integration-test",
  clientType: "cli",
  appVersion: "0.11.0-beta.3",
  reconnect: { enabled: false },
});
const directory = await mkdtemp(join(tmpdir(), "conductor-host-workspace-"));
let agentId: string | undefined;
let childAgentId: string | undefined;
let workspaceId: string | undefined;
let stopObservation: (() => void) | undefined;
let observedUpdates = 0;
async function waitForUpdate(previous: number) {
  const deadline = Date.now() + 5000;
  while (observedUpdates <= previous && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(
    observedUpdates > previous,
    "Directory observer should refresh for existing agents",
  );
}
try {
  await client.connect();
  const plugins = await client.listPlugins();
  assert.ok(
    plugins.some(
      (plugin) => plugin.id === "conductor" && plugin.status === "running",
    ),
  );
  await client.installDirectoryPlugin(resolve("tests/host/provider"));
  const paseo = createPaseoApi(client);
  const workspace = await paseo.workspaces.open(directory);
  workspaceId = workspace.id;
  const worker = await workspace.agents.create({
    config: { provider: "conductor-test/fixture" },
    title: "Conductor synthetic test",
    prompt: "Produce the fixture question",
  });
  agentId = worker.id;
  const outcome = await worker.waitForFinish(15000);
  assert.equal(outcome.status, "permission");
  const first = snapshotSchema.parse(
    await client.invokePluginRpc("conductor", "inbox.get", {
      knownAgentIds: [worker.id],
    }),
  );
  const item = first.items.find(
    (entry) => entry.agentId === worker.id && entry.requestId !== null,
  );
  assert.ok(item);
  assert.equal(item.form?.kind, "questions");
  await client.invokePluginRpc("conductor", "inbox.annotate", {
    kind: "snooze",
    key: item.key,
    minutes: 15,
  });
  await client.reloadPlugin("conductor");
  const reloaded = snapshotSchema.parse(
    await client.invokePluginRpc("conductor", "inbox.get", {
      knownAgentIds: [worker.id],
    }),
  );
  assert.ok(
    (reloaded.items.find((entry) => entry.key === item.key)?.snoozedUntil ??
      0) > Date.now(),
  );
  const input = {
    key: item.key,
    agentId: worker.id,
    requestId: item.requestId,
    decision: { kind: "answers", answers: [{ selected: [0], text: "" }] },
  };
  // Attach after the worker already exists, just as when installing Conductor mid-task.
  stopObservation = observeDirectory(paseo, () => {
    observedUpdates++;
  });
  await waitForUpdate(0);
  const updatesBeforeAnswer = observedUpdates;
  const result = answerResultSchema.parse(
    await client.invokePluginRpc("conductor", "inbox.answer", input),
  );
  assert.equal(result.status, "answered");
  await waitForUpdate(updatesBeforeAnswer);
  const second = answerResultSchema.parse(
    await client.invokePluginRpc("conductor", "inbox.answer", input),
  );
  assert.equal(second.status, "answered");
  await worker.refresh();
  assert.equal(worker.pendingPermissions?.length, 0);
  // Lifecycle hooks run on the daemon even without an open Conductor surface.
  const outcomeDeadline = Date.now() + 8000;
  let completedKey: string | undefined;
  while (!completedKey && Date.now() < outcomeDeadline) {
    const latest = snapshotSchema.parse(
      await client.invokePluginRpc("conductor", "inbox.get", {
        knownAgentIds: [worker.id],
      }),
    );
    const turn = latest.items.find(
      (entry) => entry.agentId === worker.id,
    )?.lastTurn;
    if (turn?.outcome === "completed") {
      completedKey = turn.key;
    }
    if (!completedKey) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  assert.ok(
    completedKey,
    "Daemon lifecycle hook must persist the completed response",
  );
  await client.clearAgentAttention(worker.id);
  await client.reloadPlugin("conductor");
  const final = snapshotSchema.parse(
    await client.invokePluginRpc("conductor", "inbox.get", {
      knownAgentIds: [worker.id],
    }),
  );
  assert.ok(
    final.receipts.some(
      (receipt) => receipt.key === item.key && receipt.status === "answered",
    ),
  );
  const recorded = final.items.find((entry) => entry.agentId === worker.id);
  assert.equal(recorded?.bucket, "idle");
  assert.equal(
    recorded?.lastTurn?.key,
    completedKey,
    "Reading a result and reloading must preserve its outcome",
  );
  const child = await workspace.agents.create({
    config: { provider: "conductor-test/fixture" },
    parent: worker,
    title: "Synthetic child B",
    prompt: "Produce a child question",
  });
  childAgentId = child.id;
  assert.equal((await child.waitForFinish(15000)).status, "permission");
  const family = snapshotSchema.parse(
    await client.invokePluginRpc("conductor", "inbox.get", {
      knownAgentIds: [worker.id, child.id],
    }),
  );
  const parentRow = family.items.find((entry) => entry.agentId === worker.id);
  const childRow = family.items.find((entry) => entry.agentId === child.id);
  assert.ok(parentRow?.archiveKey);
  assert.ok(childRow?.requestId);
  assert.equal(childRow.parentAgentId, worker.id);
  assert.equal(childRow.parentAgentTitle, "Conductor synthetic test");
  assert.equal(parentRow.childAgentCount, 1);
  assert.deepEqual(
    await client.invokePluginRpc("conductor", "inbox.archive", {
      agentId: worker.id,
      key: parentRow.archiveKey,
    }),
    { status: "has_children" },
  );
  await client.invokePluginRpc("conductor", "inbox.answer", {
    agentId: child.id,
    requestId: childRow.requestId,
    key: childRow.key,
    decision: { kind: "answers", answers: [{ selected: [0], text: "" }] },
  });
  await child.waitForFinish(15000);
  const inactiveFamily = snapshotSchema.parse(
    await client.invokePluginRpc("conductor", "inbox.get", {
      knownAgentIds: [worker.id, child.id],
    }),
  );
  const inactiveChild = inactiveFamily.items.find(
    (entry) => entry.agentId === child.id,
  );
  assert.ok(inactiveChild?.archiveKey);
  assert.deepEqual(
    await client.invokePluginRpc("conductor", "inbox.archive", {
      agentId: child.id,
      key: inactiveChild.archiveKey,
    }),
    { status: "archived" },
  );
  const archivedFamily = snapshotSchema.parse(
    await client.invokePluginRpc("conductor", "inbox.get", {
      knownAgentIds: [worker.id, child.id],
    }),
  );
  assert.equal(
    archivedFamily.items.some((entry) => entry.agentId === child.id),
    false,
  );
  assert.equal(
    archivedFamily.items.find((entry) => entry.agentId === worker.id)
      ?.childAgentCount,
    0,
  );
  await worker.send("Start a new fixture turn");
  assert.equal((await worker.waitForFinish(15000)).status, "permission");
  const nextTurn = snapshotSchema.parse(
    await client.invokePluginRpc("conductor", "inbox.get", {
      knownAgentIds: [worker.id],
    }),
  );
  assert.equal(
    nextTurn.items.find((entry) => entry.agentId === worker.id)?.lastTurn,
    null,
    "New turns must not inherit completion",
  );
  console.log(
    "Host smoke passed: parent/child discovery, guarded inactive archive, existing-agent updates, response deduplication, durable outcomes, reload, and new-turn invalidation.",
  );
} finally {
  stopObservation?.();
  const paseo = createPaseoApi(client);
  if (childAgentId) {
    await paseo.agents
      .ref(childAgentId)
      .archive()
      .catch(() => undefined);
  }
  if (agentId) {
    await paseo.agents
      .ref(agentId)
      .archive()
      .catch(() => undefined);
  }
  if (workspaceId) {
    await paseo.workspaces
      .ref(workspaceId)
      .archive()
      .catch(() => undefined);
  }
  await client.removePlugin("conductor-fixture").catch(() => undefined);
  await client.close();
  await rm(directory, { recursive: true, force: true });
}
