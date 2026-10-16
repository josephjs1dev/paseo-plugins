import { useEffect, useRef, useState } from "react";
import {
  Pressable,
  ScrollView,
  Text,
  View,
  type AccessibilityRole,
  type ViewProps,
} from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { fieldBorderColor } from "./profiles-controls";

/**
 * React Native Web 0.21 forwards keyboard and `aria-haspopup` props to the DOM
 * at runtime, but the project's @types/react-native prop unions predate them.
 * Keep the escape hatches scoped to these types, like loop-selector.tsx.
 */
type KeyDownProps = { onKeyDown?: (event: { key: string }) => void };
type HasPopupProps = { "aria-haspopup"?: "listbox" };
const LISTBOX_ROLE = "listbox" as unknown as AccessibilityRole;
const OPTION_ROLE = "option" as unknown as AccessibilityRole;

/**
 * One selectable choice in the picker: `label` is the accessible name,
 * `detail` is quieter trailing text such as "(elevated)" or a model label.
 */
export interface PickerOption {
  value: string;
  label: string;
  detail?: string | undefined;
}

interface OutsideEvent {
  target: {
    /** DOM node when a web event bubbles; never set in React Native. */
    closest?: (selector: string) => boolean | null;
  } | null;
}

type WebDocument = {
  addEventListener(
    type: "pointerdown",
    listener: (event: OutsideEvent) => void,
    options?: { capture?: boolean },
  ): void;
  removeEventListener(
    type: "pointerdown",
    listener: (event: OutsideEvent) => void,
    options?: { capture?: boolean },
  ): void;
};

const webDocument = (globalThis as { document?: WebDocument }).document;

function PickerRow({
  theme,
  option,
  isCurrent,
  onSelect,
}: {
  theme: PluginTheme;
  option: PickerOption;
  isCurrent: boolean;
  onSelect(this: void, value: string): void;
}) {
  const [active, setActive] = useState(false);
  return (
    <Pressable
      testID={`profile-option-${option.value === "" ? "none" : option.value}`}
      accessibilityRole={OPTION_ROLE}
      aria-selected={isCurrent}
      onPress={() => onSelect(option.value)}
      onHoverIn={() => setActive(true)}
      onHoverOut={() => setActive(false)}
      onFocus={() => setActive(true)}
      onBlur={() => setActive(false)}
      style={({ pressed }) => ({
        minHeight: 40,
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        paddingHorizontal: 12,
        borderRadius: 8,
        backgroundColor:
          isCurrent || active || pressed
            ? theme.colors.surface2
            : "transparent",
        opacity: pressed ? 0.8 : 1,
      })}
    >
      <Text
        numberOfLines={1}
        style={{
          color: theme.colors.foreground,
          fontSize: 13,
          lineHeight: 18,
          fontWeight: isCurrent ? "600" : "400",
        }}
      >
        {option.label}
      </Text>
      {option.detail && (
        <Text
          numberOfLines={1}
          style={{
            color: theme.colors.foregroundMuted,
            fontSize: 12,
            lineHeight: 18,
          }}
        >
          {option.detail}
        </Text>
      )}
      {isCurrent && (
        <View style={{ marginLeft: "auto" }}>
          <Icon name="Check" size={14} color={theme.colors.accent} />
        </View>
      )}
    </Pressable>
  );
}

/**
 * A full-width select for one profile field, styled like Paseo's filled
 * inputs: the trigger shows only the chosen value with a trailing chevron
 * (the label lives in the accessible name), and opening it floats a list
 * whose options carry real roles. Reuses the loop-selector mechanics:
 * floating panel (no layout shift), outside-press close, and Escape closes
 * without leaving focus behind.
 */
export function ProfilePicker({
  theme,
  label,
  options,
  value,
  compact,
  testID = "profile-picker",
  error = false,
  onSelect,
}: {
  theme: PluginTheme;
  /** The field name, spoken as part of the accessible name. */
  label: string;
  options: readonly PickerOption[];
  /** The selected value, or "" when nothing is chosen. */
  value: string;
  compact?: boolean;
  testID?: string;
  /** Draws the field-level error boundary the same way inputs do. */
  error?: boolean | undefined;
  onSelect(this: void, value: string): void;
}) {
  const [open, setOpen] = useState(false);
  const [focused, setFocused] = useState(false);
  const triggerRef = useRef<View>(null);
  const current = options.find((option) => option.value === value);
  const chosenLabel = current?.label ?? "";

  const closeOnEscape = {
    onKeyDown: (event: { key: string }) => {
      if (event.key === "Escape" && open) {
        setOpen(false);
        triggerRef.current?.focus();
      }
    },
  } satisfies KeyDownProps;

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
          `[data-testid="${testID}"], [data-testid="${testID}-listbox"]`,
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
  }, [open, testID]);

  return (
    <View testID={testID} {...(closeOnEscape as unknown as ViewProps)}>
      <Pressable
        ref={triggerRef}
        testID={`${testID}-trigger`}
        accessibilityRole="button"
        accessibilityLabel={
          chosenLabel ? `${label}: ${chosenLabel}` : `${label}: not chosen`
        }
        aria-expanded={open}
        {...({ "aria-haspopup": "listbox" } as HasPopupProps)}
        onPress={() => setOpen((wasOpen) => !wasOpen)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={({ pressed }) => ({
          marginTop: 4,
          minHeight: compact ? 44 : 38,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          paddingHorizontal: 12,
          borderRadius: 10,
          borderWidth: 1,
          borderColor: fieldBorderColor(theme, focused, error),
          backgroundColor: theme.colors.surface2,
          opacity: pressed ? 0.85 : 1,
        })}
      >
        <Text
          numberOfLines={1}
          style={{
            color: chosenLabel
              ? theme.colors.foreground
              : theme.colors.foregroundMuted,
            fontSize: 13,
            lineHeight: 18,
            fontWeight: chosenLabel ? "500" : "400",
            flexShrink: 1,
          }}
        >
          {chosenLabel || "Not set"}
        </Text>
        <Icon
          name={open ? "ChevronUp" : "ChevronDown"}
          size={14}
          color={theme.colors.foregroundMuted}
        />
      </Pressable>
      {open && (
        <View
          testID={`${testID}-listbox`}
          accessibilityRole={LISTBOX_ROLE}
          accessibilityLabel={label}
          style={{
            marginTop: 4,
            borderWidth: 1,
            borderColor: theme.colors.border,
            borderRadius: 10,
            backgroundColor: theme.colors.surface1,
            padding: 4,
            gap: 2,
            maxWidth: "100%",
          }}
        >
          <ScrollView nestedScrollEnabled style={{ flexGrow: 0 }}>
            {options.map((option) => (
              <PickerRow
                key={option.value || "none"}
                theme={theme}
                option={option}
                isCurrent={option.value === value}
                onSelect={(choice) => {
                  setOpen(false);
                  triggerRef.current?.focus();
                  onSelect(choice);
                }}
              />
            ))}
          </ScrollView>
        </View>
      )}
    </View>
  );
}
