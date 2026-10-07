import { useState } from "react";
import { Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import type { StoredConcert } from "../../shared/concerts/models";
import { Button, rowStyle } from "../ui/controls";

interface Props {
  theme: PluginTheme;
  run: StoredConcert;
  deleteConcert(this: void, run: StoredConcert): Promise<void>;
}

/**
 * Mirrors the store's remove() rule client-side: only finished concerts whose
 * attempts have all settled may be deleted. The server enforces the same rule.
 */
function deletable(run: StoredConcert): boolean {
  if (!run.execution) {
    return false;
  }
  if (run.status !== "completed" && run.status !== "failed") {
    return false;
  }
  if (
    run.execution.orchestration?.phase === "planning" &&
    run.execution.orchestration?.coordinatorLaunch === "pending"
  ) {
    return false;
  }
  return !run.execution.attempts.some(
    (attempt) =>
      attempt.state === "running" ||
      attempt.state === "blocked" ||
      (attempt.launch !== undefined && !attempt.launch.settled),
  );
}

export function ConcertDeleteAction({ theme, run, deleteConcert }: Props) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canDelete = deletable(run);
  const perform = async () => {
    setBusy(true);
    setError(null);
    try {
      await deleteConcert(run);
      setConfirming(false);
    } catch (cause) {
      setError(
        cause instanceof Error && cause.message
          ? cause.message
          : "The concert could not be deleted. Refresh the concert list and try again.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <View
      testID="concert-delete-action"
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
            Delete this concert? Its tasks, reports, and history are removed
            from Conductor. Agents and workspace files are not affected.
          </Text>
          <View style={rowStyle}>
            <Button
              theme={theme}
              testID="concert-delete-confirm"
              label={busy ? "Deleting…" : "Delete concert"}
              danger
              disabled={busy}
              onPress={() => {
                perform().catch(() => undefined);
              }}
            />
            <Button
              theme={theme}
              testID="concert-delete-cancel"
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
            testID="concert-delete"
            variant="quiet"
            danger
            label="Delete concert"
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
              Only finished concerts can be deleted.
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
