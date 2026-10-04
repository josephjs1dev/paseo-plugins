import type { PluginServerContext } from "@getpaseo/plugin/server";
import { fixtureProvider } from "./server/provider";
export default function contribute(server: PluginServerContext) {
  server.registerProvider(fixtureProvider());
  return () => {};
}
