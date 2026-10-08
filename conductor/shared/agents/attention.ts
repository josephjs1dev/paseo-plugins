import type { AgentItem } from "./models";
export type Filter = "attention" | "running" | "inactive" | "all";
export function category(item: AgentItem): Exclude<Filter, "all"> {
  if (
    item.bucket === "failed" ||
    item.marked ||
    (item.bucket !== "closed" &&
      (item.requestId !== null || item.bucket === "waiting"))
  ) {
    return "attention";
  }
  if (item.bucket === "running") {
    return "running";
  }
  return "inactive";
}
export function isSnoozed(item: AgentItem, now: number): boolean {
  return (item.snoozedUntil ?? 0) > now;
}
export function needsAttention(item: AgentItem): boolean {
  return category(item) === "attention";
}
export function visibleItems(
  items: readonly AgentItem[],
  filter: Filter,
  query: string,
  concertId: string | undefined,
  now: number,
  showSnoozed = false,
): AgentItem[] {
  const search = query.trim().toLocaleLowerCase();
  return items
    .filter((item) => {
      if (concertId && item.concertId !== concertId) {
        return false;
      }
      if (filter !== "all" && category(item) !== filter) {
        return false;
      }
      if (!showSnoozed && filter === "attention" && isSnoozed(item, now)) {
        return false;
      }
      return (
        !search ||
        [
          item.agentTitle,
          item.title,
          item.projectName,
          item.concertName,
          item.provider,
          item.parentAgentTitle ?? "",
        ].some((value) => value.toLocaleLowerCase().includes(search))
      );
    })
    .sort((left, right) => {
      const rank = (item: AgentItem) => (needsAttention(item) ? 0 : 1);
      return (
        rank(left) - rank(right) ||
        timestamp(left.since) - timestamp(right.since) ||
        left.key.localeCompare(right.key)
      );
    });
}
export function timestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
export function ageLabel(value: string, now: number): string {
  const time = timestamp(value);
  if (!time) {
    return "Unknown age";
  }
  const minutes = Math.max(0, Math.floor((now - time) / 60_000));
  if (minutes < 1) {
    return "Just now";
  }
  if (minutes < 60) {
    return `${minutes}m`;
  }
  if (minutes < 1440) {
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  }
  return `${Math.floor(minutes / 1440)}d`;
}
