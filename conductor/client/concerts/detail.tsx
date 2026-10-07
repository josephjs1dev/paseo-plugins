import { useState } from "react";
import { ScrollView, Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import {
  latestAttempt,
  runStatusLabel,
  type RunContext,
  type StoredRun,
} from "../../shared/concerts/models";
import { Button, Label, Notice } from "../ui/controls";
import { RunDeleteAction } from "./delete-action";
import { RunInspection } from "./inspection";
import {
  RunTaskCard,
  type TaskDisclosures,
  type TaskDisclosure,
} from "./task-card";

export function RunDetail({
  theme,
  run,
  context,
  stale,
  compact = false,
  openAgent,
  deleteRun,
}: {
  theme: PluginTheme;
  run: StoredRun;
  context: RunContext;
  stale: boolean;
  compact?: boolean;
  openAgent?: (id: string) => void;
  deleteRun?: (run: StoredRun) => Promise<void>;
}) {
  const [view, setView] = useState<"tasks" | "graph" | "context" | "history">(
    "tasks",
  );
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const graph = run.revisions.at(-1)?.graph ?? { tasks: [] };
  const orchestration = run.execution?.orchestration;
  const planning = orchestration?.phase === "planning";
  const completed = graph.tasks.filter(
    (task) => latestAttempt(run, task.id)?.state === "completed",
  ).length;
  const resultLabel =
    run.execution?.origin === "orchestrator"
      ? "RESULT · REPORTED BY THE CONDUCTOR AGENT"
      : "RESULT · REPORTED BY THE SOURCE AGENT";
  const workingNote = run.execution
    ? ` · ${completed} of ${graph.tasks.length} tasks reported complete`
    : "";
  const progressNote = planning
    ? " · Conductor agent is splitting the goal into tasks"
    : workingNote;
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
      testID="run-detail"
    >
      <Label theme={theme}>{runStatusLabel(run.status).toUpperCase()}</Label>
      <Text
        accessibilityRole="header"
        style={{
          color: theme.colors.foreground,
          fontSize: 22,
          lineHeight: 29,
          fontWeight: "600",
        }}
      >
        {run.title}
      </Text>
      <Text
        style={{
          color: theme.colors.foregroundMuted,
          fontSize: 12,
          lineHeight: 20,
        }}
      >
        {run.source.workspaceName} · {run.source.branch ?? "Branch unknown"}
        {progressNote}
      </Text>
      {stale && (
        <Notice theme={theme} warning>
          Concert refresh failed. Showing the last saved state.
        </Notice>
      )}
      {run.execution?.interruption && (
        <Notice theme={theme} warning>
          {run.execution.interruption}
        </Notice>
      )}
      {planning && (
        <Notice theme={theme}>
          The Conductor agent is planning this concert. It will define tasks
          with dependencies, then dispatch worker agents; tasks and reports
          appear here as agents are launched.
          {orchestration?.coordinatorLaunch === "pending"
            ? " The Conductor agent is still being created."
            : ""}
        </Notice>
      )}
      {run.execution?.summary && (
        <ResultSummary theme={theme} label={resultLabel}>
          {run.execution.summary}
        </ResultSummary>
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
              selected={view === entry}
              onPress={() => setView(entry)}
            />
          ))}
        </ScrollView>
        {(openAgent && run.source.agentId) || deleteRun ? (
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
            {openAgent && run.source.agentId && (
              <Button
                theme={theme}
                variant="quiet"
                label="Conductor agent"
                onPress={() => {
                  if (run.source.agentId) {
                    openAgent(run.source.agentId);
                  }
                }}
              />
            )}
            {deleteRun && (
              <RunDeleteAction theme={theme} run={run} deleteRun={deleteRun} />
            )}
          </View>
        ) : null}
      </View>
      <RunInspection
        view={view}
        theme={theme}
        run={run}
        context={context}
        graph={graph}
        compact={compact}
        {...(openAgent ? { openAgent } : {})}
      />
      {view === "tasks" && (
        <View style={{ gap: 12 }}>
          {!graph.tasks.length && !planning && (
            <Notice theme={theme}>No tasks were recorded.</Notice>
          )}
          {graph.tasks.map((task) => (
            <RunTaskCard
              key={task.id}
              theme={theme}
              run={run}
              task={task}
              compact={compact}
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

/** First up-to-three preview lines of summary prose. */
function previewLines(value: string): string[] {
  return value
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .slice(0, PREVIEW_LINES);
}

/** True when the prose continues beyond the three preview lines. */
function hasMoreLines(value: string): boolean {
  const lines = value.split("\n").filter((line) => line.trim().length > 0);
  return lines.length > PREVIEW_LINES;
}

function ResultSummary({
  theme,
  label,
  children,
}: {
  theme: PluginTheme;
  label: string;
  children: string;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <View style={{ gap: 8 }}>
      <Label theme={theme}>{label}</Label>
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
          {previewLines(children).map((line, index) => (
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
          ))}
          {hasMoreLines(children) && (
            <Button
              theme={theme}
              variant="quiet"
              dense
              label="Show more"
              onPress={() => setExpanded(true)}
            />
          )}
        </View>
      )}
    </View>
  );
}
