import { useState, useSyncExternalStore } from "react";
import { Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import type { InboxSnapshot } from "../shared/models";
import { visibleItems } from "../shared/inbox";
import { InboxSession } from "./session";
import { Label, Notice } from "./controls";
import { InboxToolbar } from "./toolbar";
import { Queue } from "./queue";
import { RequestDetail, type DetailActions } from "./request-detail";

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
  refresh(this: void): void;
}
export function InboxView(props: InboxViewProps) {
  const { theme, data, session, now, actions } = props;
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const [width, setWidth] = useState(0);
  const compact = props.compact || (width > 0 && width < 740);
  const items = visibleItems(
    data?.items ?? [],
    state.filter,
    state.query,
    props.workspaceId,
    now,
    state.showSnoozed,
  );
  const selected = data?.items.find((item) => item.key === state.selectedKey);
  const waiting = visibleItems(
    data?.items ?? [],
    "waiting",
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
    session.update({ filter: "all", query: "", selectedKey: null });
    props.scroll.offset = 0;
  };
  const next = waiting.find(
    (item) =>
      item.key !== selected?.key &&
      item.delivery === null &&
      !state.notices[item.key],
  );
  const selectNext = () => {
    if (next) {
      session.update({ filter: "waiting", query: "" });
      session.select(next);
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
  } else if (state.filter === "waiting") {
    emptyTitle = "No agents waiting for you";
    emptyDescription = `${agentCount}${data.incomplete ? "+" : ""} current agents checked. No questions or approvals are waiting in this view.`;
  }
  let detailTitle = "Choose an agent to follow.";
  let detailDescription =
    "Existing and new agents are checked automatically. Use Running, Inactive, or All to follow their current state.";
  if (waiting.length) {
    detailTitle = "Choose a request to respond.";
    detailDescription =
      "Select a question or approval from the queue to continue.";
  }
  if (state.selectedKey) {
    detailTitle = "This item changed or was resolved.";
    detailDescription =
      "Your draft stays with the original request. Continue to the next waiting item.";
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
          {(!compact || !state.selectedKey) && (
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
                onSelect={(item) => session.select(item)}
              />
            </View>
          )}
          {(!compact || state.selectedKey) && (
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
  );
}
