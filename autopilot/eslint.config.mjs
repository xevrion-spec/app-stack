import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/node_modules/**", "**/dist/**", "**/coverage/**", "**/*.d.ts", "**/.wrangler/**", "apps/web/public/**", "local/**", "evals/**", "packages/sandbox/**", ".stryker-tmp/**", "reports/**", "lighthouse/**"] },
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts", "**/*.tsx"],
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-console": ["error", { allow: ["log", "error", "warn"] }],
      eqeqeq: ["error", "smart"],
      complexity: ["error", 20],
      "max-depth": ["error", 4],
      "max-params": ["error", 6],
      "max-lines-per-function": ["error", { max: 150, skipBlankLines: true, skipComments: true }],
    },
  },
  { files: ["**/test/**", "**/e2e/**", "**/scripts/**"], rules: { "@typescript-eslint/no-explicit-any": "off", "max-lines-per-function": "off", complexity: "off" } },
);
