import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";
import prettier from "eslint-config-prettier/flat";

/**
 * Vendor packages a module's domain and application layers must never reach
 * for directly — that knowledge belongs to the adapter that speaks the
 * protocol. Node builtins and this project's own shared kernel (`logger.ts`,
 * the `storage/` port types) are not in this list on purpose: see
 * `src/modules/files/README.md` for why the boundary stops there.
 */
const VENDOR_PACKAGES = [
  "pg",
  "express",
  "multer",
  "jose",
  "nodemailer",
  "@aws-sdk/client-s3",
  "@aws-sdk/s3-request-presigner",
];

const HTTP_ERRORS = {
  regex: String.raw`^(\.\./){3,}(db/)?errors\.js$`,
  message:
    "Домен и сценарии бросают доменные ошибки; HTTP-код выбирает HTTP-адаптер модуля",
};

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
 * `except` is the module whose own files are being linted: its cross-layer
 * imports are governed by the layer rules below, not by this one.
 *
 * Known gap: `no-restricted-imports` matches the import specifier's text, not
 * where it resolves to. A file outside `modules/<name>/` that descends into it
 * (`composition.ts`'s `./modules/files/...`) spells the module's name and gets
 * caught; a sibling module reaching sideways-then-in via `..` (from
 * `modules/other/x.ts`, `../files/domain/...`) never spells it and slips past.
 * Closing this for real needs path-resolved zones (e.g. `eslint-plugin-import`'s
 * `no-restricted-paths`).
 */
const boundaryPatterns = (except) =>
  MODULE_NAMES.filter((name) => name !== except).map((name) => ({
    group: [`**/modules/${name}/*/**`, `**/modules/${name}/assembly.js`],
    message: `Снаружи модуля видно только modules/${name}/index.ts`,
  }));

const restrictImports = (patterns, paths = []) => ({
  "no-restricted-imports": ["error", { patterns, paths }],
});

const moduleImportRules = MODULE_NAMES.flatMap((name) => [
  {
    files: [`src/modules/${name}/**/*.ts`],
    rules: restrictImports(boundaryPatterns(name)),
  },
  {
    // domain/ не импортирует ничего, кроме себя: ни другие слои того же
    // модуля, ни пакеты вендора, чьё знание принадлежит адаптерам. Тесты
    // домена подчиняются тому же правилу — им и не нужен ничей чужой слой.
    files: [`src/modules/${name}/domain/**/*.ts`],
    rules: restrictImports(
      [
        ...boundaryPatterns(name),
        { group: ["**/application/**", "**/adapters/**", "**/testing/**"] },
        HTTP_ERRORS,
      ],
      VENDOR_PACKAGES,
    ),
  },
  {
    // application/ знает только домен: не адаптеры. Тестовые двойники —
    // исключение прямо здесь: тест сценария обязан собрать его на вторых
    // реализациях, и это единственное место, где application/ вправе знать
    // про testing/.
    files: [`src/modules/${name}/application/**/*.ts`],
    ignores: [`src/modules/${name}/application/**/*.test.ts`],
    rules: restrictImports(
      [
        ...boundaryPatterns(name),
        { group: ["**/adapters/**", "**/testing/**"] },
        HTTP_ERRORS,
      ],
      VENDOR_PACKAGES,
    ),
  },
]);

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
  // Наружу модуля видно только index.ts — ни один другой файл в src, включая
  // файлы соседних модулей, не заглядывает глубже фасада.
  {
    files: ["src/**/*.ts"],
    rules: restrictImports(boundaryPatterns()),
  },
  ...moduleImportRules,
  prettier,
);
