import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { taskState, type TaskStateKey } from "../shared/run-task-state";
import type { PluginTheme } from "@getpaseo/plugin";
import {
  latestAttempt,
  type StoredRun,
  type TaskDefinition,
  type TaskReport,
} from "../shared/run-models";
import { Button, Disclosure, Notice } from "./controls";

const PROSE_WIDTH = 760;

/**
 * Which details a card currently reveals. Owned by RunDetail so state survives
 * ordinary run refreshes and resets when the run identity changes.
 */
export interface TaskDisclosures {
  readonly summary?: boolean;
  readonly instructions?: boolean;
  readonly evidence?: boolean;
  readonly checks?: boolean;
}

/**
 * A card's independently toggled details. Evidence and Checks are exclusive:
 * at most one inset panel is open per card, while the summary and instructions
 * toggles stay independent.
 */
export type TaskDisclosure = "summary" | "instructions" | "evidence" | "checks";

type StateColor =
  | "foregroundMuted"
  | "accent"
  | "statusWarning"
  | "statusSuccess"
  | "statusDanger";

const STATE_COLORS: Record<TaskStateKey, StateColor> = {
  ready: "foregroundMuted",
  waiting: "foregroundMuted",
  running: "accent",
  blocked: "statusWarning",
  finishing: "statusWarning",
  failed: "statusDanger",
  completed: "statusSuccess",
};

/**
 * Full task brief shown behind the Instructions disclosure: the assignment,
 * then the bounds that tell a worker where to stop.
 */
function instructionLines(task: TaskDefinition): string[] {
  const lines: string[] = [task.outcome];
  if (task.criteria.length) {
    lines.push(`Success criteria: ${task.criteria.join("; ")}`);
  }
  if (task.checks.length) {
    lines.push(`Planned checks: ${task.checks.join("; ")}`);
  }
  if (task.reads.length) {
    lines.push(`Reads: ${task.reads.join(", ")}`);
  }
  if (task.writes.length) {
    lines.push(`Writes: ${task.writes.join(", ")}`);
  }
  lines.push(`Worker profile: ${task.worker.profile}`);
  lines.push(`Stop when: ${task.stopWhen}`);
  return lines;
}

/**
 * True when the summary is likely longer than a three-line clamp, since React
 * Native offers no reliable truncation callback across renderers.
 */
function summaryMayClamp(summary: string): boolean {
  return summary.length > 240 || summary.includes("\n");
}

/**
 * One trimmed task record: wrapping title with the agent action, a single
 * metadata line with a status dot, a three-line summary clamp, and a footer
 * that keeps Evidence and Checks behind one inset panel. Blocker messages and
 * failed checks stay visible without expanding anything.
 */
export function RunTaskCard({
  theme,
  run,
  task,
  compact = false,
  disclosures,
  onToggle,
  openAgent,
}: {
  theme: PluginTheme;
  run: StoredRun;
  task: TaskDefinition;
  compact?: boolean;
  disclosures?: TaskDisclosures;
  onToggle?: (selection: TaskDisclosure) => void;
  openAgent?: (id: string) => void;
}) {
  const attempt = latestAttempt(run, task.id);
  const state = taskState(run, task);
  const report = attempt?.report ?? null;
  const failedChecks =
    report?.checks.filter((check) => check.status === "failed") ?? [];
  const canOpenAgent = Boolean(
    openAgent &&
      attempt &&
      attempt.agentId &&
      attempt.launch?.state !== "failed",
  );
  return (
    <View
      testID={`run-task-${task.id}`}
      style={{
        gap: 8,
        padding: compact ? 12 : 16,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 8,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <Text
          accessibilityRole="header"
          style={{
            color: theme.colors.foreground,
            fontSize: 15,
            lineHeight: 21,
            fontWeight: "600",
            flexShrink: 1,
          }}
        >
          {task.title}
        </Text>
        {canOpenAgent && (
          <Button
            theme={theme}
            variant="quiet"
            dense={!compact}
            label="Open agent"
            accessibilityLabel={`Open ${task.id} agent`}
            onPress={() => {
              if (attempt) {
                openAgent?.(attempt.agentId);
              }
            }}
          />
        )}
      </View>
      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 6,
        }}
      >
        <View
          aria-hidden
          style={{
            width: 6,
            height: 6,
            borderRadius: 3,
            backgroundColor: theme.colors[STATE_COLORS[state.key]],
          }}
        />
        <Text
          selectable
          style={{
            color: theme.colors[STATE_COLORS[state.key]],
            fontSize: 12,
            lineHeight: 17,
            fontWeight: "500",
          }}
        >
          {state.label}
          {state.waitingFor.length
            ? ` · waiting for ${state.waitingFor.join(", ")}`
            : ""}
        </Text>
        <Text
          style={{
            color: theme.colors.foregroundMuted,
            fontSize: 12,
            lineHeight: 17,
            fontVariant: ["tabular-nums"],
          }}
        >
          {`· ${task.id}`}
        </Text>
      </View>
      {report?.summary && (
        <Summary
          theme={theme}
          summary={report.summary}
          compact={compact}
          expanded={disclosures?.summary === true}
          onToggle={() => onToggle?.("summary")}
        />
      )}
      {failedChecks.map((check) => (
        <Text
          key={check.name}
          selectable
          numberOfLines={2}
          ellipsizeMode="tail"
          style={{
            color: theme.colors.statusDanger,
            fontSize: 13,
            lineHeight: 20,
          }}
        >
          {`✕ ${check.name}: ${check.detail}`}
        </Text>
      ))}
      {attempt?.message && (
        <Notice theme={theme} warning>
          {attempt.message}
        </Notice>
      )}
      {report === null && (
        <InstructionPreview
          task={task}
          theme={theme}
          compact={compact}
          expanded={disclosures?.instructions === true}
          onToggle={() => onToggle?.("instructions")}
        />
      )}
      {report && (
        <ReportFooter
          theme={theme}
          taskId={task.id}
          report={report}
          compact={compact}
          evidenceOpen={disclosures?.evidence === true}
          checksOpen={disclosures?.checks === true}
          onToggle={(selection) => onToggle?.(selection)}
        />
      )}
    </View>
  );
}

/**
 * Report prose clamped to three lines by default. The toggle appears only when
 * the text likely overflows the clamp; its expanded state lives in RunDetail's
 * disclosure map so it survives refreshes.
 */
function Summary({
  theme,
  summary,
  compact,
  expanded,
  onToggle,
}: {
  theme: PluginTheme;
  summary: string;
  compact: boolean;
  expanded: boolean;
  onToggle(this: void): void;
}) {
  return (
    <View style={{ gap: 4, maxWidth: PROSE_WIDTH }}>
      <Text
        selectable
        numberOfLines={expanded ? undefined : 3}
        ellipsizeMode="tail"
        style={{
          color: theme.colors.foreground,
          fontSize: 14,
          lineHeight: 21,
          maxWidth: PROSE_WIDTH,
        }}
      >
        {summary}
      </Text>
      {summaryMayClamp(summary) && (
        <Button
          theme={theme}
          variant="quiet"
          dense={!compact}
          label={expanded ? "Show less" : "Show more"}
          onPress={onToggle}
        />
      )}
    </View>
  );
}

/**
 * Card footer: a hairline divider, the Evidence/Checks toggle row (at most one
 * panel open), and the open panel rendered as an inset surface.
 */
function ReportFooter({
  theme,
  taskId,
  report,
  compact,
  evidenceOpen,
  checksOpen,
  onToggle,
}: {
  theme: PluginTheme;
  taskId: string;
  report: TaskReport;
  compact: boolean;
  evidenceOpen: boolean;
  checksOpen: boolean;
  onToggle(this: void, selection: "evidence" | "checks"): void;
}) {
  const failedChecks = report.checks.filter(
    (check) => check.status === "failed",
  ).length;
  const passedChecks = report.checks.filter(
    (check) => check.status === "passed",
  ).length;
  const checksLabel = `Checks ${passedChecks}/${report.checks.length} passed${
    failedChecks ? ` · ${failedChecks} failed` : ""
  }`;
  return (
    <View
      style={{
        borderTopWidth: 1,
        borderTopColor: theme.colors.border,
        paddingTop: 8,
        gap: 8,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          alignItems: "center",
          columnGap: 16,
          rowGap: 4,
        }}
      >
        {report.evidence.length > 0 && (
          <FooterToggle
            theme={theme}
            label={`Evidence ${report.evidence.length}`}
            expanded={evidenceOpen}
            onToggle={() => onToggle("evidence")}
            testID={`run-task-evidence-${taskId}`}
            dense={!compact}
          />
        )}
        {report.checks.length > 0 && (
          <FooterToggle
            theme={theme}
            label={checksLabel}
            danger={failedChecks > 0}
            expanded={checksOpen}
            onToggle={() => onToggle("checks")}
            testID={`run-task-checks-${taskId}`}
            dense={!compact}
          />
        )}
      </View>
      {evidenceOpen && (
        <InsetPanel theme={theme}>
          <EvidencePanel theme={theme} evidence={report.evidence} />
        </InsetPanel>
      )}
      {checksOpen && (
        <InsetPanel theme={theme}>
          <ChecksPanel theme={theme} checks={report.checks} />
        </InsetPanel>
      )}
    </View>
  );
}

/**
 * Footer disclosure toggle. Matches the shared Disclosure control (chevron,
 * focus ring, 44px compact touch target, aria-expanded) and can render its
 * label in the danger color, which the Checks toggle needs when a check failed.
 */
function FooterToggle({
  theme,
  label,
  expanded,
  onToggle,
  testID,
  dense,
  danger = false,
}: {
  theme: PluginTheme;
  label: string;
  expanded: boolean;
  onToggle(this: void): void;
  testID: string;
  dense: boolean;
  danger?: boolean;
}) {
  const [focused, setFocused] = useState(false);
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ expanded }}
      aria-expanded={expanded}
      onPress={onToggle}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        minHeight: dense ? 36 : 44,
        paddingVertical: 4,
        paddingHorizontal: 8,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: focused ? theme.colors.foreground : "transparent",
        opacity: pressed ? 0.8 : 1,
        alignSelf: "flex-start",
      })}
    >
      <Text
        aria-hidden
        style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}
      >
        {expanded ? "▾" : "▸"}
      </Text>
      <Text
        style={{
          color: danger ? theme.colors.statusDanger : theme.colors.foreground,
          fontSize: 13,
          lineHeight: 18,
          fontWeight: "600",
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * Inset surface for revealed details: surface1 background, a hairline border,
 * radius 6, and 12 padding, rendered at the full card width.
 */
function InsetPanel({
  theme,
  children,
}: {
  theme: PluginTheme;
  children: React.ReactNode;
}) {
  return (
    <View
      style={{
        backgroundColor: theme.colors.surface1,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 6,
        padding: 12,
      }}
    >
      {children}
    </View>
  );
}

/**
 * Indexed evidence rows separated by hairlines. Each row is clamped to four
 * lines and expands on press so a long entry never dominates the card.
 */
function EvidencePanel({
  theme,
  evidence,
}: {
  theme: PluginTheme;
  evidence: string[];
}) {
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());
  const toggle = (index: number) =>
    setExpanded((prior) => {
      const next = new Set(prior);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  return evidence.map((entry, index) => {
    const isExpanded = expanded.has(index);
    return (
      <Pressable
        key={index}
        accessibilityRole="button"
        accessibilityLabel={`Evidence row ${index + 1}`}
        accessibilityState={{ expanded: isExpanded }}
        onPress={() => toggle(index)}
        style={{
          flexDirection: "row",
          gap: 8,
          paddingVertical: 6,
          borderTopWidth: index > 0 ? 1 : 0,
          borderTopColor: theme.colors.border,
        }}
      >
        <Text
          style={{
            color: theme.colors.foregroundMuted,
            fontSize: 13,
            lineHeight: 20,
            fontVariant: ["tabular-nums"],
          }}
        >
          {index + 1}
        </Text>
        <Text
          selectable
          numberOfLines={isExpanded ? undefined : 4}
          ellipsizeMode="tail"
          style={{
            color: theme.colors.foreground,
            fontSize: 13,
            lineHeight: 20,
            maxWidth: PROSE_WIDTH - 24,
            flexShrink: 1,
          }}
        >
          {entry}
        </Text>
      </Pressable>
    );
  });
}

/**
 * One row per check, failed checks included: a glyph plus status word, then
 * the check name in 600 weight and its detail in muted prose.
 */
function ChecksPanel({
  theme,
  checks,
}: {
  theme: PluginTheme;
  checks: TaskReport["checks"];
}) {
  const META: Record<
    TaskReport["checks"][number]["status"],
    { glyph: string; word: string; color: StateColor }
  > = {
    passed: { glyph: "✓", word: "Passed", color: "statusSuccess" },
    failed: { glyph: "✕", word: "Failed", color: "statusDanger" },
    "not-run": { glyph: "–", word: "Not run", color: "foregroundMuted" },
  };
  return checks.map((check, index) => {
    const meta = META[check.status];
    return (
      <View
        key={`${check.name}-${index}`}
        style={{
          paddingVertical: 6,
          borderTopWidth: index > 0 ? 1 : 0,
          borderTopColor: theme.colors.border,
          gap: 2,
        }}
      >
        <Text
          selectable
          style={{
            color: theme.colors[meta.color],
            fontSize: 13,
            lineHeight: 20,
            fontWeight: "600",
          }}
        >
          {`${meta.glyph} ${meta.word}`}
        </Text>
        <Text
          selectable
          style={{
            color: theme.colors.foreground,
            fontSize: 13,
            lineHeight: 20,
            fontWeight: "600",
            maxWidth: PROSE_WIDTH,
          }}
        >
          {check.name}
        </Text>
        <Text
          selectable
          style={{
            color: theme.colors.foregroundMuted,
            fontSize: 13,
            lineHeight: 20,
            maxWidth: PROSE_WIDTH,
          }}
        >
          {check.detail}
        </Text>
      </View>
    );
  });
}

const INSTRUCTIONS_LABEL = "Instructions";

/**
 * Assignment preview when no report exists: at most three visible lines above
 * the footer, whose disclosure reveals the full selectable brief in the same
 * inset panel Evidence and Checks use.
 */
function InstructionPreview({
  task,
  theme,
  compact,
  expanded,
  onToggle,
}: {
  task: TaskDefinition;
  theme: PluginTheme;
  compact: boolean;
  expanded: boolean;
  onToggle(this: void): void;
}) {
  const lines = instructionLines(task);
  return (
    <View style={{ gap: 8 }}>
      {lines.length > 0 && (
        <Text
          numberOfLines={3}
          ellipsizeMode="tail"
          style={{
            color: theme.colors.foregroundMuted,
            fontSize: 13,
            lineHeight: 21,
            maxWidth: PROSE_WIDTH,
          }}
        >
          {lines.join("\n")}
        </Text>
      )}
      <View
        style={{
          borderTopWidth: 1,
          borderTopColor: theme.colors.border,
          paddingTop: 8,
          gap: 8,
        }}
      >
        <Disclosure
          theme={theme}
          label={INSTRUCTIONS_LABEL}
          expanded={expanded}
          onToggle={onToggle}
          testID={`run-task-instructions-${task.id}`}
          dense={!compact}
        />
        {expanded && (
          <InsetPanel theme={theme}>
            {lines.map((line, index) => (
              <Text
                key={index}
                selectable
                style={{
                  color: theme.colors.foreground,
                  fontSize: 13,
                  lineHeight: 21,
                  maxWidth: PROSE_WIDTH,
                }}
              >
                {line}
              </Text>
            ))}
          </InsetPanel>
        )}
      </View>
    </View>
  );
}
