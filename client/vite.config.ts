import path from "node:path";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";

// https://vite.dev/config/
const __dirname = import.meta.dirname;

// The API is proxied instead of called by absolute URL: the client then talks
// to same-origin relative paths and CORS never enters the picture, in dev or
// behind a single origin in production.
const API_TARGET = process.env.VITE_API_TARGET ?? "http://localhost:3000";

const apiProxy = {
  "/api": { target: API_TARGET, changeOrigin: true },
  "/health": { target: API_TARGET, changeOrigin: true },
};

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  // Порт закреплён: presigned-PUT уходит напрямую в S3 с origin браузера, а CORS
  // бакета настроен ровно на http://localhost:5173. Молчаливый сдвиг на 5174
  // сломал бы presigned-загрузку непрозрачной CORS-ошибкой.
  server: { port: 5173, strictPort: true, proxy: apiProxy },
  // `vite preview` needs the same proxy, otherwise the production build served
  // locally has no API to talk to.
  preview: { proxy: apiProxy },
});
