/**
 * Fixture equivalent of Paseo's plugin client runtime, so the preview can
 * drive CODE THROUGH THE REAL profiles-query.ts path. The daemon supplies
 * useRpc over its socket; here the RPC dispatch routes to the in-memory
 * preview store engine (profiles-controller.ts), registered at import time.
 *
 * Only the two symbols the preview bundle imports participate:
 * defineRpc (shared/symphonies/profiles-rpc) and useRpc (profiles-query).
 */

type Handler = (input: never) => Promise<unknown>;
type Registry = Record<string, Handler>;

const REGISTRY_KEY = "__conductorPreviewRpc";

/** Installs the RPC handler registry the fake `useRpc` dispatches against. */
export function installRpcHandlers(handlers: Registry): void {
  (globalThis as Record<string, unknown>)[REGISTRY_KEY] = handlers;
}

/** Pass-through shaping, like the host's defineRpc helper. */
export function defineRpc<Definition extends { name: string }>(
  definition: Definition,
): Definition {
  return definition;
}

export function useRpc<In, Out>(
  rpc: { readonly name?: unknown } & Record<string, unknown>,
): (input: In) => Promise<Out> {
  const name = typeof rpc.name === "string" ? rpc.name : String(rpc.name);
  return (input: In): Promise<Out> => {
    const registry = (globalThis as Record<string, unknown>)[REGISTRY_KEY] as
      | Registry
      | undefined;
    const handler = registry?.[name];
    if (!handler) {
      return Promise.reject(new Error(`No preview RPC handler for "${name}".`));
    }
    return handler(input as never) as Promise<Out>;
  };
}
