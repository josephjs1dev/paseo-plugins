import assert from "node:assert/strict";
import test from "node:test";
import { openInbox, registerInboxNavigation } from "../client/registration";

function fixture() {
  const calls: string[] = [];
  const register = (kind: string, id: string) => {
    calls.push(`${kind}:${id}`);
    return () => {
      calls.push(`remove:${kind}:${id}`);
    };
  };
  const legacy = {
    addSurface: (id: string) => register("surface", id),
    addSidebarItem: ({ surface }: { surface: string }) =>
      register("sidebar", surface),
    addCommandCenterItem: ({ id }: { id: string }) => register("command", id),
  } satisfies Parameters<typeof registerInboxNavigation>[0];
  const modern = {
    ...legacy,
    addScreen: ({ id }: { id: string }) => register("screen", id),
    addSidebarHeaderItem: ({ id }: { id: string }) => register("header", id),
  } satisfies Parameters<typeof registerInboxNavigation>[0];
  return { calls, legacy, modern };
}

await test("0.10 registers a host-wide surface and native sidebar entry, with cleanup", async () => {
  const { calls, legacy } = fixture();
  const removers = registerInboxNavigation(
    legacy,
    () => null,
    () => null,
  );
  assert.deepEqual(calls, [
    "surface:podium",
    "sidebar:podium",
    "command:open-inbox",
  ]);
  for (const remove of removers.reverse()) {
    await remove();
  }
  assert.deepEqual(calls.slice(3), [
    "remove:command:open-inbox",
    "remove:sidebar:podium",
    "remove:surface:podium",
  ]);
});

await test("0.11 registers only the modern screen and live sidebar contribution", () => {
  const { calls, modern } = fixture();
  registerInboxNavigation(
    modern,
    () => null,
    () => null,
  );
  assert.deepEqual(calls, [
    "screen:inbox",
    "header:inbox",
    "command:open-inbox",
  ]);
});

await test("an incomplete modern capability set keeps the working legacy entry points", () => {
  const { calls, legacy, modern } = fixture();
  registerInboxNavigation(
    { ...legacy, addScreen: modern.addScreen },
    () => null,
    () => null,
  );
  assert.deepEqual(calls.slice(0, 2), ["surface:podium", "sidebar:podium"]);
});

await test("Command Center opens the selected host through its available navigation API", () => {
  const calls: string[] = [];
  const legacy = { openSurface: (id: string) => calls.push(`surface:${id}`) };
  openInbox(legacy);
  openInbox({
    ...legacy,
    openScreen: ({ screenId }) => {
      calls.push(`screen:${screenId}`);
    },
  });
  assert.deepEqual(calls, ["surface:podium", "screen:inbox"]);
});
