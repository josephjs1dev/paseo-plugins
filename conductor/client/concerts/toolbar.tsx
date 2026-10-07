import { ScrollView, TextInput } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import type { PodiumSession, ViewState } from "../podium/session";
import { Button } from "../ui/controls";
import { visibleConcerts, type ConcertsData } from "./list";

export function ConcertToolbar({
  theme,
  data,
  state,
  session,
  compact,
  workspaceId,
}: {
  theme: PluginTheme;
  data: ConcertsData;
  state: ViewState;
  session: PodiumSession;
  compact: boolean;
  workspaceId?: string;
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
            selected={state.concertFilter === id}
            {...(reliable
              ? {
                  count: visibleConcerts(
                    data.list?.runs ?? [],
                    { ...state, concertFilter: id, concertQuery: "" },
                    workspaceId,
                  ).length,
                }
              : {})}
            onPress={() =>
              session.update({ concertFilter: id, concertSelection: null })
            }
          />
        ))}
      </ScrollView>
      <TextInput
        accessibilityLabel="Search concerts"
        placeholder="Search concerts or workspaces…"
        placeholderTextColor={theme.colors.foregroundMuted}
        value={state.concertQuery}
        onChangeText={(concertQuery) => session.update({ concertQuery })}
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
