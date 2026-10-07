import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import {
  latestAttempt,
  type StoredRun,
  type TaskDefinition,
} from "../shared/run-models";
import {
  GRAPH_ARROW,
  GRAPH_LINE,
  graphGeometry,
  layoutGraph,
  type GraphEdgeLayout,
  type GraphPoint,
} from "../shared/run-layout";
import { taskState, type TaskStateKey } from "../shared/run-task-state";
import { conflictReason } from "../shared/run-graph";

type StateColor =
  | "foregroundMuted"
  | "accent"
  | "statusWarning"
  | "statusSuccess"
  | "statusDanger";

/**
 * Status colors deliberately differ from bare text readability: running is the
 * accent, attention and failures use the semantic status colors, and
 * waiting/ready share the muted neutral. Finishing keeps the warning hue so it
 * stays distinct from Completed, and every status is also written in text.
 */
const STATE_COLOR: Record<TaskStateKey, StateColor> = {
  ready: "foregroundMuted",
  waiting: "foregroundMuted",
  running: "accent",
  blocked: "statusWarning",
  finishing: "statusWarning",
  failed: "statusDanger",
  completed: "statusSuccess",
};

function Segment({
  p1,
  p2,
  color,
  dashed,
  testID,
}: {
  p1: GraphPoint;
  p2: GraphPoint;
  color: string;
  dashed: boolean;
  testID: string;
}) {
  if (Math.abs(p2.y - p1.y) < 1) {
    const shared = {
      position: "absolute" as const,
      left: Math.min(p1.x, p2.x),
      top: p1.y - GRAPH_LINE / 2,
      width: Math.max(GRAPH_LINE, Math.abs(p2.x - p1.x)),
      height: 0,
    };
    return dashed ? (
      <View
        testID={testID}
        style={{
          ...shared,
          borderTopWidth: GRAPH_LINE,
          borderTopColor: color,
          borderStyle: "dashed",
        }}
      />
    ) : (
      <View
        testID={testID}
        style={{ ...shared, height: GRAPH_LINE, backgroundColor: color }}
      />
    );
  }
  const shared = {
    position: "absolute" as const,
    left: p1.x - GRAPH_LINE / 2,
    top: Math.min(p1.y, p2.y),
    width: 0,
    height: Math.max(GRAPH_LINE, Math.abs(p2.y - p1.y)),
  };
  return dashed ? (
    <View
      testID={testID}
      style={{
        ...shared,
        borderLeftWidth: GRAPH_LINE,
        borderLeftColor: color,
        borderStyle: "dashed",
      }}
    />
  ) : (
    <View
      testID={testID}
      style={{ ...shared, width: GRAPH_LINE, backgroundColor: color }}
    />
  );
}

function Edge({ edge, theme }: { edge: GraphEdgeLayout; theme: PluginTheme }) {
  const color =
    edge.kind === "conflict"
      ? theme.colors.statusWarning
      : theme.colors.foregroundMuted;
  const dashed = edge.kind === "conflict";
  const points = edge.points;
  const tip = points.at(-1);
  return (
    <>
      {points.slice(0, -1).map((point, index) => {
        const next = points[index + 1];
        return next ? (
          <Segment
            key={index}
            testID={`run-edge-${edge.from}-${edge.to}-${edge.kind}-${index}`}
            p1={point}
            p2={next}
            color={color}
            dashed={dashed}
          />
        ) : null;
      })}
      {edge.kind === "dependency" && tip && (
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            left: tip.x - GRAPH_ARROW,
            top: tip.y - 5,
            width: 0,
            height: 0,
            borderTopWidth: 5,
            borderBottomWidth: 5,
            borderLeftWidth: GRAPH_ARROW,
            borderTopColor: "transparent",
            borderBottomColor: "transparent",
            borderLeftColor: color,
          }}
        />
      )}
    </>
  );
}

/**
 * One task node: ID row and textual status at 12px, a 14px two-line title in
 * between. The status line also carries a small state dot whose color alone
 * never carries meaning. Failed-launch attempts are reported like any other
 * state; they never claim an available worker.
 */
function GraphNode({
  theme,
  task,
  run,
  node,
  padding,
  selected,
  onPick,
}: {
  theme: PluginTheme;
  task: TaskDefinition;
  run: StoredRun;
  node: { x: number; y: number; width: number; height: number };
  padding: number;
  selected: boolean;
  onPick(this: void): void;
}) {
  const [focused, setFocused] = useState(false);
  const state = taskState(run, task);
  const color = theme.colors[STATE_COLOR[state.key]];
  const attempt = latestAttempt(run, task.id);
  const waitsFor = task.prerequisites.length
    ? ` Waits for ${task.prerequisites.join(", ")}.`
    : "";
  const label = attempt
    ? `Open ${task.id} agent — ${task.title}. ${state.label}.${waitsFor}`
    : `Select task ${task.id} — ${task.title}. ${state.label}.${waitsFor}`;
  const frame = {
    position: "absolute" as const,
    left: node.x,
    top: node.y,
    width: node.width,
    height: node.height,
    padding,
    borderRadius: 8,
    borderWidth: selected || focused ? 2 : 1,
    borderColor:
      selected || focused ? theme.colors.accent : theme.colors.border,
    backgroundColor:
      selected || focused ? theme.colors.surface2 : theme.colors.surface1,
  };
  return (
    <Pressable
      testID={`run-node-${task.id}`}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected }}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onPress={onPick}
      style={({ pressed }) => ({
        ...frame,
        overflow: "hidden",
        ...(pressed ? { opacity: 0.85 } : {}),
      })}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <View
          style={{
            width: 8,
            height: 8,
            borderRadius: 4,
            backgroundColor: color,
          }}
        />
        <Text
          numberOfLines={1}
          style={{
            color: theme.colors.foregroundMuted,
            fontSize: 12,
            lineHeight: 16,
            fontVariant: ["tabular-nums"],
            flexShrink: 1,
          }}
        >
          {task.id}
        </Text>
      </View>
      <Text
        numberOfLines={2}
        style={{
          color: theme.colors.foreground,
          fontSize: 14,
          lineHeight: 20,
          fontWeight: "500",
        }}
      >
        {task.title}
      </Text>
      <Text
        numberOfLines={1}
        style={{
          color: theme.colors[STATE_COLOR[state.key]],
          fontSize: 12,
          lineHeight: 16,
          fontWeight: "600",
        }}
      >
        {state.label}
        {state.waitingFor.length ? ` · ${state.waitingFor.join(", ")}` : ""}
      </Text>
    </Pressable>
  );
}

/**
 * Static legend chips shared by the graph status strip. Written labels keep
 * states scannable without relying on color alone.
 */
function Legend({ theme }: { theme: PluginTheme }) {
  const dotStyle = (state: TaskStateKey) => ({
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: theme.colors[STATE_COLOR[state]],
  });
  const caption = {
    color: theme.colors.foregroundMuted,
    fontSize: 12,
    lineHeight: 16,
  };
  const line = (color: string, dashed: boolean) => ({
    width: 18,
    height: 0,
    borderTopWidth: GRAPH_LINE,
    borderTopColor: color,
    ...(dashed ? { borderStyle: "dashed" as const } : {}),
  });
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>
      {(
        [
          ["Ready", "ready"],
          ["Waiting", "waiting"],
          ["Running", "running"],
          ["Blocked", "blocked"],
          ["Finishing", "finishing"],
          ["Completed", "completed"],
          ["Failed", "failed"],
        ] as const
      ).map(([label, state]) => (
        <View
          key={state}
          style={{ flexDirection: "row", alignItems: "center", gap: 5 }}
        >
          <View style={dotStyle(state)} />
          <Text style={{ ...caption, color: theme.colors.foreground }}>
            {label}
          </Text>
        </View>
      ))}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
        <View style={line(theme.colors.foregroundMuted, false)} />
        <Text style={caption}>prerequisite</Text>
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
        <View style={line(theme.colors.statusWarning, true)} />
        <Text style={caption}>shared resource</Text>
      </View>
    </View>
  );
}

export function RunGraphView({
  theme,
  run,
  graph,
  openAgent,
  compact = false,
}: {
  theme: PluginTheme;
  run: StoredRun;
  graph: { tasks: TaskDefinition[] };
  openAgent?: (id: string) => void;
  compact?: boolean;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const layout = useMemo(() => layoutGraph(graph, compact), [graph, compact]);
  const geometry = graphGeometry(compact);
  const tasks = new Map(graph.tasks.map((task) => [task.id, task]));
  if (!graph.tasks.length) {
    return (
      <Text style={{ color: theme.colors.foregroundMuted, lineHeight: 21 }}>
        No tasks were recorded for this performance yet.
      </Text>
    );
  }
  const selectedTask = selected ? tasks.get(selected) : undefined;
  const selectedConflicts = selectedTask
    ? graph.tasks
        .filter((other) => other.id !== selectedTask.id)
        .flatMap((other) => {
          const reason = conflictReason(selectedTask, other);
          return reason ? [{ other, reason }] : [];
        })
    : [];
  return (
    <View style={{ gap: 10 }} testID="run-graph">
      <ScrollView
        horizontal
        contentContainerStyle={{ padding: 2 }}
        style={{
          borderWidth: 1,
          borderColor: theme.colors.border,
          borderRadius: 8,
          backgroundColor: theme.colors.surface1,
        }}
      >
        <View style={{ width: layout.width, height: layout.height }}>
          {layout.edges.map((edge, index) => (
            <Edge
              key={`${edge.from}->${edge.to}:${index}`}
              edge={edge}
              theme={theme}
            />
          ))}
          {layout.nodes.map((node) => {
            const task = tasks.get(node.taskId);
            if (!task) {
              return null;
            }
            return (
              <GraphNode
                key={node.taskId}
                theme={theme}
                task={task}
                run={run}
                node={node}
                padding={geometry.nodePadding}
                selected={selected === task.id}
                onPick={() => {
                  setSelected(task.id);
                  const attempt = latestAttempt(run, task.id);
                  const agent = attempt?.agentId;
                  if (agent && attempt?.launch?.state !== "failed") {
                    openAgent?.(agent);
                  }
                }}
              />
            );
          })}
        </View>
      </ScrollView>
      <Legend theme={theme} />
      {selectedTask && (
        <Text
          testID="run-graph-selection"
          selectable
          style={{
            color: theme.colors.foregroundMuted,
            fontSize: 12,
            lineHeight: 18,
          }}
        >
          Selected {selectedTask.id}: {selectedTask.title} ·{" "}
          {taskState(run, selectedTask).label}
          {selectedTask.prerequisites.length
            ? ` · waits for ${selectedTask.prerequisites.join(", ")}`
            : " · No dependencies"}
          {selectedConflicts.map((conflict) => (
            <Text key={conflict.other.id}>
              {"\n"}
              Conflict with {conflict.other.id}: {conflict.reason} — their runs
              are serialized without adding a prerequisite.
            </Text>
          ))}
        </Text>
      )}
    </View>
  );
}
