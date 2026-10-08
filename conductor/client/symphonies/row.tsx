import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { ageLabel } from "../../shared/agents/attention";
import {
  symphonyStatusLabel,
  type SymphonySummary,
} from "../../shared/symphonies/models";

export function SymphonyRow({
  symphony,
  theme,
  now,
  selected,
  onSelect,
}: {
  symphony: SymphonySummary;
  theme: PluginTheme;
  now: number;
  selected: boolean;
  onSelect(this: void): void;
}) {
  const [focused, setFocused] = useState(false);
  return (
    <Pressable
      testID={`symphony-row-${symphony.id}`}
      accessibilityRole="button"
      accessibilityLabel={`Open symphony: ${symphony.title}`}
      accessibilityState={{ selected }}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onPress={onSelect}
      style={({ pressed }) => ({
        paddingHorizontal: 12,
        paddingVertical: 10,
        gap: 4,
        borderRadius: 6,
        borderLeftWidth: 3,
        borderLeftColor:
          selected || focused ? theme.colors.accent : theme.colors.border,
        backgroundColor:
          selected || focused || pressed
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
          numberOfLines={1}
          style={{
            color:
              symphony.status === "failed"
                ? theme.colors.statusDanger
                : theme.colors.foregroundMuted,
            fontSize: 11,
            lineHeight: 16,
            fontWeight: "500",
            flexShrink: 1,
          }}
        >
          {symphonyStatusLabel(symphony.status)}
        </Text>
        <Text
          style={{
            color: theme.colors.foregroundMuted,
            fontSize: 11,
            lineHeight: 16,
            fontVariant: ["tabular-nums"],
          }}
        >
          {ageLabel(new Date(symphony.updatedAt).toISOString(), now)}
        </Text>
      </View>
      <Text
        numberOfLines={2}
        style={{
          color: theme.colors.foreground,
          fontSize: 14,
          fontWeight: "600",
          lineHeight: 20,
        }}
      >
        {symphony.title}
      </Text>
      <Text
        numberOfLines={1}
        style={{
          color: theme.colors.foregroundMuted,
          fontSize: 12,
          lineHeight: 16,
        }}
      >
        {symphony.source.concertName} ·{" "}
        {symphony.status === "planning"
          ? "Splitting into tasks"
          : `${symphony.completedTasks}/${symphony.taskCount} tasks complete`}
      </Text>
      {symphony.message && (
        <Text
          numberOfLines={2}
          style={{
            color: theme.colors.foregroundMuted,
            fontSize: 12,
            lineHeight: 16,
          }}
        >
          {symphony.message}
        </Text>
      )}
    </Pressable>
  );
}
