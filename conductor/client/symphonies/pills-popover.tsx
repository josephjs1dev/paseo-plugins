import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import type { SymphonyListEntry } from "../../shared/symphonies/models";
import { StatusMarker, symphonyStatusPresentation } from "../ui/status";

/**
 * One ongoing symphony inside the popover: status row with its concert,
 * title, the reported-task line, and the latest message or blocker as
 * delivered by the summary. Pressing opens the symphony's podium panel.
 */
function SymphonyPillEntry({
  theme,
  symphony,
  onOpen,
}: {
  theme: PluginTheme;
  symphony: SymphonyListEntry;
  onOpen(this: void): void;
}) {
  const [focused, setFocused] = useState(false);
  const planning = symphony.status === "planning";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open symphony: ${symphony.title}`}
      accessibilityState={{ disabled: false }}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onPress={onOpen}
      style={({ pressed }) => ({
        gap: 2,
        paddingVertical: 6,
        paddingHorizontal: 8,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: focused ? theme.colors.accent : "transparent",
        backgroundColor:
          pressed || focused ? theme.colors.surface2 : theme.colors.surface1,
      })}
    >
      <View
        style={{
          flexDirection: "row",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 10,
        }}
      >
        <StatusMarker
          theme={theme}
          presentation={symphonyStatusPresentation(symphony.status)}
          size={13}
        />
        <Text
          numberOfLines={1}
          style={{
            color: theme.colors.foregroundMuted,
            fontSize: 11,
            lineHeight: 14,
          }}
        >
          {symphony.source.concertName}
        </Text>
      </View>
      <Text
        numberOfLines={2}
        style={{
          color: theme.colors.foreground,
          fontSize: 13,
          lineHeight: 18,
          fontWeight: "600",
        }}
      >
        {symphony.title}
      </Text>
      <Text
        style={{
          color: theme.colors.foregroundMuted,
          fontSize: 11,
          lineHeight: 14,
        }}
      >
        {planning
          ? "Splitting into tasks"
          : `${symphony.completedTasks} of ${symphony.taskCount} tasks reported complete`}
      </Text>
      {symphony.message ? (
        <Text
          numberOfLines={2}
          style={{
            color: theme.colors.foregroundMuted,
            fontSize: 11,
            lineHeight: 14,
          }}
        >
          {symphony.message}
        </Text>
      ) : null}
    </Pressable>
  );
}

/**
 * The composer pill's popover body. The host renders it fresh on every open
 * and supplies the theme through `PluginButtonContentProps`; `entries` must
 * come from the pill's live holder at render time, never a copy taken at
 * registration, so the list always reflects the latest refresh.
 */
export function SymphoniesPillContent({
  theme,
  entries,
  onOpen,
}: {
  theme: PluginTheme;
  entries: readonly SymphonyListEntry[];
  onOpen: (symphony: SymphonyListEntry) => void;
}) {
  return (
    <View
      accessibilityLabel="Ongoing symphonies"
      style={{ gap: 4, maxWidth: 320 }}
    >
      {entries.length === 0 ? (
        <Text
          style={{
            color: theme.colors.foregroundMuted,
            fontSize: 12,
            lineHeight: 16,
          }}
        >
          No ongoing symphonies right now.
        </Text>
      ) : (
        entries.map((entry) => (
          <SymphonyPillEntry
            key={entry.id}
            theme={theme}
            symphony={entry}
            onOpen={() => onOpen(entry)}
          />
        ))
      )}
    </View>
  );
}
