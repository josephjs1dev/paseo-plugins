import type { AttemptUsage } from "../../../shared/symphonies/models";

interface TokenTotal {
  value: number;
  known: boolean;
}

/** Per-field token totals where a missing source field stays unknown. */
export interface UsageTotals {
  readonly input: TokenTotal;
  readonly cached: TokenTotal;
  readonly output: TokenTotal;
}

export function createUsageTotals(): UsageTotals {
  return {
    input: { value: 0, known: true },
    cached: { value: 0, known: true },
    output: { value: 0, known: true },
  };
}

function add(total: TokenTotal, value: number | undefined): void {
  if (value === undefined) {
    total.known = false;
  } else {
    total.value += value;
  }
}

/** Adds one entry's fields; an absent field makes the attempt total unknown. */
export function addUsage(totals: UsageTotals, usage: AttemptUsage): void {
  add(totals.input, usage.input);
  add(totals.cached, usage.cached);
  add(totals.output, usage.output);
}

/** Returns only fields observed (or derived) for every included entry. */
export function finishUsage(totals: UsageTotals): AttemptUsage {
  return {
    ...(totals.input.known ? { input: totals.input.value } : {}),
    ...(totals.cached.known ? { cached: totals.cached.value } : {}),
    ...(totals.output.known ? { output: totals.output.value } : {}),
  };
}
