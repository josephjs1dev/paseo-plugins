import type { ViewStyle } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";

/**
 * The theme contract exposes colors only, so the appearance is read from the
 * theme: a host that declares it is trusted, otherwise the foreground decides
 * — dark themes set light text. The card elevation and the role chip tints
 * switch on this.
 */
export function themeAppearance(theme: PluginTheme): "light" | "dark" {
  const declared = (theme as { appearance?: unknown }).appearance;
  if (declared === "light" || declared === "dark") {
    return declared;
  }
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(
    theme.colors.foreground,
  );
  if (!match) {
    return "light";
  }
  const red = Number.parseInt(match[1] ?? "ff", 16);
  const green = Number.parseInt(match[2] ?? "ff", 16);
  const blue = Number.parseInt(match[3] ?? "ff", 16);
  return (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255 > 0.5
    ? "dark"
    : "light";
}

/**
 * Soft y-offset card elevation; light appearance only, where it separates the
 * card from the pane. Dark keeps the border only, so no halo. No zero-offset
 * glow.
 */
const CARD_SHADOW = {
  shadowColor: "#000000",
  shadowOffset: { width: 0, height: 2 },
  shadowOpacity: 0.1,
  shadowRadius: 6,
} as const;

/**
 * The shared option C card surface: a surface1 card that lifts off the
 * surface0 pane with a 1px frame and — in light only, so dark keeps the
 * border alone — a soft shadow. The border color is left out so callers can
 * merge their own selected/focused/pressed treatment, e.g.
 * `{ ...cardSurface(theme), borderColor: selected ? theme.colors.accent :
 * theme.colors.border }`. Whole cards are never tinted here; selection and
 * status washes stay with each surface.
 */
export function cardSurface(theme: PluginTheme): ViewStyle {
  return {
    borderRadius: 12,
    borderWidth: 1,
    backgroundColor: theme.colors.surface1,
    overflow: "hidden",
    ...(themeAppearance(theme) === "light" ? CARD_SHADOW : {}),
  };
}
