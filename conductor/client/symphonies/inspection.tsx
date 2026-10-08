import { useState } from "react";
import { Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import type {
  Attempt,
  SymphonyContext,
  Score,
  StoredSymphony,
  TaskDefinition,
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
          <Text
            selectable
            style={{ color: theme.colors.foregroundMuted, lineHeight: 21 }}
          >
            Source: {context.provenance}
            {"\n"}Expected outcome: {context.expectedOutcome}
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

type SymphonyRevision = StoredSymphony["revisions"][number];

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
 * Compact symphony history: one single-line row per attempt and per accepted
 * revision. Report summaries stay on the task cards and are never repeated
 * here; only a present blocker or failure message shows, clamped to two lines.
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
  const [openRevisions, setOpenRevisions] = useState<Record<number, boolean>>(
    {},
  );
  const toggleRevision = (number: number) =>
    setOpenRevisions((prior) => ({ ...prior, [number]: !prior[number] }));
  return (
    <View style={{ gap: 16 }}>
      {symphony.execution.attempts.length ? (
        <View style={{ gap: 4 }}>
          <Label theme={theme}>ATTEMPTS</Label>
          <View>
            {symphony.execution.attempts.map((attempt, index) => (
              <AttemptRow
                key={attempt.id}
                theme={theme}
                symphony={symphony}
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
      {symphony.revisions.length ? (
        <View style={{ gap: 4 }}>
          <Label theme={theme}>REVISIONS</Label>
          <View>
            {symphony.revisions.map((revision) => (
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

function AttemptRow({
  theme,
  symphony,
  attempt,
  index,
  openAgent,
}: {
  theme: PluginTheme;
  symphony: StoredSymphony;
  attempt: Attempt;
  index: number;
  openAgent?: (id: string) => void;
}) {
  const stateKey = attemptState(symphony, attempt);
  const stateColor = theme.colors[HISTORY_STATE_COLORS[stateKey]];
  const writesLabel = effectiveWritesLabel(symphony, attempt);
  const grants = attempt.grantedWrites ?? [];
  const diagnosis = attempt.report?.diagnosis;
  const [grantsOpen, setGrantsOpen] = useState(false);
  const [diagnosisOpen, setDiagnosisOpen] = useState(false);
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
      {writesLabel && (
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
          {`Effective writes: ${writesLabel}`}
        </Text>
      )}
      {(grants.length > 0 || diagnosis) && (
        <View
          style={{
            width: "100%",
            flexDirection: "row",
            flexWrap: "wrap",
            alignItems: "center",
            gap: 16,
          }}
        >
          {grants.length > 0 && (
            <Disclosure
              theme={theme}
              label={`Granted writes ${grants.length}`}
              expanded={grantsOpen}
              onToggle={() => setGrantsOpen((open) => !open)}
              testID={`history-granted-${index + 1}`}
            >
              <InsetPanel theme={theme}>
                {grants.map((grant, grantIndex) => (
                  <View
                    key={`${grant.path}-${grantIndex}`}
                    style={{
                      paddingVertical: 6,
                      borderTopWidth: grantIndex > 0 ? 1 : 0,
                      borderTopColor: theme.colors.border,
                      gap: 2,
                    }}
                  >
                    <Text
                      selectable
                      style={{
                        color: theme.colors.foreground,
                        fontSize: 13,
                        lineHeight: 20,
                        fontWeight: "600",
                      }}
                    >
                      {grant.path}
                    </Text>
                    <Text
                      selectable
                      style={{
                        color: theme.colors.foregroundMuted,
                        fontSize: 13,
                        lineHeight: 20,
                      }}
                    >
                      {grant.reason}
                    </Text>
                  </View>
                ))}
              </InsetPanel>
            </Disclosure>
          )}
          {diagnosis && (
            <Disclosure
              theme={theme}
              label="Diagnosis"
              expanded={diagnosisOpen}
              onToggle={() => setDiagnosisOpen((open) => !open)}
              testID={`history-diagnosis-${index + 1}`}
            >
              <InsetPanel theme={theme}>
                <DiagnosisPanel theme={theme} diagnosis={diagnosis} />
              </InsetPanel>
            </Disclosure>
          )}
        </View>
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
  revision: SymphonyRevision;
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
          · {taskCountLabel(revision.score.tasks.length)}
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
          {revision.score.tasks.map((task) => (
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

/**
 * The task definition in effect when an attempt started: the last revision
 * accepted at or before its start. Using the latest revision here would project
 * a later `addWrites` growth onto an attempt that never saw it.
 */
function taskForAttempt(
  symphony: StoredSymphony,
  attempt: Attempt,
): TaskDefinition | undefined {
  for (let index = symphony.revisions.length - 1; index >= 0; index -= 1) {
    const revision = symphony.revisions[index];
    if (revision && revision.acceptedAt <= attempt.startedAt) {
      const task = revision.score.tasks.find(
        (entry) => entry.id === attempt.taskId,
      );
      if (task) {
        return task;
      }
    }
  }
  return symphony.revisions[0]?.score.tasks.find(
    (entry) => entry.id === attempt.taskId,
  );
}

/**
 * Effective write scope behind an attempt: the writes the task declared when
 * the attempt started plus the paths the server granted during the attempt.
 * Null when the task wrote nothing and nothing was granted, so silent tasks add
 * no history noise.
 */
function effectiveWritesLabel(
  symphony: StoredSymphony,
  attempt: Attempt,
): string | null {
  const defined = taskForAttempt(symphony, attempt)?.writes ?? [];
  const granted = (attempt.grantedWrites ?? []).map((grant) => grant.path);
  if (!defined.length && !granted.length) {
    return null;
  }
  const parts: string[] = [];
  if (defined.length) {
    parts.push(defined.join(", "));
  }
  if (granted.length) {
    parts.push(`${granted.join(", ")} (granted)`);
  }
  return parts.join(" + ");
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
