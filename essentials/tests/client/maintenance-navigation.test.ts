import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import type {
  PluginCommandCenterItemContribution,
  PluginSidebarContribution,
} from "@getpaseo/plugin/client";
import { registerMaintenanceNavigation } from "../../client/maintenance-navigation";

function navigation(readHost: () => Promise<unknown>) {
  const sidebar = new Map<string, PluginSidebarContribution>();
  const commands = new Map<string, PluginCommandCenterItemContribution>();
  const client: Parameters<typeof registerMaintenanceNavigation>[0] = {
    rpc: async (contract) => contract.output.parse(await readHost()),
    addSidebarItem(item) {
      assert.equal(sidebar.has(item.id), false);
      sidebar.set(item.id, item);

      return () => {
        if (sidebar.get(item.id) === item) {
          sidebar.delete(item.id);
        }
      };
    },
    addCommandCenterItem(item) {
      assert.equal(commands.has(item.id), false);
      commands.set(item.id, item);

      return () => {
        if (commands.get(item.id) === item) {
          commands.delete(item.id);
        }
      };
    },
  };

  return { sidebar, commands, client };
}

test("actual hostnames label both entries and same-name daemons cannot be grouped together", async () => {
  const first = navigation(async () => ({
    id: "srv_Ab-c",
    name: "workstation",
  }));
  const second = navigation(async () => ({
    id: "srv_ab-c",
    name: "workstation",
  }));
  const stopFirst = registerMaintenanceNavigation(first.client);
  const stopSecond = registerMaintenanceNavigation(second.client);
  await setImmediate();

  try {
    const a = [...first.sidebar.values()][0];
    const b = [...second.sidebar.values()][0];
    assert.ok(a && b);
    assert.equal(a.title, "Harnesses (workstation)");
    assert.equal(b.title, a.title);
    assert.notEqual(a.id, b.id);
    assert.match(a.id, /^[a-z][a-z0-9-]*$/);
    assert.equal(a.surface, "cli-maintenance");
    assert.equal(
      first.commands.get("open-cli-maintenance")?.title,
      "Harnesses (workstation)",
    );
    assert.equal(first.commands.get("open-cli-maintenance")?.context, "global");
  } finally {
    stopFirst();
    stopSecond();
  }

  assert.equal(first.sidebar.size + second.sidebar.size, 0);
  assert.equal(first.commands.size + second.commands.size, 0);
});

test("cleanup before host lookup completes cannot resurrect navigation", async () => {
  let finish = (_value: unknown) => {};

  const pending = new Promise<unknown>((resolve) => {
    finish = resolve;
  });
  const app = navigation(() => pending);
  const stop = registerMaintenanceNavigation(app.client);
  stop();
  finish({ id: "srv_host", name: "example" });
  await setImmediate();
  assert.equal(app.sidebar.size, 0);
  assert.equal(app.commands.size, 0);
});

test("failed identification stays out of the sidebar and retries without duplicate commands", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const app = navigation(async () => {
    calls++;

    if (calls === 1) {
      throw new Error("Unavailable");
    }

    return { id: "srv_ready", name: "ready.local" };
  });
  const stop = registerMaintenanceNavigation(app.client);

  try {
    await setImmediate();
    assert.equal(app.sidebar.size, 0);
    assert.equal(app.commands.get("open-cli-maintenance")?.title, "Harnesses");
    context.mock.timers.tick(30_000);
    await setImmediate();
    assert.equal(app.sidebar.size, 1);
    assert.equal(app.commands.size, 1);
    assert.equal(
      app.commands.get("open-cli-maintenance")?.title,
      "Harnesses (ready.local)",
    );
  } finally {
    stop();
  }

  context.mock.timers.tick(60_000);
  assert.equal(calls, 2);
});
