import { ScrollView, TextInput } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import type { PodiumSession, ViewState } from "../podium/session";
import { Button } from "../ui/controls";
import { visibleSymphonies, type SymphoniesData } from "./list";

export function SymphonyToolbar({
  theme,
  data,
  state,
  session,
  compact,
  concertId,
}: {
  theme: PluginTheme;
  data: SymphoniesData;
  state: ViewState;
  session: PodiumSession;
  compact: boolean;
  concertId?: string;
}) {
  const reliable =
    data.list && !data.stale && !data.list.incomplete && !data.list.unavailable;
  return (
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
        {(
          [
            { id: "blocked", label: "Needs attention" },
            { id: "active", label: "Active" },
            { id: "completed", label: "Complete" },
            { id: "all", label: "All" },
          ] as const
        ).map(({ id, label }) => (
          <Button
            key={id}
            theme={theme}
            label={label}
            variant="tab"
            dense={!compact}
            selected={state.symphonyFilter === id}
            {...(reliable
              ? {
                  count: visibleSymphonies(
                    data.list?.symphonies ?? [],
                    { ...state, symphonyFilter: id, symphonyQuery: "" },
                    concertId,
                  ).length,
                }
              : {})}
            onPress={() =>
              session.update({ symphonyFilter: id, symphonySelection: null })
            }
          />
        ))}
      </ScrollView>
      <TextInput
        accessibilityLabel="Search symphonies"
        placeholder="Search symphonies, projects, or concerts…"
        placeholderTextColor={theme.colors.foregroundMuted}
        value={state.symphonyQuery}
        onChangeText={(symphonyQuery) => session.update({ symphonyQuery })}
        style={{
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
    </>
  );
}
