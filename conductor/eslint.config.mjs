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
      "server/paseo/**",
      "server/entrypoints/**",
    ],
    rules: {
      "no-restricted-imports": ["error", { patterns: [sdkPeerImports] }],
    },
  },
  // Only the Paseo adapter, the entrypoints, and the server entry file may
  // import the Paseo SDK or server/paseo modules. Domain code reaches Paseo
  // through the host.ts ports; tests exercise the adapter directly.
  {
    files: ["server/**", "shared/**"],
    ignores: ["server/paseo/**", "server/entrypoints/**"],
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
                "Only server/paseo, server/entrypoints, and index.server.ts may import the Paseo SDK or server/paseo modules. Domain code calls Paseo through its host.ts interface.",
            },
          ],
        },
      ],
    },
  },
  // The client never imports the Paseo SDK server side or server/paseo at all;
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
                "**/server/paseo/*",
              ],
              message:
                "The client must not import the Paseo SDK server side or server/paseo modules; use client/paseo/ for Paseo data access.",
            },
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
