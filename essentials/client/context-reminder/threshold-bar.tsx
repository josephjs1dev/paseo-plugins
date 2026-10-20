import { Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import type {
  ReminderThresholds,
  ReminderTier,
} from "../../shared/context-reminder/reminder-policy";

export interface Zone {
  label: string;
  tier: ReminderTier | null;
  color: string;
  from: number;
  to: number;
}

export function thresholdZones(
  { warnPercent, askPercent }: ReminderThresholds,
  colors: PluginTheme["colors"],
): Zone[] {
  const askFrom = Math.max(warnPercent, askPercent);

  return [
    {
      label: "Quiet",
      tier: null,
      color: colors.border,
      from: 0,
      to: warnPercent,
    },
    {
      label: "Pill and cards",
      tier: "warn",
      color: colors.statusWarning,
      from: warnPercent,
      to: askFrom,
    },
    {
      label: "Ask to compact",
      tier: "ask",
      color: colors.statusDanger,
      from: askFrom,
      to: 100,
    },
  ];
}

export function zoneRange({ from, to }: Zone): string {
  if (to <= from) {
    return "none";
  }

  return to === 100 ? `${from}–100%` : `${from}–${to - 1}%`;
}

/** A 0-100% bar split into the quiet, warn, and ask zones, with a legend. */
export function ThresholdBar({
  theme,
  thresholds,
}: {
  theme: PluginTheme;
  thresholds: ReminderThresholds;
}) {
  const { colors } = theme;
  const parts = thresholdZones(thresholds, colors);

  return (
    <View style={{ gap: 10, width: "100%" }}>
      <View
        accessibilityRole="image"
        accessibilityLabel={parts
          .map((zone) => `${zone.label} ${zoneRange(zone)}`)
          .join(", ")}
        style={{
          flexDirection: "row",
          height: 10,
          borderRadius: 5,
          overflow: "hidden",
          backgroundColor: colors.surface2,
        }}
      >
        {parts.map((zone) => (
          <View
            key={zone.label}
            style={{
              width: `${zone.to - zone.from}%`,
              backgroundColor: zone.color,
            }}
          />
        ))}
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 14 }}>
        {parts.map((zone) => (
          <View
            key={zone.label}
            style={{ flexDirection: "row", alignItems: "center", gap: 6 }}
          >
            <View
              style={{
                width: 10,
                height: 10,
                borderRadius: 3,
                backgroundColor: zone.color,
              }}
            />
            <Text style={{ color: colors.foreground, fontSize: 12 }}>
              {zone.label}
            </Text>
            <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>
              {zoneRange(zone)}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}
