import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  installConductorSkills,
  removeConductorSkills,
} from "../../shared/skills-rpc";
import { installSkills, removeSkills } from "../skills/install";

export function registerSkillsRpc(
  server: Pick<PluginServerContext, "handle">,
  home: string,
): void {
  server.handle(installConductorSkills, () => installSkills(home));
  server.handle(removeConductorSkills, () => removeSkills(home));
}
