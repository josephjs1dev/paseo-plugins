import { useState } from "react";
import { ActivityIndicator, Pressable } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";

export function RefreshButton({
  theme,
  refreshing,
  onPress,
}: {
  theme: PluginTheme;
  refreshing: boolean;
  onPress(this: void): void;
}) {
  const [focused, setFocused] = useState(false);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Refresh"
      accessibilityHint="Refresh the current Podium section"
      accessibilityState={{ disabled: refreshing, busy: refreshing }}
      aria-busy={refreshing}
      disabled={refreshing}
      onPress={onPress}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={({ pressed }) => ({
        width: 44,
        height: 44,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: focused ? theme.colors.foreground : "transparent",
        alignItems: "center",
        justifyContent: "center",
        opacity: refreshing || pressed ? 0.5 : 1,
      })}
    >
      {refreshing ? (
        <ActivityIndicator size="small" color={theme.colors.foreground} />
      ) : (
        <Icon name="RefreshCw" size={18} color={theme.colors.foreground} />
      )}
    </Pressable>
  );
}
