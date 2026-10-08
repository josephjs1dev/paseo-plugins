import { conflictReason } from "./score";
import type { Score } from "./models";

/**
 * Deterministic geometry for the symphony dependency graph. Pure math only: shared
 * modules must not import React Native, so the client renderer consumes these
 * coordinates directly with absolutely positioned views.
 */
export const GRAPH_LINE = 2;
export const GRAPH_ARROW = 7;

export interface GraphPoint {
  readonly x: number;
  readonly y: number;
}

export interface GraphNodeLayout {
  readonly taskId: string;
  readonly layer: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface GraphEdgeLayout {
  readonly from: string;
  readonly to: string;
  /** Dependencies point at the dependent task; conflicts are undirected. */
  readonly kind: "dependency" | "conflict";
  readonly reason: string | null;
  /** Orthogonal polyline; dependency edges end at the arrowhead tip position. */
  readonly points: readonly GraphPoint[];
}

export interface GraphLayout {
  readonly nodes: readonly GraphNodeLayout[];
  readonly edges: readonly GraphEdgeLayout[];
  readonly width: number;
  readonly height: number;
}

export interface GraphGeometry {
  readonly nodeWidth: number;
  readonly nodeHeight: number;
  /** Inner padding of every node frame, shared by the client renderer. */
  readonly nodePadding: number;
  readonly gapX: number;
  readonly gapY: number;
  readonly margin: number;
}

/**
 * Node content budget: 12px ID and status rows (16px line each) around a
 * 14px/20px title of at most two lines, plus two 4px row gaps. The 112px
 * capacity leaves 8px of slack so a 2px focus ring never clips a row.
 * Both widths use the full content budget; compact only narrows nodes.
 */
const NODE_PADDING = 12;
const NODE_HEIGHT = 112;

const WIDE: GraphGeometry = {
  nodeWidth: 240,
  nodeHeight: NODE_HEIGHT,
  nodePadding: NODE_PADDING,
  gapX: 48,
  gapY: 22,
  margin: 12,
};
const COMPACT: GraphGeometry = {
  nodeWidth: 220,
  nodeHeight: NODE_HEIGHT,
  nodePadding: NODE_PADDING,
  gapX: 36,
  gapY: 18,
  margin: 10,
};

export function graphGeometry(compact: boolean): GraphGeometry {
  return compact ? COMPACT : WIDE;
}

/** Longest-path layering; cycle members fall back to layer 0. */
function taskLayers(graph: Score): Map<string, number> {
  const ids = new Set(graph.tasks.map((task) => task.id));
  const byId = new Map(graph.tasks.map((task) => [task.id, task]));
  const layers = new Map<string, number>();
  const resolve = (id: string, active: Set<string>): number => {
    const known = layers.get(id);
    if (known !== undefined) {
      return known;
    }
    if (active.has(id)) {
      return 0;
    }
    active.add(id);
    let layer = 0;
    for (const prerequisite of byId.get(id)?.prerequisites ?? []) {
      if (ids.has(prerequisite)) {
        layer = Math.max(layer, resolve(prerequisite, active) + 1);
      }
    }
    active.delete(id);
    layers.set(id, layer);
    return layer;
  };
  for (const task of graph.tasks) {
    resolve(task.id, new Set());
  }
  return layers;
}

/** Every task reachable through prerequisites, excluding the task itself. */
function taskAncestors(graph: Score): Map<string, Set<string>> {
  const byId = new Map(graph.tasks.map((task) => [task.id, task]));
  const ancestors = new Map<string, Set<string>>();
  const resolve = (id: string, active: Set<string>): Set<string> => {
    const known = ancestors.get(id);
    if (known) {
      return known;
    }
    const found = new Set<string>();
    if (active.has(id)) {
      return found;
    }
    active.add(id);
    for (const prerequisite of byId.get(id)?.prerequisites ?? []) {
      if (!byId.has(prerequisite)) {
        continue;
      }
      found.add(prerequisite);
      for (const ancestor of resolve(prerequisite, active)) {
        found.add(ancestor);
      }
    }
    active.delete(id);
    found.delete(id);
    ancestors.set(id, found);
    return found;
  };
  for (const task of graph.tasks) {
    resolve(task.id, new Set());
  }
  return ancestors;
}

/**
 * Vertical center of an edge endpoint inside the node body.
 */
const spread = (
  center: number,
  height: number,
  index: number,
  count: number,
) =>
  count <= 1
    ? center
    : center - height / 2 + height / 4 + (height / 2 / (count - 1)) * index;

export function layoutGraph(graph: Score, compact = false): GraphLayout {
  const geometry = graphGeometry(compact);
  const layers = taskLayers(graph);
  const columns = new Map<number, string[]>();
  for (const task of graph.tasks) {
    const layer = layers.get(task.id) ?? 0;
    const column = columns.get(layer) ?? [];
    column.push(task.id);
    columns.set(layer, column);
  }
  const layerOf = new Map<string, number>();
  const positionOf = new Map<string, { x: number; y: number }>();
  let maxRows = 1;
  for (const [layer, ids] of [...columns].sort((a, b) => a[0] - b[0])) {
    maxRows = Math.max(maxRows, ids.length);
    ids.forEach((id, row) => {
      layerOf.set(id, layer);
      positionOf.set(id, {
        x: geometry.margin + layer * (geometry.nodeWidth + geometry.gapX),
        y: geometry.margin + row * (geometry.nodeHeight + geometry.gapY),
      });
    });
  }
  const nodes: GraphNodeLayout[] = graph.tasks.map((task) => {
    const position = positionOf.get(task.id) ?? {
      x: geometry.margin,
      y: geometry.margin,
    };
    return {
      taskId: task.id,
      layer: layerOf.get(task.id) ?? 0,
      x: position.x,
      y: position.y,
      width: geometry.nodeWidth,
      height: geometry.nodeHeight,
    };
  });
  const nodeOf = new Map(nodes.map((node) => [node.taskId, node]));
  const ancestors = taskAncestors(graph);
  const ordered = (a: string, b: string) =>
    Boolean(ancestors.get(a)?.has(b) || ancestors.get(b)?.has(a));

  // Dependencies: prerequisite right edge → dependent left edge, with an
  // elbow so multiple edges into one task stay readable. Only the transitive
  // reduction is drawn: a prerequisite already reached through another
  // prerequisite adds no ordering, so its direct arrow is omitted.
  const dependencyEdges = graph.tasks.flatMap((task) => {
    const direct = task.prerequisites.filter(
      (id, index, all) => all.indexOf(id) === index,
    );
    return direct
      .filter(
        (prerequisite) =>
          !direct.some(
            (other) =>
              other !== prerequisite && ancestors.get(other)?.has(prerequisite),
          ),
      )
      .map((prerequisite) => ({ from: prerequisite, to: task.id }));
  });
  const outgoing = new Map<string, number>();
  const incoming = new Map<string, number>();
  for (const edge of dependencyEdges) {
    outgoing.set(edge.from, (outgoing.get(edge.from) ?? 0) + 1);
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
  }
  const outgoingSeen = new Map<string, number>();
  const incomingSeen = new Map<string, number>();
  const edges: GraphEdgeLayout[] = dependencyEdges.map(({ from, to }) => {
    const source = nodeOf.get(from);
    const target = nodeOf.get(to);
    if (!source || !target) {
      return { from, to, kind: "dependency", reason: null, points: [] };
    }
    const fromIndex = outgoingSeen.get(from) ?? 0;
    outgoingSeen.set(from, fromIndex + 1);
    const toIndex = incomingSeen.get(to) ?? 0;
    incomingSeen.set(to, toIndex + 1);
    const startY = spread(
      source.y + source.height / 2,
      source.height,
      fromIndex,
      outgoing.get(from) ?? 1,
    );
    const endY = spread(
      target.y + target.height / 2,
      target.height,
      toIndex,
      incoming.get(to) ?? 1,
    );
    const startX = source.x + source.width;
    const endX = target.x - GRAPH_ARROW;
    const midX = (startX + endX) / 2;
    const points =
      Math.abs(endY - startY) < 1
        ? [
            { x: startX, y: startY },
            { x: endX, y: startY },
          ]
        : [
            { x: startX, y: startY },
            { x: midX, y: startY },
            { x: midX, y: endY },
            { x: endX, y: endY },
          ];
    return { from, to, kind: "dependency", reason: null, points };
  });

  // Resource conflicts: dashed, routed below their row when both tasks share
  // a layer, otherwise as a dashed elbow between the layers. Pairs already
  // ordered by prerequisites never run together, so they are not drawn.
  const conflictRows = new Map<number, number>();
  for (let i = 0; i < graph.tasks.length; i++) {
    for (let j = i + 1; j < graph.tasks.length; j++) {
      const a = graph.tasks[i];
      const b = graph.tasks[j];
      if (!a || !b) {
        continue;
      }
      const reason = ordered(a.id, b.id) ? null : conflictReason(a, b);
      if (!reason) {
        continue;
      }
      const source = nodeOf.get(a.id);
      const target = nodeOf.get(b.id);
      if (!source || !target) {
        continue;
      }
      const leftFirst =
        source.layer < target.layer ||
        (source.layer === target.layer && source.x <= target.x);
      const from = leftFirst ? source : target;
      const to = leftFirst ? target : source;
      if (from.layer === to.layer) {
        const depth = conflictRows.get(from.layer) ?? 0;
        conflictRows.set(from.layer, depth + 1);
        const lane = from.y + from.height + 10 + depth * 10;
        edges.push({
          from: from.taskId,
          to: to.taskId,
          kind: "conflict",
          reason,
          points: [
            { x: from.x + from.width / 2, y: from.y + from.height },
            { x: from.x + from.width / 2, y: lane },
            { x: to.x + to.width / 2, y: lane },
            { x: to.x + to.width / 2, y: to.y + to.height },
          ],
        });
      } else {
        const startX = from.x + from.width;
        const endX = to.x;
        const midX = (startX + endX) / 2;
        const startY = from.y + from.height / 2;
        const endY = to.y + to.height / 2;
        edges.push({
          from: from.taskId,
          to: to.taskId,
          kind: "conflict",
          reason,
          points:
            Math.abs(endY - startY) < 1
              ? [
                  { x: startX, y: startY },
                  { x: endX, y: startY },
                ]
              : [
                  { x: startX, y: startY },
                  { x: midX, y: startY },
                  { x: midX, y: endY },
                  { x: endX, y: endY },
                ],
        });
      }
    }
  }

  const width =
    geometry.margin * 2 +
    Math.max(1, columns.size) * geometry.nodeWidth +
    Math.max(0, columns.size - 1) * geometry.gapX +
    GRAPH_ARROW;
  const conflictDrop = Math.max(0, ...conflictRows.values()) * 10;
  const height =
    geometry.margin * 2 +
    maxRows * geometry.nodeHeight +
    Math.max(0, maxRows - 1) * geometry.gapY +
    (conflictRows.size ? conflictDrop + 12 : 0);
  return { nodes, edges, width, height };
}
