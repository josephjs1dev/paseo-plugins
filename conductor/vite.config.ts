import { defineConfig } from "vite";
import { fileURLToPath, URL } from "node:url";
export default defineConfig({
  root: fileURLToPath(new URL("./tests/preview", import.meta.url)),
  resolve: {
    alias: {
      "react-native": "react-native-web",
      "@getpaseo/plugin/client/react-native": fileURLToPath(
        new URL("./tests/preview/plugin-native.tsx", import.meta.url),
      ),
    },
  },
  define: { "process.env.NODE_ENV": JSON.stringify("development") },
  build: { outDir: "../../dist/preview", emptyOutDir: true },
  server: { port: 5178, strictPort: true, host: "127.0.0.1" },
});
