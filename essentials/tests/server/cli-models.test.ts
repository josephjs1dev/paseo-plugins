import assert from "node:assert/strict";
import { test } from "node:test";
import { refreshModels } from "../../server/cli-models";

test("Claude model refresh uses provider discovery without executing a cache command", async () => {
  const calls: string[] = [];
  const host: Parameters<typeof refreshModels>[2] = {
    workspaces: { ref: () => assert.fail("No workspace requested") },
    config: { get: async () => assert.fail("Claude has no CLI cache command") },
    providers: {
      refresh: async (options) => {
        assert.deepEqual(options, { providers: ["claude"] });
        calls.push("refresh");

        return { acknowledged: true, requestId: "test" };
      },
      waitForReady: async (options) => {
        assert.deepEqual(options, { timeoutMs: 60_000 });
        calls.push("ready");

        return {
          requestId: "test",
          generatedAt: new Date().toISOString(),
          entries: [
            {
              provider: "claude",
              status: "ready",
              enabled: true,
              models: [{ provider: "claude", id: "sonnet", label: "Sonnet" }],
            },
          ],
        };
      },
    },
  };
  assert.equal(
    await refreshModels(
      "claude",
      undefined,
      host,
      new AbortController().signal,
    ),
    "Claude Code model picker refreshed: 1 models.",
  );
  assert.deepEqual(calls, ["refresh", "ready"]);
  host.providers.waitForReady = async () => ({
    requestId: "test",
    generatedAt: new Date().toISOString(),
    entries: [],
  });
  await assert.rejects(
    () =>
      refreshModels("claude", undefined, host, new AbortController().signal),
    /Provider discovery failed/,
  );
});
