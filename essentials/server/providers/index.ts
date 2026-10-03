import type { Provider } from "../../shared/providers";
import { codexAdapter } from "./codex";
import { opencodeGoAdapter } from "./opencode-go";
import type { ProviderAdapter } from "./types";

// Adding metadata without an adapter is a type error.
export const providerAdapters: Record<Provider, ProviderAdapter> = {
  codex: codexAdapter,
  "opencode-go": opencodeGoAdapter,
};
