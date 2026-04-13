import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier/flat";

export default tseslint.config(
  // Ignore build outputs across all packages
  { ignores: ["**/dist/**", "**/out/**", "**/node_modules/**", "**/.turbo/**", "**/.vite/**"] },

  // Base: all TypeScript files
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended, eslintConfigPrettier],
    files: ["**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },

  // React packages (app + web + shared UI)
  {
    files: ["app/src/**/*.{ts,tsx}", "web/src/**/*.{ts,tsx}", "shared/src/ui/**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
    },
  },

  // Shared package: Node-compatible, no browser globals
  {
    files: ["shared/src/**/*.{ts,tsx}"],
    languageOptions: {
      globals: globals.node,
    },
  },

  // Worker files: Node environment
  {
    files: ["app/src/workers/**/*.ts", "app/src/native-host/**/*.ts"],
    languageOptions: {
      globals: globals.node,
    },
  },
);
