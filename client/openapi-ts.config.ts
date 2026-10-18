import { defineConfig } from "@hey-api/openapi-ts";

export default defineConfig({
  input: "../server/openapi.json",
  output: {
    path: "src/api/generated",
    header: [
      "// Этот файл автоматически сгенерирован с помощью @hey-api/openapi-ts",
    ],
  },
  plugins: ["@hey-api/typescript"],
});
