export const CLAUDE_RATE_DATE = "2026-09-25";
// Published API USD per million tokens: [input, cache read, output].
// Cache writes use the 5-minute rate of 1.25x input. These are API-equivalent
// estimates, independent of subscription limits or invoicing.
const rates: Record<
  string,
  readonly [input: number, cacheRead: number, output: number]
> = {
  "claude-fable-5-1": [10, 0.25, 50],
  "claude-fable-5": [10, 0.25, 50],
  "claude-opus-5-5": [4, 0.2, 20],
  "claude-opus-5": [5, 0.5, 25],
  "claude-opus-4-8": [5, 0.5, 25],
  "claude-opus-4-7": [5, 0.5, 25],
  "claude-opus-4-6": [5, 0.5, 25],
  "claude-opus-4-5": [5, 0.5, 25],
  "claude-opus-4-1": [15, 1.5, 75],
  "claude-opus-4": [15, 1.5, 75],
  "claude-sonnet-5-5": [2, 0.2, 10],
  "claude-sonnet-5": [2, 0.2, 10],
  "claude-sonnet-4-6": [3, 0.3, 15],
  "claude-sonnet-4-5": [3, 0.3, 15],
  "claude-sonnet-4": [3, 0.3, 15],
  "claude-haiku-4-5": [1, 0.1, 5],
};

export interface ClaudeUsageTokens {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

/** Estimated USD cost, or null when the model has no published rate. */
export function estimateClaudeCost(
  model: string,
  tokens: ClaudeUsageTokens,
): number | null {
  const key = model.replace(/\[.*\]$/, "").replace(/-\d{8}$/, "");
  const rate = Object.hasOwn(rates, key) ? rates[key] : undefined;

  if (!rate) {
    return null;
  }

  return (
    (tokens.input * rate[0] +
      tokens.cacheRead * rate[1] +
      tokens.cacheWrite * rate[0] * 1.25 +
      tokens.output * rate[2]) /
    1_000_000
  );
}
