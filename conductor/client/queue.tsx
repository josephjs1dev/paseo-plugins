import { useRef, type ElementRef } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import type { InboxItem } from "../shared/models";
import { ageLabel, isSnoozed } from "../shared/inbox";
import { queueGroups } from "../shared/hierarchy";
import { Button, Label } from "./controls";

interface Props {
  items: InboxItem[];
  theme: PluginTheme;
  now: number;
  selectedKey: string | null;
  groupBy: "project" | "workspace";
  onSelect(this: void, item: InboxItem): void;
  scroll: { offset: number };
  emptyTitle: string;
  emptyDescription: string;
  showAll: boolean;
  onShowAll(this: void): void;
}
export function Queue({
  items,
  theme,
  now,
  selectedKey,
  groupBy,
  onSelect,
  scroll,
  emptyTitle,
  emptyDescription,
  showAll,
  onShowAll,
}: Props) {
  const ref = useRef<ElementRef<typeof ScrollView>>(null);
  const restored = useRef(false);
  const groups = queueGroups(items, groupBy);
  return (
    <ScrollView
      ref={ref}
      style={{ flex: 1 }}
      contentContainerStyle={{ padding: 14, gap: 18 }}
      testID="waiting-queue"
      scrollEventThrottle={100}
      onScroll={(event) => {
        scroll.offset = event.nativeEvent.contentOffset.y;
      }}
      onContentSizeChange={() => {
        if (!restored.current) {
          restored.current = true;
          ref.current?.scrollTo({ y: scroll.offset, animated: false });
        }
      }}
    >
      {items.length === 0 && (
        <View style={{ padding: 20, gap: 10 }}>
          <Text
            style={{
              color: theme.colors.foreground,
              fontSize: 17,
              fontWeight: "500",
            }}
          >
            {emptyTitle}
          </Text>
          <Text
            style={{
              color: theme.colors.foregroundMuted,
              fontSize: 13,
              lineHeight: 21,
            }}
          >
            {emptyDescription}
          </Text>
          {showAll && (
            <View style={{ alignItems: "flex-start" }}>
              <Button
                theme={theme}
                label="View all agents"
                onPress={onShowAll}
              />
            </View>
          )}
        </View>
      )}
      {groups.map(({ label: group, entries }) => (
        <View key={group} style={{ gap: 8 }}>
          <View style={{ paddingHorizontal: 8 }}>
            <Label theme={theme}>{group.toUpperCase()}</Label>
          </View>
          {entries.map(({ item, depth }) => {
            const selected = item.key === selectedKey;
            const status = item.requestId
              ? "Needs answer"
              : item.bucket.charAt(0).toUpperCase() + item.bucket.slice(1);
            const statusColor =
              item.bucket === "failed"
                ? theme.colors.statusDanger
                : theme.colors.foregroundMuted;
            return (
              <Pressable
                key={item.key}
                testID={`item-${item.key}`}
                accessibilityRole="button"
                accessibilityLabel={
                  item.requestId
                    ? `Open ${item.title} from ${item.agentTitle}`
                    : `Open ${item.agentTitle}`
                }
                accessibilityState={{ selected }}
                onPress={() => onSelect(item)}
                style={({ pressed }) => ({
                  padding: 14,
                  marginLeft: Math.min(depth, 3) * 14,
                  gap: 7,
                  borderRadius: 8,
                  borderLeftWidth: 3,
                  borderLeftColor: selected
                    ? theme.colors.accent
                    : theme.colors.border,
                  backgroundColor:
                    selected || pressed
                      ? theme.colors.surface2
                      : theme.colors.surface1,
                })}
              >
                <View
                  style={{
                    flexDirection: "row",
                    justifyContent: "space-between",
                    gap: 12,
                  }}
                >
                  <Text
                    style={{
                      color: statusColor,
                      fontSize: 11,
                      fontWeight: "500",
                    }}
                  >
                    {item.marked ? "Manual reminder" : status}
                  </Text>
                  <Text
                    style={{
                      color: theme.colors.foregroundMuted,
                      fontSize: 11,
                    }}
                  >
                    {ageLabel(item.since, now)}
                  </Text>
                </View>
                <Text
                  numberOfLines={2}
                  style={{
                    fontSize: 14,
                    fontWeight: "600",
                    lineHeight: 21,
                    color: theme.colors.foreground,
                  }}
                >
                  {item.requestId ? item.title : item.agentTitle}
                </Text>
                <Text
                  numberOfLines={1}
                  style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}
                >
                  {item.requestId ? `${item.agentTitle} · ` : ""}
                  {item.provider}
                </Text>
                <Text
                  numberOfLines={1}
                  style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}
                >
                  {item.workspaceName}
                </Text>
                {item.parentAgentId && (
                  <Text
                    style={{
                      color: theme.colors.foregroundMuted,
                      fontSize: 12,
                    }}
                  >
                    Parent:{" "}
                    {item.parentAgentTitle ??
                      `unavailable parent (${item.parentAgentId.slice(0, 8)})`}
                  </Text>
                )}
                {item.childAgentCount > 0 && (
                  <Text
                    style={{
                      color: theme.colors.foregroundMuted,
                      fontSize: 11,
                    }}
                  >
                    {item.childAgentCount} child{" "}
                    {item.childAgentCount === 1 ? "agent" : "agents"}
                  </Text>
                )}
                {isSnoozed(item, now) && (
                  <Text
                    style={{
                      color: theme.colors.foregroundMuted,
                      fontSize: 11,
                    }}
                  >
                    Snoozed
                  </Text>
                )}
                {!item.requestId && (
                  <Text
                    style={{
                      color: theme.colors.foregroundMuted,
                      fontSize: 11,
                    }}
                  >
                    {item.lastTurn
                      ? `Last turn ${item.lastTurn.outcome} · task unverified`
                      : "Turn outcome unknown"}
                  </Text>
                )}
                {item.delivery && (
                  <Text
                    style={{ color: theme.colors.statusWarning, fontSize: 11 }}
                  >
                    {item.delivery === "answered"
                      ? "Response delivered"
                      : "Check response delivery"}
                  </Text>
                )}
              </Pressable>
            );
          })}
        </View>
      ))}
    </ScrollView>
  );
}
