import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { ageLabel } from "../../shared/agents/attention";
import { type SymphonyListEntry } from "../../shared/symphonies/models";
import { StatusMarker, symphonyStatusPresentation } from "../ui/status";
import { SymphonyProgress } from "../ui/progress";
import { cardSurface } from "../ui/card";

/**
 * One symphony card in the list: status row with age, title, concert context
 * with the reported-task count, a compact progress track, then the result or
 * blocker preview. The count and track describe reported completions only —
 * they never claim the symphony itself is done, and planning symphonies omit
 * the track instead of showing a percentage. The card lifts off the surface0
 * pane with the shared surface1 card, and selection keeps the accent frame
 * and surface2 fill.
 */
export function SymphonyRow({
  symphony,
  theme,
  now,
  selected,
  onSelect,
}: {
  symphony: SymphonyListEntry;
  theme: PluginTheme;
  now: number;
  selected: boolean;
  onSelect(this: void): void;
}) {
  const [focused, setFocused] = useState(false);
  const emphasized = selected || focused;
  const planning = symphony.status === "planning";
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
        ...cardSurface(theme),
        paddingHorizontal: 12,
        paddingVertical: 8,
        gap: 4,
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
          presentation={symphonyStatusPresentation(symphony.status)}
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
        {/* The project heading already names a concert that shares its name. */}
        {symphony.source.concertName !== symphony.projectName &&
          `${symphony.source.concertName} · `}
        {planning
          ? "Splitting into tasks"
          : `${symphony.completedTasks} of ${symphony.taskCount} tasks reported complete`}
      </Text>
      {!planning && symphony.taskCount > 0 && (
        <SymphonyProgress
          theme={theme}
          completedTasks={symphony.completedTasks}
          taskCount={symphony.taskCount}
          showLabel={false}
        />
      )}
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
