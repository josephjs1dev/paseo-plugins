import { useEffect, useRef, useState } from "react";
import {
  Pressable,
  Text,
  View,
  useWindowDimensions,
  type AccessibilityRole,
  type DimensionValue,
  type ViewProps,
} from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { Button, Label, rowStyle } from "../ui/controls";
import { loopVerdictLabel, type HistoryLoopGroup } from "./history";
import { loopVerdictColor } from "./inspection";

/**
 * React Native Web 0.21 forwards keyboard and `aria-haspopup` props to the DOM
 * at runtime, but the project's `@types/react-native` prop unions predate
 * them. Keep the escape hatches scoped to these types; the runtime invariant
 * is the forwarded-props list in react-native-web's View module.
 */
type KeyDownProps = { onKeyDown?: (event: { key: string }) => void };
type HasPopupProps = { "aria-haspopup"?: "listbox" };
/** React Native Web renders listbox/option roles; its ARIA types do not. */
const LISTBOX_ROLE = "listbox" as unknown as AccessibilityRole;
const OPTION_ROLE = "option" as unknown as AccessibilityRole;
const HAS_POPUP_LISTBOX: HasPopupProps = { "aria-haspopup": "listbox" };
const LISTBOX_ARIA_LABEL = "Loops";
/**
 * React Native Web forwards `onPointerMove` at runtime, but the RN 0.72
 * prop types predate it; same escape hatch as the keyboard props above.
 */
type PointerMoveProps = { onPointerMove?: () => void };

/** Below this width the podium uses the compact layout. */
const COMPACT_MAX_WIDTH = 740;
/** Verdict dot diameter; redundant with the text, never color-only. */
const DOT_SIZE = 6;
/** Lucide glyph size for the trigger chevron and the selected check. */
const ICON_SIZE = 14;
/** Distance between the trigger and the floating list. */
const ANCHOR_GAP = 4;
/** Wide-layout option row height; compact rows keep the 44px touch target. */
const OPTION_MIN_HEIGHT = 36;
/** The list stays near the trigger's width instead of a detached wide card. */
const PANEL_MAX_WIDTH = 320;
/**
 * Content-sized list, like a standard select. RN types predate the
 * max-content keyword; RN Web forwards it to CSS.
 */
const PANEL_WIDTH = "max-content" as unknown as DimensionValue;
/**
 * Soft y-offset elevation; no zero-offset halo.
 */
const PANEL_SHADOW = {
  shadowColor: "#000000",
  shadowOffset: { width: 0, height: 4 },
  shadowOpacity: 0.12,
  shadowRadius: 12,
} as const;

/**
 * One row of the loop list. Tracks hover and focus locally because the typed
 * Pressable state callback predates `hovered`/`focused` on web; the handlers
 * forward to the same state, so hover and keyboard focus look alike.
 */
function LoopOption({
  theme,
  group,
  isLatest,
  isCurrent,
  compact,
  onSelect,
}: {
  theme: PluginTheme;
  group: HistoryLoopGroup;
  isLatest: boolean;
  isCurrent: boolean;
  compact: boolean;
  onSelect(this: void, group: HistoryLoopGroup): void;
}) {
  const [active, setActive] = useState(false);
  /**
   * React Native Web's hover events only dispatch on pointer-enabled
   * elements; the pointer move hook makes the row receive them. RN types
   * predate onPointerMove, so keep the escape hatch scoped here.
   */
  const pointerMoveProps: PointerMoveProps = {
    onPointerMove: () => setActive(true),
  };
  return (
    <Pressable
      testID={`loop-option-${group.loop}`}
      accessibilityRole={OPTION_ROLE}
      aria-selected={isCurrent}
      onPress={() => onSelect(group)}
      onHoverIn={() => setActive(true)}
      onHoverOut={() => setActive(false)}
      onFocus={() => setActive(true)}
      onBlur={() => setActive(false)}
      {...(pointerMoveProps as unknown as ViewProps)}
      style={({ pressed }) => ({
        minHeight: compact ? 44 : OPTION_MIN_HEIGHT,
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        paddingHorizontal: 12,
        borderRadius: 6,
        backgroundColor:
          active || pressed ? theme.colors.surface2 : "transparent",
        opacity: pressed ? 0.8 : 1,
      })}
    >
      <View
        style={{
          width: DOT_SIZE,
          height: DOT_SIZE,
          borderRadius: DOT_SIZE / 2,
          backgroundColor: theme.colors[loopVerdictColor(group)],
        }}
      />
      <Text
        numberOfLines={1}
        style={{
          color: theme.colors.foreground,
          fontSize: 13,
          lineHeight: 18,
          fontWeight: isCurrent ? "600" : "400",
        }}
      >
        {`Loop ${group.loop} · ${loopVerdictLabel(group)}`}
      </Text>
      {isLatest && (
        <Text
          style={{
            color: theme.colors.foregroundMuted,
            fontSize: 12,
            lineHeight: 18,
          }}
        >
          latest
        </Text>
      )}
      {
        /** Fixed trailing column: the check sits at the same spot in every row. */
        <View
          style={{
            marginLeft: "auto",
            width: ICON_SIZE,
            alignItems: "flex-end",
          }}
        >
          {isCurrent && (
            <Icon
              name="Check"
              size={ICON_SIZE}
              color={theme.colors.foreground}
            />
          )}
        </View>
      }
    </Pressable>
  );
}

interface OutsideEvent {
  target: {
    /** DOM node when a web event bubbles; never set in React Native. */
    closest?: (selector: string) => boolean | null;
  } | null;
}

/** Minimal shape of the web globals this file touches; no DOM lib types. */
type WebDocument = {
  addEventListener(
    type: "pointerdown",
    listener: (event: OutsideEvent) => void,
    options?: AddEventListenerOptions,
  ): void;
  removeEventListener(
    type: "pointerdown",
    listener: (event: OutsideEvent) => void,
    options?: EventListenerOptions,
  ): void;
};
type AddEventListenerOptions = boolean | { capture?: boolean };
type EventListenerOptions = boolean | { capture?: boolean };

const webDocument = (globalThis as { document?: WebDocument }).document;

/**
 * Chooses the loop the Tasks, Graph and Context tabs show. A dropdown trigger
 * names the shown loop's verdict in text, so the choice never depends on
 * color. Selecting the latest loop follows new loops as they start; an older
 * loop stays pinned and says so, with a way back.
 *
 * The list floats (absolutely positioned inside the trigger wrapper), so
 * opening it never shifts the content below, and its left edge stays aligned
 * with the trigger.
 */
export function LoopSelector({
  theme,
  loops,
  shown,
  onSelect,
}: {
  theme: PluginTheme;
  loops: readonly HistoryLoopGroup[];
  shown: number;
  /** `null` selects the latest loop and keeps following it. */
  onSelect(this: void, loop: number | null): void;
}) {
  const [open, setOpen] = useState(false);
  const [focused, setFocused] = useState(false);
  const [triggerHeight, setTriggerHeight] = useState(0);
  const triggerRef = useRef<View>(null);
  const { width } = useWindowDimensions();
  const compact = width > 0 && width < COMPACT_MAX_WIDTH;
  const latest = loops.at(-1)?.loop ?? 1;
  const current = loops.find((group) => group.loop === shown) ?? loops.at(-1);
  if (!current) {
    return null;
  }
  const shownIsLatest = current.loop === latest;
  const triggerLabel = `Loop ${current.loop} · ${loopVerdictLabel(current)}${
    shownIsLatest ? " · latest" : ""
  }`;
  /** Height fallback for the first paint before onLayout reports. */
  const listTop = (triggerHeight || (compact ? 44 : 34)) + ANCHOR_GAP;

  /** Escape closes the open list and hands focus back to the trigger. */
  const closeOnEscape = {
    onKeyDown: (event: { key: string }) => {
      if (event.key === "Escape" && open) {
        setOpen(false);
        triggerRef.current?.focus();
      }
    },
  } satisfies KeyDownProps;

  /** Every choice closes the list and keeps keyboard focus on the trigger. */
  const choose = (group: HistoryLoopGroup) => {
    setOpen(false);
    triggerRef.current?.focus();
    onSelect(group.loop === latest ? null : group.loop);
  };

  /** A press outside trigger and list closes it, like a standard select. */
  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const closeOnOutsidePress = (event: OutsideEvent) => {
      const closest = event.target?.closest;
      if (
        typeof closest === "function" &&
        closest.call(
          event.target,
          '[data-testid="loop-select"], [data-testid="loop-listbox"]',
        )
      ) {
        return;
      }
      setOpen(false);
    };
    if (!webDocument) {
      return undefined;
    }
    webDocument.addEventListener("pointerdown", closeOnOutsidePress);
    return () =>
      webDocument.removeEventListener("pointerdown", closeOnOutsidePress);
  }, [open]);

  return (
    <View
      testID="loop-selector"
      style={{ gap: 8, position: "relative", zIndex: 20 }}
      {...(closeOnEscape as unknown as ViewProps)}
    >
      {/**
       * Above later siblings under the same root (the past-note row), so the
       * floating list rows keep real pointer events across them; the base
       * View z-index 0 would otherwise trap the trigger wrapper in a
       * sibling-defeatable stacking context.
       */}
      <View style={{ ...rowStyle, zIndex: 20 }}>
        <Label theme={theme}>LOOP</Label>
        <View style={{ position: "relative" }}>
          <Pressable
            ref={triggerRef}
            testID="loop-select"
            accessibilityRole="button"
            accessibilityLabel={triggerLabel}
            aria-expanded={open}
            {...HAS_POPUP_LISTBOX}
            onLayout={(event) =>
              setTriggerHeight(event.nativeEvent.layout.height)
            }
            onPress={() => setOpen((wasOpen) => !wasOpen)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            style={({ pressed }) => ({
              // 44px keeps the trigger a reachable touch target when compact.
              minHeight: compact ? 44 : 34,
              flexDirection: "row",
              alignItems: "center",
              gap: 7,
              paddingHorizontal: 12,
              paddingVertical: 6,
              borderRadius: 6,
              borderWidth: 1,
              borderColor: focused
                ? theme.colors.foreground
                : theme.colors.border,
              opacity: pressed ? 0.8 : 1,
            })}
          >
            <View
              style={{
                width: DOT_SIZE,
                height: DOT_SIZE,
                borderRadius: DOT_SIZE / 2,
                backgroundColor: theme.colors[loopVerdictColor(current)],
              }}
            />
            <Text
              style={{
                color: theme.colors.foreground,
                fontSize: 13,
                lineHeight: 18,
              }}
            >
              {triggerLabel}
            </Text>
            <Icon
              name={open ? "ChevronUp" : "ChevronDown"}
              size={ICON_SIZE}
              color={theme.colors.foregroundMuted}
            />
          </Pressable>
          {open && (
            <View
              testID="loop-listbox"
              accessibilityRole={LISTBOX_ROLE}
              aria-label={LISTBOX_ARIA_LABEL}
              style={{
                position: "absolute",
                top: listTop,
                left: 0,
                zIndex: 40,
                minWidth: "100%",
                width: PANEL_WIDTH,
                ...(compact ? {} : { maxWidth: PANEL_MAX_WIDTH }),
                padding: 4,
                borderRadius: 8,
                borderWidth: 1,
                borderColor: theme.colors.border,
                backgroundColor: theme.colors.surface1,
                ...PANEL_SHADOW,
              }}
            >
              {[...loops].reverse().map((group) => (
                <LoopOption
                  key={group.loop}
                  theme={theme}
                  group={group}
                  isLatest={group.loop === latest}
                  isCurrent={group.loop === current.loop}
                  compact={compact}
                  onSelect={choose}
                />
              ))}
            </View>
          )}
        </View>
      </View>
      {shown < latest && (
        <View style={rowStyle}>
          <Text
            testID="loop-past-note"
            style={{
              color: theme.colors.foregroundMuted,
              fontSize: 12,
              lineHeight: 17,
            }}
          >
            {`Showing loop ${shown} as it ended. Loop ${latest} is the latest.`}
          </Text>
          <Button
            theme={theme}
            variant="quiet"
            dense
            label="Show latest loop"
            onPress={() => onSelect(null)}
          />
        </View>
      )}
    </View>
  );
}
