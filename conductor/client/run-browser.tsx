import { ScrollView, Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import type { StoredRun } from "../shared/run-models";
import type { InboxSession, ViewState } from "./session";
import { Label } from "./controls";
import { RunRows, RunSelectionDetail, type RunInboxData } from "./run-inbox";

export function RunBrowser({
  theme,
  data,
  state,
  session,
  compact,
  now,
  workspaceId,
  openAgent,
  deleteRun,
}: {
  theme: PluginTheme;
  data: RunInboxData;
  state: ViewState;
  session: InboxSession;
  compact: boolean;
  now: number;
  workspaceId?: string;
  openAgent?: (id: string) => void;
  deleteRun?: (run: StoredRun) => Promise<void>;
}) {
  const hasSelection = Boolean(state.runSelection);
  return (
    <View testID="runs-browser" style={{ flex: 1, minHeight: 0 }}>
      <View
        style={{
          flex: 1,
          minHeight: 0,
          flexDirection: compact ? "column" : "row",
        }}
      >
        {(!compact || !hasSelection) && (
          <ScrollView
            testID="runs-queue"
            style={{
              flexGrow: compact ? 1 : 0,
              flexShrink: 0,
              width: compact ? "100%" : "39%",
              borderRightWidth: compact ? 0 : 1,
              borderRightColor: theme.colors.border,
            }}
            contentContainerStyle={{ padding: 14, gap: 18 }}
          >
            <RunRows
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
              <RunSelectionDetail
                theme={theme}
                data={data}
                state={state}
                compact={compact}
                {...(openAgent ? { openAgent } : {})}
                {...(deleteRun ? { deleteRun } : {})}
              />
            ) : (
              <View style={{ padding: 28, gap: 10, maxWidth: 620 }}>
                <Label theme={theme}>RUN PROGRESS</Label>
                <Text
                  style={{
                    color: theme.colors.foreground,
                    fontSize: 20,
                    lineHeight: 29,
                  }}
                >
                  Choose a run to follow.
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
