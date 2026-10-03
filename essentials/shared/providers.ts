import { z } from "zod";

interface ProviderDefinition {
  name: string;
  icon: string;
}

export const providerDefinitions = {
  chatgpt: {
    name: "ChatGPT",
    icon: "Gauge",
  },
  "opencode-go": {
    name: "OpenCode Go",
    icon: "ChartNoAxesCombined",
  },
} as const satisfies Record<string, ProviderDefinition>;

export type Provider = keyof typeof providerDefinitions;

// This object is defined locally, so its own keys are exactly the provider IDs.
export const providerIds = Object.keys(providerDefinitions) as Provider[];
export const providerSchema = z.enum(providerIds);
