import type { CostEstimate, HistoryRow, Totals } from "./history";

export const CODEX_RATE_DATE = "2026-10-06";
// Published Standard API USD per million tokens, checked on the date above.
// Source: https://developers.openai.com/api/docs/pricing
// These are API-equivalent estimates, independent of included limits or invoicing.
const rates: Record<
  string,
  readonly [input: number, cached: number, output: number]
> = {
  "gpt-6-astra": [10, 1, 50],
  "gpt-6.1-sol": [2, 0.1, 10],
  "gpt-6-sol": [2, 0.2, 10],
  "gpt-6-luna": [0.1, 0.01, 0.5],
  "gpt-5.6-sol": [4, 0.4, 20],
  "gpt-5.6-terra": [2, 0.2, 12],
  "gpt-5.6-luna": [0.2, 0.02, 1.2],
  "gpt-5.5": [5, 0.5, 30],
};

export function estimateCodexCost(
  model: string | null | undefined,
  totals: Totals,
): CostEstimate {
  const tokens = totals.input + totals.output;
  const rate = model && Object.hasOwn(rates, model) ? rates[model] : undefined;

  if (!rate || totals.cached > totals.input) {
    return { amount: null, pricedTokens: 0, unpricedTokens: tokens };
  }

  const amount =
    ((totals.input - totals.cached) * rate[0] +
      totals.cached * rate[1] +
      totals.output * rate[2]) /
    1_000_000;

  return { amount, pricedTokens: tokens, unpricedTokens: 0 };
}

/** Derive estimates on read, including older caches with recorded model names. */
export function withCodexCostEstimate(row: HistoryRow): HistoryRow {
  return row.provider === "chatgpt"
    ? {
        ...row,
        totals: {
          ...row.totals,
          costEstimate: estimateCodexCost(row.model, row.totals),
        },
      }
    : row;
}
