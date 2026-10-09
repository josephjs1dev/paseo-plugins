import { useState } from "react";
import { Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import {
  attemptNumber,
  taskAttempts,
  type Attempt,
  type SymphonyContext,
  type Score,
  type StoredSymphony,
  type TaskDefinition,
} from "../../shared/symphonies/models";
import {
  taskState,
  type TaskStateKey,
} from "../../shared/symphonies/task-state";
import { Button, Disclosure, Label, Notice, rowStyle } from "../ui/controls";
import { ScoreView } from "./graph";
import { DiagnosisPanel, InsetPanel } from "./task-report";

export function SymphonyInspection({
  view,
  theme,
  symphony,
  context,
  score,
  compact = false,
  openAgent,
}: {
  view: string;
  theme: PluginTheme;
  symphony: StoredSymphony;
  context: SymphonyContext;
  score: Score;
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
          <PlanLine theme={theme} symphony={symphony} />
          <Text
            selectable
            style={{ color: theme.colors.foregroundMuted, lineHeight: 21 }}
          >
            Source: {context.provenance}
            {/* The server stores the goal, cut to 4000 characters, as the outcome. */}
            {context.expectedOutcome !== context.plan.slice(0, 4000).trim() &&
              `\nExpected outcome: ${context.expectedOutcome}`}
            {"\n"}Accepted decisions: {context.decisions.join("; ") || "None"}
            {"\n"}Constraints: {context.constraints.join("; ") || "None"}
            {"\n"}Checkout: {symphony.source.checkout}
            {"\n"}Base: {symphony.source.base ?? "Unknown"}
            {"\n"}Initial tracked-change fingerprint:{" "}
            {symphony.source.dirtyFingerprint ?? "Unknown"}
          </Text>
        </>
      )}
      {view === "history" && (
        <HistoryView
          theme={theme}
          symphony={symphony}
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
            Select a task to open its task agent when one is running.
          </Text>
          <ScoreView
            theme={theme}
            symphony={symphony}
            score={score}
            compact={compact}
            {...(openAgent ? { openAgent } : {})}
          />
        </>
      )}
    </>
  );
}

/**
 * The accepted plan as one line: when the first revision was accepted, its
 * reason, and the task count. Older symphonies whose Conductor grew write
 * scope through a new revision also name the affected tasks here, because
 * their History rows cannot attribute those paths to one attempt.
 */
function PlanLine({
  theme,
  symphony,
}: {
  theme: PluginTheme;
  symphony: StoredSymphony;
}) {
  const first = symphony.revisions[0];
  if (!first) {
    return null;
  }
  const latest = symphony.revisions.at(-1);
  const grown = latest
    ? latest.score.tasks.flatMap((task) => {
        const original = first.score.tasks.find(
          (entry) => entry.id === task.id,
        );
        return original &&
          task.writes.some((path) => !original.writes.includes(path))
          ? [task.id]
          : [];
      })
    : [];
  return (
    <>
      <Text
        selectable
        testID="symphony-plan"
        style={{
          color: theme.colors.foregroundMuted,
          fontSize: 12,
          lineHeight: 17,
          fontVariant: ["tabular-nums"],
        }}
      >
        {`Plan accepted ${shortTimestamp(first.acceptedAt)} · ${first.reason} · ${taskCountLabel(first.score.tasks.length)}`}
      </Text>
      {grown.length > 0 && (
        <Text
          selectable
          testID="symphony-plan-added-writes"
          style={{
            color: theme.colors.foregroundMuted,
            fontSize: 12,
            lineHeight: 17,
          }}
        >
          {`Write scope later added by the Conductor to: ${grown.join(", ")}`}
        </Text>
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
 * Compact symphony history, one section per task in score order. Report
 * summaries stay on the task cards and are never repeated here; only a present
 * blocker or failure message shows, clamped to two lines. The accepted plan is
 * not listed here; the Context tab shows it.
 */
function HistoryView({
  theme,
  symphony,
  openAgent,
}: {
  theme: PluginTheme;
  symphony: StoredSymphony;
  openAgent?: (id: string) => void;
}) {
  const tasks = symphony.revisions.at(-1)?.score.tasks ?? [];
  return (
    <View style={{ gap: 4 }}>
      <Label theme={theme}>HISTORY</Label>
      {tasks.length ? (
        <View>
          {tasks.map((task) => (
            <TaskHistory
              key={task.id}
              theme={theme}
              symphony={symphony}
              task={task}
              {...(openAgent ? { openAgent } : {})}
            />
          ))}
        </View>
      ) : (
        <Notice theme={theme}>No task attempts yet.</Notice>
      )}
    </View>
  );
}

/** One task's history: its current state when idle, else its attempts oldest first. */
function TaskHistory({
  theme,
  symphony,
  task,
  openAgent,
}: {
  theme: PluginTheme;
  symphony: StoredSymphony;
  task: TaskDefinition;
  openAgent?: (id: string) => void;
}) {
  const attempts = taskAttempts(symphony, task.id);
  if (!attempts.length) {
    const state = taskState(symphony, task);
    const color = theme.colors[HISTORY_STATE_COLORS[state.key]];
    return (
      <View
        testID={`history-task-${task.id}`}
        style={{ ...HISTORY_ROW_STYLE, borderTopColor: theme.colors.border }}
      >
        <Text
          selectable
          style={{
            color: theme.colors.foreground,
            fontSize: 13,
            lineHeight: 18,
            fontWeight: "600",
            flexShrink: 1,
            minWidth: 0,
          }}
        >
          {task.id}
        </Text>
        <View
          aria-hidden
          style={{
            width: 6,
            height: 6,
            borderRadius: 3,
            backgroundColor: color,
          }}
        />
        <Text
          style={{
            color: color,
            fontSize: 12,
            lineHeight: 17,
            fontWeight: "500",
          }}
        >
          {ATTEMPT_STATE_LABELS[state.key]}
        </Text>
      </View>
    );
  }
  const retried = attempts.length > 1;
  const state = taskState(symphony, task);
  const stateColor = theme.colors[HISTORY_STATE_COLORS[state.key]];
  return (
    <View
      testID={`history-task-${task.id}`}
      style={{
        borderTopWidth: 1,
        borderTopColor: theme.colors.border,
        paddingVertical: 4,
        gap: 2,
      }}
    >
      {retried && (
        <View style={{ ...rowStyle, gap: 6, minHeight: 20 }}>
          <Text
            selectable
            style={{
              color: theme.colors.foreground,
              fontSize: 13,
              lineHeight: 18,
              fontWeight: "600",
              flexShrink: 1,
              minWidth: 0,
            }}
          >
            {task.id}
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
            {ATTEMPT_STATE_LABELS[state.key]}
          </Text>
          <Text
            style={{
              color: theme.colors.foregroundMuted,
              fontSize: 12,
              lineHeight: 17,
            }}
          >
            {attemptCountLabel(attempts.length)}
          </Text>
        </View>
      )}
      {attempts.map((attempt, index) => (
        <AttemptRow
          key={attempt.id}
          theme={theme}
          symphony={symphony}
          task={task}
          attempt={attempt}
          number={attemptNumber(symphony, attempt)}
          retried={retried}
          previousAgentId={index > 0 ? attempts[index - 1]?.agentId : undefined}
          {...(openAgent ? { openAgent } : {})}
        />
      ))}
    </View>
  );
}

/**
 * One attempt row with its number, start time, and duration. A task's only
 * attempt renders as the task row itself, so it carries the task ID before
 * "Attempt 1"; a retried task labels each row "Attempt N" and says how the
 * retry ran ("retry · same agent" or "retry · new agent"). Scope changes and
 * the diagnosis appear beneath.
 */
function AttemptRow({
  theme,
  symphony,
  task,
  attempt,
  number,
  retried,
  previousAgentId,
  openAgent,
}: {
  theme: PluginTheme;
  symphony: StoredSymphony;
  task: TaskDefinition;
  attempt: Attempt;
  number: number;
  retried: boolean;
  previousAgentId: string | undefined;
  openAgent?: (id: string) => void;
}) {
  const stateKey = attemptState(symphony, attempt);
  const stateColor = theme.colors[HISTORY_STATE_COLORS[stateKey]];
  const diagnosis = attempt.report?.diagnosis;
  const [diagnosisOpen, setDiagnosisOpen] = useState(false);
  const suffix = retried ? `-${number}` : "";
  return (
    <View
      testID={`history-attempt-${task.id}${suffix}`}
      style={{
        flexDirection: "row",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 6,
        minHeight: 32,
        paddingVertical: 4,
        paddingLeft: retried ? 12 : 0,
        flexShrink: 1,
        minWidth: 0,
      }}
    >
      <Text
        selectable
        style={{
          color: theme.colors.foreground,
          fontSize: 13,
          lineHeight: 18,
          fontWeight: retried ? "400" : "600",
          fontVariant: ["tabular-nums"],
          flexShrink: 1,
          minWidth: 0,
        }}
      >
        {retried ? `Attempt ${number}` : task.id}
      </Text>
      {!retried && (
        <Text
          style={{
            color: theme.colors.foregroundMuted,
            fontSize: 12,
            lineHeight: 17,
            fontVariant: ["tabular-nums"],
          }}
        >
          {`Attempt ${number}`}
        </Text>
      )}
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
        {`Started ${shortTimestamp(attempt.startedAt)} · ${durationLabel(attempt)}`}
      </Text>
      {number > 1 && (
        <Text
          style={{
            color: theme.colors.foregroundMuted,
            fontSize: 12,
            lineHeight: 17,
          }}
        >
          {retryLabel(attempt, previousAgentId)}
        </Text>
      )}
      {openAgent && attempt.launch?.state !== "failed" && (
        <Button
          theme={theme}
          variant="quiet"
          dense
          label="Open agent"
          accessibilityLabel={
            retried
              ? `Open agent · ${task.id} attempt ${number}`
              : `Open agent · ${task.id}`
          }
          onPress={() => openAgent?.(attempt.agentId)}
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
      <ScopeChanges theme={theme} attempt={attempt} indented={retried} />
      {diagnosis && (
        <Disclosure
          theme={theme}
          label="Diagnosis"
          expanded={diagnosisOpen}
          onToggle={() => setDiagnosisOpen((open) => !open)}
          testID={`history-diagnosis-${task.id}${suffix}`}
        >
          <InsetPanel theme={theme}>
            <DiagnosisPanel theme={theme} diagnosis={diagnosis} />
          </InsetPanel>
        </Disclosure>
      )}
    </View>
  );
}

/**
 * "retry · same agent" when the retry reused the previous attempt's agent,
 * otherwise "retry · new agent".
 */
function retryLabel(
  attempt: Attempt,
  previousAgentId: string | undefined,
): string {
  return previousAgentId === attempt.agentId
    ? "retry · same agent"
    : "retry · new agent";
}

/**
 * Write-scope changes recorded on the attempt: paths the Conductor added for
 * this and later attempts, and paths a task agent's widen granted for the
 * attempt. One muted line per path, each with the reason it was needed.
 */
function ScopeChanges({
  theme,
  attempt,
  indented,
}: {
  theme: PluginTheme;
  attempt: Attempt;
  indented: boolean;
}) {
  const added = attempt.addedWrites ?? [];
  const granted = attempt.grantedWrites ?? [];
  if (!added.length && !granted.length) {
    return null;
  }
  return (
    <View style={{ width: "100%", gap: 2, paddingLeft: indented ? 12 : 0 }}>
      {added.map((grant, index) => (
        <Text
          key={`added-${grant.path}-${index}`}
          selectable
          numberOfLines={2}
          style={{
            color: theme.colors.foregroundMuted,
            fontSize: 12,
            lineHeight: 17,
          }}
        >
          {`+ ${grant.path} added by Conductor — "${grant.reason}"`}
        </Text>
      ))}
      {granted.map((grant, index) => (
        <Text
          key={`granted-${grant.path}-${index}`}
          selectable
          numberOfLines={2}
          style={{
            color: theme.colors.foregroundMuted,
            fontSize: 12,
            lineHeight: 17,
          }}
        >
          {`widened: ${grant.path} — "${grant.reason}"`}
        </Text>
      ))}
    </View>
  );
}

/** "2 attempts" for two tries, otherwise "N attempts". */
function attemptCountLabel(count: number): string {
  return `${count} attempts`;
}

/** Attempt display state for a history row: a completed report with an unsettled agent launch reads as finishing. */
function attemptState(
  symphony: StoredSymphony,
  attempt: Attempt,
): TaskStateKey {
  const task = symphony.revisions
    .at(-1)
    ?.score.tasks.find((entry) => entry.id === attempt.taskId);
  if (!task) {
    return attempt.state;
  }
  const state = taskState(symphony, task);
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

const ATTEMPT_STATE_LABELS: Record<TaskStateKey, string> = {
  ready: "Ready",
  waiting: "Waiting",
  running: "Running",
  blocked: "Blocked",
  finishing: "Finishing",
  completed: "Completed",
  failed: "Failed",
};

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
function durationLabel(attempt: Attempt): string {
  const end = attempt.endedAt ?? Date.now();
  const minutes = Math.max(0, Math.round((end - attempt.startedAt) / 60000));
  if (minutes < 60) {
    return minutes === 1 ? "1m" : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}
