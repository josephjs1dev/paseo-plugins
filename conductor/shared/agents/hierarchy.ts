import type { AgentItem } from "./models";

interface TreeEntry {
  item: AgentItem;
  depth: number;
}
interface QueueGroup {
  label: string;
  entries: TreeEntry[];
}

/** Keep every matching request once; never hide a child just because its parent is filtered out. */
export function queueGroups(
  items: readonly AgentItem[],
  groupBy: "project" | "concert",
): QueueGroup[] {
  const agents = new Map<string, AgentItem[]>();
  const order = new Map<string, number>();
  for (const item of items) {
    const rows = agents.get(item.agentId) ?? [];
    rows.push(item);
    if (!order.has(item.agentId)) {
      order.set(item.agentId, order.size);
    }
    agents.set(item.agentId, rows);
  }
  const children = new Map<string, string[]>();
  const roots: string[] = [];
  for (const [id, rows] of agents) {
    const parent = rows[0]?.parentAgentId;
    if (!parent || parent === id || !agents.has(parent)) {
      roots.push(id);
      continue;
    }
    const siblings = children.get(parent) ?? [];
    siblings.push(id);
    children.set(parent, siblings);
  }
  const families: (QueueGroup & { priority: number })[] = [];
  const seen = new Set<string>();
  // The second pass also surfaces malformed cycles, instead of dropping or infinitely recursing.
  for (const id of [...roots, ...agents.keys()]) {
    if (seen.has(id)) {
      continue;
    }
    const root = agents.get(id)?.[0];
    if (!root) {
      continue;
    }
    const label =
      groupBy === "project"
        ? root.projectName
        : `${root.projectName} / ${root.concertName}`;
    const group: QueueGroup & { priority: number } = {
      label,
      entries: [],
      priority: Infinity,
    };
    families.push(group);
    const stack = [{ id, depth: 0 }];
    while (stack.length) {
      const node = stack.pop();
      if (!node || seen.has(node.id)) {
        continue;
      }
      seen.add(node.id);
      group.priority = Math.min(group.priority, order.get(node.id) ?? Infinity);
      for (const item of agents.get(node.id) ?? []) {
        group.entries.push({ item, depth: node.depth });
      }
      for (const child of [...(children.get(node.id) ?? [])].reverse()) {
        stack.push({ id: child, depth: node.depth + 1 });
      }
    }
  }
  // A waiting child lifts its whole family ahead of unrelated inactive agents.
  const groups = new Map<string, QueueGroup>();
  for (const family of families.sort((a, b) => a.priority - b.priority)) {
    const group = groups.get(family.label) ?? {
      label: family.label,
      entries: [],
    };
    group.entries.push(...family.entries);
    groups.set(family.label, group);
  }
  return [...groups.values()];
}
