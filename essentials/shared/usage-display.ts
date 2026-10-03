import type { Usage } from "./usage";

export function creditBalanceLabel(credits: Usage["credits"]): string {
  if (!credits) {
    return "Unavailable";
  }

  if (credits.unlimited) {
    return "Unlimited";
  }

  if (credits.balance !== null) {
    return new Intl.NumberFormat(undefined, {
      maximumFractionDigits: 6,
    }).format(credits.balance);
  }

  return credits.hasCredits
    ? "Available · balance unavailable"
    : "No credits available";
}

export function remainingPercent(usedPercent: number): number {
  return Math.max(0, Math.min(100, 100 - usedPercent));
}

export function formatResetTime(
  resetsAt: string | null,
  now = Date.now(),
): string {
  if (!resetsAt) {
    return "Reset time unavailable";
  }

  const minutes = Math.ceil((Date.parse(resetsAt) - now) / 60_000);

  if (minutes <= 0) {
    return "Reset due";
  }

  if (minutes >= 1440) {
    return `Resets in ${Math.floor(minutes / 1440)}d ${Math.floor((minutes % 1440) / 60)}h`;
  }

  if (minutes >= 60) {
    return `Resets in ${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  }

  return `Resets in ${minutes}m`;
}
