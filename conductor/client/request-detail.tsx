import { useState } from "react";
import { ScrollView, Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import type {
  AnswerResult,
  ArchiveResult,
  Decision,
  InboxItem,
} from "../shared/models";
import { questionAnswers } from "../shared/questions";
import { ageLabel, isSnoozed, needsAttention } from "../shared/inbox";
import { ArchiveAction } from "./archive-action";
import { Button, Label, Notice, rowStyle } from "./controls";
import { QuestionForm } from "./question-form";

export interface DetailActions {
  openAgent(agentId: string): void;
  canNavigate: boolean;
  answer(item: InboxItem, decision: Decision): Promise<void>;
  snooze(item: InboxItem, minutes: 0 | 15 | 60): Promise<void>;
  mark(item: InboxItem): Promise<void>;
  archive(this: void, item: InboxItem): Promise<ArchiveResult>;
}
interface Props {
  theme: PluginTheme;
  item: InboxItem;
  now: number;
  stale: boolean;
  directoryIncomplete: boolean;
  draft: Decision | undefined;
  notice: AnswerResult["status"] | "sending" | undefined;
  onDraft(this: void, value: Decision): void;
  actions: DetailActions;
}
const messages = {
  sending: "Sending your response…",
  answered:
    "Response delivered. The agent’s next activity will appear after refresh.",
  unknown:
    "Delivery is uncertain. Do not resend here. Open the agent and verify its current request.",
  stale:
    "This request changed or was resolved elsewhere. Your draft remains attached to the original request.",
  unsupported:
    "This request needs its native controls. Open the agent to respond.",
};
export function RequestDetail({
  theme,
  item,
  now,
  stale,
  directoryIncomplete,
  draft,
  notice,
  onDraft,
  actions,
}: Props) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const delivery = notice ?? item.delivery;
  const locked =
    stale ||
    busy ||
    (delivery !== null && delivery !== undefined) ||
    item.bucket === "failed" ||
    item.bucket === "closed";
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setActionError(null);
    try {
      await work();
    } catch {
      setActionError(
        "The action could not be confirmed. Refresh or open the agent before trying again.",
      );
    } finally {
      setBusy(false);
    }
  };
  let valid = false;
  let submitLabel = "Send answer";
  if (draft && item.form?.kind === "questions") {
    valid = questionAnswers(item.form, draft) !== null;
  }
  if (draft?.kind === "action" && item.form?.kind === "actions") {
    const action = item.form.actions.find(
      (entry) => entry.id === draft.actionId,
    );
    valid = Boolean(action);
    submitLabel = `Confirm ${action?.label ?? "response"}`;
  }
  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{ padding: 24, gap: 20 }}
      testID="request-detail"
    >
      <View style={{ gap: 10 }}>
        <Label theme={theme}>
          {item.requestId ? "AWAITING YOUR RESPONSE" : "AGENT ACTIVITY"}
        </Label>
        <Text
          accessibilityRole="header"
          style={{
            fontSize: 22,
            lineHeight: 29,
            fontWeight: "600",
            color: theme.colors.foreground,
          }}
        >
          {item.requestId ? item.title : item.agentTitle}
        </Text>
        <Text
          style={{
            fontSize: 13,
            lineHeight: 20,
            color: theme.colors.foregroundMuted,
          }}
        >
          {item.requestId ? `${item.agentTitle} · ` : ""}
          {item.provider} · {item.bucket} · {ageLabel(item.since, now)}
        </Text>
        <Text style={{ fontSize: 12, color: theme.colors.foregroundMuted }}>
          {item.projectName} / {item.workspaceName}
        </Text>
      </View>
      {item.parentAgentId && (
        <View
          testID="parent-agent"
          style={{
            padding: 16,
            gap: 10,
            borderWidth: 1,
            borderColor: theme.colors.border,
            borderRadius: 8,
            backgroundColor: theme.colors.surface1,
          }}
        >
          <Label theme={theme}>PARENT AGENT</Label>
          <Text
            style={{
              color: theme.colors.foreground,
              fontSize: 14,
              lineHeight: 21,
              fontWeight: "500",
            }}
          >
            {item.parentAgentTitle ??
              `Unavailable parent (${item.parentAgentId})`}
          </Text>
          {item.parentAgentTitle && (
            <View style={{ alignItems: "flex-start" }}>
              <Button
                theme={theme}
                label="Open parent ↗"
                disabled={!actions.canNavigate}
                onPress={() => {
                  if (item.parentAgentId) {
                    actions.openAgent(item.parentAgentId);
                  }
                }}
              />
            </View>
          )}
        </View>
      )}
      {item.error && (
        <Notice theme={theme} warning>
          {item.error}
        </Notice>
      )}
      {stale && (
        <Notice theme={theme} warning>
          Connection or refresh unavailable. This is the last known state.
          Responses are disabled until a successful refresh.
        </Notice>
      )}
      {delivery && (
        <Notice theme={theme} warning={delivery === "unknown"}>
          {messages[delivery]}
        </Notice>
      )}
      {actionError && (
        <Notice theme={theme} warning>
          {actionError}
        </Notice>
      )}
      {item.description !== "" && (
        <Text
          selectable
          style={{
            fontSize: 14,
            lineHeight: 23,
            color: theme.colors.foreground,
          }}
        >
          {item.description}
        </Text>
      )}
      {item.form && (
        <QuestionForm
          form={item.form}
          theme={theme}
          draft={draft}
          disabled={locked}
          onChange={onDraft}
        />
      )}
      {item.form && item.form.kind !== "native" && (
        <View style={{ gap: 8 }}>
          <Button
            theme={theme}
            label={delivery === "sending" ? "Sending…" : submitLabel}
            primary
            disabled={!valid || locked}
            onPress={() => {
              if (draft) {
                run(() => actions.answer(item, draft)).catch(() => undefined);
              }
            }}
          />
          <Text
            style={{
              fontSize: 12,
              lineHeight: 19,
              color: theme.colors.foregroundMuted,
            }}
          >
            Applies only to this request. Sending an answer does not confirm
            that work resumed.
          </Text>
        </View>
      )}
      {!item.requestId && (
        <View style={{ gap: 8 }}>
          <Label theme={theme}>TURN OUTCOME</Label>
          <Text
            style={{
              color: theme.colors.foreground,
              fontSize: 14,
              lineHeight: 22,
            }}
          >
            {item.lastTurn
              ? `Last turn ${item.lastTurn.outcome} · observed ${new Date(item.lastTurn.observedAt).toLocaleString()}`
              : "Outcome unknown — no recorded end for the current turn."}
          </Text>
          <Text
            style={{
              color: theme.colors.foregroundMuted,
              fontSize: 13,
              lineHeight: 21,
            }}
          >
            {item.lastTurn
              ? "This is a recorded response outcome, not a verified task result. Review the output and required checks before treating the work as complete."
              : "Idle means not running. Closed means the session is closed. Neither proves the task is complete. Earlier outcomes cannot be recovered from an unread flag."}
          </Text>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
            Task completion: not verified by Conductor.
          </Text>
        </View>
      )}
      <View style={rowStyle}>
        <Button
          theme={theme}
          label="Open agent ↗"
          disabled={!actions.canNavigate}
          onPress={() => actions.openAgent(item.agentId)}
        />
        {(needsAttention(item) || isSnoozed(item, now)) && (
          <Button
            theme={theme}
            label={isSnoozed(item, now) ? "Unsnooze" : "Snooze 15 min"}
            disabled={stale || busy}
            onPress={() => {
              run(() =>
                actions.snooze(item, isSnoozed(item, now) ? 0 : 15),
              ).catch(() => undefined);
            }}
          />
        )}
        {!item.requestId && item.marked && (
          <Button
            theme={theme}
            label="Clear my reminder"
            disabled={stale || busy}
            onPress={() => {
              run(() => actions.mark(item)).catch(() => undefined);
            }}
          />
        )}
      </View>
      <ArchiveAction
        key={`${item.key}:${item.archiveKey}`}
        theme={theme}
        item={item}
        stale={stale}
        directoryIncomplete={directoryIncomplete}
        archive={actions.archive}
      />
      {!actions.canNavigate && (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
          Agent navigation is unavailable on this client.
        </Text>
      )}
      <Text
        style={{
          color: theme.colors.foregroundMuted,
          fontSize: 12,
          lineHeight: 19,
        }}
      >
        Snooze affects Conductor’s queue only. Paseo controls native
        notifications.
      </Text>
      {item.details !== "" && (
        <View style={{ gap: 12 }}>
          <Button
            theme={theme}
            label={
              detailsOpen ? "Hide request details" : "Show request details"
            }
            onPress={() => setDetailsOpen(!detailsOpen)}
          />
          {detailsOpen && (
            <Text
              selectable
              style={{
                color: theme.colors.foregroundMuted,
                fontFamily: "monospace",
                fontSize: 12,
                lineHeight: 19,
              }}
            >
              {item.details}
            </Text>
          )}
        </View>
      )}
    </ScrollView>
  );
}
