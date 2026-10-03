import assert from "node:assert/strict";
import { test } from "node:test";

import { providerIds } from "../../shared/providers";
import { readUsage } from "../../shared/usage";
import { createUsageReader } from "../../server/usage";

test("provider RPC validation rejects unknown providers before dispatch", () => {
  assert.equal(
    readUsage.input.safeParse({ provider: "unknown-provider" }).success,
    false,
  );

  for (const provider of providerIds) {
    assert.equal(readUsage.input.safeParse({ provider }).success, true);
  }
});

test("registered providers use separate caches and sanitize collector quota errors", async () => {
  const calls: string[] = [];
  const reader = createUsageReader(async (provider) => {
    calls.push(provider);
    throw new Error("private-credential");
  });

  try {
    for (const provider of providerIds) {
      const first = await reader.read(provider);
      const cached = await reader.read(provider);

      assert.equal(first.provider, provider);
      assert.equal(first.status, "unavailable");
      assert.equal(first.message.includes("private-credential"), false);
      assert.deepEqual(cached, first);
    }

    assert.deepEqual(calls, providerIds);
  } finally {
    reader.close();
  }
});
