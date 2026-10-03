import assert from "node:assert/strict";
import { test } from "node:test";
import {
  historyQueryOptions,
  validSessionOffset,
} from "../../client/history-query-options";
import { readHistory } from "../../shared/history";

test("request scopes match cache keys and omitted scope stays workspace-only", () => {
  const workspace = historyQueryOptions("host-a", "workspace-a", "codex", 7);
  const explicit = historyQueryOptions(
    "host-a",
    "workspace-a",
    "codex",
    7,
    0,
    "workspace",
  );
  const host = historyQueryOptions(
    "host-a",
    "workspace-a",
    "codex",
    7,
    0,
    "host",
  );
  assert.deepEqual(workspace, explicit);
  assert.notDeepEqual(host.queryKey, workspace.queryKey);
  assert.deepEqual(host.input, {
    provider: "codex",
    workspaceId: "workspace-a",
    days: 7,
    sessionOffset: 0,
    scope: "host",
  });
  assert.deepEqual(workspace.input, { ...host.input, scope: "workspace" });
  assert.deepEqual(readHistory.input.parse(host.input), host.input);
});

test("filter identity resets results for every filter but keeps pagination inside the same results", () => {
  const first = historyQueryOptions(
    "host-a",
    "workspace-a",
    "codex",
    7,
    0,
    "host",
  );
  const page = historyQueryOptions(
    "host-a",
    "workspace-a",
    "codex",
    7,
    20,
    "host",
  );
  assert.deepEqual(first.filterKey, page.filterKey);
  assert.notDeepEqual(first.queryKey, page.queryKey);
  assert.equal(page.input.sessionOffset, 20);

  for (const changed of [
    historyQueryOptions("host-b", "workspace-a", "codex", 7, 0, "host"),
    historyQueryOptions("host-a", "workspace-b", "codex", 7, 0, "host"),
    historyQueryOptions("host-a", "workspace-a", "opencode-go", 7, 0, "host"),
    historyQueryOptions("host-a", "workspace-a", "codex", 30, 0, "host"),
    historyQueryOptions("host-a", "workspace-a", "codex", 7, 0, "workspace"),
  ]) {
    assert.notDeepEqual(first.filterKey, changed.filterKey);
    assert.notDeepEqual(first.queryKey, changed.queryKey);
  }
});

test("shrinking counts clamp to the last valid page, including empty results", () => {
  assert.equal(validSessionOffset(40, 41), 40);
  assert.equal(validSessionOffset(40, 40), 20);
  assert.equal(validSessionOffset(40, 21), 20);
  assert.equal(validSessionOffset(40, 20), 0);
  assert.equal(validSessionOffset(40, 0), 0);
  assert.equal(validSessionOffset(20, 100), 20);
  assert.equal(validSessionOffset(0, 100), 0);
});
