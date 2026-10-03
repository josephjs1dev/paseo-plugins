import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { MaintenanceAction, CliVersionRow } from "./maintenance-controls";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  usePaseo,
  useRpc,
  type PluginClientContext,
  type PluginSurfaceProps,
} from "@getpaseo/plugin/client";
import {
  applyCliUpdate,
  checkCliUpdates,
  readMaintenance,
  refreshCliModels,
  cliIds,
  cliNames,
  type CliId,
  type Maintenance,
} from "../shared/cli-maintenance";
import { HistoryChoice, HistoryOptions } from "./history-controls";
import { registerMaintenanceNavigation } from "./maintenance-navigation";

function MaintenancePage(props: PluginSurfaceProps) {
  const { host, theme, layout } = props;
  const { colors } = theme;
  const [provider, setProvider] = useState<CliId>("codex");
  const [search, setSearch] = useState("");
  const [section, setSection] = useState<"updates" | "models">("updates");
  const [page, setPage] = useState(0);
  const paseo = usePaseo();
  const queryClient = useQueryClient();
  const read = useRpc(readMaintenance);
  const check = useRpc(checkCliUpdates);
  const update = useRpc(applyCliUpdate);
  const refresh = useRpc(refreshCliModels);
  const key = ["nestkit-cli-maintenance", host.id];
  const status = useQuery({
    queryKey: key,
    queryFn: () => read({}),
    retry: false,
    refetchInterval: (query) => (query.state.data?.busy ? 1_000 : 10_000),
  });
  const action = useMutation({
    mutationFn: (work: () => Promise<Maintenance>) => work(),
    onSuccess: (data) => {
      queryClient.setQueryData(key, data);
    },
    retry: false,
  });
  const modelKey = ["nestkit-cli-models", host.id];
  const models = useQuery({
    queryKey: modelKey,
    queryFn: () => paseo.providers.snapshot(),
    retry: false,
  });
  useEffect(
    () =>
      paseo.providers.subscribe(() => {
        void queryClient.invalidateQueries({
          queryKey: ["nestkit-cli-models", host.id],
        });
      }),
    [paseo, queryClient, host.id],
  );
  const busy = action.isPending || status.data?.busy === true;
  const entry = models.data?.entries.find(
    (entry) => entry.provider === provider,
  );
  const available =
    entry?.models?.filter((model) => model.isSelectable !== false) ?? [];
  const filtered = available.filter((model) =>
    `${model.label} ${model.id}`.toLowerCase().includes(search.toLowerCase()),
  );

  const updateCount =
    status.data?.rows.filter((row) => row.canUpdate).length ?? 0;
  const pageCount = Math.max(1, Math.ceil(filtered.length / 8));
  const currentPage = Math.min(page, pageCount - 1);
  const pageModels = filtered.slice(currentPage * 8, (currentPage + 1) * 8);
  const checking =
    status.data?.busy === true &&
    status.data.action === "Checking CLI updates…";
  const refreshing =
    status.data?.busy === true &&
    status.data.action === `Refreshing ${cliNames[provider]} models…`;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.surface0 }}
      contentContainerStyle={{
        width: "100%",
        maxWidth: 760,
        alignSelf: "center",
        padding: layout.compact ? 16 : 24,
        gap: 16,
      }}
    >
      <View style={{ gap: 4 }}>
        <Text
          accessibilityRole="header"
          style={{
            color: colors.foreground,
            fontSize: 18,
            lineHeight: 24,
            fontWeight: "600",
          }}
        >
          CLIs & Models ({host.label})
        </Text>
        <Text
          style={{
            color: colors.foreground,
            fontSize: 14,
            lineHeight: 20,
          }}
        >
          Host: {host.label}
        </Text>
        <Text
          style={{
            color: colors.foregroundMuted,
            fontSize: 12,
            lineHeight: 18,
          }}
        >
          Updates and model refreshes apply only to this host.
        </Text>
      </View>
      <HistoryOptions theme={theme} label="Maintenance view">
        <HistoryChoice
          theme={theme}
          selected={section === "updates"}
          onPress={() => setSection("updates")}
        >
          {updateCount ? `Updates · ${updateCount}` : "Updates"}
        </HistoryChoice>
        <HistoryChoice
          theme={theme}
          selected={section === "models"}
          onPress={() => setSection("models")}
        >
          Models
        </HistoryChoice>
      </HistoryOptions>
      {(status.data?.busy || status.data?.message) && (
        <View
          accessibilityLiveRegion="polite"
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 10,
            backgroundColor: colors.surface1,
            borderRadius: 8,
            padding: 12,
          }}
        >
          {status.data.busy && (
            <ActivityIndicator size="small" color={colors.accent} />
          )}
          <Text
            style={{
              color: colors.foreground,
              flex: 1,
              fontSize: 12,
              lineHeight: 18,
            }}
          >
            {status.data.busy ? status.data.action : status.data.message}
          </Text>
        </View>
      )}
      {(status.isError || action.isError) && (
        <View style={{ gap: 8 }}>
          <Text
            accessibilityRole="alert"
            style={{ color: colors.statusDanger, fontSize: 13, lineHeight: 20 }}
          >
            Could not complete the request. Check the host connection and try
            again.
          </Text>
          <View style={{ alignSelf: "flex-start" }}>
            <MaintenanceAction
              theme={theme}
              label="Retry connection"
              onPress={() => {
                action.reset();
                void status.refetch();
              }}
            />
          </View>
        </View>
      )}
      {section === "updates" ? (
        <View style={{ gap: 12 }}>
          <View
            style={{
              flexDirection: "row",
              flexWrap: "wrap",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 10,
            }}
          >
            <View style={{ gap: 2 }}>
              <Text
                accessibilityRole="header"
                style={{
                  color: colors.foreground,
                  fontSize: 14,
                  lineHeight: 20,
                  fontWeight: "600",
                }}
              >
                Installed CLIs
              </Text>
              <Text
                style={{
                  color: colors.foregroundMuted,
                  fontSize: 12,
                  lineHeight: 18,
                }}
              >
                {updateCount
                  ? `${updateCount} updates available`
                  : "Codex, OpenCode and Pi"}
              </Text>
            </View>
            <MaintenanceAction
              theme={theme}
              label={checking ? "Checking" : "Check updates"}
              icon="RefreshCw"
              pending={checking}
              disabled={busy || status.isPending || status.isError}
              onPress={() => action.mutate(() => check({}))}
            />
          </View>
          {status.isPending && (
            <Text style={{ color: colors.foregroundMuted, fontSize: 13 }}>
              Loading CLI status…
            </Text>
          )}
          {status.data?.rows.length === 0 && (
            <Text
              style={{
                color: colors.foregroundMuted,
                fontSize: 13,
                lineHeight: 20,
                paddingVertical: 12,
              }}
            >
              Check for updates to compare your installed versions with the
              latest releases.
            </Text>
          )}
          <View>
            {status.data?.rows.map((row, index) => (
              <View
                key={row.id}
                style={{
                  borderTopWidth: index ? 1 : 0,
                  borderTopColor: colors.border,
                }}
              >
                <CliVersionRow
                  theme={theme}
                  row={row}
                  busy={busy}
                  updating={
                    status.data?.busy === true &&
                    status.data.action === `Updating ${cliNames[row.id]}…`
                  }
                  onUpdate={() =>
                    action.mutate(() =>
                      update({ id: row.id, version: row.latest ?? "" }),
                    )
                  }
                />
              </View>
            ))}
          </View>
          <View
            style={{
              borderTopWidth: 1,
              borderTopColor: colors.border,
              paddingTop: 12,
              gap: 6,
            }}
          >
            {status.data?.checkedAt && (
              <Text
                style={{
                  color: colors.foregroundMuted,
                  fontSize: 11,
                  lineHeight: 16,
                }}
              >
                Last checked{" "}
                {new Date(status.data.checkedAt).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </Text>
            )}
            {updateCount > 0 && (
              <Text
                style={{
                  color: colors.foregroundMuted,
                  fontSize: 12,
                  lineHeight: 18,
                }}
              >
                Finish active work before updating a CLI.
              </Text>
            )}
          </View>
        </View>
      ) : (
        <View style={{ gap: 12 }}>
          <HistoryOptions theme={theme} label="Model provider">
            {cliIds.map((id) => (
              <HistoryChoice
                key={id}
                theme={theme}
                selected={provider === id}
                onPress={() => {
                  setProvider(id);
                  setPage(0);
                }}
              >
                {cliNames[id]}
              </HistoryChoice>
            ))}
          </HistoryOptions>
          <View
            style={{
              flexDirection: "row",
              flexWrap: "wrap",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
            }}
          >
            <Text
              accessibilityRole="header"
              style={{
                color: colors.foreground,
                fontSize: 14,
                lineHeight: 20,
                fontWeight: "600",
              }}
            >
              {available.length} available models
            </Text>
            <MaintenanceAction
              theme={theme}
              label={refreshing ? "Refreshing" : "Refresh models"}
              icon="RefreshCw"
              pending={refreshing}
              disabled={busy}
              onPress={() => action.mutate(() => refresh({ id: provider }))}
            />
          </View>
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
              borderWidth: 1,
              borderColor: colors.border,
              borderRadius: 8,
              backgroundColor: colors.surface1,
              paddingHorizontal: 12,
            }}
          >
            <Icon name="Search" size={16} color={colors.foregroundMuted} />
            <TextInput
              accessibilityLabel="Search models"
              placeholder="Search by name or model ID"
              placeholderTextColor={colors.foregroundMuted}
              value={search}
              onChangeText={(value) => {
                setSearch(value);
                setPage(0);
              }}
              autoCapitalize="none"
              autoCorrect={false}
              maxLength={100}
              style={{
                flex: 1,
                minWidth: 0,
                minHeight: 44,
                paddingVertical: 10,
                color: colors.foreground,
                fontSize: 13,
                lineHeight: 20,
              }}
            />
          </View>
          {models.isError && (
            <Text
              accessibilityRole="alert"
              style={{
                color: colors.statusDanger,
                fontSize: 13,
                lineHeight: 20,
              }}
            >
              Could not load the catalog. Try Refresh models.
            </Text>
          )}
          {models.isPending && (
            <Text style={{ color: colors.foregroundMuted, fontSize: 13 }}>
              Loading models…
            </Text>
          )}
          {!models.isPending &&
            !models.isError &&
            (!entry || entry.status !== "ready") && (
              <Text
                style={{
                  color: colors.foregroundMuted,
                  fontSize: 13,
                  lineHeight: 20,
                }}
              >
                Provider {entry?.status ?? "unavailable"}. Refresh models or
                check its configuration.
              </Text>
            )}
          <View>
            {pageModels.map((model, index) => (
              <View
                key={model.id}
                style={{
                  paddingVertical: 10,
                  gap: 3,
                  borderTopWidth: index ? 1 : 0,
                  borderTopColor: colors.border,
                }}
              >
                <View
                  style={{ flexDirection: "row", alignItems: "center", gap: 8 }}
                >
                  <Text
                    style={{
                      color: colors.foreground,
                      flex: 1,
                      fontSize: 13,
                      lineHeight: 20,
                      fontWeight: "500",
                    }}
                  >
                    {model.label}
                  </Text>
                  {model.isDefault && (
                    <Text
                      style={{
                        color: colors.foregroundMuted,
                        fontSize: 11,
                        lineHeight: 16,
                        backgroundColor: colors.surface1,
                        paddingHorizontal: 6,
                        paddingVertical: 2,
                        borderRadius: 4,
                      }}
                    >
                      Default
                    </Text>
                  )}
                </View>
                <Text
                  selectable
                  style={{
                    color: colors.foregroundMuted,
                    fontSize: 11,
                    lineHeight: 16,
                  }}
                >
                  {model.id}
                </Text>
              </View>
            ))}
          </View>
          {!models.isPending &&
            !models.isError &&
            entry?.status === "ready" &&
            filtered.length === 0 && (
              <Text
                style={{
                  color: colors.foregroundMuted,
                  fontSize: 13,
                  lineHeight: 20,
                }}
              >
                {search
                  ? "No matching models. Try another name or ID."
                  : "No models listed yet. Try Refresh models."}
              </Text>
            )}
          {pageCount > 1 && (
            <View
              style={{
                flexDirection: "row",
                flexWrap: "wrap",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
                borderTopWidth: 1,
                borderTopColor: colors.border,
                paddingTop: 12,
              }}
            >
              <Text
                style={{
                  color: colors.foregroundMuted,
                  fontSize: 11,
                  lineHeight: 16,
                }}
              >
                {currentPage * 8 + 1}–
                {Math.min((currentPage + 1) * 8, filtered.length)} of{" "}
                {filtered.length}
              </Text>
              <View style={{ flexDirection: "row", gap: 6 }}>
                <MaintenanceAction
                  theme={theme}
                  label="Previous"
                  disabled={currentPage === 0}
                  onPress={() => setPage(currentPage - 1)}
                />
                <MaintenanceAction
                  theme={theme}
                  label="Next"
                  disabled={currentPage + 1 >= pageCount}
                  onPress={() => setPage(currentPage + 1)}
                />
              </View>
            </View>
          )}
          <Text
            style={{
              color: colors.foregroundMuted,
              fontSize: 11,
              lineHeight: 16,
            }}
          >
            This host’s default model catalog. Workspace configuration and
            account access may affect the models available in each workspace.
          </Text>
        </View>
      )}
    </ScrollView>
  );
}

function MaintenanceSurface(props: PluginSurfaceProps) {
  return <MaintenancePage key={props.host.id} {...props} />;
}

export default function contribute(client: PluginClientContext) {
  const removeSurface = client.addSurface(
    "cli-maintenance",
    MaintenanceSurface,
  );
  const removeNavigation = registerMaintenanceNavigation(client);

  return () => {
    removeNavigation();
    removeSurface();
  };
}
