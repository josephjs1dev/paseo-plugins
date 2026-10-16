import type {
  ProviderCatalog,
  ProviderEntry,
  ProviderMode,
  ProviderModel,
} from "../../shared/symphonies/profiles-rpc";
import { isKnownElevatedMode } from "../symphonies/workers";
import type { PaseoApi } from "./types";

/**
 * The provider/model/mode/thinking catalog the Podium profile editor reads.
 * Built from one provider snapshot; a provider that reports an error still
 * appears so the editor can explain why it is unavailable.
 */
export async function providerCatalog(
  paseo: PaseoApi,
): Promise<ProviderCatalog> {
  const snapshot = await paseo.providers.snapshot();
  const providers: ProviderEntry[] = snapshot.entries.map((entry) => {
    const models: ProviderModel[] = (entry.models ?? [])
      .filter((model) => model.isSelectable !== false)
      .map((model) => ({
        id: model.id,
        label: model.label || model.id,
        isDefault: model.isDefault ?? false,
        ...(model.defaultThinkingOptionId
          ? { defaultThinkingOptionId: model.defaultThinkingOptionId }
          : {}),
        thinkingOptions: (model.thinkingOptions ?? []).map((option) => ({
          id: option.id,
          label: option.label || option.id,
          isDefault: option.isDefault ?? false,
        })),
      }));
    const modes: ProviderMode[] = (entry.modes ?? []).map((mode) => ({
      id: mode.id,
      label: mode.label || mode.id,
      ...(mode.description ? { description: mode.description } : {}),
      elevated: isKnownElevatedMode(mode.id),
    }));
    return {
      id: entry.provider,
      label: entry.label ?? entry.provider,
      available: entry.enabled && entry.status === "ready",
      status: entry.status,
      ...(entry.error ? { error: entry.error } : {}),
      defaultModeId: entry.defaultModeId ?? null,
      models,
      modes,
    };
  });
  return { providers };
}
