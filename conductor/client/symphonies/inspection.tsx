import { useState } from "react";
import { Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import {
  attemptNumber,
  taskAttempts,
  type Attempt,
  type LoopRecord,
  type SymphonyContext,
  type Score,
  type StoredSymphony,
  type TaskDefinition,
  type TaskFinding,
} from "../../shared/symphonies/models";
import {
  taskState,
  type TaskStateKey,
} from "../../shared/symphonies/task-state";
import { attemptLoop } from "../../shared/symphonies/score";
import {
  attemptMetrics,
  type DurationTotals,
  type TokenSum,
  type TokenTotals,
} from "../../shared/symphonies/metrics";
import {
  groupedTaskState,
  hasLoopGroups,
  historyLoops,
  loopRecord,
  loopVerdictLabel,
  unresolvedItemLabel,
  type HistoryLoopGroup,
} from "./history";
import { Button, Disclosure, Label, Notice, rowStyle } from "../ui/controls";
import { ScoreView } from "./graph";
import type { ProfilesData } from "./profiles";
import {
  launchWorker,
  overrideLine,
  reopenWorker,
  routingLine,
  shortRevision,
  warningLine,
  workerSelection,
} from "./routing";
import { DiagnosisPanel, FindingsPanel, InsetPanel } from "./task-report";

export function SymphonyInspection({
  view,
  theme,
  symphony,
  context,
  score,
  compact = false,
  loop,
  openAgent,
  profiles,
}: {
  view: string;
  theme: PluginTheme;
  symphony: StoredSymphony;
  context: SymphonyContext;
  score: Score;
  /** Layout hint carried to the graph; defaults only because the chain may lack layout info. */
  compact?: boolean;
  /** The loop the Tasks, Graph and Context tabs show, when there are several. */
  loop?: number;
  openAgent?: (id: string) => void;
  /** Worker profiles and provider catalog; the graph node identity reads them. */
  profiles?: ProfilesData;
}) {
  const record = loop ? loopRecord(symphony, loop) : undefined;
  return (
    <>
      {view === "context" && (
        <>
          {record && <LoopContext theme={theme} record={record} />}
          {record && <Label theme={theme}>GOAL</Label>}
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
            Select a task to inspect its relationships below the score; its Open
            agent action there opens the task agent when one is running.
          </Text>
          <ScoreView
            theme={theme}
            symphony={symphony}
            score={score}
            compact={compact}
            profiles={profiles?.state?.profiles}
            catalog={profiles?.providers}
            {...(openAgent ? { openAgent } : {})}
          />
        </>
      )}
    </>
  );
}

/**
 * Why the Conductor started a later loop: its reason, each reopened task with
 * the findings it must fix and any note, appended tasks, deferred items, and
 * the user's recorded answer when the loop went past the budget.
 */
function LoopContext({
  theme,
  record,
}: {
  theme: PluginTheme;
  record: LoopRecord;
}) {
  const body = {
    color: theme.colors.foreground,
    fontSize: 13,
    lineHeight: 20,
  } as const;
  const muted = { ...body, color: theme.colors.foregroundMuted } as const;
  return (
    <View testID={`loop-context-${record.number}`} style={{ gap: 8 }}>
      <Label theme={theme}>{`WHY LOOP ${record.number} STARTED`}</Label>
      <Text selectable style={body}>
        {record.reason}
      </Text>
      {record.reopened.map((reopen) => {
        const findings = reopen.resolved?.length
          ? reopen.resolved.map(
              (finding) => `${finding.id}: ${finding.summary}`,
            )
          : reopen.findings;
        return (
          <View key={reopen.taskId} style={{ gap: 2 }}>
            <Text selectable style={{ ...body, fontWeight: "600" }}>
              {`Reopened ${reopen.taskId}`}
              {reopen.after?.length
                ? ` · after ${reopen.after.join(", ")}`
                : ""}
            </Text>
            {findings.map((line) => (
              <Text key={line} selectable style={muted}>
                {`• ${line}`}
              </Text>
            ))}
            {reopen.note && (
              <Text selectable style={muted}>
                {`Note: ${reopen.note}`}
              </Text>
            )}
            {reopen.worker && (
              <Text
                selectable
                testID={`loop-reopen-worker-${reopen.taskId}`}
                style={muted}
              >
                {reopen.routing
                  ? routingLine(reopen.routing, reopenWorker(reopen.worker))
                  : `Worker: ${workerSelection(reopen.worker)}`}
              </Text>
            )}
            {reopen.routing?.override && (
              <Text selectable style={muted}>
                {overrideLine(reopen.routing)}
              </Text>
            )}
            {(reopen.warnings?.length ?? 0) > 0 &&
              (reopen.warnings ?? []).map((warning, index) => (
                <Text
                  key={`${warning.code}-${index}`}
                  selectable
                  style={{ ...muted, color: theme.colors.statusWarning }}
                >
                  {warningLine(warning)}
                </Text>
              ))}
          </View>
        );
      })}
      {record.added.length > 0 && (
        <Text selectable style={muted}>
          {`Added tasks: ${record.added.join(", ")}`}
        </Text>
      )}
      {record.deferred.map((item, index) => (
        <Text
          key={`${item.finding ?? item.taskId}-${index}`}
          selectable
          style={muted}
        >
          {`Deferred: ${unresolvedItemLabel(item)}`}
        </Text>
      ))}
      {record.approval && (
        <Text selectable style={muted}>
          {`User approved loop ${record.approval.loops}: "${record.approval.userAnswer}"`}
        </Text>
      )}
    </View>
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
  "needs-changes": "statusWarning",
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
  return (
    <View style={{ gap: 4 }}>
      <Label theme={theme}>HISTORY</Label>
      <HistoryBody
        theme={theme}
        symphony={symphony}
        {...(openAgent ? { openAgent } : {})}
      />
    </View>
  );
}

/**
 * When the symphony ran more than one loop, the body groups every attempt by
 * loop with a verdict header per loop; otherwise it keeps the compact flat
 * sections a single-loop symphony always had.
 */
function HistoryBody({
  theme,
  symphony,
  openAgent,
}: {
  theme: PluginTheme;
  symphony: StoredSymphony;
  openAgent?: (id: string) => void;
}) {
  const tasks = symphony.revisions.at(-1)?.score.tasks ?? [];
  if (!tasks.length) {
    return <Notice theme={theme}>No task attempts yet.</Notice>;
  }
  if (hasLoopGroups(symphony)) {
    return (
      <View style={{ gap: 12 }}>
        {historyLoops(symphony).map((group) => {
          const loopTasks = tasks.filter((task) =>
            group.attempts.some((attempt) => attempt.taskId === task.id),
          );
          return (
            <View
              key={group.loop}
              testID={`history-loop-${group.loop}`}
              style={{
                gap: 4,
                paddingTop: 8,
                borderTopWidth: 1,
                borderTopColor: theme.colors.border,
              }}
            >
              <LoopHeader theme={theme} group={group} />
              <View style={{ gap: 4 }}>
                {loopTasks.map((task) => (
                  <TaskHistory
                    key={task.id}
                    theme={theme}
                    symphony={symphony}
                    task={task}
                    attempts={group.attempts.filter(
                      (attempt) => attempt.taskId === task.id,
                    )}
                    grouped
                    {...(openAgent ? { openAgent } : {})}
                  />
                ))}
              </View>
            </View>
          );
        })}
      </View>
    );
  }
  return (
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
  );
}

/** Display hue for a loop header's verdict; this file's own state palette. */
export function loopVerdictColor(group: HistoryLoopGroup): StateColorName {
  if (group.running) {
    return "accent";
  }
  if (group.verdict === "attention") {
    return "statusDanger";
  }
  return group.verdict === "succeeded" ? "statusSuccess" : "statusWarning";
}

/**
 * One loop's History header: the loop number, its verdict, and the Conductor
 * facts stored on the loop record — the reopen reason, the user's recorded
 * answer when the loop went past the budget, and deferred sections.
 */
function LoopHeader({
  theme,
  group,
}: {
  theme: PluginTheme;
  group: HistoryLoopGroup;
}) {
  const color = theme.colors[loopVerdictColor(group)];
  const verdict = loopVerdictLabel(group);
  const muted = {
    color: theme.colors.foregroundMuted,
    fontSize: 12,
    lineHeight: 17,
  } as const;
  return (
    <View style={{ gap: 2 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Text
          selectable
          style={{
            color: theme.colors.foreground,
            fontSize: 13,
            lineHeight: 18,
            fontWeight: "600",
          }}
        >
          {`Loop ${group.loop}`}
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
          style={{ color, fontSize: 12, lineHeight: 17, fontWeight: "500" }}
        >
          {verdict}
        </Text>
      </View>
      {group.reason && (
        <Text
          selectable
          testID={`history-loop-reason-${group.loop}`}
          numberOfLines={2}
          ellipsizeMode="tail"
          style={muted}
        >
          {`Reopened because: ${group.reason}`}
        </Text>
      )}
      {group.approval && (
        <Text
          selectable
          testID={`history-loop-approval-${group.loop}`}
          numberOfLines={2}
          ellipsizeMode="tail"
          style={muted}
        >
          {`User approved loop ${group.approval.loops}: "${group.approval.userAnswer}"`}
        </Text>
      )}
      {group.deferred.map((item, index) => (
        <Text
          key={`${item.label}-${index}`}
          selectable
          numberOfLines={2}
          ellipsizeMode="tail"
          style={muted}
        >
          {`Deferred: ${item.label} — ${item.reason}`}
        </Text>
      ))}
    </View>
  );
}

/**
 * One task's history: its current state when idle, else its attempts oldest
 * first. With `attempts` and `grouped`, the same rows render for one loop
 * group instead, whose header speaks for that loop's last attempt so a
 * historical loop never inherits the task's newer state.
 */
function TaskHistory({
  theme,
  symphony,
  task,
  openAgent,
  attempts: attemptOverride,
  grouped = false,
}: {
  theme: PluginTheme;
  symphony: StoredSymphony;
  task: TaskDefinition;
  openAgent?: (id: string) => void;
  attempts?: readonly Attempt[];
  grouped?: boolean;
}) {
  const attempts = attemptOverride ?? taskAttempts(symphony, task.id);
  const testId =
    grouped && attempts[0]
      ? `history-task-${task.id}-loop-${attemptLoop(attempts[0])}`
      : `history-task-${task.id}`;
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
  const lastAttempt = attempts.at(-1);
  // A loop group states its own last attempt's outcome; the ungrouped view
  // keeps the task's overall display state.
  const stateKey =
    grouped && lastAttempt
      ? groupedTaskState(lastAttempt)
      : taskState(symphony, task).key;
  const stateColor = theme.colors[HISTORY_STATE_COLORS[stateKey]];
  return (
    <View
      testID={testId}
      style={{
        borderTopWidth: 1,
        borderTopColor: theme.colors.border,
        paddingVertical: 4,
        gap: 2,
      }}
    >
      {(retried || grouped) && lastAttempt && (
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
            {ATTEMPT_STATE_LABELS[stateKey]}
          </Text>
          {retried && (
            <Text
              style={{
                color: theme.colors.foregroundMuted,
                fontSize: 12,
                lineHeight: 17,
              }}
            >
              {attemptCountLabel(attempts.length)}
            </Text>
          )}
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
          forceNumber={grouped}
          previousAgentId={index > 0 ? attempts[index - 1]?.agentId : undefined}
          {...(openAgent ? { openAgent } : {})}
        />
      ))}
    </View>
  );
}

/**
 * One attempt row with its number, start time, duration, and token usage. A
 * task's only attempt renders as the task row itself, so it carries the task
 * ID before "Attempt 1"; a retried task labels each row "Attempt N" and says
 * how the retry ran ("retry · same agent" or "retry · new agent"). Scope
 * changes and the diagnosis appear beneath.
 */
function AttemptRow({
  theme,
  symphony,
  task,
  attempt,
  number,
  retried,
  forceNumber = false,
  previousAgentId,
  openAgent,
}: {
  theme: PluginTheme;
  symphony: StoredSymphony;
  task: TaskDefinition;
  attempt: Attempt;
  number: number;
  retried: boolean;
  /** Number every row when a task appears in several loop groups. */
  forceNumber?: boolean;
  previousAgentId: string | undefined;
  openAgent?: (id: string) => void;
}) {
  const stateKey = attemptState(symphony, attempt);
  const stateColor = theme.colors[HISTORY_STATE_COLORS[stateKey]];
  const diagnosis = attempt.report?.diagnosis;
  const reopen = attempt.reopen;
  const [diagnosisOpen, setDiagnosisOpen] = useState(false);
  const [findingsOpen, setFindingsOpen] = useState(false);
  const suffix = retried || forceNumber ? `-${number}` : "";
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
        paddingLeft: retried || forceNumber ? 12 : 0,
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
          fontWeight: retried || forceNumber ? "400" : "600",
          fontVariant: ["tabular-nums"],
          flexShrink: 1,
          minWidth: 0,
        }}
      >
        {retried || forceNumber ? `Attempt ${number}` : task.id}
      </Text>
      {!retried && !forceNumber && (
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
        {`Started ${shortTimestamp(attempt.startedAt)} · ${attemptDurationLabel(attempt)}`}
      </Text>
      <Text
        selectable
        numberOfLines={1}
        testID={`history-attempt-${task.id}${suffix}-tokens`}
        style={{
          color: theme.colors.foregroundMuted,
          fontSize: 12,
          lineHeight: 17,
          fontVariant: ["tabular-nums"],
          flexShrink: 1,
          minWidth: 0,
        }}
      >
        {attemptTokensLabel(attempt)}
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
            retried || forceNumber
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
      {reopen && (
        <View style={{ width: "100%", gap: 2, paddingLeft: retried ? 12 : 0 }}>
          <Text
            selectable
            numberOfLines={2}
            style={{
              color: theme.colors.foregroundMuted,
              fontSize: 12,
              lineHeight: 17,
            }}
          >
            {`Reopened — ${reopen.reason}`}
          </Text>
          {reopen.findings.length > 0 && (
            <Disclosure
              theme={theme}
              label={addressedFindingsLabel(reopen.findings, attempt)}
              expanded={findingsOpen}
              onToggle={() => setFindingsOpen((open) => !open)}
              testID={`history-reopen-findings-${task.id}${suffix}`}
              dense
            >
              <InsetPanel theme={theme}>
                <FindingsPanel
                  theme={theme}
                  findings={reopen.findings}
                  compact
                />
              </InsetPanel>
            </Disclosure>
          )}
        </View>
      )}
      <ScopeChanges theme={theme} attempt={attempt} indented={retried} />
      <ChangedPaths theme={theme} attempt={attempt} indented={retried} />
      <RoutingLines
        theme={theme}
        attempt={attempt}
        suffix={suffix}
        indented={retried}
      />
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
 * Paths the attempt changed in its write scope, recorded by the server from
 * the start/settle write-scope fingerprint diff. Advisory only: it renders
 * only when present and non-empty, and "+ more" marks a list capped by the
 * stored-path limit. Styling follows the addedWrites and grantedWrites lines.
 */
function ChangedPaths({
  theme,
  attempt,
  indented,
}: {
  theme: PluginTheme;
  attempt: Attempt;
  indented: boolean;
}) {
  const changed = attempt.changedPaths;
  if (!changed?.length) {
    return null;
  }
  const line = {
    color: theme.colors.foregroundMuted,
    fontSize: 12,
    lineHeight: 17,
  } as const;
  return (
    <View style={{ width: "100%", gap: 2, paddingLeft: indented ? 12 : 0 }}>
      <Text selectable numberOfLines={2} style={line}>
        {`Changed: ${changed.join(", ")}`}
      </Text>
      {attempt.changedPathsTruncated && (
        <Text selectable style={line}>
          "+ more"
        </Text>
      )}
    </View>
  );
}

/**
 * An attempt's persisted routing decision, as History lines under the attempt
 * row: how the worker was picked and why, the override with its category and
 * evidence, the validation warnings, and the catalog revision. Absent on
 * records stored before routing existed, which render nothing here.
 */
function RoutingLines({
  theme,
  attempt,
  suffix,
  indented,
}: {
  theme: PluginTheme;
  attempt: Attempt;
  suffix: string;
  indented: boolean;
}) {
  const launch = attempt.launch;
  const routing = launch?.routing;
  if (!routing && !launch?.warnings?.length) {
    return null;
  }
  const line = {
    color: theme.colors.foregroundMuted,
    fontSize: 12,
    lineHeight: 17,
  } as const;
  const warnings = launch?.warnings ?? [];
  const override = routing ? overrideLine(routing) : null;
  const revision = shortRevision(launch?.catalogRevision);
  return (
    <View
      testID={`history-routing-${attempt.taskId}${suffix}`}
      style={{ width: "100%", gap: 2, paddingLeft: indented ? 12 : 0 }}
    >
      {launch?.routing && (
        <Text selectable numberOfLines={2} style={line}>
          {routingLine(launch.routing, launchWorker(launch))}
        </Text>
      )}
      {override && (
        <Text selectable numberOfLines={2} style={line}>
          {override}
        </Text>
      )}
      {warnings.map((warning, index) => (
        <Text
          key={`${warning.code}-${index}`}
          selectable
          numberOfLines={2}
          style={{ ...line, color: theme.colors.statusWarning }}
        >
          {warningLine(warning)}
        </Text>
      ))}
      {revision && (
        <Text selectable style={line}>{`Catalog revision: ${revision}`}</Text>
      )}
    </View>
  );
}

/**
 * Labels reopen findings as the attempt's input: the defects an earlier loop
 * reported that this attempt was asked to fix or re-check, not its own result.
 */
function addressedFindingsLabel(
  findings: readonly TaskFinding[],
  attempt: Attempt,
): string {
  const blocking = findings.filter(
    (finding) => finding.severity === "blocking",
  ).length;
  const count = `${findings.length} finding${findings.length === 1 ? "" : "s"}`;
  return `Addresses ${count} from loop ${attemptLoop(attempt) - 1}${
    blocking ? ` · ${blocking} blocking` : ""
  }`;
}

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
  "needs-changes": "Needs changes",
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

/** "12m" for under an hour, "9h 44m" beyond it, from milliseconds. */
export function formatDuration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60000));
  if (minutes < 60) {
    return minutes === 1 ? "1m" : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

/**
 * One attempt's duration: "12m work · 3h blocked" for a tracked attempt,
 * with the blocked span left out when there was none, or the plain wall
 * duration for a record stored before blocked time was tracked.
 */
export function attemptDurationLabel(attempt: Attempt): string {
  const metrics = attemptMetrics(attempt, Date.now());
  if (metrics.legacy) {
    return formatDuration(metrics.wallMs);
  }
  const parts = [`${formatDuration(metrics.workMs)} work`];
  if (metrics.blockedMs > 0) {
    parts.push(`${formatDuration(metrics.blockedMs)} blocked`);
  }
  return parts.join(" · ");
}

/** "48k" for 48 000, "942" below a thousand, "1.2m" beyond a million. */
export function tokenCountLabel(value: number): string {
  if (value < 1000) {
    return String(value);
  }
  if (value < 1_000_000) {
    return `${trimFraction(value / 1000)}k`;
  }
  return `${trimFraction(value / 1_000_000)}m`;
}

function trimFraction(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/** One summed field, e.g. "48k in"; null when no attempt reported it. */
function tokenSumLabel(sum: TokenSum, suffix: string): string | null {
  if (sum.coverage === "unknown" || sum.total === null) {
    return null;
  }
  // A partial sum is a lower bound: attempts without the field may add more.
  const marker = sum.coverage === "partial" ? "≥ " : "";
  return `${marker}${tokenCountLabel(sum.total)}${suffix}`;
}

/**
 * Totals line like "48k in (40k cached) · 6k out". A field no attempt
 * reported is left out, and a record with none reads "—". Cached reads as
 * one figure beside a known input sum, and stands alone — "40k cached" —
 * when only the cache reads are known.
 */
export function tokenTotalsLabel(tokens: TokenTotals): string {
  const input = tokenSumLabel(tokens.input, " in");
  const cached = tokenSumLabel(tokens.cached, " cached");
  const output = tokenSumLabel(tokens.output, " out");
  if (input === null && cached === null && output === null) {
    return "—";
  }
  const parts: string[] = [];
  if (input !== null) {
    parts.push(cached === null ? input : `${input} (${cached})`);
  } else if (cached !== null) {
    parts.push(cached);
  }
  if (output !== null) {
    parts.push(output);
  }
  return parts.join(" · ");
}

/** One attempt's tokens, e.g. "48k in (40k cached) · 6k out" or "—". */
export function attemptTokensLabel(attempt: Attempt): string {
  return tokenTotalsLabel(attemptMetrics(attempt, Date.now()).tokens);
}

/**
 * Summed work time over several attempts. Records stored before blocked
 * time was tracked have no measured work — their work time is wall time —
 * so a sum over only such records reads as wall time instead.
 */
export function workTotalsLabel(totals: DurationTotals): string {
  const unit =
    totals.attemptCount > 0 && totals.legacyAttempts === totals.attemptCount
      ? "wall"
      : "work";
  return `${formatDuration(totals.workMs)} ${unit}`;
}
