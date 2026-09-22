import js from "@eslint/js";
import tseslint from "typescript-eslint";
import pluginVue from "eslint-plugin-vue";
import globals from "globals";

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...pluginVue.configs["flat/recommended"],
  {
    languageOptions: {
      globals: globals.browser,
      parserOptions: {
        parser: tseslint.parser,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    files: ["*.config.ts", "*.config.js"],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ["src/components/ui/**/*.vue"],
    rules: {
      "vue/multi-word-component-names": "off",
      "vue/require-default-prop": "off",
    },
  },
);
