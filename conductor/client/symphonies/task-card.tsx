import { useState } from "react";
import { Text, View } from "react-native";
import {
  taskState,
  type TaskStateKey,
} from "../../shared/symphonies/task-state";
import type { PluginTheme } from "@getpaseo/plugin";
import {
  latestAttempt,
  type GrantedWrite,
  type StoredSymphony,
  type TaskDefinition,
} from "../../shared/symphonies/models";
import { Button, Disclosure, Notice } from "../ui/controls";
import {
  InsetPanel,
  PROSE_WIDTH,
  ReportFooter,
  type StateColor,
} from "./task-report";

/**
 * Which details a card currently reveals. Owned by SymphonyDetail so state survives
 * ordinary symphony refreshes and resets when the symphony identity changes.
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
 * then the bounds that tell a task agent where to stop.
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
  const { provider, model, thinkingOptionId } = task.worker;
  const inline = [
    [provider, model].filter(Boolean).join("/"),
    thinkingOptionId ? `thinking ${thinkingOptionId}` : "",
  ].filter(Boolean);
  lines.push(
    inline.length
      ? `Task agent: ${inline.join(", ")}`
      : `Task agent profile: ${task.worker.profile}`,
  );
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
export function SymphonyTaskCard({
  theme,
  symphony,
  task,
  compact = false,
  disclosures,
  onToggle,
  openAgent,
}: {
  theme: PluginTheme;
  symphony: StoredSymphony;
  task: TaskDefinition;
  compact?: boolean;
  disclosures?: TaskDisclosures;
  onToggle?: (selection: TaskDisclosure) => void;
  openAgent?: (id: string) => void;
}) {
  const attempt = latestAttempt(symphony, task.id);
  const state = taskState(symphony, task);
  const report = attempt?.report ?? null;
  const failedChecks =
    report?.checks.filter((check) => check.status === "failed") ?? [];
  const agentAttempts = attempt
    ? symphony.execution.attempts.filter(
        (entry) =>
          entry.taskId === task.id && entry.agentId === attempt.agentId,
      ).length
    : 0;
  const grantedWrites = attempt?.grantedWrites ?? [];
  const canOpenAgent = Boolean(
    openAgent &&
      attempt &&
      attempt.agentId &&
      attempt.launch?.state !== "failed",
  );
  return (
    <View
      testID={`symphony-task-${task.id}`}
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
        {agentAttempts > 1 && (
          <Text
            style={{
              color: theme.colors.foregroundMuted,
              fontSize: 12,
              lineHeight: 17,
            }}
          >
            {`· same agent across ${agentAttempts} attempts`}
          </Text>
        )}
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
      {grantedWrites.length > 0 && attempt && (
        <GrantedWritesRow
          theme={theme}
          taskId={task.id}
          grantedWrites={grantedWrites}
          compact={compact}
        />
      )}
    </View>
  );
}

/**
 * Server-widened write paths recorded on the attempt, each with the reason the
 * task agent gave when it was granted. Visible with or without a report, because a
 * running attempt can already hold grants.
 */
function GrantedWritesRow({
  theme,
  taskId,
  grantedWrites,
  compact,
}: {
  theme: PluginTheme;
  taskId: string;
  grantedWrites: GrantedWrite[];
  compact: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
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
        label={`Granted writes ${grantedWrites.length}`}
        expanded={expanded}
        onToggle={() => setExpanded((open) => !open)}
        testID={`symphony-task-granted-${taskId}`}
        dense={!compact}
      />
      {expanded && (
        <InsetPanel theme={theme}>
          {grantedWrites.map((grant, index) => (
            <View
              key={`${grant.path}-${index}`}
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
                  color: theme.colors.foreground,
                  fontSize: 13,
                  lineHeight: 20,
                  fontWeight: "600",
                  maxWidth: PROSE_WIDTH,
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
                  maxWidth: PROSE_WIDTH,
                }}
              >
                {grant.reason}
              </Text>
            </View>
          ))}
        </InsetPanel>
      )}
    </View>
  );
}

/**
 * Report prose clamped to three lines by default. The toggle appears only when
 * the text likely overflows the clamp; its expanded state lives in SymphonyDetail's
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
          testID={`symphony-task-instructions-${task.id}`}
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
