// Flat ESLint config. Type-checking is handled by `tsc` (pnpm typecheck);
// ESLint here focuses on correctness smells and unused code. Prettier owns
// formatting, so eslint-config-prettier disables any stylistic rules.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: ["node_modules/", "out/", "jobs/", "vendor/", "dist/", "**/*.json"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Allow intentionally-unused identifiers when prefixed with `_`.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      // `any` is a real escape hatch in a few spots; flag it without failing CI.
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
  prettier,
);
