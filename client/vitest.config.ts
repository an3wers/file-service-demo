import path from "node:path"
import vue from "@vitejs/plugin-vue"
import { defineConfig } from "vitest/config"

const __dirname = import.meta.dirname

// Отдельный конфиг, а не поле `test` в `vite.config.ts`: при наличии
// vitest.config.ts vite.config.ts не подхватывается вовсе, и тесты не тянут ни
// tailwind-плагин, ни dev-proxy — им нужен только SFC-компилятор.
export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "happy-dom",
    include: ["src/**/*.{test,spec}.ts"],
    setupFiles: ["./src/test/setup.ts"],
    // Глобалы выключены: `import { describe, it, expect } from "vitest"`
    // типизируется под существующим tsconfig.app.json без правки `types`.
    globals: false,
    // Tailwind-директивы в style.css нечего разбирать в jsdom-окружении —
    // классы в тестах проверяются как строки.
    css: false,
    clearMocks: true,
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
  },
})
