import path from "node:path";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";

// https://vite.dev/config/
const __dirname = import.meta.dirname;

// Запросы к API идут через прокси по относительным адресам того же источника.
// Это избавляет от настройки CORS как при разработке, так и при размещении
// клиента и сервера под одним источником в рабочем окружении.
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
  // Для `vite preview` нужен тот же прокси, чтобы локально запущенная
  // производственная сборка могла обращаться к API.
  preview: { proxy: apiProxy },
});
