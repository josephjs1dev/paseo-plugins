import { useState } from "react";
import { ScrollView, Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import {
  latestAttempt,
  symphonyStatusLabel,
  type SymphonyContext,
  type StoredSymphony,
} from "../../shared/symphonies/models";
import { Button, Label, Notice } from "../ui/controls";
import { SymphonyDeleteAction } from "./delete-action";
import { SymphonyInspection } from "./inspection";
import {
  SymphonyTaskCard,
  type TaskDisclosures,
  type TaskDisclosure,
} from "./task-card";

export function SymphonyDetail({
  theme,
  symphony,
  context,
  stale,
  compact = false,
  openAgent,
  deleteSymphony,
}: {
  theme: PluginTheme;
  symphony: StoredSymphony;
  context: SymphonyContext;
  stale: boolean;
  compact?: boolean;
  openAgent?: (id: string) => void;
  deleteSymphony?: (symphony: StoredSymphony) => Promise<void>;
}) {
  const [view, setView] = useState<"tasks" | "graph" | "context" | "history">(
    "tasks",
  );
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const score = symphony.revisions.at(-1)?.score ?? { tasks: [] };
  const conducting = symphony.execution.conducting;
  const planning = conducting?.phase === "planning";
  const completed = score.tasks.filter(
    (task) => latestAttempt(symphony, task.id)?.state === "completed",
  ).length;
  const resultLabel =
    symphony.execution.origin === "conducted"
      ? "RESULT · REPORTED BY THE CONDUCTOR AGENT"
      : "RESULT · REPORTED BY THE SOURCE AGENT";
  const progressNote = planning
    ? " · Conductor agent is splitting the goal into tasks"
    : ` · ${completed} of ${score.tasks.length} tasks reported complete`;
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
      <Label theme={theme}>
        {symphonyStatusLabel(symphony.status).toUpperCase()}
      </Label>
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
        {progressNote}
      </Text>
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
        <ResultSummary theme={theme} label={resultLabel}>
          {symphony.execution.summary}
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
      <SymphonyInspection
        view={view}
        theme={theme}
        symphony={symphony}
        context={context}
        score={score}
        compact={compact}
        {...(openAgent ? { openAgent } : {})}
      />
      {view === "tasks" && (
        <View style={{ gap: 12 }}>
          {!score.tasks.length && !planning && (
            <Notice theme={theme}>No tasks were recorded.</Notice>
          )}
          {score.tasks.map((task) => (
            <SymphonyTaskCard
              key={task.id}
              theme={theme}
              symphony={symphony}
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
