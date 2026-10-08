import { useState } from "react";
import { Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import type { StoredSymphony } from "../../shared/symphonies/models";
import { Button, rowStyle } from "../ui/controls";

interface Props {
  theme: PluginTheme;
  symphony: StoredSymphony;
  deleteSymphony(this: void, symphony: StoredSymphony): Promise<void>;
}

/**
 * Mirrors the store's remove() rule client-side: only finished symphonies whose
 * attempts have all settled may be deleted. The server enforces the same rule.
 */
function deletable(symphony: StoredSymphony): boolean {
  if (symphony.status !== "completed" && symphony.status !== "failed") {
    return false;
  }
  if (
    symphony.execution.conducting?.phase === "planning" &&
    symphony.execution.conducting.conductorLaunch === "pending"
  ) {
    return false;
  }
  return !symphony.execution.attempts.some(
    (attempt) =>
      attempt.state === "running" ||
      attempt.state === "blocked" ||
      (attempt.launch !== undefined && !attempt.launch.settled),
  );
}

export function SymphonyDeleteAction({
  theme,
  symphony,
  deleteSymphony,
}: Props) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canDelete = deletable(symphony);
  const perform = async () => {
    setBusy(true);
    setError(null);
    try {
      await deleteSymphony(symphony);
      setConfirming(false);
    } catch (cause) {
      setError(
        cause instanceof Error && cause.message
          ? cause.message
          : "The symphony could not be deleted. Refresh the symphony list and try again.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <View
      testID="symphony-delete-action"
      style={{ gap: 8, maxWidth: 420, flexShrink: 1, minWidth: 0 }}
    >
      {confirming ? (
        <>
          <Text
            style={{
              color: theme.colors.foreground,
              fontSize: 13,
              lineHeight: 20,
            }}
          >
            Delete this symphony? Its tasks, reports, and history are removed
            from Conductor. Agents and concert files are not affected.
          </Text>
          <View style={rowStyle}>
            <Button
              theme={theme}
              testID="symphony-delete-confirm"
              label={busy ? "Deleting…" : "Delete symphony"}
              danger
              disabled={busy}
              onPress={() => {
                perform().catch(() => undefined);
              }}
            />
            <Button
              theme={theme}
              testID="symphony-delete-cancel"
              label="Cancel"
              variant="quiet"
              disabled={busy}
              onPress={() => {
                setConfirming(false);
                setError(null);
              }}
            />
          </View>
        </>
      ) : (
        <View style={{ gap: 4, alignItems: "flex-start" }}>
          <Button
            theme={theme}
            testID="symphony-delete"
            variant="quiet"
            danger
            label="Delete symphony"
            disabled={!canDelete}
            onPress={() => {
              setError(null);
              setConfirming(true);
            }}
          />
          {!canDelete && (
            <Text
              style={{
                color: theme.colors.foregroundMuted,
                fontSize: 12,
                lineHeight: 18,
              }}
            >
              Only finished symphonies can be deleted.
            </Text>
          )}
        </View>
      )}
      {error && (
        <Text
          accessibilityRole="alert"
          style={{
            color: theme.colors.statusDanger,
            fontSize: 13,
            lineHeight: 20,
          }}
        >
          {error}
        </Text>
      )}
    </View>
  );
}
