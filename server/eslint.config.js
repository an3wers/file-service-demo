import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";
import prettier from "eslint-config-prettier/flat";

/**
 * Сторонние пакеты, к которым домен и прикладной слой модуля не должны обращаться
 * напрямую: знание протокола принадлежит соответствующему адаптеру.
 * Встроенные модули Node и общее ядро проекта (`logger.ts`, типы порта
 * `storage/`) намеренно исключены: причины такой границы описаны
 * в `src/modules/files/README.md`.
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
 * Имена модулей в `src/modules` читаются с диска. Если перечислить их вручную,
 * правило перестанет защищать новые модули, а при их добавлении легко забыть
 * обновить этот список.
 */
const MODULE_NAMES = readdirSync(MODULES_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

/**
 * Правило «снаружи модуля виден только index.ts» задаётся для каждого модуля:
 * код соседнего модуля находится за его границей так же, как `composition.ts`.
 * `except` — модуль, чьи файлы сейчас проверяются; его внутренние импорты
 * между слоями проверяются правилами ниже.
 *
 * Известное ограничение: `no-restricted-imports` проверяет текст пути импорта,
 * а не файл, к которому он ведёт. Импорт `./modules/files/...` из
 * `composition.ts` содержит имя модуля и обнаруживается. Импорт соседнего
 * модуля через `..`, например `../files/domain/...` из `modules/other/x.ts`,
 * может обойти проверку. Для устранения нужны правила с разрешением путей,
 * например `no-restricted-paths` из `eslint-plugin-import`.
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
  {
    files: [`src/modules/${name}/adapters/persistence/**/*.ts`],
    ignores: [`src/modules/${name}/adapters/persistence/**/*.test.ts`],
    rules: restrictImports([
      ...boundaryPatterns(name),
      {
        group: ["./sql-*"],
        message:
          "Адаптер хранения не знает другой адаптер: их связывает persistence.ts",
      },
    ]),
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
