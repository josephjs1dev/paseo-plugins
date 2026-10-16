import {
  Pressable,
  Text,
  View,
  type AccessibilityRole,
  type ViewStyle,
} from "react-native";
import { useState, type ReactNode } from "react";
import { Icon } from "@getpaseo/plugin/client/react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginIconProps } from "@getpaseo/plugin/client/react-native";

/**
 * The boundary color of a filled form field: accent while focused, danger on
 * a field error, otherwise no stroke at all.
 */
export function fieldBorderColor(
  theme: PluginTheme,
  focused: boolean,
  /** An error marker: a message string or a plain flag. */
  error?: boolean | string,
): string {
  if (focused) {
    return theme.colors.accent;
  }
  return error ? theme.colors.statusDanger : "transparent";
}

export type NoticeTone = "info" | "success" | "warning" | "danger";

type ToneSpec = {
  color: keyof PluginTheme["colors"];
  icon: PluginIconProps["name"];
};

const NOTICE_TONES: Record<NoticeTone, ToneSpec> = {
  info: { color: "foreground", icon: "CircleCheck" },
  success: { color: "statusSuccess", icon: "CircleCheck" },
  warning: { color: "statusWarning", icon: "TriangleAlert" },
  danger: { color: "statusDanger", icon: "TriangleAlert" },
};

/**
 * One dismissible notice: a tinted status surface with the status-colored
 * icon and text, so warnings read yellow and successes read green in both
 * themes instead of the gray text notices they replace.
 */
export function StatusNotice({
  theme,
  tone,
  children,
  onDismiss,
  action,
  testID,
}: {
  theme: PluginTheme;
  tone: NoticeTone;
  children: ReactNode;
  /** Renders a trailing "Dismiss" control when given. */
  onDismiss?: (this: void) => void;
  /** A trailing action control, such as a reload button. */
  action?: ReactNode;
  testID?: string;
}) {
  const spec = NOTICE_TONES[tone];
  const color = theme.colors[spec.color];
  const role = (
    tone === "danger" || tone === "warning" ? "alert" : undefined
  ) as AccessibilityRole | undefined;
  return (
    <View
      testID={testID}
      accessibilityRole={role}
      style={{
        borderRadius: 10,
        backgroundColor: theme.colors.surface1,
      }}
    >
      <TintedView color={color} opacity={0.16}>
        <View
          style={{
            padding: 12,
            gap: 8,
          }}
        >
          <View
            style={{
              flexDirection: "row",
              alignItems: "flex-start",
              gap: 8,
            }}
          >
            <View aria-hidden accessible={false} style={{ marginTop: 1 }}>
              <Icon name={spec.icon} size={15} color={color} />
            </View>
            <Text
              style={{
                color: theme.colors.foreground,
                fontSize: 13,
                lineHeight: 19,
                flexShrink: 1,
              }}
            >
              {children}
            </Text>
            {onDismiss && (
              <Pressable
                testID="profiles-notice-dismiss"
                accessibilityRole="button"
                accessibilityLabel="Dismiss notice"
                onPress={onDismiss}
                style={({ pressed }) => ({
                  marginLeft: "auto",
                  minHeight: 24,
                  minWidth: 24,
                  alignItems: "center",
                  justifyContent: "center",
                  borderRadius: 6,
                  opacity: pressed ? 0.7 : 1,
                })}
              >
                <Icon name="X" size={14} color={color} />
              </Pressable>
            )}
          </View>
          {action}
        </View>
      </TintedView>
    </View>
  );
}

/**
 * A surface washed with one theme color: an absolutely-positioned tint layer
 * paints first beneath the children, so a token color reads as a soft,
 * theme-correct background in light and dark without inventing a fixed hex.
 */
export function TintedView({
  color,
  opacity = 0.14,
  style,
  /** Optional test id for the tint layer itself (contrast, bounds checks). */
  testID,
  children,
}: {
  /** The token color washed over the view's own background. */
  color: string;
  opacity?: number;
  style?: ViewStyle;
  testID?: string | undefined;
  children?: ReactNode;
}) {
  return (
    <View style={[style, { overflow: "hidden" }]}>
      <View
        aria-hidden
        accessible={false}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        testID={testID}
        style={{
          position: "absolute",
          top: 0,
          right: 0,
          bottom: 0,
          left: 0,
          backgroundColor: color,
          opacity,
        }}
      />
      {children}
    </View>
  );
}

/** One choice in a segmented control. */
export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  /** Full accessible name when the short label alone is not enough. */
  accessibilityLabel?: string | undefined;
}

/**
 * A pill-shaped segmented control: the active segment fills with the accent,
 * at most 44px tall in compact layouts. Pressing the active segment clears
 * the choice when `allowClear`, which a size control uses to unset it.
 */
export function Segmented<T extends string>({
  theme,
  options,
  value,
  onChange,
  allowClear = false,
  compact = false,
}: {
  theme: PluginTheme;
  options: readonly SegmentOption<T>[];
  /** The selected value, or "" when nothing is chosen. */
  value: T | "";
  onChange(this: void, value: T | ""): void;
  allowClear?: boolean;
  compact?: boolean;
}) {
  const [focus, setFocus] = useState<T | "">("");
  return (
    <View
      accessibilityRole="radiogroup"
      style={{
        maxWidth: 360,
        alignSelf: "flex-start",
        minWidth: 240,
        flexDirection: "row",
        gap: 2,
        padding: 2,
        borderRadius: 10,
        backgroundColor: theme.colors.surface2,
      }}
    >
      {options.map((option) => {
        const active = option.value === value;
        const focused = option.value === focus;
        return (
          <Pressable
            key={option.value}
            testID={`profile-segment-${option.value}`}
            accessibilityRole="button"
            accessibilityLabel={option.accessibilityLabel ?? option.label}
            accessibilityState={{ selected: active && Boolean(value) }}
            aria-pressed={active}
            disabled={active && !allowClear}
            onPress={() => onChange(active && allowClear ? "" : option.value)}
            onFocus={() => setFocus(option.value)}
            onBlur={() =>
              setFocus((current) => (current === option.value ? "" : current))
            }
            style={({ pressed }) => ({
              flex: 1,
              minHeight: compact ? 44 : 30,
              alignItems: "center",
              justifyContent: "center",
              paddingHorizontal: 10,
              borderRadius: 8,
              borderWidth: 1,
              borderColor: focused ? theme.colors.accent : "transparent",
              backgroundColor: active ? theme.colors.accent : "transparent",
              opacity: pressed ? 0.85 : 1,
            })}
          >
            <Text
              numberOfLines={1}
              style={{
                color: active
                  ? theme.colors.accentForeground
                  : theme.colors.foreground,
                fontSize: 13,
                lineHeight: 18,
                fontWeight: active ? "600" : "400",
              }}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
