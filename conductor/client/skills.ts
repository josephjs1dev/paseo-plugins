import type { PluginClientContext } from "@getpaseo/plugin/client";
import {
  installConductorSkills,
  removeConductorSkills,
} from "../shared/skills-rpc";

function assertNoneSkipped({ skipped }: { skipped: string[] }): void {
  if (skipped.length) {
    throw new Error(
      `Conductor left existing skills unchanged: ${skipped.join(", ")}`,
    );
  }
}

export function registerSkillCommands(
  client: Pick<PluginClientContext, "addCommandCenterItem">,
) {
  return [
    client.addCommandCenterItem({
      id: "install-conductor-skills",
      title: "Install conductor skills",
      icon: "Download",
      keywords: [
        "skills",
        "orchestrate",
        "install",
        "update",
        "~/.claude",
        "~/.agents",
      ],
      context: "global",
      async onSelect(context) {
        assertNoneSkipped(await context.rpc(installConductorSkills, {}));
      },
    }),
    client.addCommandCenterItem({
      id: "remove-conductor-skills",
      title: "Remove conductor skills",
      icon: "Trash2",
      keywords: ["skills", "orchestrate", "uninstall", "delete"],
      context: "global",
      async onSelect(context) {
        assertNoneSkipped(await context.rpc(removeConductorSkills, {}));
      },
    }),
  ];
}
