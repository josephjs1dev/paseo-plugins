import type { CreditEstimate, HistoryRow, Totals } from "./history";

export const CODEX_CREDIT_RATE_DATE = "2026-10-03";
// Published Standard credits per million tokens, checked on the date above.
// Source: https://learn.chatgpt.com/docs/pricing#token-rates
// These are model-usage estimates, independent of included limits or invoicing.
const rates: Record<
  string,
  readonly [input: number, cached: number, output: number]
> = {
  "gpt-6-astra": [250, 25, 1250],
  "gpt-6.1-sol": [50, 2.5, 250],
  "gpt-6-sol": [50, 5, 250],
  "gpt-6-luna": [2.5, 0.25, 12.5],
  "gpt-5.6-sol": [100, 10, 500],
  "gpt-5.6-terra": [50, 5, 300],
  "gpt-5.6-luna": [5, 0.5, 30],
  "gpt-5.5": [125, 12.5, 750],
};

export function estimateCodexCredits(
  model: string | null | undefined,
  totals: Totals,
): CreditEstimate {
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
export function withCodexCreditEstimate(row: HistoryRow): HistoryRow {
  return row.provider === "codex"
    ? {
        ...row,
        totals: {
          ...row.totals,
          creditEstimate: estimateCodexCredits(row.model, row.totals),
        },
      }
    : row;
}
