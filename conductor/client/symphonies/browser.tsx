import { ScrollView, Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import type { StoredSymphony } from "../../shared/symphonies/models";
import type { PodiumSession, ViewState } from "../podium/session";
import { Label } from "../ui/controls";
import {
  SymphonyRows,
  SymphonySelectionDetail,
  type SymphoniesData,
} from "./list";

export function SymphonyBrowser({
  theme,
  data,
  state,
  session,
  compact,
  now,
  concertId,
  openAgent,
  deleteSymphony,
}: {
  theme: PluginTheme;
  data: SymphoniesData;
  state: ViewState;
  session: PodiumSession;
  compact: boolean;
  now: number;
  concertId?: string;
  openAgent?: (id: string) => void;
  deleteSymphony?: (symphony: StoredSymphony) => Promise<void>;
}) {
  const hasSelection = Boolean(state.symphonySelection);
  return (
    <View testID="symphonies-browser" style={{ flex: 1, minHeight: 0 }}>
      <View
        style={{
          flex: 1,
          minHeight: 0,
          flexDirection: compact ? "column" : "row",
        }}
      >
        {(!compact || !hasSelection) && (
          <ScrollView
            testID="symphonies-queue"
            style={{
              flexGrow: compact ? 1 : 0,
              flexShrink: 0,
              width: compact ? "100%" : "39%",
              borderRightWidth: compact ? 0 : 1,
              borderRightColor: theme.colors.border,
            }}
            contentContainerStyle={{ padding: 14, gap: 18 }}
          >
            <SymphonyRows
              theme={theme}
              now={now}
              data={data}
              state={state}
              session={session}
              {...(concertId ? { concertId } : {})}
            />
          </ScrollView>
        )}
        {(!compact || hasSelection) && (
          <View style={{ flex: 1, minWidth: 0 }}>
            {hasSelection ? (
              <SymphonySelectionDetail
                theme={theme}
                data={data}
                state={state}
                compact={compact}
                {...(openAgent ? { openAgent } : {})}
                {...(deleteSymphony ? { deleteSymphony } : {})}
              />
            ) : (
              <View style={{ padding: 28, gap: 10, maxWidth: 620 }}>
                <Label theme={theme}>SYMPHONY PROGRESS</Label>
                <Text
                  style={{
                    color: theme.colors.foreground,
                    fontSize: 20,
                    lineHeight: 29,
                  }}
                >
                  Choose a symphony to follow.
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
