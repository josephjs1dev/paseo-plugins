import { percentOfWindow } from "./gauge";

export type ReminderTier = "warn" | "ask";

/**
 * One agent's reminder progress. `lastCardTier` is the tier of the last card
 * shown since usage was last below the warn threshold. `snoozedUntil` is epoch
 * milliseconds.
 */
export type ReminderState = {
  lastCardTier: ReminderTier | null;
  turnsSinceCard: number;
  snoozedUntil: number;
};

export const FRESH_STATE: ReminderState = {
  lastCardTier: null,
  turnsSinceCard: 0,
  snoozedUntil: 0,
};

const TIER_RANK = { warn: 1, ask: 2 } as const;

function tierRank(tier: ReminderTier | null): number {
  return tier === null ? 0 : TIER_RANK[tier];
}

export interface ReminderThresholds {
  warnPercent: number;
  askPercent: number;
}

export interface ReminderCadence extends ReminderThresholds {
  notifyEvery: number;
}

/**
 * The tier for one reading. When `askPercent <= warnPercent`, every reading
 * at or above `warnPercent` asks.
 */
export function reminderTier(
  used: number,
  max: number,
  { warnPercent, askPercent }: ReminderThresholds,
): ReminderTier | null {
  const percent = percentOfWindow(used, max);

  if (percent < warnPercent) {
    return null;
  }

  return percent >= askPercent ? "ask" : "warn";
}

/**
 * Advances one agent's state by a turn and returns the tier of the card to
 * show, if any. A card shows when the tier ranks above the last card's tier,
 * or after `notifyEvery` turns without a card. A reading below the warn
 * threshold resets the state, even during a snooze. A snooze counts turns but
 * shows no card, so a rise or a due card shows once the snooze ends.
 */
export function nextReminder(
  state: ReminderState,
  used: number,
  max: number,
  config: ReminderCadence,
  now: number,
): { state: ReminderState; tier: ReminderTier | null } {
  const tier = reminderTier(used, max, config);

  if (tier === null) {
    return {
      state: { ...state, lastCardTier: null, turnsSinceCard: 0 },
      tier: null,
    };
  }

  const turnsSinceCard = state.turnsSinceCard + 1;

  if (state.snoozedUntil > now) {
    return { state: { ...state, turnsSinceCard }, tier: null };
  }

  const isRise = tierRank(tier) > tierRank(state.lastCardTier);
  const isDue = turnsSinceCard >= Math.max(1, config.notifyEvery);

  if (!isRise && !isDue) {
    return { state: { ...state, turnsSinceCard }, tier: null };
  }

  return {
    state: { ...state, lastCardTier: tier, turnsSinceCard: 0 },
    tier,
  };
}
