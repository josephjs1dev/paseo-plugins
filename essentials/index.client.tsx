import type { PluginClientContext } from "@getpaseo/plugin/client";
import contributeProviderUsage from "./client/provider-usage";
import contributeMaintenance from "./client/cli-maintenance";

export default function contribute(context: PluginClientContext) {
  const cleanupProviderUsage = contributeProviderUsage(context);
  const cleanupMaintenance = contributeMaintenance(context);

  return () => {
    cleanupMaintenance();
    cleanupProviderUsage();
  };
}
