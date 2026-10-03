import type { PluginServerContext } from "@getpaseo/plugin/server";
import contributeProviderUsage from "./server/provider-usage";
import contributeMaintenance from "./server/cli-maintenance";

export default function contribute(context: PluginServerContext) {
  const cleanupProviderUsage = contributeProviderUsage(context);
  const cleanupMaintenance = contributeMaintenance(context);

  return async () => {
    cleanupMaintenance();
    await cleanupProviderUsage();
  };
}
