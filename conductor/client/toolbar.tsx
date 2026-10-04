import { useState, useSyncExternalStore } from "react";
import { ScrollView, Text, TextInput, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import type { InboxSnapshot } from "../shared/models";
import {
  visibleItems,
  isSnoozed,
  category,
  type Filter,
} from "../shared/inbox";
import type { InboxSession } from "./session";
import { Button, Label, Notice, rowStyle } from "./controls";

const filters: { id: Filter; label: string }[] = [
  { id: "waiting", label: "Waiting" },
  { id: "attention", label: "Needs attention" },
  { id: "running", label: "Running" },
  { id: "inactive", label: "Inactive" },
  { id: "all", label: "All" },
];

interface Props {
  theme: PluginTheme;
  hostLabel: string;
  workspaceId?: string;
  data: InboxSnapshot | undefined;
  session: InboxSession;
  compact: boolean;
  stale: boolean;
  refreshing: boolean;
  now: number;
  hasNext: boolean;
  scroll: { offset: number };
  refresh(this: void): void;
  selectNext(this: void): void;
}

export function InboxToolbar(props: Props) {
  const { theme, data, session, compact, now } = props;
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const [showHistory, setShowHistory] = useState(false);
  const scoped = (data?.items ?? []).filter(
    (item) => !props.workspaceId || item.workspaceId === props.workspaceId,
  );
  const agentCount = new Set(scoped.map((item) => item.agentId)).size;
  const reliable = data && !props.stale;
  const controls = { theme, dense: !compact };
  return (
    <View
      style={{
        paddingHorizontal: compact ? 16 : 24,
        paddingTop: 18,
        paddingBottom: 14,
        gap: 12,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
      }}
    >
      <View
        style={{
          ...rowStyle,
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <View style={{ gap: 5, flexShrink: 1 }}>
          <Text
            accessibilityRole="header"
            style={{
              color: theme.colors.foreground,
              fontSize: 22,
              lineHeight: 28,
              fontWeight: "600",
            }}
          >
            Inbox
          </Text>
          <Text
            testID="agent-coverage"
            style={{
              color: theme.colors.foregroundMuted,
              fontSize: 12,
              lineHeight: 18,
            }}
          >
            {props.hostLabel} ·{" "}
            {props.workspaceId ? "This workspace" : "All workspaces"}
            {data
              ? ` · ${agentCount}${data.incomplete ? "+" : ""} agents${props.stale ? " · last known" : ""}`
              : ""}
          </Text>
        </View>
        <View style={rowStyle}>
          {compact && state.selectedKey && (
            <Button
              {...controls}
              label="← Back to queue"
              variant="quiet"
              onPress={() => session.update({ selectedKey: null })}
            />
          )}
          <Button
            {...controls}
            variant="quiet"
            label={props.refreshing ? "Refreshing…" : "Refresh"}
            disabled={props.refreshing}
            onPress={props.refresh}
          />
          <Button
            {...controls}
            label="Next waiting →"
            disabled={!props.hasNext}
            onPress={props.selectNext}
          />
        </View>
      </View>
      {props.stale && (
        <Notice theme={theme} warning>
          Could not refresh this host. Showing the last known state; answer
          controls are disabled.
        </Notice>
      )}
      {data?.incomplete && (
        <Notice theme={theme} warning>
          Directory is incomplete. Counts are a lower bound; previously waiting
          agents are checked separately.
        </Notice>
      )}
      {data?.workspaceIncomplete && (
        <Notice theme={theme}>
          Some workspace names are unavailable. Agent requests remain visible.
        </Notice>
      )}
      {data?.turnHistoryIncomplete && (
        <Notice theme={theme} warning>
          Some recorded turn outcomes could not be loaded. Missing outcomes
          remain unknown.
        </Notice>
      )}
      {(!compact || !state.selectedKey) && (
        <>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={{
              flexGrow: 0,
              borderBottomWidth: 1,
              borderBottomColor: theme.colors.border,
            }}
            contentContainerStyle={{ gap: 6 }}
          >
            {filters.map((filter) => (
              <Button
                key={filter.id}
                {...controls}
                variant="tab"
                label={filter.label}
                selected={state.filter === filter.id}
                {...(reliable
                  ? {
                      count: visibleItems(
                        scoped,
                        filter.id,
                        "",
                        undefined,
                        now,
                        state.showSnoozed,
                      ).length,
                    }
                  : {})}
                onPress={() => {
                  session.update({ filter: filter.id, selectedKey: null });
                  props.scroll.offset = 0;
                }}
              />
            ))}
          </ScrollView>
          <View
            testID="inbox-tools"
            style={{ ...rowStyle, alignItems: "center" }}
          >
            <TextInput
              accessibilityLabel="Search agents and requests"
              placeholder="Search agents, requests, workspaces…"
              placeholderTextColor={theme.colors.foregroundMuted}
              value={state.query}
              onChangeText={(query) => session.update({ query })}
              style={{
                flex: 1,
                minWidth: compact ? 220 : 240,
                height: compact ? 44 : 34,
                paddingHorizontal: 10,
                paddingVertical: 6,
                color: theme.colors.foreground,
                backgroundColor: theme.colors.surface1,
                borderWidth: 1,
                borderColor: theme.colors.border,
                borderRadius: 6,
                fontSize: 13,
                lineHeight: 18,
              }}
            />
            <Button
              {...controls}
              label={
                state.groupBy === "project"
                  ? "Group: project"
                  : "Group: workspace"
              }
              onPress={() =>
                session.update({
                  groupBy:
                    state.groupBy === "project" ? "workspace" : "project",
                })
              }
            />
            <Button
              {...controls}
              variant="quiet"
              label={showHistory ? "Hide recent actions" : "Recent actions"}
              onPress={() => setShowHistory(!showHistory)}
            />
            {(state.filter === "waiting" || state.filter === "attention") &&
              (state.showSnoozed ||
                scoped.some(
                  (item) =>
                    category(item) === state.filter && isSnoozed(item, now),
                )) && (
                <Button
                  {...controls}
                  variant="quiet"
                  label="Show snoozed"
                  selected={state.showSnoozed}
                  onPress={() =>
                    session.update({ showSnoozed: !state.showSnoozed })
                  }
                />
              )}
          </View>
        </>
      )}
      {data && (
        <Text
          style={{
            fontSize: 11,
            lineHeight: 16,
            color: theme.colors.foregroundMuted,
          }}
        >
          {props.stale ? "Last updated" : "Auto-refresh on"} ·{" "}
          {new Date(data.fetchedAt).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </Text>
      )}
      {showHistory && (
        <View style={{ gap: 8 }}>
          <Label theme={theme}>RECENT RESPONSE DELIVERY</Label>
          {data?.receipts.length === 0 && (
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
              No responses sent from Conductor yet.
            </Text>
          )}
          {data?.receipts.slice(0, 5).map((receipt) => (
            <Text
              key={receipt.key}
              style={{ color: theme.colors.foreground, fontSize: 12 }}
            >
              {receipt.status === "answered" ? "Delivered" : "Unconfirmed"} ·{" "}
              {data.items.find((item) => item.agentId === receipt.agentId)
                ?.agentTitle ?? receipt.agentId.slice(0, 12)}{" "}
              · {new Date(receipt.at).toLocaleTimeString()}
            </Text>
          ))}
        </View>
      )}
    </View>
  );
}
