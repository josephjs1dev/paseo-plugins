import { useState } from "react";
import { Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import type { ArchiveResult, AgentItem } from "../../shared/agents/models";
import { category } from "../../shared/agents/attention";
import { Button, rowStyle } from "../ui/controls";

interface Props {
  theme: PluginTheme;
  item: AgentItem;
  stale: boolean;
  directoryIncomplete: boolean;
  archive(this: void, item: AgentItem): Promise<ArchiveResult>;
}
const errors = {
  stale:
    "The agent changed. Refresh and check its current state before archiving.",
  has_children:
    "This agent has children. Archive or detach them in Paseo before archiving this parent.",
  incomplete:
    "The directory is incomplete, so child agents cannot be checked. Refresh before archiving.",
  unknown:
    "The archive could not be confirmed. Refresh or open the agent to check its state before trying again.",
};
export function ArchiveAction({
  theme,
  item,
  stale,
  directoryIncomplete,
  archive,
}: Props) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(false);
  if (category(item) !== "inactive") {
    return null;
  }
  const blocked =
    stale ||
    directoryIncomplete ||
    !item.archiveKey ||
    item.childAgentCount > 0 ||
    busy ||
    uncertain;
  const perform = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await archive(item);
      if (result.status !== "archived") {
        setError(errors[result.status]);
        setUncertain(result.status === "unknown");
      }
    } catch {
      setError(errors.unknown);
      setUncertain(true);
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };
  return (
    <View style={{ gap: 8 }}>
      {confirming ? (
        <>
          <Text
            style={{
              color: theme.colors.foreground,
              fontSize: 13,
              lineHeight: 20,
            }}
          >
            Archive {item.agentTitle}? This removes the agent from active Paseo
            lists. Workspace files remain.
          </Text>
          <View style={rowStyle}>
            <Button
              theme={theme}
              label={busy ? "Archiving…" : "Confirm archive"}
              disabled={blocked}
              onPress={() => {
                perform().catch(() => undefined);
              }}
            />
            <Button
              theme={theme}
              label="Cancel archive"
              disabled={busy}
              onPress={() => setConfirming(false)}
            />
          </View>
        </>
      ) : (
        <View style={{ alignItems: "flex-start" }}>
          <Button
            theme={theme}
            label="Archive agent"
            disabled={blocked}
            onPress={() => setConfirming(true)}
          />
        </View>
      )}
      {item.childAgentCount > 0 && (
        <Text
          style={{
            color: theme.colors.foregroundMuted,
            fontSize: 12,
            lineHeight: 18,
          }}
        >
          Archive children first. Paseo can archive attached children when their
          parent is archived.
        </Text>
      )}
      {directoryIncomplete && (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
          Archiving is unavailable until the full agent directory can be
          checked.
        </Text>
      )}
      {error && (
        <Text
          accessibilityRole="alert"
          style={{ color: theme.colors.statusDanger, fontSize: 13 }}
        >
          {error}
        </Text>
      )}
    </View>
  );
}
