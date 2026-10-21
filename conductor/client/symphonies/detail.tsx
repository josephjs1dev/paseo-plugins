import { useState } from "react";
import { ScrollView, Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import {
  SYMPHONY_LIMITS,
  latestAttempt,
  type SymphonyContext,
  type StoredSymphony,
} from "../../shared/symphonies/models";
import { currentLoop } from "../../shared/symphonies/score";
import { symphonyMetrics } from "../../shared/symphonies/metrics";
import { taskState } from "../../shared/symphonies/task-state";
import { StatusMarker, symphonyStatusPresentation } from "../ui/status";
import { SymphonyProgress } from "../ui/progress";
import {
  historyLoops,
  scoreAtLoop,
  symphonyAtLoop,
  unresolvedItemLabel,
} from "./history";
import { LoopSelector } from "./loop-selector";
import { Button, Label, Notice } from "../ui/controls";
import { cardSurface } from "../ui/card";
import { SymphonyDeleteAction } from "./delete-action";
import {
  formatDuration,
  tokenTotalsLabel,
  workTotalsLabel,
} from "./inspection";
import { SymphonyInspection } from "./inspection";
import type { ProfilesData } from "./profiles";
import {
  SymphonyTaskCard,
  type TaskDisclosures,
  type TaskDisclosure,
} from "./task-card";

const TAB_ICONS = {
  tasks: "ListChecks",
  graph: "GitBranch",
  context: "FileText",
  history: "History",
} as const;

export function SymphonyDetail({
  theme,
  symphony,
  context,
  stale,
  compact = false,
  openAgent,
  deleteSymphony,
  profiles,
}: {
  theme: PluginTheme;
  symphony: StoredSymphony;
  context: SymphonyContext;
  stale: boolean;
  compact?: boolean;
  openAgent?: (id: string) => void;
  deleteSymphony?: (symphony: StoredSymphony) => Promise<void>;
  /** Worker profiles and provider catalog, passed to the graph tab. */
  profiles?: ProfilesData;
}) {
  const [view, setView] = useState<"tasks" | "graph" | "context" | "history">(
    "tasks",
  );
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  // null follows the latest loop as new loops start.
  const [pickedLoop, setPickedLoop] = useState<number | null>(null);
  const score = symphony.revisions.at(-1)?.score ?? { tasks: [] };
  const loops = historyLoops(symphony);
  const latestLoop = loops.at(-1)?.loop ?? 1;
  const shownLoop =
    pickedLoop !== null && pickedLoop < latestLoop ? pickedLoop : latestLoop;
  const multiLoop = loops.length > 1;
  // Tasks, Graph and Context show the chosen loop; History always shows all.
  const loopSymphony = symphonyAtLoop(symphony, shownLoop);
  const loopScore = multiLoop ? scoreAtLoop(symphony, shownLoop) : score;
  const conducting = symphony.execution.conducting;
  const planning = conducting?.phase === "planning";
  const completed = score.tasks.filter(
    (task) => latestAttempt(symphony, task.id)?.state === "completed",
  ).length;
  /**
   * Header segments mirror the reported completion the count names: a slice
   * fills only when that task's latest attempt reported complete, in score
   * order. A settling agent still reports complete; it is not inertly done,
   * but the list counts it and the header must agree with the list.
   */
  const segments = score.tasks.map((task) => ({
    id: task.id,
    title: task.title,
    state: taskState(symphony, task).key,
    reportedComplete: latestAttempt(symphony, task.id)?.state === "completed",
  }));
  const resultLabel =
    symphony.execution.origin === "conducted"
      ? "RESULT · REPORTED BY THE CONDUCTOR AGENT"
      : "RESULT · REPORTED BY THE SOURCE AGENT";
  // Whole-symphony figures: elapsed from creation to finish (or now), the
  // summed work of every attempt, and their tokens.
  const metrics = symphonyMetrics(symphony, Date.now());
  // A conducted symphony shows its loop against the budget chosen at
  // `orchestrate`; records without one use the default budget.
  const loopNote =
    conducting && !planning
      ? ` · Loop ${currentLoop(symphony)} of ${conducting.maxLoops ?? SYMPHONY_LIMITS.defaultLoops}`
      : "";
  const toggle = (key: string) =>
    setExpanded((prior) => ({ ...prior, [key]: !prior[key] }));
  const isOpen = (key: string) => Boolean(expanded[key]);
  const taskDisclosures = (taskId: string): TaskDisclosures => ({
    summary: isOpen(`summary-${taskId}`),
    instructions: isOpen(`instructions-${taskId}`),
    evidence: isOpen(`evidence-${taskId}`),
    checks: isOpen(`checks-${taskId}`),
  });
  const toggleTask = (taskId: string, selection: TaskDisclosure) => {
    const key = `${selection}-${taskId}`;
    if (selection === "evidence" || selection === "checks") {
      // Evidence and Checks share one inset panel per card, so opening one
      // closes the other.
      const other =
        selection === "evidence" ? `checks-${taskId}` : `evidence-${taskId}`;
      setExpanded((prior) => ({
        ...prior,
        [key]: !prior[key],
        [other]: false,
      }));
      return;
    }
    toggle(key);
  };
  return (
    <ScrollView
      contentContainerStyle={{ padding: compact ? 16 : 24, gap: 16 }}
      testID="symphony-detail"
    >
      <View style={{ gap: 6 }} testID="symphony-detail-header">
        <StatusMarker
          theme={theme}
          presentation={symphonyStatusPresentation(symphony.status)}
          size={16}
        />
        <Text
          accessibilityRole="header"
          style={{
            color: theme.colors.foreground,
            fontSize: 22,
            lineHeight: 29,
            fontWeight: "600",
          }}
        >
          {symphony.title}
        </Text>
        <Text
          style={{
            color: theme.colors.foregroundMuted,
            fontSize: 12,
            lineHeight: 20,
          }}
        >
          {symphony.source.concertName} ·{" "}
          {symphony.source.branch ?? "Branch unknown"}
          {loopNote}
        </Text>
        {metrics.attemptCount > 0 && (
          <Text
            testID="symphony-detail-metrics"
            selectable
            style={{
              color: theme.colors.foregroundMuted,
              fontSize: 12,
              lineHeight: 20,
              fontVariant: ["tabular-nums"],
            }}
          >
            {[
              `${formatDuration(metrics.elapsedMs)} elapsed`,
              workTotalsLabel(metrics),
              ...(metrics.blockedMs > 0
                ? [`${formatDuration(metrics.blockedMs)} blocked`]
                : []),
              tokenTotalsLabel(metrics.tokens),
            ].join(" · ")}
          </Text>
        )}
      </View>
      <SymphonyProgress
        theme={theme}
        completedTasks={completed}
        taskCount={score.tasks.length}
        planning={planning}
        {...(planning ? {} : { segments })}
      />
      {stale && (
        <Notice theme={theme} warning>
          Symphony refresh failed. Showing the last saved state.
        </Notice>
      )}
      {symphony.execution.interruption && (
        <Notice theme={theme} warning>
          {symphony.execution.interruption}
        </Notice>
      )}
      {planning && (
        <Notice theme={theme}>
          The Conductor agent is planning this symphony. It will define tasks
          with dependencies, then dispatch task agents; tasks and reports appear
          here as agents are launched.
          {conducting?.conductorLaunch === "pending"
            ? " The Conductor agent is still being created."
            : ""}
        </Notice>
      )}
      {symphony.execution.summary && (
        <ResultSummary theme={theme} label={resultLabel} compact={compact}>
          {symphony.execution.summary}
        </ResultSummary>
      )}
      {(symphony.execution.unresolved?.length ?? 0) > 0 && (
        <View testID="symphony-unresolved" style={{ gap: 8 }}>
          <Label theme={theme}>UNRESOLVED</Label>
          <Notice theme={theme} warning>
            The symphony ended with open work the user chose not to fix:
            {"\n"}
            {symphony.execution.unresolved
              ?.map((item) => unresolvedItemLabel(item))
              .join("\n")}
          </Notice>
        </View>
      )}
      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 12,
        }}
      >
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={{ flexShrink: 1, minWidth: 0 }}
          contentContainerStyle={{ gap: 4 }}
        >
          {(["tasks", "graph", "context", "history"] as const).map((entry) => (
            <Button
              key={entry}
              theme={theme}
              variant="tab"
              label={entry.charAt(0).toUpperCase() + entry.slice(1)}
              icon={TAB_ICONS[entry]}
              selected={view === entry}
              onPress={() => setView(entry)}
            />
          ))}
        </ScrollView>
        {(openAgent && symphony.source.agentId) || deleteSymphony ? (
          <View
            style={{
              flexShrink: 1,
              minWidth: 0,
              maxWidth: "100%",
              flexDirection: "row",
              flexWrap: "wrap",
              alignItems: "flex-start",
              gap: 8,
            }}
          >
            {openAgent && symphony.source.agentId && (
              <Button
                theme={theme}
                variant="quiet"
                label="Conductor agent"
                icon="ArrowUpRight"
                onPress={() => {
                  if (symphony.source.agentId) {
                    openAgent(symphony.source.agentId);
                  }
                }}
              />
            )}
            {deleteSymphony && (
              <SymphonyDeleteAction
                theme={theme}
                symphony={symphony}
                deleteSymphony={deleteSymphony}
              />
            )}
          </View>
        ) : null}
      </View>
      {multiLoop && view !== "history" && (
        <LoopSelector
          theme={theme}
          loops={loops}
          shown={shownLoop}
          onSelect={setPickedLoop}
        />
      )}
      <SymphonyInspection
        view={view}
        theme={theme}
        symphony={view === "history" ? symphony : loopSymphony}
        context={context}
        score={view === "history" ? score : loopScore}
        compact={compact}
        {...(profiles ? { profiles } : {})}
        {...(multiLoop ? { loop: shownLoop } : {})}
        {...(openAgent ? { openAgent } : {})}
      />
      {view === "tasks" && (
        <View style={{ gap: 12 }}>
          {!score.tasks.length && !planning && (
            <Notice theme={theme}>No tasks were recorded.</Notice>
          )}
          {loopScore.tasks.map((task) => (
            <SymphonyTaskCard
              key={task.id}
              theme={theme}
              symphony={loopSymphony}
              task={task}
              profiles={profiles?.state?.profiles ?? []}
              catalog={profiles?.providers}
              compact={compact}
              {...(multiLoop ? { loop: shownLoop } : {})}
              disclosures={taskDisclosures(task.id)}
              onToggle={(selection) => toggleTask(task.id, selection)}
              {...(openAgent ? { openAgent } : {})}
            />
          ))}
        </View>
      )}
    </ScrollView>
  );
}

const PREVIEW_LINES = 3;

/** First up-to-three nonempty preview lines of summary prose. */
function previewLines(value: string): string[] {
  return value
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .slice(0, PREVIEW_LINES);
}

/**
 * The reported result in its own quiet surface: a surface1 card holding the
 * attribution heading and a clamped preview. Every clamp is a React Native truncation, so whether a
 * line overflows depends on pane width, which no character count can know —
 * therefore every nonempty result offers Show more unconditionally instead of
 * guessing. Prose that already fits reveals the same selectable text; prose
 * that clamps at any width always reaches the full content.
 */
function ResultSummary({
  theme,
  label,
  compact,
  children,
}: {
  theme: PluginTheme;
  label: string;
  /** Layout hint from the browser; defaults only for callers without layout info. */
  compact?: boolean;
  children: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const lines = previewLines(children);
  return (
    <View
      testID="symphony-result"
      style={{
        ...cardSurface(theme),
        gap: 8,
        borderColor: theme.colors.border,
        padding: 14,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <View
          aria-hidden
          accessible={false}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          <Icon
            name="MessageSquareText"
            size={14}
            color={theme.colors.foregroundMuted}
          />
        </View>
        <Label theme={theme}>{label}</Label>
      </View>
      {expanded ? (
        <Text
          selectable
          style={{
            color: theme.colors.foreground,
            fontSize: 14,
            lineHeight: 22,
            maxWidth: 760,
          }}
        >
          {children}
        </Text>
      ) : (
        <View style={{ gap: 6 }}>
          {lines.length === 0 ? (
            <Text
              selectable
              style={{
                color: theme.colors.foreground,
                fontSize: 14,
                lineHeight: 20,
                maxWidth: 760,
              }}
            >
              {children}
            </Text>
          ) : (
            lines.map((line, index) => (
              <Text
                key={index}
                numberOfLines={1}
                selectable
                style={{
                  color: theme.colors.foreground,
                  fontSize: 14,
                  lineHeight: 20,
                  maxWidth: 760,
                }}
              >
                {line}
              </Text>
            ))
          )}
          <View style={{ alignItems: "flex-start" }}>
            <Button
              theme={theme}
              variant="quiet"
              dense={!compact}
              label="Show more"
              onPress={() => setExpanded(true)}
            />
          </View>
        </View>
      )}
    </View>
  );
}
