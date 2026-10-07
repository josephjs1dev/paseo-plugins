import { ScrollView, TextInput } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import type { InboxSession, ViewState } from "../podium/session";
import { Button } from "../ui/controls";
import { visibleRuns, type RunInboxData } from "./list";

export function RunToolbar({
  theme,
  data,
  state,
  session,
  compact,
  workspaceId,
}: {
  theme: PluginTheme;
  data: RunInboxData;
  state: ViewState;
  session: InboxSession;
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
            selected={state.runFilter === id}
            {...(reliable
              ? {
                  count: visibleRuns(
                    data.list?.runs ?? [],
                    { ...state, runFilter: id, runQuery: "" },
                    workspaceId,
                  ).length,
                }
              : {})}
            onPress={() =>
              session.update({ runFilter: id, runSelection: null })
            }
          />
        ))}
      </ScrollView>
      <TextInput
        accessibilityLabel="Search concerts"
        placeholder="Search concerts or workspaces…"
        placeholderTextColor={theme.colors.foregroundMuted}
        value={state.runQuery}
        onChangeText={(runQuery) => session.update({ runQuery })}
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
