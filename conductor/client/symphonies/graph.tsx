import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { Icon } from "@getpaseo/plugin/client/react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import {
  latestAttempt,
  type StoredSymphony,
  type TaskDefinition,
} from "../../shared/symphonies/models";
import {
  GRAPH_ARROW,
  GRAPH_LINE,
  graphGeometry,
  layoutGraph,
  type GraphEdgeLayout,
  type GraphPoint,
  type GraphLayoutSummary,
} from "../../shared/symphonies/layout";
import {
  taskState,
  type TaskStateKey,
} from "../../shared/symphonies/task-state";
import { conflictReason } from "../../shared/symphonies/score";
import type { ConductorProfile } from "../../shared/symphonies/profiles";
import type { ProviderCatalog } from "../../shared/symphonies/profiles-rpc";
import { Button } from "../ui/controls";
import {
  StatusMarker,
  statusColor,
  taskStatusPresentation,
} from "../ui/status";
import { HarnessMark } from "../ui/harness-mark";
import {
  identityLabel,
  taskIdentity,
  type WorkerIdentity,
} from "./worker-identity";

/**
 * Unrelated edges fade to this opacity while a node is selected: still
 * visible, so the rest of the score stays readable, but clearly out of the
 * selected relationship.
 */
const EDGE_DIM_OPACITY = 0.3;

/** Legend order follows the shared task-state projection's own set. */
const LEGEND_ORDER: readonly TaskStateKey[] = [
  "ready",
  "waiting",
  "running",
  "blocked",
  "finishing",
  "completed",
  "needs-changes",
  "failed",
];

const LEGEND_LABELS: Record<TaskStateKey, string> = {
  ready: "Ready",
  waiting: "Waiting",
  running: "Running",
  blocked: "Blocked",
  finishing: "Finishing",
  completed: "Completed",
  "needs-changes": "Needs changes",
  failed: "Failed",
};

/** Count label helpers for the compact heading. */
const plural = (count: number, singular: string, rest: string) =>
  `${count} ${count === 1 ? singular : rest}`;

function Segment({
  p1,
  p2,
  color,
  dashed,
  opacity,
  testID,
}: {
  p1: GraphPoint;
  p2: GraphPoint;
  color: string;
  dashed: boolean;
  opacity: number;
  testID: string;
}) {
  if (Math.abs(p2.y - p1.y) < 1) {
    const shared = {
      position: "absolute" as const,
      left: Math.min(p1.x, p2.x),
      top: p1.y - GRAPH_LINE / 2,
      width: Math.max(GRAPH_LINE, Math.abs(p2.x - p1.x)),
      height: 0,
      opacity,
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
    opacity,
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

/**
 * Edge colors keep their meaning: solid muted arrows are directed
 * prerequisites, dashed warning connectors are shared-resource conflicts.
 * While a node is selected, its direct edges read in full strength (accent
 * for prerequisites) and every unrelated edge fades.
 */
function Edge({
  edge,
  theme,
  highlighted,
  dim,
}: {
  edge: GraphEdgeLayout;
  theme: PluginTheme;
  highlighted: boolean;
  /** True when a selection is active and this edge is unrelated to it. */
  dim: boolean;
}) {
  let color = theme.colors.foregroundMuted;
  if (edge.kind === "conflict") {
    color = theme.colors.statusWarning;
  } else if (highlighted) {
    color = theme.colors.accent;
  }
  const opacity = dim ? EDGE_DIM_OPACITY : 1;
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
            testID={`symphony-edge-${edge.from}-${edge.to}-${edge.kind}-${index}`}
            p1={point}
            p2={next}
            color={color}
            dashed={dashed}
            opacity={opacity}
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
            opacity,
          }}
        />
      )}
    </>
  );
}

/**
 * The worker sentence for a node's accessible label and the selection panel:
 * what actually runs versus what the plan alone names.
 */
function workerClause(identity: WorkerIdentity): string {
  return identity.source === "launched"
    ? `Runs on ${identityLabel(identity)}`
    : `Planned: ${identityLabel(identity)}`;
}

/**
 * One task node: a muted ID row that shares its line with the worker's
 * harness mark and model when the task names a worker, then a 14px two-line
 * title and the status icon and label from the shared presentation map.
 * Activating a node selects it for inspection; opening the agent is a
 * separate explicit action in the selection panel, so the accessible name
 * promises selection, never navigation. Failed-launch attempts are reported
 * like any other state; they never claim an available task agent.
 */
function GraphNode({
  theme,
  task,
  symphony,
  node,
  padding,
  selected,
  connected,
  profiles,
  catalog,
  onPick,
}: {
  theme: PluginTheme;
  task: TaskDefinition;
  symphony: StoredSymphony;
  node: { x: number; y: number; width: number; height: number };
  padding: number;
  selected: boolean;
  connected: boolean;
  /** Worker profiles for identity resolution; empty while profiles load. */
  profiles: readonly ConductorProfile[];
  catalog: ProviderCatalog | undefined;
  onPick(this: void): void;
}) {
  const [focused, setFocused] = useState(false);
  const state = taskState(symphony, task);
  const presentation = taskStatusPresentation(state);
  const color = statusColor(theme, presentation.color);
  const identity = taskIdentity(symphony, task, profiles, catalog);
  const waitsFor = task.prerequisites.length
    ? ` Waits for ${task.prerequisites.join(", ")}.`
    : "";
  const worker = identity?.provider ? ` ${workerClause(identity)}.` : "";
  const label = `${selected ? "Task" : "Select task"} ${task.id} — ${task.title}. ${presentation.label}.${waitsFor}${worker}${selected ? " Selected." : ""}`;
  const active = selected || focused;
  // The 2px accent frame marks either the active node or keyboard focus; a
  // selected node's direct neighbors carry the accent at 1px so the selected
  // node and its connected relationships still read as one group.
  const accent = theme.colors.accent;
  const borderColor = active || connected ? accent : theme.colors.border;
  const frame = {
    position: "absolute" as const,
    left: node.x,
    top: node.y,
    width: node.width,
    height: node.height,
    padding,
    borderRadius: 10,
    borderWidth: active ? 2 : 1,
    borderColor,
    backgroundColor: active ? theme.colors.surface2 : theme.colors.surface1,
  };
  return (
    <Pressable
      testID={`symphony-node-${task.id}`}
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
      <View style={{ gap: 4 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
          <Text
            numberOfLines={1}
            style={{
              color: theme.colors.foregroundMuted,
              fontSize: 12,
              lineHeight: 16,
              fontVariant: ["tabular-nums"],
              flexShrink: 1,
              minWidth: 0,
            }}
          >
            {task.id}
          </Text>
          {/* The worker sits at the trailing edge of the ID row, capped at
              roughly half its width so a long model name truncates instead
              of pushing the ID out; the model label only, since the row is
              as muted as the ID. */}
          {identity?.provider && (
            <View
              testID={`symphony-worker-${task.id}`}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 4,
                flexShrink: 1,
                marginLeft: "auto",
                maxWidth: "55%",
              }}
            >
              <View style={{ flexShrink: 0 }}>
                <HarnessMark
                  provider={identity.provider}
                  {...(identity.providerLabel
                    ? { label: identity.providerLabel }
                    : {})}
                  size={12}
                  color={theme.colors.foregroundMuted}
                  surface={theme.colors.surface2}
                />
              </View>
              <Text
                numberOfLines={1}
                style={{
                  color: theme.colors.foregroundMuted,
                  fontSize: 12,
                  lineHeight: 16,
                  flexShrink: 1,
                }}
              >
                {identity.modelLabel ?? identity.providerLabel}
              </Text>
            </View>
          )}
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
        <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
          <View
            aria-hidden
            accessible={false}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          >
            <Icon name={presentation.icon} size={13} color={color} />
          </View>
          <Text
            numberOfLines={1}
            style={{
              color,
              fontSize: 12,
              lineHeight: 16,
              fontWeight: "600",
              flexShrink: 1,
            }}
          >
            {presentation.label}
            {state.waitingFor.length ? ` · ${state.waitingFor.join(", ")}` : ""}
          </Text>
        </View>
      </View>
    </Pressable>
  );
}

/**
 * Status legend chips for the states actually present in the displayed score,
 * plus the two connector meanings. Written labels keep states scannable
 * without relying on color alone.
 */
function Legend({
  theme,
  present,
}: {
  theme: PluginTheme;
  present: readonly TaskStateKey[];
}) {
  // Legend chips use the same icon and color roles as the nodes themselves,
  // so the legend mirrors what the canvas shows rather than paraphrasing it.
  const presentationFor = (state: TaskStateKey) =>
    taskStatusPresentation({
      key: state,
      label: LEGEND_LABELS[state],
      waitingFor: [],
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
    <View
      testID="symphony-graph-legend"
      accessibilityLabel="Graph legend"
      style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}
    >
      {LEGEND_ORDER.filter((state) => present.includes(state)).map((state) => (
        <View
          key={state}
          style={{ flexDirection: "row", alignItems: "center", gap: 5 }}
        >
          <View
            aria-hidden
            accessible={false}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          >
            <Icon
              name={presentationFor(state).icon}
              size={13}
              color={statusColor(theme, presentationFor(state).color)}
            />
          </View>
          <Text style={{ ...caption, color: theme.colors.foreground }}>
            {LEGEND_LABELS[state]}
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

/** "8 tasks · 5 dependency arrows · 7 shared-resource conflicts". */
function summaryLine(summary: GraphLayoutSummary): string {
  const parts = [
    plural(summary.tasks, "task", "tasks"),
    plural(summary.dependencies, "dependency arrow", "dependency arrows"),
  ];
  if (summary.conflicts === 1) {
    parts.push("1 shared-resource conflict");
  } else if (summary.conflicts > 1) {
    parts.push(`${summary.conflicts} shared-resource conflicts`);
  }
  return parts.join(" · ");
}

/**
 * The selected task's inspection panel: full title, current state, direct
 * prerequisites, direct dependents, and shared-resource conflicts in one
 * bounded block, with an explicit Open agent action when navigation is
 * available and the launch has not failed. It never opens an agent on node
 * selection; that is this panel's job only.
 */
function SelectionPanel({
  theme,
  symphony,
  task,
  dependents,
  conflicts,
  profiles,
  catalog,
  compact = false,
  openAgent,
}: {
  theme: PluginTheme;
  symphony: StoredSymphony;
  task: TaskDefinition;
  dependents: readonly string[];
  conflicts: readonly { other: TaskDefinition; reason: string }[];
  profiles: readonly ConductorProfile[];
  catalog: ProviderCatalog | undefined;
  compact?: boolean;
  openAgent?: (id: string) => void;
}) {
  const attempt = latestAttempt(symphony, task.id);
  const state = taskState(symphony, task);
  const identity = taskIdentity(symphony, task, profiles, catalog);
  const muted = {
    color: theme.colors.foregroundMuted,
    fontSize: 12,
    lineHeight: 18,
  } as const;
  const agents =
    attempt && attempt.launch?.state !== "failed" ? attempt.agentId : null;
  return (
    <View
      testID="symphony-graph-selection"
      style={{
        gap: 8,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 10,
        backgroundColor: theme.colors.surface1,
        padding: 14,
      }}
    >
      <Text
        testID="symphony-graph-selection-title"
        selectable
        style={{
          color: theme.colors.foreground,
          fontSize: 14,
          lineHeight: 20,
          fontWeight: "600",
        }}
      >
        {`Selected ${task.id}: ${task.title}`}
      </Text>
      <StatusMarker
        theme={theme}
        presentation={taskStatusPresentation(state)}
        size={15}
      />
      {identity?.provider && (
        <Text
          selectable
          testID={`symphony-selection-worker-${task.id}`}
          style={muted}
        >
          {`${workerClause(identity)}.`}
        </Text>
      )}
      <Text selectable style={muted}>
        {task.prerequisites.length
          ? `Waits for ${task.prerequisites.join(", ")}`
          : "No dependencies"}
        {dependents.length ? `\nNeeded by ${dependents.join(", ")}` : ""}
        {state.waitingFor.length
          ? `\nStill waiting on ${state.waitingFor.join(", ")}`
          : ""}
      </Text>
      {conflicts.map((conflict) => (
        <Text key={conflict.other.id} selectable style={muted}>
          {`Conflict with ${conflict.other.id}: ${conflict.reason} — their work is serialized without adding a prerequisite.`}
        </Text>
      ))}
      {openAgent && agents ? (
        <View style={{ alignItems: "flex-start" }}>
          <Button
            theme={theme}
            variant="quiet"
            dense={!compact}
            label="Open agent"
            icon="ArrowUpRight"
            testID="symphony-graph-open-agent"
            accessibilityLabel={`Open agent · ${task.id}`}
            onPress={() => openAgent(agents)}
          />
        </View>
      ) : null}
      {openAgent && attempt && attempt.launch?.state === "failed" && (
        <Text style={muted}>
          The last agent launch failed; there is no agent to open.
        </Text>
      )}
    </View>
  );
}

/**
 * The symphony score as an inspectable graph. Selecting a node highlights its
 * direct prerequisite, dependent, and conflict edges, summarizes the selected
 * task below the canvas, and keeps the user in Podium; an explicit Open agent
 * action navigates. Selection clears itself whenever the displayed score
 * stops containing the picked task — a different loop or a different
 * symphony — so stale picks never leak across views.
 */
export function ScoreView({
  theme,
  symphony,
  score,
  openAgent,
  compact = false,
  profiles,
  catalog,
}: {
  theme: PluginTheme;
  symphony: StoredSymphony;
  score: { tasks: TaskDefinition[] };
  openAgent?: (id: string) => void;
  compact?: boolean;
  /** Worker profiles for node identity resolution; empty while unloaded. */
  profiles?: readonly ConductorProfile[] | undefined;
  catalog?: ProviderCatalog | undefined;
}) {
  const tasks = useMemo(
    () => new Map(score.tasks.map((task) => [task.id, task])),
    [score],
  );
  // The pick's validity key: one symphony plus the exact task IDs shown.
  // A data refresh rewrites the stored records but keeps the same shown task
  // IDs, so it preserves a valid selection.
  const pickKey = useMemo(
    () => `${symphony.id}:${score.tasks.map((task) => task.id).join(",")}`,
    [symphony.id, score],
  );
  const [picked, setPicked] = useState<{
    symphonyId: string;
    taskId: string;
  } | null>(null);
  const [pickedKey, setPickedKey] = useState(pickKey);
  if (pickedKey !== pickKey) {
    // The score moved on while this component stayed mounted: a loop switch
    // whose score no longer contains the task, or another symphony. Reset the
    // stored pick itself when its task is gone, so visiting a score without
    // the task and then returning can never revive the selection without a
    // new activation; a pick whose task still exists survives the change.
    setPickedKey(pickKey);
    setPicked(
      picked?.symphonyId === symphony.id && tasks.has(picked.taskId)
        ? picked
        : null,
    );
  }
  const selected = picked?.taskId ?? null;
  const layout = useMemo(() => layoutGraph(score, compact), [score, compact]);
  const geometry = graphGeometry(compact);
  const presentStates = useMemo(
    () => [
      ...new Set(score.tasks.map((task) => taskState(symphony, task).key)),
    ],
    [score, symphony],
  );
  if (!score.tasks.length) {
    return (
      <Text style={{ color: theme.colors.foregroundMuted, lineHeight: 21 }}>
        No tasks were recorded for this symphony yet.
      </Text>
    );
  }
  const selectedTask = selected ? tasks.get(selected) : undefined;
  const connectedNodes = new Set<string>();
  if (selectedTask) {
    for (const edge of layout.edges) {
      const touches =
        edge.from === selectedTask.id || edge.to === selectedTask.id;
      if (!touches) {
        continue;
      }
      connectedNodes.add(edge.from);
      connectedNodes.add(edge.to);
    }
    for (const other of score.tasks) {
      const reason = conflictReason(selectedTask, other);
      if (other.id !== selectedTask.id && reason) {
        connectedNodes.add(other.id);
      }
    }
    connectedNodes.delete(selectedTask.id);
  }
  const selectedConflicts = selectedTask
    ? score.tasks
        .filter((other) => other.id !== selectedTask.id)
        .flatMap((other) => {
          const reason = conflictReason(selectedTask, other);
          return reason ? [{ other, reason }] : [];
        })
    : [];
  const selectedDependents = selectedTask
    ? score.tasks
        .filter((other) => other.prerequisites.includes(selectedTask.id))
        .map((other) => other.id)
    : [];
  return (
    <View style={{ gap: 10 }} testID="symphony-graph">
      <Text
        testID="symphony-graph-heading"
        style={{
          color: theme.colors.foregroundMuted,
          fontSize: 12,
          lineHeight: 17,
          fontVariant: ["tabular-nums"],
        }}
      >
        {summaryLine(layout.summary)}
      </Text>
      <ScrollView
        horizontal
        contentContainerStyle={{ padding: 2 }}
        // A short score hugs its content instead of stretching into an empty
        // stage; a long score keeps its scrolling inside this frame.
        style={{
          borderWidth: 1,
          borderColor: theme.colors.border,
          borderRadius: 8,
          backgroundColor: theme.colors.surface1,
          maxWidth: layout.width + 4,
        }}
      >
        <View style={{ width: layout.width, height: layout.height }}>
          {layout.edges.map((edge, index) => {
            const touches =
              Boolean(selectedTask) &&
              (edge.from === selected || edge.to === selected);
            return (
              <Edge
                key={`${edge.from}->${edge.to}:${index}`}
                edge={edge}
                theme={theme}
                highlighted={touches}
                dim={Boolean(selectedTask) && !touches}
              />
            );
          })}
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
                symphony={symphony}
                node={node}
                padding={geometry.nodePadding}
                selected={selected === task.id}
                connected={connectedNodes.has(task.id)}
                profiles={profiles ?? []}
                catalog={catalog}
                onPick={() => {
                  setPicked({ symphonyId: symphony.id, taskId: task.id });
                }}
              />
            );
          })}
        </View>
      </ScrollView>
      <Legend theme={theme} present={presentStates} />
      {selectedTask && (
        <SelectionPanel
          theme={theme}
          symphony={symphony}
          task={selectedTask}
          dependents={selectedDependents}
          conflicts={selectedConflicts}
          profiles={profiles ?? []}
          catalog={catalog}
          compact={compact}
          {...(openAgent ? { openAgent } : {})}
        />
      )}
    </View>
  );
}
