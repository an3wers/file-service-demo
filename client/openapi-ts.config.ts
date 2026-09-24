import { defineConfig } from "@hey-api/openapi-ts";

export default defineConfig({
  input: "../server/openapi.json",
  output: "src/api/generated",
  plugins: ["@hey-api/typescript"],
});
