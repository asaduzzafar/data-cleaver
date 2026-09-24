import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // The dev server proxies to the backend so the browser sees one origin and
    // CORS never enters the picture during development.
    proxy: { "/api": { target: "http://localhost:8000", changeOrigin: true } },
  },
});
