import type { PluginServerContext } from "@getpaseo/plugin/server";
import contributeProviderUsage from "./server/provider-usage";
import contributeMaintenance from "./server/cli-maintenance";
import contributeContextReminder from "./server/context-reminder";

export default function contribute(context: PluginServerContext) {
  const cleanupProviderUsage = contributeProviderUsage(context);
  const cleanupMaintenance = contributeMaintenance(context);
  const cleanupContextReminder = contributeContextReminder(context);

  return async () => {
    cleanupContextReminder();
    cleanupMaintenance();
    await cleanupProviderUsage();
  };
}
