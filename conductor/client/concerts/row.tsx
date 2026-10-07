import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { ageLabel } from "../../shared/agents/inbox";
import { runStatusLabel, type RunSummary } from "../../shared/concerts/models";

export function RunRow({
  run,
  theme,
  now,
  selected,
  onSelect,
}: {
  run: RunSummary;
  theme: PluginTheme;
  now: number;
  selected: boolean;
  onSelect(this: void): void;
}) {
  const [focused, setFocused] = useState(false);
  return (
    <Pressable
      testID={`run-row-${run.id}`}
      accessibilityRole="button"
      accessibilityLabel={`Open concert: ${run.title}`}
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
              run.status === "failed"
                ? theme.colors.statusDanger
                : theme.colors.foregroundMuted,
            fontSize: 11,
            lineHeight: 16,
            fontWeight: "500",
            flexShrink: 1,
          }}
        >
          {runStatusLabel(run.status)}
        </Text>
        <Text
          style={{
            color: theme.colors.foregroundMuted,
            fontSize: 11,
            lineHeight: 16,
            fontVariant: ["tabular-nums"],
          }}
        >
          {ageLabel(new Date(run.updatedAt).toISOString(), now)}
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
        {run.title}
      </Text>
      <Text
        numberOfLines={1}
        style={{
          color: theme.colors.foregroundMuted,
          fontSize: 12,
          lineHeight: 16,
        }}
      >
        {run.source.workspaceName} ·{" "}
        {run.status === "planning"
          ? "Splitting into tasks"
          : `${run.completedTasks}/${run.taskCount} tasks complete`}
      </Text>
      {run.message && (
        <Text
          numberOfLines={2}
          style={{
            color: theme.colors.foregroundMuted,
            fontSize: 12,
            lineHeight: 16,
          }}
        >
          {run.message}
        </Text>
      )}
    </Pressable>
  );
}
