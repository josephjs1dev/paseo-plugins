import tseslint from "typescript-eslint";

const sdkPeerImports = {
  group: [
    "@getpaseo/client",
    "@getpaseo/client/*",
    "@getpaseo/protocol",
    "@getpaseo/protocol/*",
  ],
  message:
    "Use the host-provided plugin SDK and derive types from its contracts; direct SDK peer imports require local packages during installation.",
};
const usePaseoMessage =
  "usePaseo is allowed only in client/paseo/; keep Paseo data access behind that module.";
const harnessImports = {
  group: ["**/engine/harnesses", "**/engine/harnesses/*"],
  message:
    "Only server/symphonies/metrics.ts and server/entrypoints may import harness log readers. Domain code sees tokens through metrics.",
};
export default tseslint.config(
  { ignores: ["dist/**", "test-results/**", "playwright-report/**"] },
  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      curly: ["error", "all"],
      "no-nested-ternary": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
    },
  },
  // Each file group gets one no-restricted-imports entry, because a later
  // entry for the same rule replaces an earlier one instead of extending it.
  {
    files: [
      "index.*.ts",
      "index.*.tsx",
      "server/engine/paseo/**",
      "server/entrypoints/**",
    ],
    rules: {
      "no-restricted-imports": ["error", { patterns: [sdkPeerImports] }],
    },
  },
  // The server entry file is not part of server/entrypoints; it may import the
  // Paseo SDK but not the harness readers.
  {
    files: ["index.*.ts", "index.*.tsx"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [sdkPeerImports, harnessImports] },
      ],
    },
  },
  // Only the Paseo adapter, the entrypoints, and the server entry file may
  // import the Paseo SDK or server/engine/paseo modules. Domain code reaches Paseo
  // through the host.ts ports; tests exercise the adapter directly. Harness
  // readers are likewise visible only to metrics collection and entrypoints.
  {
    files: ["server/**", "shared/**"],
    ignores: [
      "server/engine/paseo/**",
      "server/entrypoints/**",
      "server/symphonies/metrics.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            sdkPeerImports,
            {
              group: [
                "@getpaseo/plugin/server",
                "@getpaseo/plugin/server/*",
                "**/paseo/*",
              ],
              message:
                "Only server/engine/paseo, server/entrypoints, and index.server.ts may import the Paseo SDK or server/engine/paseo modules. Domain code calls Paseo through its host.ts interface.",
            },
            harnessImports,
          ],
        },
      ],
    },
  },
  // The client never imports the Paseo SDK server side or server/engine/paseo at all;
  // its Paseo data access lives behind client/paseo/.
  {
    files: ["client/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            sdkPeerImports,
            {
              group: [
                "@getpaseo/plugin/server",
                "@getpaseo/plugin/server/*",
                "**/server/engine/paseo/*",
              ],
              message:
                "The client must not import the Paseo SDK server side or server/engine/paseo modules; use client/paseo/ for Paseo data access.",
            },
            harnessImports,
          ],
        },
      ],
    },
  },
  // Paseo data access lives in client/paseo/; the Podium borrows it through
  // that module instead of calling usePaseo itself.
  {
    files: ["client/**"],
    ignores: ["client/paseo/**"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: 'ImportSpecifier[imported.name="usePaseo"]',
          message: usePaseoMessage,
        },
        // Namespace imports: Plugin.usePaseo() or const { usePaseo } = Plugin.
        {
          selector: 'MemberExpression[property.name="usePaseo"]',
          message: usePaseoMessage,
        },
        {
          selector: 'ObjectPattern > Property[key.name="usePaseo"]',
          message: usePaseoMessage,
        },
      ],
    },
  },
  // Fake asynchronous adapters preserve the production interface without artificial waits.
  {
    files: ["tests/**/*.ts", "tests/**/*.tsx"],
    rules: { "@typescript-eslint/require-await": "off" },
  },
  { files: ["**/*.mjs"], ...tseslint.configs.disableTypeChecked },
);
