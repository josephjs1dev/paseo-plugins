import tseslint from "typescript-eslint";
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
  {
    files: ["index.*.ts", "index.*.tsx", "client/**", "server/**", "shared/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "@getpaseo/client",
                "@getpaseo/client/*",
                "@getpaseo/protocol",
                "@getpaseo/protocol/*",
              ],
              message:
                "Use the host-provided plugin SDK and derive types from its contracts; direct SDK peer imports require local packages during installation.",
            },
          ],
        },
      ],
    },
  },
  // Feature code reaches Paseo only through its host.ts interface.
  {
    files: ["server/agents/**", "server/concerts/**", "server/skills/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "@getpaseo/client",
                "@getpaseo/client/*",
                "@getpaseo/protocol",
                "@getpaseo/protocol/*",
              ],
              message:
                "Use the host-provided plugin SDK and derive types from its contracts; direct SDK peer imports require local packages during installation.",
            },
            {
              group: [
                "@getpaseo/plugin/server",
                "**/paseo/*",
                "!**/paseo/types",
                "**/entrypoints/*",
              ],
              message:
                "Feature code calls Paseo through its host.ts interface; only server/paseo and server/entrypoints use the SDK.",
            },
          ],
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
