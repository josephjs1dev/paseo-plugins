import type {
  PluginClientContext,
  PluginTimelineItemProps,
} from "@getpaseo/plugin/client";
import {
  CONTEXT_REMINDER_KIND,
  CONTEXT_REMINDER_VERSION,
  DEMO_USAGE,
  demoReminder,
  parseDemoArgs,
  reminderNoticeSchema,
  type ReminderNotice,
} from "../shared/context-reminder/contracts";
import {
  CONFIG_SCREEN_ID,
  CONFIG_TITLE,
  ConfigScreenSurface,
  ConfigSidebarItem,
} from "./context-reminder/config-screen";
import { registerReminderPills } from "./context-reminder/pills";
import { ReminderCard } from "./context-reminder/reminder-card";

function ReminderTimelineItem({
  theme,
  layout,
  agentId,
  item,
}: PluginTimelineItemProps<ReminderNotice>) {
  return (
    <ReminderCard
      theme={theme}
      layout={layout}
      agentId={agentId}
      notice={item.data}
    />
  );
}

export default function contribute(client: PluginClientContext) {
  const removers = [
    client.addTimelineRenderer({
      kind: CONTEXT_REMINDER_KIND,
      version: CONTEXT_REMINDER_VERSION,
      schema: reminderNoticeSchema,
      Component: ReminderTimelineItem,
    }),
    registerReminderPills(client),
    client.addScreen({
      id: CONFIG_SCREEN_ID,
      title: CONFIG_TITLE,
      Component: ConfigScreenSurface,
    }),
    client.addSidebarHeaderItem({
      id: CONFIG_SCREEN_ID,
      title: CONFIG_TITLE,
      Component: ConfigSidebarItem,
    }),
    client.addSlashCommand({
      name: "context-reminder",
      description: "Preview a Context Reminder card",
      argumentHint: "demo <0-100>",
      context: "agent",
      async onSubmit({ args, agent, rpc }) {
        const percent = parseDemoArgs(args);

        if (percent === null) {
          throw new Error(DEMO_USAGE);
        }

        await rpc(demoReminder, { agentId: agent.id, percent });
      },
    }),
  ];

  return async () => {
    for (const remove of removers.reverse()) {
      await remove();
    }
  };
}
