import { useRef, useState } from "react";
import { useRpc, type PluginHostProps } from "@getpaseo/plugin/client";
import { Icon, Modal } from "@getpaseo/plugin/client/react-native";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Pressable, Text, View } from "react-native";
import {
  consumeCodexReset,
  prepareCodexReset,
  resetOutcomeMessages,
} from "../shared/codex-reset";
import type { Usage } from "../shared/usage";

type Props = Pick<PluginHostProps, "theme" | "host" | "layout"> & {
  usage: Usage;
  onUsageChange(usage: Usage): void;
};

export function CodexReset({
  theme,
  host,
  layout,
  usage,
  onUsageChange,
}: Props) {
  const { colors } = theme;
  const [open, setOpen] = useState(false);
  const submitting = useRef(false);
  const prepare = useRpc(prepareCodexReset);
  const consume = useRpc(consumeCodexReset);
  const cache = useQueryClient();
  const hasAttempt =
    cache.getQueryData(["nestkit-codex-reset-attempt", host.id]) !== undefined;
  const count = usage.resetCredits?.availableCount;
  const available = usage.status === "ok" && count != null && count > 0;
  const mutation = useMutation({
    mutationKey: ["nestkit-codex-reset", host.id],
    retry: false,
    mutationFn: async () => {
      // The query survives closing the popover. Keep it on uncertain failures.
      const attempt = await cache.fetchQuery({
        queryKey: ["nestkit-codex-reset-attempt", host.id],
        queryFn: () => prepare({}),
        staleTime: Infinity,
        gcTime: Infinity,
        retry: false,
      });

      return consume({ ...attempt, confirmed: true });
    },
    onSuccess: async (result) => {
      const queryKey = ["nestkit-usage", host.id, "chatgpt"];
      await cache.cancelQueries({ queryKey });
      cache.setQueryData(queryKey, result.usage);
      cache.removeQueries({
        queryKey: ["nestkit-codex-reset-attempt", host.id],
        exact: true,
      });
      onUsageChange(result.usage);
      setOpen(false);
    },
    onSettled: () => {
      submitting.current = false;
    },
  });
  const errorMessage =
    "Could not confirm the reset. Try again to check the same request without spending an additional credit. Check Codex sign-in and CLI support if this continues.";

  return (
    <View
      style={{
        borderTopWidth: 1,
        borderTopColor: colors.border,
        paddingTop: 16,
        gap: 10,
      }}
    >
      <View
        style={{
          flexDirection: layout.compact ? "column" : "row",
          alignItems: layout.compact ? "stretch" : "center",
          gap: 12,
        }}
      >
        <View style={{ flex: 1, gap: 4 }}>
          <Text
            style={{
              color: colors.foreground,
              fontSize: 13,
              lineHeight: 20,
              fontWeight: "600",
            }}
          >
            Banked resets
          </Text>
          <Text
            style={{
              color: colors.foregroundMuted,
              fontSize: 12,
              lineHeight: 18,
            }}
          >
            {count == null
              ? "Unavailable for this account or Codex version"
              : `${count} available · account-wide`}
          </Text>
        </View>
        <ResetButton
          theme={theme}
          disabled={(!available && !hasAttempt) || mutation.isPending}
          onPress={() => setOpen(true)}
        >
          {mutation.isPending ? "Using reset…" : "Use reset"}
        </ResetButton>
      </View>
      {mutation.isSuccess && (
        <Text
          accessibilityLiveRegion="polite"
          style={{ color: colors.foreground, fontSize: 12, lineHeight: 18 }}
        >
          {resetOutcomeMessages[mutation.data.outcome]}
          {mutation.data.usage.status === "unavailable"
            ? " Quota could not be refreshed. Try Refresh shortly."
            : ""}
        </Text>
      )}
      {mutation.isError && !open && (
        <Text
          accessibilityRole="alert"
          style={{ color: colors.statusDanger, fontSize: 12, lineHeight: 18 }}
        >
          {errorMessage}
        </Text>
      )}
      <Modal
        title="Use one banked reset?"
        open={open}
        onOpenChange={setOpen}
        icon={<Icon name="RotateCcw" size={18} color={colors.foreground} />}
      >
        <Modal.Content>
          <Text
            style={{ color: colors.foreground, fontSize: 14, lineHeight: 22 }}
          >
            This spends one banked reset on the Codex account connected to{" "}
            {host.label}. It resets eligible quota for all sessions using that
            account.
          </Text>
          <Text
            style={{
              color: colors.foregroundMuted,
              fontSize: 13,
              lineHeight: 20,
            }}
          >
            {count ?? "Unknown"} available. A spent reset cannot be undone.
          </Text>
          {mutation.isError && (
            <Text
              accessibilityRole="alert"
              style={{
                color: colors.statusDanger,
                fontSize: 13,
                lineHeight: 20,
              }}
            >
              {errorMessage}
            </Text>
          )}
          <View
            style={{
              flexDirection: layout.compact ? "column" : "row",
              justifyContent: "flex-end",
              gap: 8,
            }}
          >
            <ResetButton
              theme={theme}
              disabled={mutation.isPending}
              onPress={() => setOpen(false)}
            >
              Cancel
            </ResetButton>
            <ResetButton
              theme={theme}
              primary
              disabled={mutation.isPending || (!available && !hasAttempt)}
              onPress={() => {
                if (submitting.current) {
                  return;
                }

                submitting.current = true;
                mutation.mutate();
              }}
            >
              {mutation.isPending ? "Using reset…" : "Confirm · use 1 reset"}
            </ResetButton>
          </View>
        </Modal.Content>
      </Modal>
    </View>
  );
}

function ResetButton({
  theme,
  children,
  disabled,
  primary = false,
  onPress,
}: Pick<PluginHostProps, "theme"> & {
  children: string;
  disabled: boolean;
  primary?: boolean;
  onPress(): void;
}) {
  const { colors } = theme;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 44,
        paddingHorizontal: 14,
        paddingVertical: 10,
        borderRadius: 8,
        justifyContent: "center",
        alignItems: "center",
        borderWidth: 1,
        borderColor: primary ? colors.accent : colors.border,
        backgroundColor: primary ? colors.accent : colors.surface1,
        opacity: disabled ? 0.5 : 1,
        ...(pressed && !disabled ? { opacity: 0.75 } : {}),
      })}
    >
      <Text
        style={{
          color: primary ? colors.accentForeground : colors.foreground,
          fontSize: 13,
          lineHeight: 20,
          fontWeight: "600",
        }}
      >
        {children}
      </Text>
    </Pressable>
  );
}
