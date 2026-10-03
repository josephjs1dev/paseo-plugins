import { z } from "zod";

export const harnessDefinitions = {
  codex: { name: "Codex" },
  pi: { name: "Pi" },
  opencode: { name: "OpenCode" },
} as const;

export type Harness = keyof typeof harnessDefinitions;
export const harnessIds = Object.keys(harnessDefinitions) as Harness[];
export const harnessSchema = z.enum(harnessIds);
