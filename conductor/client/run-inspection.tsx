import { useState } from "react";
import { Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import type {
  RunAttempt,
  RunContext,
  RunGraph,
  StoredRun,
} from "../shared/run-models";
import { taskState, type TaskStateKey } from "../shared/run-task-state";
import { Button, Disclosure, Label, Notice, rowStyle } from "./controls";
import { RunGraphView } from "./run-graph";

export function RunInspection({
  view,
  theme,
  run,
  context,
  graph,
  compact = false,
  openAgent,
}: {
  view: string;
  theme: PluginTheme;
  run: StoredRun;
  context: RunContext;
  graph: RunGraph;
  /** Layout hint carried to the graph; defaults only because the chain may lack layout info. */
  compact?: boolean;
  openAgent?: (id: string) => void;
}) {
  return (
    <>
      {view === "context" && (
        <>
          <Text
            selectable
            style={{ color: theme.colors.foreground, lineHeight: 23 }}
          >
            {context.plan}
          </Text>
          <Text
            selectable
            style={{ color: theme.colors.foregroundMuted, lineHeight: 21 }}
          >
            Source: {context.provenance}
            {"\n"}Expected outcome: {context.expectedOutcome}
            {"\n"}Accepted decisions: {context.decisions.join("; ") || "None"}
            {"\n"}Constraints: {context.constraints.join("; ") || "None"}
            {"\n"}Checkout: {run.source.checkout}
            {"\n"}Base: {run.source.base ?? "Unknown"}
            {"\n"}Initial tracked-change fingerprint:{" "}
            {run.source.dirtyFingerprint ?? "Unknown"}
          </Text>
        </>
      )}
      {view === "history" && (
        <HistoryView
          theme={theme}
          run={run}
          {...(openAgent ? { openAgent } : {})}
        />
      )}
      {view === "graph" && (
        <>
          <Label theme={theme}>TASK DEPENDENCIES</Label>
          <Text
            style={{
              color: theme.colors.foregroundMuted,
              fontSize: 13,
              lineHeight: 20,
            }}
          >
            Every task lists its own status; arrows point from a prerequisite to
            the task that depends on it, and dashed connectors mark shared
            resources that need serialization without adding prerequisites.
            Select a task to open its worker when one is running.
          </Text>
          <RunGraphView
            theme={theme}
            run={run}
            graph={graph}
            compact={compact}
            {...(openAgent ? { openAgent } : {})}
          />
        </>
      )}
    </>
  );
}

/** State row color, matching the task card's status dot palette. */
const HISTORY_STATE_COLORS: Record<TaskStateKey, StateColorName> = {
  ready: "foregroundMuted",
  waiting: "foregroundMuted",
  running: "accent",
  blocked: "statusWarning",
  finishing: "statusWarning",
  failed: "statusDanger",
  completed: "statusSuccess",
};

type StateColorName =
  | "foregroundMuted"
  | "accent"
  | "statusWarning"
  | "statusSuccess"
  | "statusDanger";

type RunRevision = StoredRun["revisions"][number];

const HISTORY_ROW_STYLE = {
  flexDirection: "row",
  flexWrap: "wrap",
  alignItems: "center",
  gap: 6,
  minHeight: 32,
  paddingVertical: 4,
  borderTopWidth: 1,
} as const;

/**
 * Compact run history: one single-line row per attempt and per accepted
 * revision. Report summaries stay on the task cards and are never repeated
 * here; only a present blocker or failure message shows, clamped to two lines.
 */
function HistoryView({
  theme,
  run,
  openAgent,
}: {
  theme: PluginTheme;
  run: StoredRun;
  openAgent?: (id: string) => void;
}) {
  const [openRevisions, setOpenRevisions] = useState<Record<number, boolean>>(
    {},
  );
  const toggleRevision = (number: number) =>
    setOpenRevisions((prior) => ({ ...prior, [number]: !prior[number] }));
  return (
    <View style={{ gap: 16 }}>
      {run.execution?.attempts.length ? (
        <View style={{ gap: 4 }}>
          <Label theme={theme}>ATTEMPTS</Label>
          <View>
            {run.execution.attempts.map((attempt, index) => (
              <AttemptRow
                key={attempt.id}
                theme={theme}
                run={run}
                attempt={attempt}
                index={index}
                {...(openAgent ? { openAgent } : {})}
              />
            ))}
          </View>
        </View>
      ) : (
        <Notice theme={theme}>No task attempts yet.</Notice>
      )}
      {run.revisions.length ? (
        <View style={{ gap: 4 }}>
          <Label theme={theme}>REVISIONS</Label>
          <View>
            {run.revisions.map((revision) => (
              <RevisionRow
                key={revision.number}
                theme={theme}
                revision={revision}
                expanded={Boolean(openRevisions[revision.number])}
                onToggle={() => toggleRevision(revision.number)}
              />
            ))}
          </View>
        </View>
      ) : (
        <Notice theme={theme}>No accepted revisions yet.</Notice>
      )}
    </View>
  );
}

/** Attempt display state for a history row: a completed report with an unsettled agent launch reads as finishing. */
function attemptState(run: StoredRun, attempt: RunAttempt): TaskStateKey {
  const task = run.revisions
    .at(-1)
    ?.graph.tasks.find((entry) => entry.id === attempt.taskId);
  if (!task) {
    return attempt.state;
  }
  const state = taskState(run, task);
  // Only keep the display state while it matches the attempt's own outcome;
  // a later prerequisite-driven reading would mislabel this historical row.
  if (
    (state.key === "finishing" && attempt.state === "completed") ||
    state.key === attempt.state
  ) {
    return state.key;
  }
  return attempt.state;
}

function AttemptRow({
  theme,
  run,
  attempt,
  index,
  openAgent,
}: {
  theme: PluginTheme;
  run: StoredRun;
  attempt: RunAttempt;
  index: number;
  openAgent?: (id: string) => void;
}) {
  const stateKey = attemptState(run, attempt);
  const stateColor = theme.colors[HISTORY_STATE_COLORS[stateKey]];
  return (
    <View
      testID={`history-attempt-${index + 1}`}
      style={{
        ...HISTORY_ROW_STYLE,
        borderTopColor: theme.colors.border,
        flexShrink: 1,
        minWidth: 0,
      }}
    >
      <Text
        selectable
        style={{
          color: theme.colors.foregroundMuted,
          fontSize: 12,
          lineHeight: 17,
          fontVariant: ["tabular-nums"],
        }}
      >
        #{index + 1}
      </Text>
      <Text
        selectable
        style={{
          color: theme.colors.foreground,
          fontSize: 12,
          lineHeight: 17,
          flexShrink: 1,
          minWidth: 0,
        }}
      >
        {attempt.taskId}
      </Text>
      <View
        aria-hidden
        style={{
          width: 6,
          height: 6,
          borderRadius: 3,
          backgroundColor: stateColor,
        }}
      />
      <Text
        style={{
          color: stateColor,
          fontSize: 12,
          lineHeight: 17,
          fontWeight: "500",
        }}
      >
        {ATTEMPT_STATE_LABELS[stateKey]}
      </Text>
      <Text
        selectable
        numberOfLines={1}
        style={{
          color: theme.colors.foregroundMuted,
          fontSize: 12,
          lineHeight: 17,
          flexShrink: 1,
          minWidth: 0,
        }}
      >
        {durationLabel(attempt)}
      </Text>
      {openAgent && attempt.launch?.state !== "failed" && (
        <Button
          theme={theme}
          variant="quiet"
          dense
          label="Open agent"
          accessibilityLabel={`Open agent · attempt ${index + 1}`}
          onPress={() => openAgent(attempt.agentId)}
        />
      )}
      {attempt.message && (
        <Text
          selectable
          numberOfLines={2}
          style={{
            color: theme.colors.foregroundMuted,
            fontSize: 12,
            lineHeight: 17,
            width: "100%",
          }}
        >
          {attempt.message}
        </Text>
      )}
    </View>
  );
}

const ATTEMPT_STATE_LABELS: Record<TaskStateKey, string> = {
  ready: "Ready",
  waiting: "Waiting",
  running: "Running",
  blocked: "Blocked",
  finishing: "Finishing",
  completed: "Completed",
  failed: "Failed",
};

/** One revision row: number, short timestamp, one-line reason, task count, and a local disclosure of task titles. */
function RevisionRow({
  theme,
  revision,
  expanded,
  onToggle,
}: {
  theme: PluginTheme;
  revision: RunRevision;
  expanded: boolean;
  onToggle(this: void): void;
}) {
  return (
    <View
      testID={`history-revision-${revision.number}`}
      style={{
        borderTopWidth: 1,
        borderTopColor: theme.colors.border,
        paddingVertical: 4,
      }}
    >
      <View style={{ ...rowStyle, gap: 6, minHeight: 32 }}>
        <Text
          selectable
          style={{
            color: theme.colors.foregroundMuted,
            fontSize: 12,
            lineHeight: 17,
            fontVariant: ["tabular-nums"],
          }}
        >
          R{revision.number}
        </Text>
        <Text
          selectable
          numberOfLines={1}
          style={{
            color: theme.colors.foregroundMuted,
            fontSize: 12,
            lineHeight: 17,
          }}
        >
          {shortTimestamp(revision.acceptedAt)}
        </Text>
        <Text
          selectable
          numberOfLines={1}
          style={{
            color: theme.colors.foreground,
            fontSize: 12,
            lineHeight: 17,
            flexShrink: 1,
            minWidth: 0,
          }}
        >
          {revision.reason}
        </Text>
        <Text
          style={{
            color: theme.colors.foregroundMuted,
            fontSize: 12,
            lineHeight: 17,
          }}
        >
          · {taskCountLabel(revision.graph.tasks.length)}
        </Text>
        <Disclosure
          theme={theme}
          label={`Tasks in revision ${revision.number}`}
          expanded={expanded}
          onToggle={onToggle}
        />
      </View>
      {expanded && (
        <View
          style={{
            backgroundColor: theme.colors.surface1,
            borderColor: theme.colors.border,
            borderWidth: 1,
            borderRadius: 6,
            padding: 12,
            gap: 4,
          }}
        >
          {revision.graph.tasks.map((task) => (
            <Text
              key={task.id}
              selectable
              style={{
                color: theme.colors.foreground,
                fontSize: 13,
                lineHeight: 20,
              }}
            >
              {task.title}
            </Text>
          ))}
        </View>
      )}
    </View>
  );
}

/** "1 task" for a single task, otherwise "N tasks". */
function taskCountLabel(count: number): string {
  return count === 1 ? "1 task" : `${count} tasks`;
}

/** Short human timestamp like "Oct 6, 09:12". */
function shortTimestamp(epochMillis: number): string {
  const date = new Date(epochMillis);
  const day = date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
  const time = date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return `${day}, ${time}`;
}

/** Age or duration text from the attempt timestamps, e.g. "9h 44m" or "12m". */
function durationLabel(attempt: RunAttempt): string {
  const end = attempt.endedAt ?? Date.now();
  const minutes = Math.max(0, Math.round((end - attempt.startedAt) / 60000));
  if (minutes < 60) {
    return minutes === 1 ? "1m" : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}
