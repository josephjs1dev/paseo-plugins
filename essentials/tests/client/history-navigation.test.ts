import assert from "node:assert/strict";
import { test } from "node:test";
import { createHistoryNavigation } from "../../client/history-navigation";

test("opening history targets the correct workspace and preserves other tab filters", () => {
  const opened: string[] = [];
  const navigation = createHistoryNavigation((id) => opened.push(id));
  const initial = navigation.getSnapshot("workspace-a");
  assert.equal(navigation.getSnapshot("workspace-a"), initial);
  navigation.open("workspace-a", "opencode-go", 30, "host");
  const first = navigation.getSnapshot("workspace-a");
  navigation.open("workspace-b", "codex", 7);
  assert.deepEqual(opened, ["workspace-a", "workspace-b"]);
  assert.equal(navigation.getSnapshot("workspace-a"), first);
  assert.deepEqual(first, { provider: "opencode-go", days: 30, scope: "host" });
  assert.deepEqual(navigation.getSnapshot("workspace-b"), {
    provider: "codex",
    days: 7,
    scope: "workspace",
  });
  navigation.select("workspace-b", {
    provider: "codex",
    days: 7,
    scope: "host",
  });
  assert.equal(navigation.getSnapshot("workspace-a"), first);
  navigation.forget("workspace-a");
  assert.equal(navigation.getSnapshot("workspace-a"), initial);
  assert.equal(navigation.getSnapshot("workspace-b").scope, "host");
});

test("popup navigation replaces scope in the owning tab and keeps other hosts isolated", () => {
  const firstHost = createHistoryNavigation(() => {});
  const secondHost = createHistoryNavigation(() => {});
  secondHost.open("workspace-a", "opencode-go", 30, "host");
  const otherHostSelection = secondHost.getSnapshot("workspace-a");
  firstHost.open("workspace-a", "codex", 7, "host");
  assert.equal(firstHost.getSnapshot("workspace-a").scope, "host");
  firstHost.open("workspace-a", "opencode-go", 30, "workspace");
  assert.deepEqual(firstHost.getSnapshot("workspace-a"), {
    provider: "opencode-go",
    days: 30,
    scope: "workspace",
  });
  assert.equal(secondHost.getSnapshot("workspace-a"), otherHostSelection);
});
