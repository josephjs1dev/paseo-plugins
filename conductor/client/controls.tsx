import { Pressable, Text, View, type ViewStyle } from "react-native";
import { useState, type ReactNode } from "react";
import type { PluginTheme } from "@getpaseo/plugin";

export interface ButtonProps {
  theme: PluginTheme;
  label: string;
  onPress(this: void): void;
  disabled?: boolean;
  selected?: boolean;
  primary?: boolean;
  danger?: boolean;
  testID?: string;
  variant?: "default" | "quiet" | "tab";
  dense?: boolean;
  count?: number;
}
export function Button({
  theme,
  label,
  onPress,
  disabled = false,
  selected = false,
  primary = false,
  danger = false,
  testID,
  variant = "default",
  dense = false,
  count,
}: ButtonProps) {
  const [focused, setFocused] = useState(false);
  const color = primary ? theme.colors.surface0 : theme.colors.foreground;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, selected }}
      disabled={disabled}
      onPress={onPress}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={({ pressed }) => ({
        minHeight: dense ? 34 : 44,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 7,
        paddingHorizontal: variant === "tab" ? 10 : 12,
        paddingVertical: dense ? 6 : 10,
        borderRadius: variant === "tab" ? 0 : 6,
        borderWidth: 1,
        borderColor: focused ? theme.colors.foreground : "transparent",
        ...(variant === "default" && !focused
          ? {
              borderColor: selected
                ? theme.colors.foreground
                : theme.colors.border,
            }
          : {}),
        ...(variant === "tab"
          ? {
              borderBottomWidth: 2,
              borderBottomColor: selected
                ? theme.colors.foreground
                : "transparent",
            }
          : {}),
        backgroundColor: primary ? theme.colors.foreground : "transparent",
        opacity: disabled ? 0.5 : 1,
        ...(pressed ? { opacity: 0.8 } : {}),
      })}
    >
      <Text
        style={{
          color: danger ? theme.colors.statusDanger : color,
          fontSize: 13,
          lineHeight: 18,
          textAlign: "center",
          fontWeight: selected || primary ? "600" : "400",
        }}
      >
        {label}
      </Text>
      {count !== undefined && (
        <Text
          style={{
            color: theme.colors.foregroundMuted,
            fontSize: 11,
            lineHeight: 18,
            fontVariant: ["tabular-nums"],
          }}
        >
          {count}
        </Text>
      )}
    </Pressable>
  );
}
export function Label({
  theme,
  children,
}: {
  theme: PluginTheme;
  children: ReactNode;
}) {
  return (
    <Text
      style={{
        color: theme.colors.foregroundMuted,
        fontSize: 11,
        fontWeight: "600",
        letterSpacing: 1.2,
      }}
    >
      {children}
    </Text>
  );
}
export function Notice({
  theme,
  children,
  warning = false,
}: {
  theme: PluginTheme;
  children: ReactNode;
  warning?: boolean;
}) {
  return (
    <View
      accessibilityRole="alert"
      style={{
        padding: 14,
        gap: 6,
        borderWidth: 1,
        borderRadius: 8,
        borderColor: warning ? theme.colors.statusWarning : theme.colors.border,
        backgroundColor: theme.colors.surface1,
      }}
    >
      <Text
        style={{ fontSize: 13, lineHeight: 20, color: theme.colors.foreground }}
      >
        {children}
      </Text>
    </View>
  );
}
export const rowStyle = {
  flexDirection: "row",
  flexWrap: "wrap",
  alignItems: "center",
  gap: 8,
} satisfies ViewStyle;
