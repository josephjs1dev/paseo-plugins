import type { ReactNode } from "react";
import type { PluginHostProps } from "@getpaseo/plugin/client";
import { Pressable, Text, View } from "react-native";

type Themed = Pick<PluginHostProps, "theme">;

export function HistoryChoice({
  theme,
  selected,
  onPress,
  children,
}: Themed & {
  selected: boolean;
  onPress(): void;
  children: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 40,
        justifyContent: "center",
        paddingHorizontal: 12,
        borderRadius: 6,
        backgroundColor:
          selected || pressed ? theme.colors.surface2 : "transparent",
      })}
    >
      <Text
        style={{
          color: selected
            ? theme.colors.foreground
            : theme.colors.foregroundMuted,
          fontSize: 13,
          lineHeight: 20,
          fontWeight: selected ? "600" : "400",
        }}
      >
        {children}
      </Text>
    </Pressable>
  );
}

export function HistoryOptions({
  theme,
  label,
  children,
}: Themed & { label: string; children: ReactNode }) {
  return (
    <View
      role="group"
      accessibilityLabel={label}
      style={{
        flexDirection: "row",
        flexWrap: "wrap",
        padding: 3,
        gap: 2,
        borderRadius: 8,
        backgroundColor: theme.colors.surface1,
      }}
    >
      {children}
    </View>
  );
}

export function HistoryAction({
  theme,
  children,
  onPress,
  disabled = false,
}: Themed & {
  children: string;
  onPress(): void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 40,
        justifyContent: "center",
        paddingHorizontal: 12,
        borderRadius: 6,
        opacity: disabled ? 0.5 : 1,
        backgroundColor: pressed ? theme.colors.surface2 : "transparent",
      })}
    >
      <Text
        style={{
          color: theme.colors.foreground,
          fontSize: 13,
          lineHeight: 20,
          fontWeight: "500",
        }}
      >
        {children}
      </Text>
    </Pressable>
  );
}

export function HistorySection({
  theme,
  title,
  description,
  trailing,
  children,
}: Themed & {
  title: string;
  description?: string;
  trailing?: ReactNode;
  children: ReactNode;
}) {
  return (
    <View style={{ gap: 16 }}>
      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <View style={{ gap: 4 }}>
          <Text
            accessibilityRole="header"
            style={{
              color: theme.colors.foreground,
              fontSize: 16,
              lineHeight: 24,
              fontWeight: "600",
            }}
          >
            {title}
          </Text>
          {description && (
            <Text
              style={{
                color: theme.colors.foregroundMuted,
                fontSize: 12,
                lineHeight: 18,
              }}
            >
              {description}
            </Text>
          )}
        </View>
        {trailing}
      </View>
      {children}
    </View>
  );
}

export function HistoryValue({
  theme,
  label,
  value,
  nested = false,
}: Themed & { label: string; value: string; nested?: boolean }) {
  const color = nested ? theme.colors.foregroundMuted : theme.colors.foreground;

  return (
    <View
      style={{
        flexDirection: "row",
        justifyContent: "space-between",
        gap: 16,
        paddingLeft: nested ? 12 : 0,
      }}
    >
      <Text style={{ color, flexShrink: 1, fontSize: 13, lineHeight: 22 }}>
        {label}
      </Text>
      <Text
        selectable
        style={{
          color,
          fontSize: 13,
          lineHeight: 22,
          fontVariant: ["tabular-nums"],
          textAlign: "right",
        }}
      >
        {value}
      </Text>
    </View>
  );
}
