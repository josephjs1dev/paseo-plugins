import { useState } from "react";
import {
  useWorkspace,
  type PluginButtonContentProps,
} from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { Pressable, Text, View } from "react-native";
import {
  providerDefinitions,
  providerIds,
  type Provider,
} from "../shared/providers";
import { compactTokens, totalTokens } from "../shared/history-display";
import {
  HistoryAction,
  HistoryChoice,
  HistoryOptions,
  HistorySection,
} from "./history-controls";
import { ModelUsage, SessionUsage } from "./history";
import { useHistoryQuery } from "./history-query";

export function WorkspaceUsage({
  theme,
  layout,
  host,
  workspaceId,
  initialProvider,
  close,
  onOpenHistory,
}: PluginButtonContentProps & {
  initialProvider: Provider;
  onOpenHistory(provider: Provider, days: 7 | 30): void;
}) {
  const name = useWorkspace(workspaceId, (workspace) => workspace.name);
  const [provider, setProvider] = useState(initialProvider);
  const [days, setDays] = useState<7 | 30>(7);
  const query = useHistoryQuery(
    host.id,
    workspaceId,
    provider,
    days,
    0,
    "workspace",
  );
  const data = query.data;
  const { colors } = theme;

  return (
    <View
      style={{
        width: layout.compact ? "100%" : 480,
        maxWidth: "100%",
        gap: 24,
      }}
    >
      <View style={{ gap: 4 }}>
        <Text
          accessibilityRole="header"
          style={{
            color: colors.foreground,
            fontSize: 18,
            lineHeight: 26,
            fontWeight: "600",
          }}
        >
          Workspace usage
        </Text>
        <Text
          style={{
            color: colors.foregroundMuted,
            fontSize: 12,
            lineHeight: 18,
          }}
        >
          {name ?? "This workspace"}
        </Text>
      </View>
      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 8,
        }}
      >
        <HistoryOptions theme={theme} label="Provider">
          {providerIds.map((id) => (
            <HistoryChoice
              key={id}
              theme={theme}
              selected={provider === id}
              onPress={() => setProvider(id)}
            >
              {providerDefinitions[id].name}
            </HistoryChoice>
          ))}
        </HistoryOptions>
        <HistoryOptions theme={theme} label="Time period">
          {([7, 30] as const).map((range) => (
            <HistoryChoice
              key={range}
              theme={theme}
              selected={days === range}
              onPress={() => setDays(range)}
            >
              {range + "d"}
            </HistoryChoice>
          ))}
        </HistoryOptions>
      </View>
      {query.isPending && (
        <Text style={{ color: colors.foregroundMuted, fontSize: 13 }}>
          Loading workspace usage…
        </Text>
      )}
      {query.isError && (
        <HistoryAction
          theme={theme}
          onPress={() => {
            void query.refetch();
          }}
        >
          Usage unavailable · retry
        </HistoryAction>
      )}
      {data && (
        <>
          {data.warning !== "" && (
            <Text
              style={{ color: colors.foreground, fontSize: 13, lineHeight: 20 }}
            >
              History may be incomplete. Showing saved usage.
            </Text>
          )}
          <View
            style={{
              padding: 16,
              borderRadius: 8,
              backgroundColor: colors.surface1,
              gap: 4,
            }}
          >
            <Text
              style={{
                color: colors.foregroundMuted,
                fontSize: 12,
                lineHeight: 18,
              }}
            >
              Tokens used · {days} days
            </Text>
            <Text
              selectable
              style={{
                color: colors.foreground,
                fontSize: 28,
                lineHeight: 36,
                fontWeight: "600",
                fontVariant: ["tabular-nums"],
              }}
            >
              {compactTokens(totalTokens(data.workspaceTotals))}
            </Text>
            <Text
              style={{
                color: colors.foregroundMuted,
                fontSize: 12,
                lineHeight: 18,
              }}
            >
              {data.workspaceSessionCount} sessions
            </Text>
          </View>
          <HistorySection theme={theme} title="Models">
            <ModelUsage
              key={provider}
              theme={theme}
              models={data.workspaceModels}
            />
          </HistorySection>
          <HistorySection
            theme={theme}
            title="Recent sessions"
            description="Latest 5 · select a session for details"
            trailing={
              <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>
                Tokens
              </Text>
            }
          >
            <View>
              {data.sessions.slice(0, 5).map((session) => (
                <SessionUsage
                  key={session.sessionId}
                  theme={theme}
                  session={session}
                />
              ))}
              {data.workspaceSessionCount === 0 && (
                <Text style={{ color: colors.foregroundMuted, fontSize: 13 }}>
                  No sessions recorded in this period.
                </Text>
              )}
            </View>
          </HistorySection>
        </>
      )}
      <Pressable
        accessibilityRole="button"
        onPress={() => {
          close();
          onOpenHistory(provider, days);
        }}
        style={{
          minHeight: 44,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <Text
          style={{
            color: colors.foreground,
            fontSize: 13,
            lineHeight: 20,
            fontWeight: "500",
          }}
        >
          Open usage tab
        </Text>
        <Icon name="PanelsTopLeft" size={16} color={colors.foregroundMuted} />
      </Pressable>
    </View>
  );
}
