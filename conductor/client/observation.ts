import type { usePaseo } from "@getpaseo/plugin/client";

type PaseoApi = ReturnType<typeof usePaseo>;

/** One directory observer per borrowed client, shared by every mounted contribution. */
const observers = new WeakMap<
  PaseoApi,
  { listeners: Set<() => void>; stop: () => void }
>();
export function observeDirectory(
  paseo: PaseoApi,
  listener: () => void,
): () => void {
  let entry = observers.get(paseo);
  if (!entry) {
    const listeners = new Set<() => void>();
    const lifetime = new AbortController();
    const cleanups: (() => void)[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const invalidate = () => {
      if (lifetime.signal.aborted || timer) {
        return;
      }
      timer = setTimeout(() => {
        timer = undefined;
        for (const call of listeners) {
          call();
        }
      }, 500);
    };
    const attach = async () => {
      const agents = await paseo.agents.list({
        subscribe: {},
        signal: lifetime.signal,
      });
      if (lifetime.signal.aborted) {
        await agents.subscription.release();
        return;
      }
      cleanups.push(
        agents.subscription.subscribe({
          snapshot: invalidate,
          update: invalidate,
          error: invalidate,
        }),
      );
      cleanups.push(() => {
        agents.subscription.release().catch(() => undefined);
      });
      const workspaces = await paseo.workspaces.list({ subscribe: {} });
      if (lifetime.signal.aborted) {
        await workspaces.subscription.release();
        return;
      }
      cleanups.push(
        workspaces.subscription.subscribe({
          snapshot: invalidate,
          update: invalidate,
          error: invalidate,
        }),
      );
      cleanups.push(() => {
        workspaces.subscription.release().catch(() => undefined);
      });
    };
    attach().catch(() => {
      invalidate();
    });
    entry = {
      listeners,
      stop() {
        lifetime.abort();
        clearTimeout(timer);
        for (const cleanup of cleanups) {
          cleanup();
        }
      },
    };
    observers.set(paseo, entry);
  }
  entry.listeners.add(listener);
  const held = entry;
  return () => {
    held.listeners.delete(listener);
    if (held.listeners.size === 0) {
      held.stop();
      observers.delete(paseo);
    }
  };
}
