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
import {
  sessionKey,
  compactTokens,
  formatCreditEstimate,
  totalTokens,
} from "../shared/history-display";
import {
  HistoryAction,
  HistoryChoice,
  HistoryOptions,
  HistorySection,
  HistoryValue,
} from "./history-controls";
import { ModelUsage, SessionUsage } from "./history";
import { useHistoryQuery } from "./history-query";
import { ProviderLogo } from "./provider-logo";

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
  const refreshing = query.isFetching || (data?.refreshing ?? false);
  const hasSessions = data !== undefined && data.workspaceSessionCount > 0;
  const providerName = providerDefinitions[provider].name;
  const partial = data?.warning !== undefined && data.warning !== "";
  let emptyTitle = `No ${providerName} usage yet`;
  let emptyMessage = `Usage from ${providerName} sessions in this workspace will appear here. Try a longer time range or refresh after a session.`;

  if (refreshing) {
    emptyTitle = "Reading session history…";
    emptyMessage = "Checking local sessions on this host.";
  } else if (partial) {
    emptyTitle = "History is incomplete";
    emptyMessage =
      "Some local records could not be read. Try refreshing to check again.";
  }

  return (
    <View
      style={{
        width: layout.compact ? "100%" : 480,
        maxWidth: "100%",
        gap: 20,
      }}
    >
      <View style={{ gap: 4 }}>
        <Text
          accessibilityRole="header"
          style={{
            color: colors.foreground,
            fontSize: 16,
            lineHeight: 24,
            fontWeight: "600",
          }}
        >
          Workspace usage
        </Text>
        <Text
          numberOfLines={1}
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
          justifyContent: "space-between",
          alignItems: "center",
          gap: 12,
        }}
      >
        <View
          role="group"
          accessibilityLabel="Usage provider"
          style={{ flexDirection: "row", gap: 4 }}
        >
          {providerIds.map((id) => {
            const selected = provider === id;

            return (
              <Pressable
                key={id}
                accessibilityRole="button"
                accessibilityLabel={providerDefinitions[id].name}
                accessibilityState={{ selected }}
                aria-pressed={selected}
                onPress={() => setProvider(id)}
                style={({ pressed }) => ({
                  width: 44,
                  height: 44,
                  borderRadius: 8,
                  borderWidth: 1,
                  borderColor: selected ? colors.accent : "transparent",
                  backgroundColor: selected ? colors.surface2 : "transparent",
                  alignItems: "center",
                  justifyContent: "center",
                  opacity: pressed ? 0.65 : 1,
                })}
              >
                <ProviderLogo
                  provider={id}
                  size={24}
                  color={selected ? colors.foreground : colors.foregroundMuted}
                  backgroundColor={selected ? colors.surface2 : colors.surface0}
                />
              </Pressable>
            );
          })}
        </View>
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
      {query.isError && (
        <Text
          accessibilityRole="alert"
          style={{ color: colors.statusDanger, fontSize: 13, lineHeight: 20 }}
        >
          {data
            ? "Could not refresh history. Showing the last available records."
            : "Could not load workspace usage. Check this host’s connection and try refreshing."}
        </Text>
      )}
      {partial && hasSessions && (
        <Text
          style={{
            color: colors.foregroundMuted,
            fontSize: 12,
            lineHeight: 18,
          }}
        >
          Some session records could not be read. Totals include available and
          saved usage.
        </Text>
      )}
      {hasSessions && data ? (
        <>
          <View
            style={{
              padding: 20,
              borderRadius: 12,
              backgroundColor: colors.surface1,
              gap: 16,
            }}
          >
            <View style={{ gap: 6 }}>
              <Text
                style={{
                  color: colors.foregroundMuted,
                  fontSize: 12,
                  lineHeight: 18,
                }}
              >
                {providerName} · last {days} days
              </Text>
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "baseline",
                  flexWrap: "wrap",
                  gap: 8,
                }}
              >
                <Text
                  selectable
                  style={{
                    color: colors.foreground,
                    fontSize: 32,
                    lineHeight: 40,
                    fontWeight: "600",
                    fontVariant: ["tabular-nums"],
                  }}
                >
                  {compactTokens(totalTokens(data.workspaceTotals))}
                </Text>
                <Text
                  style={{
                    color: colors.foregroundMuted,
                    fontSize: 13,
                    lineHeight: 20,
                  }}
                >
                  tokens
                </Text>
              </View>
              <Text
                style={{
                  color: colors.foregroundMuted,
                  fontSize: 12,
                  lineHeight: 18,
                }}
              >
                {data.workspaceSessionCount}{" "}
                {data.workspaceSessionCount === 1 ? "session" : "sessions"} in
                this workspace
              </Text>
            </View>
            <View
              style={{
                flexDirection: "row",
                flexWrap: "wrap",
                gap: 16,
                borderTopWidth: 1,
                borderTopColor: colors.border,
                paddingTop: 16,
              }}
            >
              {[
                { label: "Input", value: data.workspaceTotals.input },
                { label: "Output", value: data.workspaceTotals.output },
                { label: "Cache reads", value: data.workspaceTotals.cached },
              ].map(({ label, value }) => (
                <View key={label} style={{ flex: 1, minWidth: 64, gap: 4 }}>
                  <Text
                    style={{
                      color: colors.foregroundMuted,
                      fontSize: 11,
                      lineHeight: 16,
                    }}
                  >
                    {label}
                  </Text>
                  <Text
                    selectable
                    style={{
                      color: colors.foreground,
                      fontSize: 16,
                      lineHeight: 24,
                      fontWeight: "500",
                      fontVariant: ["tabular-nums"],
                    }}
                  >
                    {compactTokens(value)}
                  </Text>
                </View>
              ))}
            </View>
            <Text
              style={{
                color: colors.foregroundMuted,
                fontSize: 11,
                lineHeight: 16,
              }}
            >
              Cache reads are included in input.
            </Text>
            {provider === "chatgpt" && (
              <HistoryValue
                theme={theme}
                label="Estimated credits"
                value={formatCreditEstimate(
                  data.workspaceTotals.creditEstimate,
                )}
              />
            )}
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
            description="Latest 5 · select for token details"
          >
            <View>
              {data.sessions.slice(0, 5).map((session) => (
                <SessionUsage
                  key={sessionKey(session)}
                  theme={theme}
                  session={session}
                />
              ))}
            </View>
          </HistorySection>
        </>
      ) : (
        !query.isError && (
          <View
            style={{
              padding: 20,
              gap: 16,
              borderRadius: 12,
              backgroundColor: colors.surface1,
            }}
          >
            <ProviderLogo
              provider={provider}
              size={32}
              color={colors.foregroundMuted}
              backgroundColor={colors.surface1}
            />
            <View accessibilityLiveRegion="polite" style={{ gap: 6 }}>
              <Text
                style={{
                  color: colors.foreground,
                  fontSize: 15,
                  lineHeight: 22,
                  fontWeight: "600",
                }}
              >
                {emptyTitle}
              </Text>
              <Text
                style={{
                  color: colors.foregroundMuted,
                  fontSize: 13,
                  lineHeight: 20,
                }}
              >
                {emptyMessage}
              </Text>
            </View>
          </View>
        )
      )}
      <View
        style={{
          flexDirection: "row",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 8,
        }}
      >
        <Text
          style={{
            color: colors.foregroundMuted,
            fontSize: 11,
            lineHeight: 18,
            flexShrink: 1,
          }}
        >
          {data?.scannedAt
            ? `Local history · ${new Date(data.scannedAt).toLocaleTimeString()}`
            : "Local session history on this host"}
        </Text>
        <HistoryAction
          theme={theme}
          disabled={refreshing}
          onPress={() => {
            void query.refresh();
          }}
        >
          {refreshing ? "Refreshing…" : "Refresh"}
        </HistoryAction>
      </View>
      <Pressable
        accessibilityRole="button"
        onPress={() => {
          close();
          onOpenHistory(provider, days);
        }}
        style={{
          minHeight: 44,
          paddingTop: 12,
          borderTopWidth: 1,
          borderTopColor: colors.border,
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
          Open usage history
        </Text>
        <Icon name="ArrowUpRight" size={16} color={colors.foregroundMuted} />
      </Pressable>
    </View>
  );
}
