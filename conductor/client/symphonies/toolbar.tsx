import { ScrollView, TextInput, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
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
            { id: "blocked", label: "Needs attention", icon: "Bell" },
            { id: "active", label: "Active", icon: "Activity" },
            { id: "completed", label: "Complete", icon: "CircleCheck" },
            { id: "all", label: "All", icon: "ListChecks" },
          ] as const
        ).map(({ id, label, icon }) => (
          <Button
            key={id}
            theme={theme}
            label={label}
            icon={icon}
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
      <View>
        <View
          aria-hidden
          accessible={false}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          pointerEvents="none"
          style={{
            position: "absolute",
            left: 10,
            top: 0,
            bottom: 0,
            justifyContent: "center",
          }}
        >
          <Icon name="Search" size={16} color={theme.colors.foregroundMuted} />
        </View>
        <TextInput
          accessibilityLabel="Search symphonies"
          placeholder="Search symphonies, projects, or concerts…"
          placeholderTextColor={theme.colors.foregroundMuted}
          value={state.symphonyQuery}
          onChangeText={(symphonyQuery) => session.update({ symphonyQuery })}
          style={{
            height: compact ? 44 : 34,
            paddingLeft: 32,
            paddingRight: 10,
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
      </View>
    </>
  );
}
