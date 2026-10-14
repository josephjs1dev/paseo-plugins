import { Text, View } from "react-native";
import type { ReactNode } from "react";
import type { PluginTheme } from "@getpaseo/plugin";
import type { TaskStateKey } from "../../shared/symphonies/task-state";

/**
 * One slice of a detailed progress track, in score order. `reportedComplete`
 * mirrors the shared completion count for the list (an attempt with state
 * "completed"); display state can still read "Finishing" while the agent
 * settles, so the fill never trusts `state` alone.
 */
export interface SymphonyProgressSegment {
  id: string;
  title: string;
  state: TaskStateKey;
  reportedComplete: boolean;
}

/** Labels mirror `shared/symphonies/task-state.ts` (its map is not exported). */
const SEGMENT_LABELS: Record<TaskStateKey, string> = {
  ready: "Ready",
  waiting: "Waiting",
  running: "Running",
  blocked: "Blocked",
  finishing: "Finishing",
  completed: "Completed",
  "needs-changes": "Needs changes",
  failed: "Failed",
};

/**
 * Truthful reported-task progress. Progress always represents equal task
 * counts, never effort, elapsed time, or an ETA, and a filled track does not
 * claim symphony completion; the symphony status stays authoritative.
 *
 * - `planning` renders "Splitting into tasks" with no track or percentage.
 * - Zero tasks render the count line only; the track is omitted instead of
 *   dividing by zero.
 * - Without `segments`, a single continuous track fills by the reported
 *   completion count. With `segments`, slices render in the supplied score
 *   order and each slice fills only when that task's latest attempt reported
 *   complete.
 */
export function SymphonyProgress({
  theme,
  completedTasks,
  taskCount,
  planning = false,
  showLabel = true,
  segments,
}: {
  theme: PluginTheme;
  /** Count shared by the list summary; completion reports, not settlement. */
  completedTasks: number;
  taskCount: number;
  planning?: boolean;
  /** Hide when surrounding content already names the count. */
  showLabel?: boolean;
  segments?: readonly SymphonyProgressSegment[];
}) {
  if (planning) {
    return (
      <View style={{ gap: 6 }}>
        {showLabel && (
          <ProgressLabel theme={theme}>Splitting into tasks</ProgressLabel>
        )}
      </View>
    );
  }
  const clamped = Math.min(Math.max(completedTasks, 0), Math.max(taskCount, 0));
  const fraction = taskCount > 0 ? Math.min(clamped / taskCount, 1) : 0;
  return (
    <View
      style={{ gap: 8 }}
      accessibilityLabel={`${completedTasks} of ${taskCount} tasks reported complete`}
    >
      {showLabel && (
        <ProgressLabel theme={theme}>
          {completedTasks} of {taskCount} tasks reported complete
        </ProgressLabel>
      )}
      {taskCount > 0 && segments ? (
        <View style={{ flexDirection: "row", gap: 2 }}>
          {segments.map((segment) => {
            const fill = segment.reportedComplete;
            return (
              <View
                key={segment.id}
                accessibilityLabel={`${segment.title}: ${fill ? "reported complete" : SEGMENT_LABELS[segment.state]}`}
                style={{
                  height: 6,
                  flex: 1,
                  borderRadius: 3,
                  backgroundColor: fill
                    ? theme.colors.statusSuccess
                    : theme.colors.surface2,
                }}
              />
            );
          })}
        </View>
      ) : null}
      {/* Proportional flex avoids percentage widths. Segments already express
          the fill, so the continuous track renders only without them, never
          stacked under the slices; an empty track is still a track while
          tasks exist and nothing has been reported complete yet. */}
      {taskCount > 0 && !segments ? (
        <View
          style={{
            height: 4,
            borderRadius: 2,
            overflow: "hidden",
            flexDirection: "row",
            backgroundColor: theme.colors.surface2,
          }}
        >
          {fraction > 0 ? (
            <View
              style={{
                flexGrow: fraction,
                height: 4,
                borderRadius: 2,
                backgroundColor: theme.colors.accent,
              }}
            />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function ProgressLabel({
  theme,
  children,
}: {
  theme: PluginTheme;
  children: ReactNode;
}) {
  return (
    <Text
      style={{
        color: theme.colors.foregroundMuted,
        fontSize: 12,
        lineHeight: 18,
      }}
    >
      {children}
    </Text>
  );
}
