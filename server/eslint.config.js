import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

/**
 * Vendor packages a module's domain and application layers must never reach
 * for directly — that knowledge belongs to the adapter that speaks the
 * protocol. Node builtins and this project's own shared kernel (`errors.ts`,
 * `logger.ts`, the `storage/` port types) are not in this list on purpose:
 * see `src/modules/files/README.md` for why the boundary stops there.
 */
const VENDOR_PACKAGES = ["pg", "express", "multer", "@aws-sdk/client-s3", "@aws-sdk/s3-request-presigner"];

const MODULES_DIR = fileURLToPath(new URL("src/modules/", import.meta.url));

/**
 * One name per module under `src/modules`, read from disk rather than typed
 * out by hand: a rule that named `files` literally would stop protecting a
 * module the day a second one is added next to it, and nobody editing that
 * new module would think to come back here and extend a list.
 */
const MODULE_NAMES = readdirSync(MODULES_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

/**
 * "Outside the module, only index.ts is visible" has to name which module,
 * because the file being linted is not always the file doing the reaching —
 * a sibling module's own code is just as "outside" as `composition.ts` is.
 * `ignores` here means "this module's own files", so its own cross-layer
 * imports stay governed by the domain/application rules below, not this one.
 *
 * Known gap: `no-restricted-imports` matches the import specifier's text, not
 * where it resolves to. A file outside `modules/<name>/` that descends into it
 * (`composition.ts`'s `./modules/files/...`) spells the module's name and gets
 * caught; a sibling module reaching sideways-then-in via `..` (from
 * `modules/other/x.ts`, `../files/domain/...`) never spells it and slips past.
 * With one module today there is no sibling to reach from. Closing this for
 * real needs path-resolved zones (e.g. `eslint-plugin-import`'s
 * `no-restricted-paths`) — worth adding before a second module exists.
 */
const moduleBoundaryRules = MODULE_NAMES.map((name) => ({
  files: ["src/**/*.ts"],
  ignores: [`src/modules/${name}/**/*.ts`],
  rules: {
    "no-restricted-imports": [
      "error",
      {
        patterns: [
          {
            group: [`**/modules/${name}/*/**`],
            message: `Снаружи модуля видно только modules/${name}/index.ts`,
          },
        ],
      },
    ],
  },
}));

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // domain/ не импортирует ничего, кроме себя: ни другие слои того же
    // модуля, ни пакеты вендора, чьё знание принадлежит адаптерам. Тесты
    // домена подчиняются тому же правилу — им и не нужен ничей чужой слой.
    files: ["src/modules/*/domain/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: ["**/application/**", "**/adapters/**", "**/testing/**"],
          paths: VENDOR_PACKAGES,
        },
      ],
    },
  },
  {
    // application/ знает только домен: не адаптеры. Тестовые двойники —
    // исключение прямо здесь: тест сценария обязан собрать его на вторых
    // реализациях, и это единственное место, где application/ вправе знать
    // про testing/.
    files: ["src/modules/*/application/**/*.ts"],
    ignores: ["src/modules/*/application/**/*.test.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: ["**/adapters/**", "**/testing/**"],
          paths: VENDOR_PACKAGES,
        },
      ],
    },
  },
  // Наружу модуля видно только index.ts — ни один другой файл в src, включая
  // файлы соседних модулей, не заглядывает глубже фасада. Один блок на модуль,
  // а не один на весь src/modules: иначе исключение для «это файлы модуля»
  // освобождало бы от правила и файлы совсем другого модуля.
  ...moduleBoundaryRules,
);
