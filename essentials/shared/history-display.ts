import {
  addTotals,
  emptyTotals,
  type CreditEstimate,
  type Totals,
} from "./history";

export function formatCredits(amount: number | null | undefined): string {
  if (amount == null) {
    return "Unavailable";
  }

  if (amount > 0 && amount < 0.0001) {
    return "< 0.0001";
  }

  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 }).format(
    amount,
  );
}

export function formatCreditEstimate(
  estimate: CreditEstimate | undefined,
): string {
  const amount = formatCredits(estimate?.amount);

  return estimate?.amount != null && estimate.unpricedTokens > 0
    ? amount + " (partial)"
    : amount;
}

export const totalTokens = (totals: Totals) => totals.input + totals.output;
export const exactTokens = (value: number) => value.toLocaleString();
export const compactTokens = (value: number) =>
  new Intl.NumberFormat(undefined, {
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(value);

export function historyBuckets(
  daily: readonly { day: string; totals: Totals }[],
  days: 7 | 30,
  periodEnd: string,
) {
  const end = Date.parse(`${periodEnd}T00:00:00Z`);
  const start = end - (days - 1) * 86_400_000;
  const buckets: {
    startDay: string;
    endDay: string;
    totals: Totals;
    hasUsage: boolean;
  }[] = [];

  for (let time = start; time <= end; time += 86_400_000) {
    const day = new Date(time).toISOString().slice(0, 10);
    const rows = daily.filter((row) => row.day === day);
    buckets.push({
      startDay: day,
      endDay: day,
      totals: rows.reduce(
        (total, row) => addTotals(total, row.totals),
        emptyTotals(),
      ),
      hasUsage: rows.length > 0,
    });
  }

  return buckets;
}

export function bucketLabel(startDay: string, endDay: string): string {
  const format = (day: string) =>
    new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });

  return startDay === endDay
    ? format(startDay)
    : `${format(startDay)} – ${format(endDay)}`;
}

export function formatCost(value: number | null): string {
  if (value === null) {
    return "Unavailable";
  }

  if (value > 0 && value < 0.0001) {
    return "< $0.0001";
  }

  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: value < 1 ? 4 : 2,
  }).format(value);
}
