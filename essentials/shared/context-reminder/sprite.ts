import type { ReminderTier } from "./reminder-policy";

export type Character = "girl" | "boy";
export type Mood = "calm" | "worried" | "alarmed";

/**
 * A pixel-art frame. In each row, a glyph `0-9a-z` indexes `palette` as a
 * hex color, and `.` is a clear pixel. Frames may be any size.
 */
export type SpriteFrame = {
  palette: readonly string[];
  rows: readonly string[];
};

export type PixelRun = { width: number; color: string | null };

const CLEAR = ".";

/** The color of one glyph; unknown glyphs render clear. */
function glyphColor(frame: SpriteFrame, glyph: string): string | null {
  if (glyph === CLEAR) {
    return null;
  }

  const index = Number.parseInt(glyph, 36);

  return Number.isNaN(index) ? null : (frame.palette[index] ?? null);
}

/** Each row as left-to-right runs, merging neighbors of the same color. */
export function toPixelRuns(frame: SpriteFrame): PixelRun[][] {
  return frame.rows.map((row) => {
    const runs: PixelRun[] = [];

    for (const glyph of row) {
      const color = glyphColor(frame, glyph);
      const last = runs.at(-1);

      if (last && last.color === color) {
        last.width += 1;
      } else {
        runs.push({ width: 1, color });
      }
    }

    return runs;
  });
}

export function moodFor(tier: ReminderTier | null): Mood {
  if (tier === "ask") {
    return "alarmed";
  }

  return tier === "warn" ? "worried" : "calm";
}
