import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/node_modules/**", "**/dist/**", "**/coverage/**", "**/*.d.ts", "**/.wrangler/**", "apps/web/public/**", "local/**", "evals/**", "packages/sandbox/**"] },
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts", "**/*.tsx"],
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-console": ["error", { allow: ["log", "error", "warn"] }],
      eqeqeq: ["error", "smart"],
    },
  },
  { files: ["**/test/**", "**/e2e/**", "**/scripts/**"], rules: { "@typescript-eslint/no-explicit-any": "off" } },
);
