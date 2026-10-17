import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import type { ReactElement, FunctionComponent } from "react";
import type { PluginTheme } from "@getpaseo/plugin";
import type {
  PluginButton,
  PluginButtonContentProps,
  PluginComposerPillContribution,
} from "@getpaseo/plugin/client";
import { symphonyStatusLabel } from "../shared/symphonies/models";
import type { SymphonyListEntry } from "../shared/symphonies/models";
import type {
  registerSymphonyPills,
  SymphonyPillOptions,
} from "../client/symphonies/pills";

// The node:test run has no bundler alias, and the pill's popover shares the
// React Native UI primitives; the SDK's own react-native facade stays empty
// until the host mounts the runtime. The component tree is inspected through
// the created elements and never rendered, so this shims the imported names.
const reactNativeShim = `data:text/javascript,${encodeURIComponent(
  [
    "export const Pressable = {};",
    "export const Text = {};",
    "export const View = {};",
    "export const StyleSheet = {};",
    "export const Icon = {};",
  ].join(""),
)}`;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier === "react-native" ||
      specifier.startsWith("@getpaseo/plugin/client/react-native")
    ) {
      return { url: reactNativeShim, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const { registerSymphonyPills: register } = await import(
  "../client/symphonies/pills"
);

type PillClient = Parameters<typeof registerSymphonyPills>[0];

type ListOutput = {
  symphonies: SymphonyListEntry[];
  unavailable: number;
  incomplete: boolean;
};

type RecordedUpdate = Partial<PluginButton>;

interface RecordedPill {
  contribution: PluginComposerPillContribution;
  updates: RecordedUpdate[];
  removed: boolean;
}

interface FakeTimer {
  id: number;
  callback: () => void;
  ms: number;
}

/** Fires only the timers scheduled before the advance; re-arms wait. */
class FakeTimers {
  private nextId = 1;
  private scheduled: FakeTimer[] = [];

  get size(): number {
    return this.scheduled.length;
  }

  scheduledAll(predicate: (ms: number) => boolean): boolean {
    return this.scheduled.every((entry) => predicate(entry.ms));
  }

  set(callback: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.scheduled.push({ id, callback, ms });
    return id;
  }

  clear(handle: unknown): void {
    this.scheduled = this.scheduled.filter((entry) => entry.id !== handle);
  }

  advance(ms: number): void {
    const due = this.scheduled.filter((entry) => entry.ms <= ms);
    for (const entry of due) {
      if (!this.scheduled.includes(entry)) {
        continue;
      }
      this.scheduled = this.scheduled.filter((other) => other !== entry);
      entry.callback();
    }
  }
}

interface FakeObserver {
  snapshot(snapshot: { entries: { agent: { id: string } }[] }): void;
  update(message: unknown): void;
  error?(error: unknown): void;
}

interface FakeState {
  agents: { agent: { id: string } }[];
  listResult: ListOutput;
  rpcCalls: number;
  rpcImpl: () => Promise<ListOutput>;
  observers: FakeObserver[];
  /** Runs inside subscribe(); models synchronously delivered bootstrap. */
  onSubscribe?: (observer: FakeObserver) => void;
  pills: RecordedPill[];
  openCalls: { id: string; workspaceId: string; agentId: string }[];
  releases: number;
}

/** A caller-controlled rpc: every call parks until `respond` resolves it. */
function gatedRpc() {
  const gates: ((output: ListOutput) => void)[] = [];
  return {
    gates,
    impl: (): Promise<ListOutput> =>
      new Promise<ListOutput>((resolve) => {
        gates.push(resolve);
      }),
    respond(index: number, output: ListOutput): void {
      gates[index]?.(output);
    },
  };
}

function symphonyFixture(
  overrides: Partial<SymphonyListEntry> = {},
): SymphonyListEntry {
  return {
    schemaVersion: 1,
    id: "sym-1",
    version: 1,
    title: "Ship the composer pill",
    source: {
      concertId: "concert-1",
      agentId: "agent-1",
      concertName: "paseo-plugins",
      checkout: ".",
      branch: null,
      base: null,
      dirtyFingerprint: null,
    },
    createdAt: 0,
    updatedAt: 0,
    status: "running",
    taskCount: 5,
    acceptedRevision: 1,
    completedTasks: 2,
    activeTasks: 1,
    message: null,
    projectName: "paseo-plugins",
    ...overrides,
  };
}

function listOutput(
  symphonies: SymphonyListEntry[],
  overrides: Partial<ListOutput> = {},
): ListOutput {
  return { symphonies, unavailable: 0, incomplete: false, ...overrides };
}

/** A fake client in the exact shape `registerSymphonyPills` consumes. */
function fakeClient(seed?: Partial<FakeState>) {
  const state: FakeState = {
    agents: [],
    listResult: listOutput([]),
    rpcCalls: 0,
    rpcImpl: () => Promise.resolve(state.listResult),
    observers: [],
    pills: [],
    openCalls: [],
    releases: 0,
    ...seed,
  };
  const base = {
    paseo: {
      agents: {
        list: async () => ({
          entries: state.agents,
          subscription: {
            subscribe: (observer: FakeObserver) => {
              state.observers.push(observer);
              state.onSubscribe?.(observer);
              return () => {
                const index = state.observers.indexOf(observer);
                if (index !== -1) {
                  state.observers.splice(index, 1);
                }
              };
            },
            release: () => {
              state.releases += 1;
              state.observers.length = 0;
              return Promise.resolve();
            },
          },
        }),
      },
    },
    rpc: async () => {
      state.rpcCalls += 1;
      return state.rpcImpl();
    },
    openPanel: (
      id: string,
      options: { workspaceId: string; agentId: string },
    ) => {
      state.openCalls.push({ id, ...options });
    },
  };
  const addComposerPill = (contribution: PluginComposerPillContribution) => {
    const pill: RecordedPill = { contribution, updates: [], removed: false };
    state.pills.push(pill);
    return {
      update: (patch: RecordedUpdate) => {
        // Mirrors the host: updates after removal do nothing.
        if (!pill.removed) {
          pill.updates.push(patch);
        }
      },
      remove: () => {
        pill.removed = true;
      },
    };
  };
  return {
    client: { ...base, addComposerPill } satisfies PillClient,
    withoutComposerPill: base satisfies PillClient,
    state,
  };
}

/** Drains the microtask queue far enough for attach plus one refresh. */
async function flush(): Promise<void> {
  for (let round = 0; round < 8; round += 1) {
    await Promise.resolve();
  }
}

const theme = {
  colors: {
    surface0: "#000000",
    surface1: "#101010",
    surface2: "#202020",
    border: "#303030",
    foreground: "#ffffff",
    foregroundMuted: "#aaaaaa",
    accent: "#0a8cff",
    accentForeground: "#ffffff",
    statusSuccess: "#00cc00",
    statusWarning: "#ffcc00",
    statusDanger: "#ff0000",
  },
} satisfies PluginTheme;

/** The host calls the popover body with these, theme aside. */
function contentProps(
  overrides: Partial<Omit<PluginButtonContentProps, "theme">> = {},
): PluginButtonContentProps {
  return {
    theme,
    host: { id: "host-1", label: "Paseo" },
    layout: { compact: false, platform: "web" },
    context: "agent",
    workspaceId: "concert-1",
    agentId: "agent-1",
    close: () => undefined,
    ...overrides,
  };
}

/** Invokes the popover body and unwraps the element `createElement` made. */
function renderContent(pill: RecordedPill, props: PluginButtonContentProps) {
  const behavior = pill.contribution.button.behavior;
  assert.equal(behavior.kind, "popover");
  if (behavior.kind !== "popover") {
    throw new Error("unreachable");
  }
  // The SDK types the behavior's content as any component; it is always a
  // function here, and createElement always returns an element.
  const body = behavior.Content as FunctionComponent<PluginButtonContentProps>;
  const node = body(props) as ReactElement<{
    entries: readonly SymphonyListEntry[];
    onOpen: (symphony: SymphonyListEntry) => void;
  }> | null;
  assert.ok(node, "the popover body must render an element");
  return node.props;
}

function pillOptions(timers: FakeTimers): SymphonyPillOptions {
  return { timers };
}

function firstPill(state: FakeState): RecordedPill {
  const pill = state.pills[0];
  assert.ok(pill, "expected a registered pill");
  return pill;
}

await test("a host without addComposerPill attaches nothing and skips the loop", async () => {
  const { withoutComposerPill, state } = fakeClient();
  const timers = new FakeTimers();
  await register(withoutComposerPill, pillOptions(timers))();
  await flush();
  assert.equal(state.rpcCalls, 0);
  assert.equal(state.observers.length, 0);
  assert.equal(timers.size, 0);
  assert.equal(state.pills.length, 0);
  assert.equal(state.releases, 0);
});

await test("one agent with one ongoing symphony registers its pill", async () => {
  const { client, state } = fakeClient({
    agents: [{ agent: { id: "agent-1" } }],
    listResult: listOutput([symphonyFixture()]),
  });
  const timers = new FakeTimers();
  const remover = register(client, pillOptions(timers));
  await flush();
  assert.equal(state.pills.length, 1);
  const { contribution } = firstPill(state);
  assert.equal(contribution.id, "symphonies");
  assert.equal(contribution.workspaceId, "concert-1");
  assert.equal(contribution.agentId, "agent-1");
  assert.equal(contribution.button.label, "Symphony 2/5");
  assert.equal(contribution.button.title, "Ongoing symphonies");
  assert.equal(contribution.button.icon, "Activity");
  // The 30s fallback waits behind the initial refresh.
  assert.ok(timers.scheduledAll((ms) => ms >= 30000));
  await remover();
});

await test("a refresh updates label and icon without patching behavior", async () => {
  const { client, state } = fakeClient({
    agents: [{ agent: { id: "agent-1" } }],
    listResult: listOutput([symphonyFixture()]),
  });
  const timers = new FakeTimers();
  const remover = register(client, pillOptions(timers));
  await flush();
  state.listResult = listOutput([
    symphonyFixture({
      status: "blocked",
      message: "Task widen needs a decision",
    }),
  ]);
  timers.advance(30000);
  await flush();

  const pill = firstPill(state);
  assert.equal(state.pills.length, 1, "a refresh never re-registers");
  assert.equal(pill.contribution.button.label, "Symphony 2/5");
  assert.deepEqual(pill.updates, [
    {
      title: "Ongoing symphonies",
      label: symphonyStatusLabel("blocked"),
      icon: "CirclePause",
    },
  ]);
  await remover();
});

await test("several ongoing symphonies label with a count, in one pill", async () => {
  const { client, state } = fakeClient({
    agents: [{ agent: { id: "agent-1" } }],
    listResult: listOutput([
      symphonyFixture({ id: "sym-a" }),
      symphonyFixture({
        id: "sym-b",
        source: {
          concertId: "concert-2",
          agentId: "agent-1",
          concertName: "other",
          checkout: ".",
          branch: null,
          base: null,
          dirtyFingerprint: null,
        },
      }),
    ]),
  });
  const timers = new FakeTimers();
  const remover = register(client, pillOptions(timers));
  await flush();
  const pill = firstPill(state);
  assert.equal(state.pills.length, 1);
  assert.equal(pill.contribution.button.label, "2 symphonies");
  // The first group member's concert owns the placement.
  assert.equal(pill.contribution.workspaceId, "concert-1");
  assert.equal(pill.contribution.button.icon, "Activity");
  await remover();
});

await test("a finished symphony drops its agent's pill", async () => {
  const { client, state } = fakeClient({
    agents: [{ agent: { id: "agent-1" } }],
    listResult: listOutput([symphonyFixture()]),
  });
  const timers = new FakeTimers();
  const remover = register(client, pillOptions(timers));
  await flush();
  assert.equal(state.pills.length, 1);
  state.listResult = listOutput([symphonyFixture({ status: "completed" })]);
  timers.advance(30000);
  await flush();
  assert.equal(state.pills.length, 1);
  assert.equal(firstPill(state).removed, true);
  await remover();
});

await test("an agent leaving drops its pill even when the list request fails", async () => {
  const { client, state } = fakeClient({
    agents: [{ agent: { id: "agent-1" } }],
    listResult: listOutput([symphonyFixture()]),
  });
  const timers = new FakeTimers();
  const remover = register(client, pillOptions(timers));
  await flush();
  assert.equal(firstPill(state).removed, false);
  state.rpcImpl = () => Promise.reject(new Error("boom"));

  const observer = state.observers[0];
  assert.ok(observer, "the agents subscription was never attached");
  observer.update({ payload: { kind: "remove", agentId: "agent-1" } });
  assert.equal(firstPill(state).removed, true);
  await remover();
});

await test("a snapshot plus buffered removal replayed during subscribe win over the list response", async () => {
  const { client, state } = fakeClient({
    agents: [{ agent: { id: "agent-1" } }],
    listResult: listOutput([symphonyFixture()]),
    onSubscribe: (observer) => {
      observer.snapshot({ entries: [] });
      observer.update({ payload: { kind: "remove", agentId: "agent-1" } });
    },
  });
  const timers = new FakeTimers();
  const remover = register(client, pillOptions(timers));
  // The list response arrives after subscribe()'s synchronous replay; the
  // agent stays absent and the stale response registers no pill.
  await flush();
  timers.advance(30000);
  await flush();
  assert.equal(state.pills.length, 0);
  await remover();
});

await test("a buffered upsert replayed during subscribe is not undone by the list response", async () => {
  const { client, state } = fakeClient({
    listResult: listOutput([symphonyFixture()]),
    onSubscribe: (observer) => {
      observer.update({
        payload: {
          kind: "upsert",
          agent: { id: "agent-1", provider: "test", cwd: ".", model: null },
        },
      });
    },
  });
  const timers = new FakeTimers();
  const remover = register(client, pillOptions(timers));
  await flush();
  assert.equal(state.pills.length, 1);
  assert.equal(state.pills[0]?.contribution.agentId, "agent-1");
  await remover();
});

await test("a moved concert re-registers the pill at the new workspace", async () => {
  const { client, state } = fakeClient({
    agents: [{ agent: { id: "agent-1" } }],
    listResult: listOutput([symphonyFixture()]),
  });
  const timers = new FakeTimers();
  const remover = register(client, pillOptions(timers));
  await flush();
  assert.equal(state.pills.length, 1);
  assert.equal(state.pills[0]?.contribution.workspaceId, "concert-1");

  state.listResult = listOutput([
    symphonyFixture({
      source: {
        concertId: "concert-2",
        agentId: "agent-1",
        concertName: "moved",
        checkout: ".",
        branch: null,
        base: null,
        dirtyFingerprint: null,
      },
    }),
  ]);
  timers.advance(30000);
  await flush();
  assert.equal(
    state.pills.length,
    2,
    "a moved group re-registers for the host key",
  );
  assert.equal(state.pills[0]?.removed, true);
  const moved = state.pills[1];
  assert.ok(moved, "expected the replacement registration");
  assert.equal(moved.removed, false);
  assert.equal(moved.contribution.workspaceId, "concert-2");
  assert.equal(moved.contribution.agentId, "agent-1");
  assert.deepEqual(moved.updates, [], "behavior is set once, at registration");
  await remover();
});

await test("refreshes serialize: a queued rerun applies after the pending response", async () => {
  const { client, state } = fakeClient({
    agents: [{ agent: { id: "agent-1" } }],
  });
  const gates = gatedRpc();
  state.rpcImpl = gates.impl;
  const timers = new FakeTimers();
  const remover = register(client, pillOptions(timers));
  await flush();
  assert.equal(state.rpcCalls, 1, "the initial refresh holds the only request");

  // A fallback trigger while a request is pending queues one rerun; it
  // never creates a second in-flight response that could arrive first.
  timers.advance(30000);
  assert.equal(state.rpcCalls, 1);

  // The earlier (stale) response applies first: the known ongoing group.
  gates.respond(0, listOutput([symphonyFixture()]));
  await flush();
  assert.equal(firstPill(state).removed, false);
  assert.equal(state.rpcCalls, 2, "the queued rerun starts after apply");

  // The newer response claims the symphonies ended; it wins.
  gates.respond(1, listOutput([]));
  await flush();
  assert.equal(firstPill(state).removed, true);
  await remover();
});

await test("an upsert adds the agent's pill; a following refresh stays debounced", async () => {
  const { client, state } = fakeClient({
    listResult: listOutput([symphonyFixture()]),
  });
  const timers = new FakeTimers();
  const remover = register(client, pillOptions(timers));
  await flush();
  assert.equal(state.pills.length, 0);
  assert.equal(state.rpcCalls, 1);

  const observer = state.observers[0];
  assert.ok(observer, "the agents subscription was never attached");
  observer.update({
    payload: {
      kind: "upsert",
      agent: { id: "agent-1", provider: "test", cwd: ".", model: null },
    },
  });
  assert.equal(state.pills.length, 1);
  assert.equal(state.pills[0]?.contribution.agentId, "agent-1");
  assert.equal(state.rpcCalls, 1, "the debounced refresh has not run yet");
  timers.advance(500);
  await flush();
  assert.equal(state.rpcCalls, 2);
  assert.equal(state.pills.length, 1, "a debounced refresh never re-registers");
  await remover();
});

await test("agents missing from the subscription get no pill", async () => {
  const { client, state } = fakeClient({
    agents: [{ agent: { id: "agent-1" } }],
    listResult: listOutput([
      symphonyFixture({
        source: {
          concertId: "concert-1",
          agentId: "agent-2",
          concertName: "elsewhere",
          checkout: ".",
          branch: null,
          base: null,
          dirtyFingerprint: null,
        },
      }),
    ]),
  });
  const timers = new FakeTimers();
  const remover = register(client, pillOptions(timers));
  await flush();
  timers.advance(30000);
  await flush();
  assert.equal(state.rpcCalls, 2);
  assert.equal(state.pills.length, 0);
  await remover();
});

await test("symphonies without a Conductor agent get no pill", async () => {
  const { client, state } = fakeClient({
    agents: [{ agent: { id: "agent-1" } }],
    listResult: listOutput([
      symphonyFixture({
        source: {
          concertId: "concert-1",
          agentId: null,
          concertName: "paseo-plugins",
          checkout: ".",
          branch: null,
          base: null,
          dirtyFingerprint: null,
        },
      }),
    ]),
  });
  const timers = new FakeTimers();
  const remover = register(client, pillOptions(timers));
  await flush();
  timers.advance(30000);
  await flush();
  assert.equal(state.pills.length, 0);
  await remover();
});

await test("an RPC failure keeps current pills and the fallback retries", async () => {
  const { client, state } = fakeClient({
    agents: [{ agent: { id: "agent-1" } }],
    listResult: listOutput([symphonyFixture()]),
  });
  const timers = new FakeTimers();
  const remover = register(client, pillOptions(timers));
  await flush();
  assert.equal(state.pills.length, 1);

  state.rpcImpl = () => Promise.reject(new Error("boom"));
  state.listResult = listOutput([]);
  timers.advance(30000);
  await flush();
  const pill = firstPill(state);
  assert.equal(pill.removed, false, "the failure must not drop the pill");
  assert.equal(pill.updates.length, 0);

  state.rpcImpl = () => Promise.resolve(state.listResult);
  timers.advance(30000);
  await flush();
  assert.equal(firstPill(state).removed, true);
  await remover();
});

await test("an RPC resolving after unload registers nothing", async () => {
  const { client, state } = fakeClient({
    agents: [{ agent: { id: "agent-1" } }],
    listResult: listOutput([symphonyFixture()]),
  });
  let openGate = () => {};
  const gated = new Promise<ListOutput>((resolve) => {
    openGate = () => resolve(state.listResult);
  });
  state.rpcImpl = () => gated;
  const timers = new FakeTimers();
  const remover = register(client, pillOptions(timers));
  await flush();
  assert.equal(state.pills.length, 0);

  await remover();
  assert.equal(state.releases, 1);
  assert.equal(state.observers.length, 0);
  assert.equal(timers.size, 0);

  openGate();
  await flush();
  assert.equal(state.pills.length, 0);
});

await test("unload clears timers, releases the subscription, and removes pills", async () => {
  const { client, state } = fakeClient({
    agents: [{ agent: { id: "agent-1" } }],
    listResult: listOutput([symphonyFixture()]),
  });
  const timers = new FakeTimers();
  const remover = register(client, pillOptions(timers));
  await flush();
  assert.equal(state.pills.length, 1);
  assert.ok(timers.size > 0);

  await remover();
  assert.equal(firstPill(state).removed, true);
  assert.equal(state.releases, 1);
  assert.equal(state.observers.length, 0);
  assert.equal(timers.size, 0);
  // A second remover stays quiet.
  await remover();
  assert.equal(firstPill(state).removed, true);
});

await test("the popover reads live data and opens the podium for its symphony", async () => {
  const { client, state } = fakeClient({
    agents: [{ agent: { id: "agent-1" } }],
    listResult: listOutput([symphonyFixture()]),
  });
  const timers = new FakeTimers();
  const selected: unknown[] = [];
  const remover = register(client, {
    ...pillOptions(timers),
    selectSymphony: (input) => {
      selected.push(input);
    },
  });
  await flush();
  const pill = firstPill(state);
  const closed: string[] = [];
  const first = renderContent(
    pill,
    contentProps({ close: () => closed.push("close") }),
  );
  assert.deepEqual([...first.entries], [symphonyFixture()]);

  state.listResult = listOutput([
    symphonyFixture({ status: "blocked", title: "Unblock the widening" }),
  ]);
  timers.advance(30000);
  await flush();
  // Same registration, same behavior object, fresh data at the next open.
  assert.equal(state.pills.length, 1);
  assert.equal(pill.updates.length, 1);
  const refreshed = renderContent(
    pill,
    contentProps({ close: () => closed.push("close") }),
  );
  const unblocked = refreshed.entries[0];
  if (!unblocked) {
    throw new Error("the refreshed popover lost its symphony");
  }
  assert.equal(unblocked.title, "Unblock the widening");

  refreshed.onOpen(unblocked);
  assert.deepEqual(state.openCalls, [
    { id: "podium", workspaceId: "concert-1", agentId: "agent-1" },
  ]);
  assert.deepEqual(selected, [
    {
      hostId: "host-1",
      workspaceId: "concert-1",
      symphonyId: symphonyFixture().id,
    },
  ]);
  assert.deepEqual(closed, ["close"]);
  await remover();
});
