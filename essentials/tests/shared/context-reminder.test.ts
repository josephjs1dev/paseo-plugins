import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_SETTINGS,
  contextReminderSettings,
  parseDemoArgs,
} from "../../shared/context-reminder/contracts";
import {
  formatGauge,
  formatTokens,
  percentOfWindow,
} from "../../shared/context-reminder/gauge";
import {
  FRESH_STATE,
  nextReminder,
  reminderTier,
  type ReminderState,
} from "../../shared/context-reminder/reminder-policy";
import { moodFor, toPixelRuns } from "../../shared/context-reminder/sprite";
import { FRAMES } from "../../shared/context-reminder/sprite-frames";

const MAX = 1_000_000;
const thresholds = { warnPercent: 25, askPercent: 50 };
const at = (percent: number) => (MAX * percent) / 100;

test("reminderTier is quiet below warn, warns, then asks", () => {
  assert.equal(reminderTier(at(24), MAX, thresholds), null);
  assert.equal(reminderTier(at(25), MAX, thresholds), "warn");
  assert.equal(reminderTier(at(49), MAX, thresholds), "warn");
  assert.equal(reminderTier(at(50), MAX, thresholds), "ask");
});

test("reminderTier asks for every warning when ask is at or below warn", () => {
  const inverted = { warnPercent: 40, askPercent: 30 };

  assert.equal(reminderTier(at(39), MAX, inverted), null);
  assert.equal(reminderTier(at(40), MAX, inverted), "ask");
  assert.equal(
    reminderTier(at(40), MAX, { warnPercent: 40, askPercent: 40 }),
    "ask",
  );
});

test("reminderTier caps usage beyond the window at 100%", () => {
  assert.equal(percentOfWindow(MAX * 3, MAX), 100);
  assert.equal(
    reminderTier(MAX * 3, MAX, { warnPercent: 100, askPercent: 100 }),
    "ask",
  );
});

/** Runs one turn per percent and returns the turns that showed a card. */
function cardTurns(
  percents: readonly number[],
  notifyEvery: number,
  initial: ReminderState = FRESH_STATE,
  now = 0,
): { turns: number[]; state: ReminderState } {
  const turns: number[] = [];
  let state = initial;

  percents.forEach((percent, index) => {
    const result = nextReminder(
      state,
      at(percent),
      MAX,
      { ...thresholds, notifyEvery },
      now,
    );
    state = result.state;

    if (result.tier !== null) {
      turns.push(index + 1);
    }
  });

  return { turns, state };
}

const repeat = (percent: number, turns: number) =>
  Array<number>(turns).fill(percent);

test("nextReminder shows a card on entry and every notifyEvery turns", () => {
  assert.deepEqual(cardTurns(repeat(30, 8), 3).turns, [1, 4, 7]);
  assert.deepEqual(cardTurns(repeat(30, 12), 10).turns, [1, 11]);
});

test("nextReminder shows a card every turn for notifyEvery 0 or 1", () => {
  assert.deepEqual(cardTurns(repeat(30, 4), 1).turns, [1, 2, 3, 4]);
  assert.deepEqual(cardTurns(repeat(30, 4), 0).turns, [1, 2, 3, 4]);
});

test("nextReminder shows a card at once when the tier rises", () => {
  const { turns, state } = cardTurns([...repeat(30, 3), ...repeat(60, 12)], 10);

  // Warn on turn 1; ask on turn 4 without waiting; then 10 turns after that.
  assert.deepEqual(turns, [1, 4, 14]);
  assert.equal(state.lastCardTier, "ask");
});

test("nextReminder measures a rise against the last card shown", () => {
  // Hovering around the ask line shows no extra ask card.
  assert.deepEqual(cardTurns([60, 30, 30, 60], 10).turns, [1]);

  // A due card at warn lowers the last card's tier; the next ask rises.
  assert.deepEqual(
    cardTurns([60, ...repeat(30, 10), 60], 10).turns,
    [1, 11, 12],
  );
});

test("nextReminder resets below warn, even during a snooze", () => {
  const snoozed: ReminderState = {
    lastCardTier: "ask",
    turnsSinceCard: 3,
    snoozedUntil: 1_000,
  };
  const during = cardTurns([5], 10, snoozed, 500);

  assert.deepEqual(during.turns, []);
  assert.deepEqual(during.state, {
    lastCardTier: null,
    turnsSinceCard: 0,
    snoozedUntil: 1_000,
  });
  // The next climb after the snooze is a fresh warn card.
  assert.deepEqual(cardTurns([30], 10, during.state, 2_000).turns, [1]);
});

test("nextReminder hides cards while snoozed and shows a rise after", () => {
  const snoozed: ReminderState = {
    lastCardTier: "warn",
    turnsSinceCard: 2,
    snoozedUntil: 1_000,
  };
  const during = cardTurns([60, 60], 10, snoozed, 500);

  assert.deepEqual(during.turns, []);
  assert.equal(during.state.turnsSinceCard, 4);
  assert.deepEqual(cardTurns([60], 10, during.state, 2_000).turns, [1]);
});

test("nextReminder shows a card that came due during a snooze", () => {
  const snoozed: ReminderState = {
    lastCardTier: "warn",
    turnsSinceCard: 0,
    snoozedUntil: 1_000,
  };
  const during = cardTurns(repeat(30, 12), 10, snoozed, 500);

  assert.deepEqual(during.turns, []);
  assert.deepEqual(cardTurns([30], 10, during.state, 2_000).turns, [1]);
});

test("nextReminder applies a notifyEvery change from the current count", () => {
  const state: ReminderState = {
    lastCardTier: "warn",
    turnsSinceCard: 4,
    snoozedUntil: 0,
  };

  // 5, 6, then 7 turns since the last card.
  assert.deepEqual(cardTurns(repeat(30, 3), 7, state).turns, [3]);
});

test("settings parse an empty document to the defaults", () => {
  const parsed = contextReminderSettings.schema.parse({});

  assert.deepEqual(parsed, {
    enabled: true,
    warnPercent: 25,
    askPercent: 50,
    notifyEvery: 10,
    snoozeMinutes: 60,
    character: "girl",
  });
  assert.deepEqual(DEFAULT_SETTINGS, parsed);
});

test("every frame has equal-width rows and only palette glyphs", () => {
  for (const [character, moods] of Object.entries(FRAMES)) {
    for (const [mood, frame] of Object.entries(moods)) {
      const name = `${character}/${mood}`;
      const width = frame.rows[0]?.length ?? 0;

      assert.ok(width > 0, `${name} has rows`);

      for (const row of frame.rows) {
        assert.equal(row.length, width, `${name} row width`);

        for (const glyph of row) {
          const index = Number.parseInt(glyph, 36);
          assert.ok(
            glyph === "." || (index >= 0 && index < frame.palette.length),
            `${name} glyph ${glyph} is in its palette`,
          );
        }
      }

      for (const runs of toPixelRuns(frame)) {
        const total = runs.reduce((sum, run) => sum + run.width, 0);
        assert.equal(total, width, `${name} run widths`);
      }
    }
  }
});

test("toPixelRuns merges neighbors and clears dots", () => {
  const frame = { palette: ["#000000", "#ffffff"], rows: ["..0011.0"] };

  assert.deepEqual(toPixelRuns(frame), [
    [
      { width: 2, color: null },
      { width: 2, color: "#000000" },
      { width: 2, color: "#ffffff" },
      { width: 1, color: null },
      { width: 1, color: "#000000" },
    ],
  ]);
});

test("moodFor maps tiers to moods", () => {
  assert.equal(moodFor(null), "calm");
  assert.equal(moodFor("warn"), "worried");
  assert.equal(moodFor("ask"), "alarmed");
});

test("formatTokens and formatGauge", () => {
  assert.equal(formatTokens(1_000_000), "1M");
  assert.equal(formatTokens(2_000_000), "2M");
  assert.equal(formatTokens(258_000), "258k");
  assert.equal(formatTokens(347_499), "347k");
  assert.equal(formatTokens(1_500_000), "1500k");
  assert.equal(formatTokens(0), "0k");
  assert.equal(formatGauge(347_000, 1_000_000), "347k / 1M · 34%");
  assert.equal(formatGauge(200_000, 258_000), "200k / 258k · 77%");
});

test("parseDemoArgs accepts demo with a 0-100 percent only", () => {
  assert.equal(parseDemoArgs("demo 0"), 0);
  assert.equal(parseDemoArgs("  demo   75 "), 75);
  assert.equal(parseDemoArgs("demo 100"), 100);
  assert.equal(parseDemoArgs("demo 101"), null);
  assert.equal(parseDemoArgs("demo"), null);
  assert.equal(parseDemoArgs("demo -1"), null);
  assert.equal(parseDemoArgs("demo 4.5"), null);
  assert.equal(parseDemoArgs("show 40"), null);
});
