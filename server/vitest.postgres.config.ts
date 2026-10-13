import { defineConfig } from "vitest/config";
import base from "./vitest.config.js";

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ["src/**/*.postgres.test.ts"],
    exclude: [],
    env: { ...base.test?.env, DATABASE_PORT: "55431" },
  },
});
