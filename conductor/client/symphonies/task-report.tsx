import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import type {
  FailureNeed,
  TaskDiagnosis,
  TaskReport,
} from "../../shared/symphonies/models";

/** Readable line length for task prose in cards and report panels. */
export const PROSE_WIDTH = 760;

export type StateColor =
  | "foregroundMuted"
  | "accent"
  | "statusWarning"
  | "statusSuccess"
  | "statusDanger";

/**
 * Card footer: a hairline divider, the Evidence/Checks toggle row (at most one
 * panel open), and the open panel rendered as an inset surface.
 */
export function ReportFooter({
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
  const [diagnosisOpen, setDiagnosisOpen] = useState(false);
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
            testID={`symphony-task-evidence-${taskId}`}
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
            testID={`symphony-task-checks-${taskId}`}
            dense={!compact}
          />
        )}
        {report.diagnosis && (
          <FooterToggle
            theme={theme}
            label="Diagnosis"
            danger
            expanded={diagnosisOpen}
            onToggle={() => setDiagnosisOpen((open) => !open)}
            testID={`symphony-task-diagnosis-${taskId}`}
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
      {diagnosisOpen && report.diagnosis && (
        <InsetPanel theme={theme}>
          <DiagnosisPanel theme={theme} diagnosis={report.diagnosis} />
        </InsetPanel>
      )}
    </View>
  );
}

/** What each structured failure `need` value asks the Conductor to do. */
const NEED_ACTIONS: Record<FailureNeed, string> = {
  scope: "Needs wider write scope",
  input: "Needs user input",
  model: "Needs a different profile or model",
  none: "Needs a direction to continue",
};

/**
 * A failed report's task agent self-diagnosis: fix rounds tried, the suspected
 * cause, what the task agent needs next, and the write paths it requested when
 * it ran out of scope. Sections with nothing to say are skipped.
 */
export function DiagnosisPanel({
  theme,
  diagnosis,
}: {
  theme: PluginTheme;
  diagnosis: TaskDiagnosis;
}) {
  const labelStyle = {
    fontSize: 12,
    lineHeight: 17,
    fontWeight: "600",
  } as const;
  return (
    <View style={{ gap: 8 }}>
      <View style={{ gap: 4 }}>
        <Text style={{ color: theme.colors.foregroundMuted, ...labelStyle }}>
          Tried
        </Text>
        {diagnosis.tried.map((entry, index) => (
          <Text
            key={index}
            selectable
            style={{
              color: theme.colors.foreground,
              fontSize: 13,
              lineHeight: 20,
              maxWidth: PROSE_WIDTH,
            }}
          >
            {`${index + 1}. ${entry}`}
          </Text>
        ))}
      </View>
      <View style={{ gap: 4 }}>
        <Text style={{ color: theme.colors.foregroundMuted, ...labelStyle }}>
          Suspected cause
        </Text>
        <Text
          selectable
          style={{
            color: theme.colors.foreground,
            fontSize: 13,
            lineHeight: 20,
            maxWidth: PROSE_WIDTH,
          }}
        >
          {diagnosis.suspectedCause}
        </Text>
      </View>
      <View style={{ gap: 4 }}>
        <Text style={{ color: theme.colors.foregroundMuted, ...labelStyle }}>
          Need
        </Text>
        <Text
          selectable
          style={{
            color: theme.colors.statusDanger,
            fontSize: 13,
            lineHeight: 20,
          }}
        >
          {NEED_ACTIONS[diagnosis.need]}
        </Text>
        {diagnosis.requestedWrites?.map((path) => (
          <Text
            key={path}
            selectable
            style={{
              color: theme.colors.foreground,
              fontSize: 13,
              lineHeight: 20,
              maxWidth: PROSE_WIDTH,
            }}
          >
            {path}
          </Text>
        ))}
      </View>
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
export function InsetPanel({
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
