import { View } from "react-native";

/**
 * Harness marks drawn from plain views, so they stay crisp at any size and
 * take their color from the theme without bundled image assets. Both marks
 * are decorative; the caller's accessible label names the provider.
 */
export interface HarnessMarkProps {
  /** Square box edge in px; the mark is centered inside it. */
  size: number;
  color: string;
  /**
   * "muted" (default) draws every mark in the passed theme color so status
   * stays the only color on a graph node; "brand" draws the provider's
   * official colors where it has them, for profile cards.
   */
  tone?: "muted" | "brand";
}

/**
 * The Pi logo's cells on its 4×4 grid (https://pi.dev/logo-auto.svg): a
 * pixel "P" over columns 0–2 and a two-cell "i" in column 3. The muted tone
 * collapses the logo's three colors into one theme color like every other
 * mark; the brand tone keeps each cell's official color from the logo.
 */
const PI_CELLS: readonly (readonly [
  column: number,
  row: number,
  /** The cell's color in the brand tone; the muted tone ignores it. */
  brand: string,
])[] = [
  // The "P" top bar and right cells.
  [0, 0, "#F09082"],
  [1, 0, "#F09082"],
  [2, 0, "#F09082"],
  [0, 1, "#4D9ABF"],
  [2, 1, "#F09082"],
  // The "P" left column and middle cell.
  [0, 2, "#4D9ABF"],
  [1, 2, "#4D9ABF"],
  // The "i" cells.
  [3, 2, "#F1BE58"],
  [0, 3, "#4D9ABF"],
  [3, 3, "#F1BE58"],
];

/** Pi: the logo's pixel grid, one square view per filled cell. */
export function PiMark({ size, color, tone = "muted" }: HarnessMarkProps) {
  const cell = size / 4;
  return (
    <View
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      style={{ width: size, height: size }}
    >
      {PI_CELLS.map(([column, row, brand]) => (
        <View
          key={`${column}-${row}`}
          style={{
            position: "absolute",
            left: column * cell,
            top: row * cell,
            // Half a pixel of overlap keeps adjacent cells from showing a
            // seam at fractional sizes.
            width: cell + 0.5,
            height: cell + 0.5,
            backgroundColor: tone === "brand" ? brand : color,
          }}
        />
      ))}
    </View>
  );
}

/**
 * OpenCode: a tall frame whose lower two thirds are a faint fill. Matches the
 * Essentials geometry, but draws the frame with borders so the hole shows the
 * real surface behind it instead of a passed-in background color.
 */
export function OpenCodeMark({ size, color }: HarnessMarkProps) {
  return (
    <View
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      style={{ width: size, height: size, alignItems: "center" }}
    >
      <View
        style={{
          width: size * 0.8,
          height: size,
          borderWidth: size * 0.2,
          borderColor: color,
        }}
      >
        <View
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 0,
            height: "66.67%",
            backgroundColor: color,
            opacity: 0.2,
          }}
        />
      </View>
    </View>
  );
}
