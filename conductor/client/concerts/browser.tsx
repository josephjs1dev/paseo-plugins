import { ScrollView, Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import type { StoredConcert } from "../../shared/concerts/models";
import type { PodiumSession, ViewState } from "../podium/session";
import { Label } from "../ui/controls";
import { ConcertRows, ConcertSelectionDetail, type ConcertsData } from "./list";

export function ConcertBrowser({
  theme,
  data,
  state,
  session,
  compact,
  now,
  workspaceId,
  openAgent,
  deleteConcert,
}: {
  theme: PluginTheme;
  data: ConcertsData;
  state: ViewState;
  session: PodiumSession;
  compact: boolean;
  now: number;
  workspaceId?: string;
  openAgent?: (id: string) => void;
  deleteConcert?: (run: StoredConcert) => Promise<void>;
}) {
  const hasSelection = Boolean(state.concertSelection);
  return (
    <View testID="concerts-browser" style={{ flex: 1, minHeight: 0 }}>
      <View
        style={{
          flex: 1,
          minHeight: 0,
          flexDirection: compact ? "column" : "row",
        }}
      >
        {(!compact || !hasSelection) && (
          <ScrollView
            testID="concerts-queue"
            style={{
              flexGrow: compact ? 1 : 0,
              flexShrink: 0,
              width: compact ? "100%" : "39%",
              borderRightWidth: compact ? 0 : 1,
              borderRightColor: theme.colors.border,
            }}
            contentContainerStyle={{ padding: 14, gap: 18 }}
          >
            <ConcertRows
              theme={theme}
              now={now}
              data={data}
              state={state}
              session={session}
              {...(workspaceId ? { workspaceId } : {})}
            />
          </ScrollView>
        )}
        {(!compact || hasSelection) && (
          <View style={{ flex: 1, minWidth: 0 }}>
            {hasSelection ? (
              <ConcertSelectionDetail
                theme={theme}
                data={data}
                state={state}
                compact={compact}
                {...(openAgent ? { openAgent } : {})}
                {...(deleteConcert ? { deleteConcert } : {})}
              />
            ) : (
              <View style={{ padding: 28, gap: 10, maxWidth: 620 }}>
                <Label theme={theme}>CONCERT PROGRESS</Label>
                <Text
                  style={{
                    color: theme.colors.foreground,
                    fontSize: 20,
                    lineHeight: 29,
                  }}
                >
                  Choose a concert to follow.
                </Text>
                <Text
                  style={{
                    color: theme.colors.foregroundMuted,
                    fontSize: 14,
                    lineHeight: 23,
                  }}
                >
                  Follow tasks, blockers, and reported results. Open the source
                  agent when a decision needs your input.
                </Text>
              </View>
            )}
          </View>
        )}
      </View>
    </View>
  );
}
