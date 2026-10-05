import { useState } from "react";
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { Pressable, Text, View } from "react-native";
import { providerDefinitions, type Provider } from "../shared/providers";
import type { Usage } from "../shared/usage";
import { ProviderLogo } from "./provider-logo";

export function UsageUnavailable({
  theme,
  provider,
  issue,
  message,
  refreshing,
  onRetry,
}: {
  theme: PluginTheme;
  provider: Provider;
  issue: Usage["issue"];
  message: string;
  refreshing: boolean;
  onRetry(): void;
}) {
  const [expanded, setExpanded] = useState(false);
  const { colors } = theme;
  const name = providerDefinitions[provider].name;
  const signIn = issue === "sign-in";
  const rateLimited = issue === "rate-limit";
  const title = signIn ? `Connect ${name}` : "Usage unavailable";
  const retryLabel = signIn ? "Check connection" : "Try again";
  let description =
    "We couldn’t retrieve your remaining quota. Try again shortly.";

  if (signIn) {
    description =
      "Sign in to Claude Code on this host to see your remaining quota.";
  } else if (rateLimited) {
    description = `${name} is limiting usage checks. Try again in a few minutes.`;
  }

  return (
    <View style={{ gap: 8 }}>
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
            {title}
          </Text>
          <Text
            style={{
              color: colors.foregroundMuted,
              fontSize: 13,
              lineHeight: 20,
            }}
          >
            {description}
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: refreshing, busy: refreshing }}
          disabled={refreshing}
          onPress={onRetry}
          style={({ pressed }) => ({
            minHeight: 44,
            paddingHorizontal: 16,
            alignSelf: "flex-start",
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
            borderRadius: 8,
            backgroundColor: colors.foreground,
            opacity: refreshing || pressed ? 0.65 : 1,
          })}
        >
          <Icon name="RefreshCw" size={14} color={colors.surface0} />
          <Text
            style={{
              color: colors.surface0,
              fontSize: 13,
              lineHeight: 20,
              fontWeight: "600",
            }}
          >
            {refreshing ? "Checking…" : retryLabel}
          </Text>
        </Pressable>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        aria-expanded={expanded}
        onPress={() => setExpanded((value) => !value)}
        style={({ pressed }) => ({
          minHeight: 44,
          paddingHorizontal: 4,
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          opacity: pressed ? 0.65 : 1,
        })}
      >
        <Icon
          name={expanded ? "ChevronDown" : "ChevronRight"}
          size={14}
          color={colors.foregroundMuted}
        />
        <Text
          style={{
            color: colors.foregroundMuted,
            fontSize: 12,
            lineHeight: 18,
          }}
        >
          {signIn ? "Connection details" : "Details"}
        </Text>
      </Pressable>
      {expanded && (
        <Text
          selectable
          style={{
            color: colors.foregroundMuted,
            fontSize: 12,
            lineHeight: 19,
            paddingHorizontal: 4,
          }}
        >
          {message}
        </Text>
      )}
    </View>
  );
}
