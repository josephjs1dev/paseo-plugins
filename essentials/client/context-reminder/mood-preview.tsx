import { Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import type { ReminderThresholds } from "../../shared/context-reminder/reminder-policy";
import type { Character } from "../../shared/context-reminder/sprite";
import { PixelSprite } from "./pixel-sprite";
import { thresholdZones, zoneRange } from "./threshold-bar";

/** The selected assistant's sprite in each threshold zone. */
export function MoodPreview({
  theme,
  character,
  thresholds,
}: {
  theme: PluginTheme;
  character: Character;
  thresholds: ReminderThresholds;
}) {
  const { colors } = theme;

  return (
    <View style={{ gap: 8 }}>
      <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>
        By threshold
      </Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>
        {thresholdZones(thresholds, colors).map((zone) => {
          const range = zoneRange(zone);
          const isEmpty = zone.to <= zone.from;

          return (
            <View
              key={zone.label}
              accessibilityLabel={`${zone.label}, ${range}`}
              style={{
                width: 120,
                alignItems: "center",
                gap: 6,
                paddingVertical: 12,
                paddingHorizontal: 8,
                borderRadius: 12,
                borderTopWidth: 3,
                borderTopColor: zone.color,
                backgroundColor: colors.surface2,
                opacity: isEmpty ? 0.5 : 1,
              }}
            >
              <PixelSprite
                character={character}
                tier={zone.tier}
                pixelSize={3}
              />
              <Text
                style={{
                  color: colors.foreground,
                  fontSize: 13,
                  fontWeight: "600",
                  textAlign: "center",
                }}
              >
                {zone.label}
              </Text>
              <Text
                style={{
                  color: colors.foregroundMuted,
                  fontSize: 12,
                  fontVariant: ["tabular-nums"],
                }}
              >
                {range}
              </Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}
