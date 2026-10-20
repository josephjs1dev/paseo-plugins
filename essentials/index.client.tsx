import type { PluginClientContext } from "@getpaseo/plugin/client";
import contributeProviderUsage from "./client/provider-usage";
import contributeMaintenance from "./client/cli-maintenance";
import contributeContextReminder from "./client/context-reminder";

export default function contribute(context: PluginClientContext) {
  const cleanupProviderUsage = contributeProviderUsage(context);
  const cleanupMaintenance = contributeMaintenance(context);
  const cleanupContextReminder = contributeContextReminder(context);

  return async () => {
    await cleanupContextReminder();
    cleanupMaintenance();
    cleanupProviderUsage();
  };
}
