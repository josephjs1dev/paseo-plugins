/** Window size assumed when a provider reports usage without a window size. */
export const DEFAULT_WINDOW_TOKENS = 1_000_000;

/** Whole percent of the window in use, capped at 100. `max` must be positive. */
export function percentOfWindow(used: number, max: number): number {
  return Math.min(100, Math.floor((used * 100) / max));
}

export function formatTokens(n: number): string {
  if (n > 0 && n % 1_000_000 === 0) {
    return `${n / 1_000_000}M`;
  }

  return `${Math.round(n / 1000)}k`;
}

/** For example `347k / 1M · 34%`. */
export function formatGauge(used: number, max: number): string {
  return `${formatTokens(used)} / ${formatTokens(max)} · ${percentOfWindow(used, max)}%`;
}
