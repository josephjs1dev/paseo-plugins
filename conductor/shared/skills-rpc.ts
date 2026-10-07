import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const skillResult = z.object({
  changed: z.array(z.string()),
  skipped: z.array(z.string()),
});
export const installConductorSkills = defineRpc({
  name: "skills.install",
  input: z.object({}).strict(),
  output: skillResult,
});
export const removeConductorSkills = defineRpc({
  name: "skills.remove",
  input: z.object({}).strict(),
  output: skillResult,
});
