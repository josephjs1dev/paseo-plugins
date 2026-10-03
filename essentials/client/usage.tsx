import { useState } from "react";
import { useRpc, type PluginButtonContentProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import { Pressable, Text, View } from "react-native";
import {
  providerDefinitions,
  providerIds,
  type Provider,
} from "../shared/providers";
import { readUsage, type Usage } from "../shared/usage";
import { creditBalanceLabel } from "../shared/usage-display";
import { CodexReset } from "./codex-reset";
import { QuotaWindow } from "./quota-window";
import { ProviderLogo } from "./provider-logo";
import { HistoryAction, HistoryValue } from "./history-controls";

type UsagePopoverProps = PluginButtonContentProps & {
  initialProvider: Provider;
  onProviderChange(provider: Provider): void;
  onOpenHistory(provider: Provider): void;
  onUsageChange(usage: Usage): void;
};

export function UsagePopover(props: UsagePopoverProps) {
  const { theme, layout, initialProvider, onProviderChange } = props;
  const [provider, setProvider] = useState(initialProvider);
  const { colors } = theme;

  return (
    <View
      style={{
        width: layout.compact ? "100%" : 480,
        maxWidth: "100%",
        flexDirection: "row",
        gap: layout.compact ? 12 : 20,
      }}
    >
      <View
        role="group"
        accessibilityLabel="Usage provider"
        style={{
          width: 57,
          flexShrink: 0,
          gap: 8,
          paddingRight: 12,
          borderRightWidth: 1,
          borderRightColor: colors.border,
        }}
      >
        {providerIds.map((id) => {
          const selected = id === provider;

          return (
            <Pressable
              key={id}
              accessibilityRole="button"
              accessibilityLabel={providerDefinitions[id].name}
              accessibilityState={{ selected }}
              onPress={() => {
                setProvider(id);
                onProviderChange(id);
              }}
              style={({ pressed }) => ({
                width: 44,
                height: 44,
                borderRadius: 8,
                borderWidth: 1,
                borderColor: selected ? colors.accent : "transparent",
                alignItems: "center",
                justifyContent: "center",
                opacity: pressed ? 0.7 : 1,
                backgroundColor: selected ? colors.surface2 : "transparent",
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
      <View style={{ flex: 1, minWidth: 0 }}>
        <UsageDetails
          key={`${props.host.id}:${provider}`}
          {...props}
          provider={provider}
        />
      </View>
    </View>
  );
}

function UsageDetails(props: UsagePopoverProps & { provider: Provider }) {
  const { provider, theme, host } = props;
  const { colors } = theme;
  const read = useRpc(readUsage);
  const query = useQuery({
    queryKey: ["nestkit-usage", host.id, provider],
    queryFn: () => read({ provider }),
    refetchInterval: 60_000,
    staleTime: 30_000,
    retry: false,
  });
  const usage = query.data;

  return (
    <View style={{ gap: 20 }}>
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
          Remaining quota
        </Text>
        <Text
          style={{
            color: colors.foregroundMuted,
            fontSize: 12,
            lineHeight: 18,
          }}
        >
          {providerDefinitions[provider].name} · all sessions
        </Text>
      </View>
      {query.isPending && (
        <Text style={{ color: colors.foregroundMuted, fontSize: 13 }}>
          Loading usage…
        </Text>
      )}
      {query.isError && (
        <Text
          accessibilityRole="alert"
          style={{ color: colors.statusDanger, fontSize: 13, lineHeight: 20 }}
        >
          Could not refresh usage. Showing the previous check, if available.
        </Text>
      )}
      {usage?.status === "unavailable" && (
        <Text
          style={{ color: colors.foreground, fontSize: 13, lineHeight: 20 }}
        >
          {usage.message}
        </Text>
      )}
      {usage?.windows.map((quota, index) => (
        <QuotaWindow key={quota.name + index} quota={quota} theme={theme} />
      ))}
      {provider === "codex" && usage && (
        <View style={{ gap: 16 }}>
          <HistoryValue
            theme={theme}
            label="Credit balance"
            value={creditBalanceLabel(usage.credits)}
          />
          <CodexReset
            theme={theme}
            host={host}
            layout={props.layout}
            usage={usage}
            onUsageChange={props.onUsageChange}
          />
        </View>
      )}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
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
          {usage
            ? "Updated " + new Date(usage.checkedAt).toLocaleTimeString()
            : "Updates every minute"}
        </Text>
        <HistoryAction
          theme={theme}
          disabled={query.isFetching}
          onPress={() => {
            void query.refetch();
          }}
        >
          {query.isFetching ? "Refreshing…" : "Refresh"}
        </HistoryAction>
      </View>
      <Pressable
        accessibilityRole="button"
        onPress={() => {
          props.close();
          props.onOpenHistory(provider);
        }}
        style={{
          minHeight: 44,
          borderTopWidth: 1,
          borderTopColor: colors.border,
          paddingTop: 12,
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
