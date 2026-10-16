import { defineConfig } from "vite";
import { fileURLToPath, URL } from "node:url";
export default defineConfig({
  root: fileURLToPath(new URL("./tests/preview", import.meta.url)),
  resolve: {
    alias: [
      // Order matters: the most specific plugin entry points come first, so
      // only the daemon-runtime modules a page actually imports are faked.
      {
        find: "@getpaseo/plugin/client/react-native",
        replacement: fileURLToPath(
          new URL("./tests/preview/plugin-native.tsx", import.meta.url),
        ),
      },
      {
        find: "@getpaseo/plugin/client",
        replacement: fileURLToPath(
          new URL("./tests/preview/plugin-client.tsx", import.meta.url),
        ),
      },
      {
        find: "@getpaseo/plugin",
        replacement: fileURLToPath(
          new URL("./tests/preview/plugin-client.tsx", import.meta.url),
        ),
      },
      { find: "react-native", replacement: "react-native-web" },
    ],
  },
  define: { "process.env.NODE_ENV": JSON.stringify("development") },
  build: { outDir: "../../dist/preview", emptyOutDir: true },
  server: { port: 5178, strictPort: true, host: "127.0.0.1" },
});
