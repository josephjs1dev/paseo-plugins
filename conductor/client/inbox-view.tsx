import { useState, useSyncExternalStore } from "react";
import { Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import type { InboxItem, InboxSnapshot } from "../shared/models";
import type { StoredRun } from "../shared/run-models";
import { visibleItems } from "../shared/inbox";
import { InboxSession } from "./session";
import { Label, Notice } from "./controls";
import { InboxToolbar } from "./toolbar";
import { Queue } from "./queue";
import { RequestDetail, type DetailActions } from "./request-detail";
import type { RunInboxData } from "./run-inbox";
import { RunBrowser } from "./run-browser";

export interface InboxViewProps {
  theme: PluginTheme;
  hostLabel: string;
  compact: boolean;
  workspaceId?: string;
  data: InboxSnapshot | undefined;
  loading: boolean;
  refreshing: boolean;
  stale: boolean;
  now: number;
  session: InboxSession;
  scroll: { offset: number };
  actions: DetailActions;
  runs?: RunInboxData;
  deleteRun?: (run: StoredRun) => Promise<void>;
  refresh(this: void): void;
}
export function InboxView(props: InboxViewProps) {
  const { theme, data, session, now, actions } = props;
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const [width, setWidth] = useState(0);
  const compact = props.compact || (width > 0 && width < 740);
  const hasSelection = Boolean(state.selectedKey);
  const isRuns = state.section === "runs" && Boolean(props.runs);
  const items = visibleItems(
    data?.items ?? [],
    state.filter,
    state.query,
    props.workspaceId,
    now,
    state.showSnoozed,
  );
  const selected = data?.items.find((item) => item.key === state.selectedKey);
  const attention = visibleItems(
    data?.items ?? [],
    "attention",
    "",
    props.workspaceId,
    now,
  );
  const agentCount = new Set(
    (data?.items ?? [])
      .filter(
        (item) => !props.workspaceId || item.workspaceId === props.workspaceId,
      )
      .map((item) => item.agentId),
  ).size;
  const showAll = () => {
    session.update({
      filter: "all",
      query: "",
      selectedKey: null,
    });
    props.scroll.offset = 0;
  };
  const next = attention.find(
    (item) =>
      item.key !== selected?.key &&
      item.delivery === null &&
      !state.notices[item.key],
  );
  const select = (item: InboxItem) => {
    if (item.form?.kind === "native" && actions.canNavigate) {
      actions.openAgent(item.agentId);
      return;
    }
    session.select(item);
  };
  const selectNext = () => {
    if (next) {
      session.update({ filter: "attention", query: "" });
      select(next);
    }
  };
  let emptyTitle = "Nothing in this view";
  let emptyDescription = "Try another status or clear your search.";
  if (!data || props.stale) {
    emptyTitle = "Agent status unavailable";
    emptyDescription = "Refresh to check the current state of your agents.";
  } else if (state.query) {
    emptyTitle = "No matching agents or requests";
  } else if (agentCount === 0) {
    emptyTitle = "No agents in this scope";
    emptyDescription =
      "Existing agents appear automatically. Open or create an agent in Paseo to get started.";
  } else if (state.filter === "attention") {
    emptyTitle = "No agents need attention";
    emptyDescription = `${agentCount}${data.incomplete ? "+" : ""} current agents checked. No pending questions, approvals, failures, or reminders in this view.`;
  }
  let detailTitle = "Choose an agent to follow.";
  let detailDescription =
    "Existing and new agents are checked automatically. Use Running, Inactive, or All to follow their current state.";
  if (attention.length) {
    detailTitle = "Choose an item to review.";
    detailDescription =
      "Select a question, approval, failure, or reminder from the queue.";
  }
  if (state.selectedKey) {
    detailTitle = "This item changed or was resolved.";
    detailDescription =
      "Your draft stays with the original request. Continue to the next item needing attention.";
  }
  return (
    <View
      testID="conductor-inbox"
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      style={{ flex: 1, minHeight: 0, backgroundColor: theme.colors.surface0 }}
    >
      <InboxToolbar
        {...props}
        compact={compact}
        hasNext={Boolean(next)}
        selectNext={selectNext}
      />
      {props.runs && (
        <View
          style={{ flex: 1, minHeight: 0, display: isRuns ? "flex" : "none" }}
        >
          <RunBrowser
            theme={theme}
            now={now}
            data={props.runs}
            state={state}
            session={session}
            compact={compact}
            {...(props.workspaceId ? { workspaceId: props.workspaceId } : {})}
            {...(actions.canNavigate
              ? { openAgent: (id: string) => actions.openAgent(id) }
              : {})}
            {...(props.deleteRun ? { deleteRun: props.deleteRun } : {})}
          />
        </View>
      )}
      <View
        style={{ flex: 1, minHeight: 0, display: isRuns ? "none" : "flex" }}
      >
        {props.loading && !data ? (
          <View style={{ padding: 24 }}>
            <Notice theme={theme}>Loading agents and pending requests…</Notice>
          </View>
        ) : (
          <View
            style={{
              flex: 1,
              flexDirection: compact ? "column" : "row",
              minHeight: 0,
            }}
          >
            {(!compact || !hasSelection) && (
              <View
                style={{
                  flex: compact ? 1 : undefined,
                  width: compact ? "100%" : "39%",
                  borderRightWidth: compact ? 0 : 1,
                  borderRightColor: theme.colors.border,
                }}
              >
                <Queue
                  items={items}
                  emptyTitle={emptyTitle}
                  emptyDescription={emptyDescription}
                  onShowAll={showAll}
                  showAll={
                    agentCount > 0 &&
                    (state.filter !== "all" || Boolean(state.query))
                  }
                  theme={theme}
                  now={now}
                  selectedKey={state.selectedKey}
                  groupBy={state.groupBy}
                  scroll={props.scroll}
                  onSelect={select}
                />
              </View>
            )}
            {(!compact || hasSelection) && (
              <View style={{ flex: 1, minWidth: 0 }}>
                {selected ? (
                  <RequestDetail
                    key={selected.key}
                    theme={theme}
                    item={selected}
                    now={now}
                    stale={props.stale}
                    directoryIncomplete={data?.incomplete ?? true}
                    draft={state.drafts[selected.key]}
                    notice={state.notices[selected.key]}
                    onDraft={(value) => session.draft(selected.key, value)}
                    actions={actions}
                  />
                ) : (
                  <View style={{ padding: 28, gap: 10, maxWidth: 620 }}>
                    <Label theme={theme}>
                      {state.selectedKey
                        ? "REQUEST NO LONGER PENDING"
                        : "YOUR NEXT ACTION"}
                    </Label>
                    <Text
                      style={{
                        color: theme.colors.foreground,
                        fontSize: 20,
                        lineHeight: 29,
                      }}
                    >
                      {detailTitle}
                    </Text>
                    <Text
                      style={{
                        color: theme.colors.foregroundMuted,
                        fontSize: 14,
                        lineHeight: 23,
                      }}
                    >
                      {detailDescription}
                    </Text>
                  </View>
                )}
              </View>
            )}
          </View>
        )}
      </View>
    </View>
  );
}
