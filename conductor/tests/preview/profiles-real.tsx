import { useSyncExternalStore } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PluginTheme } from "@getpaseo/plugin";
import { PodiumSession } from "../../client/podium/session";
import { ProfileBrowser } from "../../client/symphonies/profiles";
import { useProfiles } from "../../client/symphonies/profiles-query";
import { light } from "./fixtures";
import { PreviewProfilesController } from "./profiles-controller";
import { installRpcHandlers } from "./plugin-client";

/**
 * The real-query-path preview: renders the Profiles tab with data produced
 * by the production useProfiles hook, whose useRpc calls are served by the
 * in-memory store engine. Only this page's bundle reaches useRpc, so the
 * alias to the plugin-client fake is a no-op elsewhere in the preview.
 */
const controller = new PreviewProfilesController();

installRpcHandlers({
  "profiles.list": () => Promise.resolve(controller.list()),
  "profiles.providers": () => Promise.resolve(controller.providers()),

  "profiles.save": (input: {
    expectedRevision: string;
    operation: Parameters<PreviewProfilesController["save"]>[1];
  }) => controller.save(input.expectedRevision, input.operation),
  "profiles.import": (input: { expectedRevision: string }) =>
    controller.importFromPaseo(input.expectedRevision),
  "profiles.sync-preview": () => controller.syncPreview(),
  "profiles.sync": (input: {
    expectedRevision: string;
    expectedPaseoRevision: string;
    profileIds: string[];
  }) =>
    controller.syncToPaseo(
      input.expectedRevision,
      input.expectedPaseoRevision,
      input.profileIds,
    ),
});

/** The browser tests drive the "another client" from here. */
(window as unknown as Record<string, unknown>).__profilesReal = controller;
(window as unknown as Record<string, unknown>).__profilesRealPaseo =
  (): unknown[] => controller.paseoList();

const previewQueryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});

const session = new PodiumSession();
const theme: PluginTheme = light;

function RealProfilesHost(): React.JSX.Element {
  const profiles = useProfiles("fixture-host");
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <p
        role="status"
        data-testid="preview-status"
        style={{ position: "absolute", left: -9999 }}
      >
        real query path · revision {profiles.state?.revision ?? "loading"}
      </p>
      <ProfileBrowser
        theme={theme}
        data={profiles}
        state={state}
        session={session}
        compact={false}
      />
    </div>
  );
}

export function ProfilesRealPage(): React.JSX.Element {
  return (
    <QueryClientProvider client={previewQueryClient}>
      <RealProfilesHost />
    </QueryClientProvider>
  );
}
