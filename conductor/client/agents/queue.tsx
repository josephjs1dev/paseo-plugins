import { useRef, useState, type ElementRef } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import type { AgentItem } from "../../shared/agents/models";
import { ageLabel, isSnoozed } from "../../shared/agents/attention";
import { queueGroups } from "../../shared/agents/hierarchy";
import { agentStatusPresentation, StatusMarker } from "../ui/status";
import { Button, Label } from "../ui/controls";

interface Props {
  items: AgentItem[];
  theme: PluginTheme;
  now: number;
  selectedKey: string | null;
  groupBy: "project" | "concert";
  onSelect(this: void, item: AgentItem): void;
  scroll: { offset: number };
  emptyTitle: string;
  emptyDescription: string;
  showAll: boolean;
  onShowAll(this: void): void;
}

/**
 * The Agents queue: project/concert groups of raised cards on the podium
 * surface. A card reads top-down as status row, request or agent title, then
 * quiet concert and lineage metadata. Selection and keyboard focus share the
 * accent frame; selection alone keeps the raised fill so both stay visible.
 * Agents never show a progress track: their snapshots cannot establish task
 * completion.
 */
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
      testID="agents-queue"
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
          <View style={{ paddingHorizontal: 12 }}>
            <Label theme={theme}>{group.toUpperCase()}</Label>
          </View>
          {entries.map(({ item, depth }) => (
            <AgentCard
              key={item.key}
              item={item}
              theme={theme}
              now={now}
              selected={item.key === selectedKey}
              depth={depth}
              onSelect={onSelect}
            />
          ))}
        </View>
      ))}
    </ScrollView>
  );
}

/**
 * One queue card. Hover and pressed feedback only swap the surface fill, so
 * press never moves or resizes the card; the accent border marks selection
 * and keyboard focus without relying on the fill alone.
 */
function AgentCard({
  item,
  theme,
  now,
  selected,
  depth,
  onSelect,
}: {
  item: AgentItem;
  theme: PluginTheme;
  now: number;
  selected: boolean;
  depth: number;
  onSelect(this: void, item: AgentItem): void;
}) {
  const [focused, setFocused] = useState(false);
  const emphasized = selected || focused;
  return (
    <Pressable
      testID={`item-${item.key}`}
      accessibilityRole="button"
      accessibilityLabel={
        item.requestId
          ? `Open ${item.title} from ${item.agentTitle}`
          : `Open ${item.agentTitle}`
      }
      accessibilityState={{ selected }}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onPress={() => onSelect(item)}
      style={({ pressed }) => ({
        paddingHorizontal: 12,
        paddingVertical: 8,
        marginLeft: Math.min(depth, 3) * 32,
        gap: 4,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: emphasized ? theme.colors.accent : theme.colors.border,
        backgroundColor:
          emphasized || pressed ? theme.colors.surface2 : theme.colors.surface1,
      })}
    >
      <View
        style={{
          flexDirection: "row",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 12,
        }}
      >
        <StatusMarker
          theme={theme}
          presentation={agentStatusPresentation(item)}
          size={14}
        />
        <Text
          style={{
            color: theme.colors.foregroundMuted,
            fontSize: 11,
            lineHeight: 14,
            fontVariant: ["tabular-nums"],
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
          lineHeight: 20,
          color: theme.colors.foreground,
        }}
      >
        {item.requestId ? item.title : item.agentTitle}
      </Text>
      <Text
        numberOfLines={1}
        style={{
          color: theme.colors.foregroundMuted,
          fontSize: 12,
          lineHeight: 16,
        }}
      >
        {[
          item.concertName,
          item.childAgentCount > 0 &&
            `${item.childAgentCount} child ${item.childAgentCount === 1 ? "agent" : "agents"}`,
          isSnoozed(item, now) && "Snoozed",
        ]
          .filter(Boolean)
          .join(" · ")}
      </Text>
      {item.parentAgentId && depth === 0 && (
        <Text
          numberOfLines={1}
          style={{
            color: theme.colors.foregroundMuted,
            fontSize: 12,
            lineHeight: 16,
          }}
        >
          Parent:{" "}
          {item.parentAgentTitle ??
            `unavailable parent (${item.parentAgentId.slice(0, 8)})`}
        </Text>
      )}
      {item.delivery && (
        <Text
          style={{
            color: theme.colors.statusWarning,
            fontSize: 12,
            lineHeight: 16,
          }}
        >
          {item.delivery === "answered"
            ? "Response delivered"
            : "Check response delivery"}
        </Text>
      )}
    </Pressable>
  );
}
