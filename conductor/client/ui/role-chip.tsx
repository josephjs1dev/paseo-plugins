import { Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { themeAppearance } from "./card";

/** Display labels for the routing roles a chip can carry. */
export const ROLE_CHIP_LABEL: Record<string, string> = {
  exploration: "Exploration",
  implementation: "Implementation",
  planning: "Planning",
  review: "Review",
};

/**
 * Role chip background/text pairs per role and appearance. Each pair holds
 * WCAG AA (4.5:1) text contrast on its own background; the browser suite
 * measures the rendered pair in both themes.
 */
export const ROLE_CHIP_COLORS: Record<
  string,
  Record<"light" | "dark", { background: string; foreground: string }>
> = {
  exploration: {
    light: { background: "#e0f4f1", foreground: "#1f6b5e" },
    dark: { background: "#183631", foreground: "#8fdccb" },
  },
  implementation: {
    light: { background: "#e3eefb", foreground: "#245e98" },
    dark: { background: "#1d3047", foreground: "#9ac7ff" },
  },
  planning: {
    light: { background: "#efe7fb", foreground: "#5b3a99" },
    dark: { background: "#2f2545", foreground: "#cdb8f5" },
  },
  review: {
    light: { background: "#fbf0dc", foreground: "#7a4f00" },
    dark: { background: "#3a2e17", foreground: "#ecc779" },
  },
};

/**
 * A role chip tints with the role's pair for the current appearance; a role
 * without a pair keeps the neutral surface, like the size badge beside it.
 */
export function RoleChip({
  theme,
  role,
  label,
  testID,
}: {
  theme: PluginTheme;
  role: string;
  /** Defaults to the role's display label, falling back to the raw id. */
  label?: string;
  testID?: string;
}) {
  const tint = ROLE_CHIP_COLORS[role]?.[themeAppearance(theme)];
  return (
    <View
      {...(testID ? { testID } : {})}
      style={{
        minHeight: 22,
        paddingHorizontal: 8,
        paddingVertical: 2,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: tint ? "transparent" : theme.colors.border,
        backgroundColor: tint ? tint.background : theme.colors.surface2,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Text
        numberOfLines={1}
        style={{
          color: tint ? tint.foreground : theme.colors.foreground,
          fontSize: 11,
          lineHeight: 15,
        }}
      >
        {label ?? ROLE_CHIP_LABEL[role] ?? role}
      </Text>
    </View>
  );
}
