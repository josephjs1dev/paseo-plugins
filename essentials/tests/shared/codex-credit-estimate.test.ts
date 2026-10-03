import assert from "node:assert/strict";
import { test } from "node:test";
import {
  estimateCodexCredits,
  withCodexCreditEstimate,
} from "../../shared/codex-credit-estimate";
import {
  addTotals,
  emptyTotals,
  totalsSchema,
  type HistoryRow,
} from "../../shared/history";
import {
  formatCredits,
  formatCreditEstimate,
} from "../../shared/history-display";

test("credit estimates separate cached input and count reasoning inside output once", () => {
  const totals = {
    input: 1_000_000,
    cached: 500_000,
    output: 100_000,
    reasoning: 50_000,
    cost: null,
  };
  assert.deepEqual(estimateCodexCredits("gpt-6.1-sol", totals), {
    amount: 51.25,
    pricedTokens: 1_100_000,
    unpricedTokens: 0,
  });
  assert.equal(
    estimateCodexCredits("gpt-6-astra", { ...totals, cached: 1_000_000 })
      .amount,
    150,
  );
  assert.equal(estimateCodexCredits("gpt-6-luna", emptyTotals()).amount, 0);
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
    assert.deepEqual(estimateCodexCredits(model, totals), {
      amount: null,
      pricedTokens: 0,
      unpricedTokens: 120,
    });
  }

  assert.equal(
    estimateCodexCredits("gpt-6.1-sol", { ...totals, cached: 101 }).amount,
    null,
  );
});

test("partial credit totals retain known estimates and explicit unpriced coverage", () => {
  const tokens = { ...emptyTotals(), input: 1_000_000, cost: null };
  const priced = {
    ...tokens,
    creditEstimate: estimateCodexCredits("gpt-6.1-sol", tokens),
  };
  const unpriced = {
    ...tokens,
    creditEstimate: estimateCodexCredits("codex-auto-review", tokens),
  };
  const combined = addTotals(priced, unpriced);
  assert.deepEqual(combined.creditEstimate, {
    amount: 50,
    pricedTokens: 1_000_000,
    unpricedTokens: 1_000_000,
  });
  assert.equal(combined.cost, null);
  assert.equal(formatCreditEstimate(combined.creditEstimate), "50 (partial)");
  assert.equal(addTotals(emptyTotals(), unpriced).creditEstimate?.amount, null);
  assert.equal(addTotals(unpriced, emptyTotals()).creditEstimate?.amount, null);
  assert.deepEqual(
    addTotals(tokens, priced).creditEstimate,
    combined.creditEstimate,
  );
  assert.equal(totalsSchema.safeParse(combined).success, true);
});

test("recorded USD costs remain intact and other providers keep their own history", () => {
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
  const estimated = withCodexCreditEstimate(row);
  assert.equal(estimated.totals.creditEstimate?.amount, 50);
  assert.equal(estimated.totals.cost, 0.25);
  assert.equal(row.totals.creditEstimate, undefined);
  const go: HistoryRow = { ...row, provider: "opencode-go" };
  assert.equal(withCodexCreditEstimate(go), go);
});

test("credit labels distinguish zero, tiny estimates, and unavailable prices", () => {
  assert.equal(formatCredits(undefined), "Unavailable");
  assert.equal(formatCredits(null), "Unavailable");
  assert.equal(formatCredits(0), "0");
  assert.equal(formatCredits(0.000001), "< 0.0001");
  assert.equal(
    formatCreditEstimate({
      amount: null,
      pricedTokens: 0,
      unpricedTokens: 100,
    }),
    "Unavailable",
  );
});
