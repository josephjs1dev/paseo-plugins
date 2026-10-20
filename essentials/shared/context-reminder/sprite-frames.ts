import type { Character, Mood, SpriteFrame } from "./sprite";

// Placeholder 16x16 art. Generated 32x32 frames will replace this file.
//
// Palette slots: 0 outline, 1 hair, 2 skin, 3 blush, 4 skin shadow,
// 5 eye white, 6 clothes, 7 mouth, 8 sweat, 9 shoes.

const GIRL_PALETTE = [
  "#2b1d1a",
  "#8a4b2f",
  "#f7d5b5",
  "#f2a0a6",
  "#d9a982",
  "#ffffff",
  "#ff8fb1",
  "#c2453d",
  "#7cc8ff",
  "#4a3b5c",
] as const;

const BOY_PALETTE = [
  "#1f1a17",
  "#3b2a20",
  "#f3cfae",
  "#eea39b",
  "#d4a27c",
  "#ffffff",
  "#5b8def",
  "#b9473f",
  "#7cc8ff",
  "#2f3a4f",
] as const;

// Long hair falls past the chin on both sides.
const GIRL_CALM = [
  "....00000000....",
  "...0111111110...",
  "..011111111110..",
  ".01111111111110.",
  ".01112222221110.",
  ".01122222222110.",
  ".01120222202110.",
  ".01120222202110.",
  ".01132222223110.",
  ".01122277222110.",
  ".01100222200110.",
  ".01006666660010.",
  "..006666666600..",
  "..026666666620..",
  "...0666666660...",
  "....09900990....",
] as const;

// Short hair stops at the ears; the chin is narrower.
const BOY_CALM = [
  "....00000000....",
  "...0111111110...",
  "..011111111110..",
  ".01111111111110.",
  ".01111222211110.",
  ".01122222222110.",
  ".01120222202110.",
  ".01120222202110.",
  "..013222222310..",
  "..012227722210..",
  "...0002222000...",
  "....06666660....",
  "..006666666600..",
  "..026666666620..",
  "...0666666660...",
  "....09900990....",
] as const;

/** Replaces rows by index; the result keeps the base frame's size. */
function withRows(
  base: readonly string[],
  overrides: Readonly<Record<number, string>>,
): readonly string[] {
  return base.map((row, index) => overrides[index] ?? row);
}

type Pixel = readonly [x: number, y: number, glyph: string];

/** Sets single pixels; marks outside the frame are ignored. */
function withPixels(
  rows: readonly string[],
  pixels: readonly Pixel[],
): readonly string[] {
  return rows.map((row, y) =>
    [...row]
      .map(
        (glyph, x) =>
          pixels.find((pixel) => pixel[0] === x && pixel[1] === y)?.[2] ??
          glyph,
      )
      .join(""),
  );
}

// A sweat drop beside the right temple.
const WORRIED_MARKS: readonly Pixel[] = [
  [15, 4, "8"],
  [15, 5, "8"],
];

// A red "!" above the right side and a sweat drop on the left.
const ALARMED_MARKS: readonly Pixel[] = [
  [15, 0, "7"],
  [15, 1, "7"],
  [15, 3, "7"],
  [0, 6, "8"],
  [0, 7, "8"],
];

// Raised inner brows, small eyes, and a flat mouth.
const WORRIED_FACE = {
  5: ".01122022022110.",
  6: ".01122222222110.",
  7: ".01120222202110.",
} as const;

// Wide eyes and a sweat drop on the right.
const ALARMED_FACE = {
  6: ".011552222551108",
  7: ".011502222051108",
} as const;

export const FRAMES: Record<Character, Record<Mood, SpriteFrame>> = {
  girl: {
    calm: { palette: GIRL_PALETTE, rows: GIRL_CALM },
    worried: {
      palette: GIRL_PALETTE,
      rows: withPixels(
        withRows(GIRL_CALM, { ...WORRIED_FACE, 9: ".01122000022110." }),
        WORRIED_MARKS,
      ),
    },
    alarmed: {
      palette: GIRL_PALETTE,
      rows: withPixels(
        withRows(GIRL_CALM, { ...ALARMED_FACE, 9: ".01122700722110." }),
        ALARMED_MARKS,
      ),
    },
  },
  boy: {
    calm: { palette: BOY_PALETTE, rows: BOY_CALM },
    worried: {
      palette: BOY_PALETTE,
      rows: withPixels(
        withRows(BOY_CALM, { ...WORRIED_FACE, 9: "..012200002210.." }),
        WORRIED_MARKS,
      ),
    },
    alarmed: {
      palette: BOY_PALETTE,
      rows: withPixels(
        withRows(BOY_CALM, { ...ALARMED_FACE, 9: "..012270072210.." }),
        ALARMED_MARKS,
      ),
    },
  },
};
