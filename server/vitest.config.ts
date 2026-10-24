import { defineConfig } from "vitest/config";

/**
 * `src/config.ts` валидирует окружение прямо на импорте и завершает процесс,
 * если чего-то не хватает, поэтому тестам нужен полный набор переменных ещё до
 * того, как загрузится первый модуль. Значения фиктивные: юнит-тесты не ходят
 * ни в S3, ни в базу — они лишь дают конфигу пройти валидацию.
 *
 * Эти значения перекрывают всё, что пришло из окружения или из `.env`, так что
 * прогон одинаков и локально, и в CI.
 */
const testEnv = {
  NODE_ENV: "test",
  NOTIFICATION_ENABLED: "false",
  AUTH_PUBLIC_URL: "https://files.example.com",
  AUTH_ALLOWED_ORIGINS: "http://localhost:5173",
  AUTH_RESPONSE_DEADLINE_MS: "15000",
  TRUSTED_PROXIES: "",
  LOG_LEVEL: "silent",
  PORT: "3000",
  JWT_ACCESS_SECRET: "test-access-secret-0123456789abcdef",
  AUTH_CODE_SECRET: "test-refresh-secret-0123456789abcdef",
  COOKIE_SECURE: "false",
  CORS_ORIGIN: "http://localhost:5173",

  S3_ENDPOINT: "https://s3.test.local",
  S3_REGION: "ru-central-1",
  S3_BUCKET_NAME: "test-bucket",
  S3_TENANT_ID: "test-tenant",
  KEY_ID: "test-key-id",
  KEY_SECRET: "test-key-secret",

  DATABASE_HOST: "127.0.0.1",
  DATABASE_PORT: "5432",
  DATABASE_NAME: "file_service_test",
  DATABASE_USER: "test",
  DATABASE_PASSWORD: "test",
  DATABASE_SSL: "false",
};

export default defineConfig({
  test: {
    environment: "node",
    // Тесты лежат рядом с кодом; из сборки они исключены в tsconfig.json.
    include: ["src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/.git/**", "src/**/*.postgres.test.ts"],
    env: testEnv,
    // Явные импорты из "vitest" вместо глобальных describe/it/expect.
    globals: false,
    restoreMocks: true,
    unstubEnvs: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      reportsDirectory: "coverage",
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/server.ts",
        "src/db/migrate.ts",
        "src/scripts/**",
      ],
    },
  },
});
