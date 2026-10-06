import assert from "node:assert/strict";
import test from "node:test";

import { estimateClaudeCost } from "../../shared/claude-cost";

const million = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };

test("Claude cost prices input, cache reads, cache writes, and output separately", () => {
  const cost = estimateClaudeCost("claude-sonnet-4-5", {
    input: 1_000_000,
    cacheRead: 1_000_000,
    cacheWrite: 1_000_000,
    output: 1_000_000,
  });

  assert.ok(Math.abs((cost ?? 0) - (3 + 0.3 + 3.75 + 15)) < 1e-9);
});

test("Claude cost ignores date and context suffixes and rejects unknown models", () => {
  const tokens = { ...million, output: 1_000_000 };

  assert.equal(estimateClaudeCost("claude-haiku-4-5-20251001", tokens), 5);
  assert.equal(estimateClaudeCost("claude-opus-5-5[1m]", tokens), 20);
  assert.equal(estimateClaudeCost("claude-unknown", tokens), null);
  assert.equal(estimateClaudeCost("constructor", tokens), null);
});
