import { ActivityIndicator, Pressable, Text, View } from "react-native";
import type { PluginButtonContentProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { cliNames, type CliStatus } from "../shared/cli-maintenance";

type Theme = PluginButtonContentProps["theme"];

export function MaintenanceAction({
  theme,
  label,
  onPress,
  disabled = false,
  primary = false,
  pending = false,
  accessibilityLabel,
  icon,
}: {
  theme: Theme;
  label: string;
  onPress(): void;
  disabled?: boolean;
  primary?: boolean;
  pending?: boolean;
  accessibilityLabel?: string;
  icon?: string;
}) {
  const color = primary
    ? theme.colors.accentForeground
    : theme.colors.foreground;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: disabled || pending, busy: pending }}
      disabled={disabled || pending}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 44,
        minWidth: 44,
        paddingHorizontal: icon ? 0 : 14,
        borderRadius: 8,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        borderWidth: 1,
        borderColor: primary ? theme.colors.accent : theme.colors.border,
        backgroundColor: primary ? theme.colors.accent : theme.colors.surface0,
        opacity: disabled && !pending ? 0.45 : 1,
        ...(pressed ? { opacity: 0.7 } : {}),
      })}
    >
      {pending && <ActivityIndicator size="small" color={color} />}
      {!pending && icon && <Icon name={icon} size={18} color={color} />}
      {!icon && (
        <Text
          style={{ color, fontSize: 13, lineHeight: 18, fontWeight: "600" }}
        >
          {label}
        </Text>
      )}
    </Pressable>
  );
}

export function CliVersionRow({
  theme,
  row,
  busy,
  updating,
  onUpdate,
}: {
  theme: Theme;
  row: CliStatus;
  busy: boolean;
  updating: boolean;
  onUpdate(): void;
}) {
  const { colors } = theme;
  const current = row.message === "Up to date";
  const showDetail = !current && row.message !== "Update available";

  return (
    <View
      style={{
        flexDirection: "row",
        gap: 12,
        alignItems: "center",
        paddingVertical: 14,
      }}
    >
      <View style={{ flex: 1, minWidth: 0, gap: 5 }}>
        <View
          style={{
            flexDirection: "row",
            flexWrap: "wrap",
            alignItems: "center",
            gap: 8,
          }}
        >
          <Text
            style={{
              color: colors.foreground,
              fontSize: 14,
              lineHeight: 20,
              fontWeight: "600",
            }}
          >
            {cliNames[row.id]}
          </Text>
          {current && (
            <View
              style={{ flexDirection: "row", alignItems: "center", gap: 3 }}
            >
              <Icon name="Check" size={12} color={colors.foregroundMuted} />
              <Text
                style={{
                  color: colors.foregroundMuted,
                  fontSize: 11,
                  lineHeight: 16,
                }}
              >
                Up to date
              </Text>
            </View>
          )}
        </View>
        <Text
          selectable
          style={{
            color: colors.foregroundMuted,
            fontSize: 12,
            lineHeight: 18,
            fontVariant: ["tabular-nums"],
          }}
        >
          {row.installed ?? "Unavailable"}
          {row.canUpdate && row.latest ? ` → ${row.latest}` : ""}
        </Text>
        {showDetail && (
          <Text
            style={{
              color: colors.foregroundMuted,
              fontSize: 12,
              lineHeight: 18,
            }}
          >
            {row.message}
          </Text>
        )}
      </View>
      {(row.canUpdate || updating) && (
        <MaintenanceAction
          theme={theme}
          label={updating ? "Updating" : "Update"}
          accessibilityLabel={`${updating ? "Updating" : "Update"} ${cliNames[row.id]}`}
          icon="Download"
          primary
          disabled={busy}
          pending={updating}
          onPress={onUpdate}
        />
      )}
    </View>
  );
}
