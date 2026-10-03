import type { Provider } from "../shared/providers";

export interface HistorySelection {
  provider: Provider;
  days: 7 | 30;
  scope: "workspace" | "host";
}

const initialSelection: HistorySelection = {
  provider: "codex",
  days: 7,
  scope: "workspace",
};

/** Each workspace tab keeps its own filters; the contribution is already host-scoped. */
export function createHistoryNavigation(
  openPanel: (workspaceId: string) => void,
) {
  const selections = new Map<string, HistorySelection>();
  const listeners = new Set<() => void>();
  function select(workspaceId: string, next: HistorySelection) {
    selections.set(workspaceId, next);

    for (const listener of listeners) {
      listener();
    }
  }

  return {
    getSnapshot: (workspaceId: string) =>
      selections.get(workspaceId) ?? initialSelection,
    subscribe(listener: () => void) {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
    select,
    open(
      workspaceId: string,
      provider: Provider,
      days: 7 | 30 = 7,
      scope: "workspace" | "host" = "workspace",
    ) {
      select(workspaceId, { provider, days, scope });
      openPanel(workspaceId);
    },
    forget(workspaceId: string) {
      selections.delete(workspaceId);
    },
  };
}

export type HistoryNavigation = ReturnType<typeof createHistoryNavigation>;
