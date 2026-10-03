import type { PluginTheme } from "@getpaseo/plugin";
import { Text, View } from "react-native";

import type { Usage } from "../shared/usage";
import { formatResetTime, remainingPercent } from "../shared/usage-display";

interface QuotaWindowProps {
  quota: Usage["windows"][number];
  theme: PluginTheme;
}

export function QuotaWindow({ quota, theme }: QuotaWindowProps) {
  const { colors } = theme;
  const remaining = remainingPercent(quota.usedPercent);
  const statusColor = getStatusColor(remaining, theme);

  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text
          style={{
            color: colors.foreground,
            fontSize: 14,
            fontWeight: "600",
            flexShrink: 1,
          }}
        >
          {quota.name}
        </Text>
        <View
          style={{
            width: 6,
            height: 6,
            borderRadius: 3,
            backgroundColor: statusColor,
          }}
        />
      </View>

      <View
        accessibilityRole="progressbar"
        accessibilityLabel={`${quota.name} remaining`}
        accessibilityValue={{
          min: 0,
          max: 100,
          now: remaining,
          text: `${Math.round(remaining)}% left`,
        }}
        style={{
          height: 6,
          borderRadius: 3,
          backgroundColor: colors.surface2,
          overflow: "hidden",
        }}
      >
        <View
          style={{
            height: 6,
            borderRadius: 3,
            width: `${remaining}%`,
            backgroundColor: colors.foreground,
          }}
        />
      </View>

      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <Text style={{ color: colors.foregroundMuted, fontSize: 13 }}>
          {Math.round(remaining)}% left
        </Text>
        <Text style={{ color: colors.foregroundMuted, fontSize: 13 }}>
          {formatResetTime(quota.resetsAt)}
        </Text>
      </View>
    </View>
  );
}

function getStatusColor(remaining: number, theme: PluginTheme): string {
  if (remaining <= 10) {
    return theme.colors.statusDanger;
  }

  if (remaining <= 30) {
    return theme.colors.statusWarning;
  }

  return theme.colors.statusSuccess;
}
