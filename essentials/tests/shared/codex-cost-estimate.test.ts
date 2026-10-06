import assert from "node:assert/strict";
import { test } from "node:test";
import {
  estimateCodexCost,
  withCodexCostEstimate,
} from "../../shared/codex-cost-estimate";
import {
  addTotals,
  emptyTotals,
  totalsSchema,
  type HistoryRow,
} from "../../shared/history";
import {
  estimatedCost,
  formatCost,
  formatCostEstimate,
} from "../../shared/history-display";

test("cost estimates separate cached input and count reasoning inside output once", () => {
  const totals = {
    input: 1_000_000,
    cached: 500_000,
    output: 100_000,
    reasoning: 50_000,
    cost: null,
  };
  assert.deepEqual(estimateCodexCost("gpt-6.1-sol", totals), {
    amount: 2.05,
    pricedTokens: 1_100_000,
    unpricedTokens: 0,
  });
  assert.equal(
    estimateCodexCost("gpt-6-astra", { ...totals, cached: 1_000_000 }).amount,
    6,
  );
  assert.equal(estimateCodexCost("gpt-6-luna", emptyTotals()).amount, 0);
});

test("missing model rates, internal aliases, and invalid cache subsets stay unpriced", () => {
  const totals = { ...emptyTotals(), input: 100, output: 20, cost: null };

  for (const model of [
    undefined,
    null,
    "codex-auto-review",
    "gpt-unknown",
    "constructor",
    "__proto__",
  ]) {
    assert.deepEqual(estimateCodexCost(model, totals), {
      amount: null,
      pricedTokens: 0,
      unpricedTokens: 120,
    });
  }

  assert.equal(
    estimateCodexCost("gpt-6.1-sol", { ...totals, cached: 101 }).amount,
    null,
  );
});

test("partial cost totals retain known estimates and explicit unpriced coverage", () => {
  const tokens = { ...emptyTotals(), input: 1_000_000, cost: null };
  const priced = {
    ...tokens,
    costEstimate: estimateCodexCost("gpt-6.1-sol", tokens),
  };
  const unpriced = {
    ...tokens,
    costEstimate: estimateCodexCost("codex-auto-review", tokens),
  };
  const combined = addTotals(priced, unpriced);
  assert.deepEqual(combined.costEstimate, {
    amount: 2,
    pricedTokens: 1_000_000,
    unpricedTokens: 1_000_000,
  });
  assert.equal(combined.cost, null);
  assert.equal(estimatedCost(combined), 2);
  assert.equal(formatCostEstimate(combined), formatCost(2) + " (partial)");
  assert.equal(addTotals(emptyTotals(), unpriced).costEstimate?.amount, null);
  assert.equal(addTotals(unpriced, emptyTotals()).costEstimate?.amount, null);
  assert.deepEqual(
    addTotals(tokens, priced).costEstimate,
    combined.costEstimate,
  );
  assert.equal(totalsSchema.safeParse(combined).success, true);
});

test("rate estimates take precedence over recorded costs only for display", () => {
  const row: HistoryRow = {
    provider: "chatgpt",
    harness: "pi",
    sessionId: "one",
    model: "gpt-6.1-sol",
    cwd: "/workspace",
    day: "2026-10-03",
    lastAt: "2026-10-03T00:00:00Z",
    totals: { ...emptyTotals(), input: 1_000_000, cost: 0.25 },
  };
  const estimated = withCodexCostEstimate(row);
  assert.equal(estimated.totals.costEstimate?.amount, 2);
  assert.equal(estimated.totals.cost, 0.25);
  assert.equal(estimatedCost(estimated.totals), 2);
  assert.equal(row.totals.costEstimate, undefined);
  assert.equal(estimatedCost(row.totals), 0.25);
  const go: HistoryRow = { ...row, provider: "opencode-go" };
  assert.equal(withCodexCostEstimate(go), go);
});

test("cost labels distinguish zero, tiny estimates, and unavailable prices", () => {
  assert.equal(formatCost(null), "Unavailable");
  assert.equal(formatCost(0.000001), "< $0.0001");
  assert.equal(
    formatCostEstimate({
      ...emptyTotals(),
      input: 100,
      cost: null,
      costEstimate: { amount: null, pricedTokens: 0, unpricedTokens: 100 },
    }),
    "Unavailable",
  );
  assert.equal(
    formatCostEstimate({ ...emptyTotals(), cost: null }),
    "Unavailable",
  );
});
