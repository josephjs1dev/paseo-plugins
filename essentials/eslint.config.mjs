import tseslint from "typescript-eslint";

export default tseslint.config(...tseslint.configs.recommended, {
  rules: {
    curly: ["error", "all"],
    "no-nested-ternary": "error",
    "padding-line-between-statements": [
      "error",
      { blankLine: "always", prev: "*", next: ["return", "if", "for", "try"] },
      { blankLine: "always", prev: "block-like", next: "*" },
      { blankLine: "always", prev: "import", next: "*" },
      { blankLine: "any", prev: "import", next: "import" },
    ],
    "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
  },
});
