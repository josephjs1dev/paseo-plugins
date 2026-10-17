import { Image, Text, View } from "react-native";

import { claudeLogoUri } from "../assets/claude-logo";
import { codexLogoUri } from "../assets/codex-logo";
import { OpenCodeMark, PiMark, type HarnessMarkProps } from "./harness-marks";

/**
 * The provider mark to render. The plugin SDK only exposes Lucide icons, so
 * the harness marks are bundled here: copied image assets for Claude and
 * Codex, view-drawn marks for Pi and OpenCode, and a monogram tile for every
 * other provider until someone adds its mark.
 */
export interface HarnessMarkComponentProps extends HarnessMarkProps {
  /** The provider id, e.g. "claude", "codex", "pi", "opencode". */
  provider: string;
  /** The provider's display label; the monogram tile uses its first letter. */
  label?: string;
  /** The surface behind the mark, used as the monogram tile background. */
  surface: string;
}

/**
 * Data-URI PNGs, tinted like the Essentials provider logos.
 */
const LOGO_URIS: Record<string, string> = {
  claude: claudeLogoUri,
  codex: codexLogoUri,
};

/** Claude's brand orange for the brand tone; Codex stays monochrome. */
const CLAUDE_BRAND = "#D97757";

/**
 * The harness mark for a provider: a tinted asset, a drawn mark, or a
 * monogram of the label's first letter in a rounded tile on `surface`.
 * The brand tone swaps in the provider's official colors where it has them;
 * monochrome brands and the monogram tile keep the passed theme color in
 * both tones. Decorative in every case; the parent's accessible label names
 * the provider.
 */
export function HarnessMark({
  provider,
  label,
  size,
  color,
  surface,
  tone = "muted",
}: HarnessMarkComponentProps) {
  const uri = LOGO_URIS[provider];
  if (uri) {
    return (
      <Image
        source={{ uri }}
        accessible={false}
        importantForAccessibility="no-hide-descendants"
        resizeMode="contain"
        style={{
          width: size,
          height: size,
          tintColor:
            provider === "claude" && tone === "brand" ? CLAUDE_BRAND : color,
        }}
      />
    );
  }
  if (provider === "pi") {
    return <PiMark size={size} color={color} tone={tone} />;
  }
  if (provider === "opencode") {
    return <OpenCodeMark size={size} color={color} />;
  }
  const letter = (label ?? provider).trim().charAt(0).toUpperCase();
  const fontSize = Math.round(size * 0.55);
  return (
    <View
      aria-hidden
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.25,
        backgroundColor: surface,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Text
        style={{ color, fontSize, lineHeight: Math.round(size * 0.8) }}
        numberOfLines={1}
      >
        {letter}
      </Text>
    </View>
  );
}
