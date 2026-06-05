import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  // Relative base so the prebuilt bundle works regardless of where
  // cronfish's static server mounts it.
  base: "./",
  plugins: [react(), tailwindcss()],
  server: {
    // dev-only proxy so `bun run dev` can hit `cronfish ui` running on 4747
    proxy: {
      "/api": "http://127.0.0.1:4747",
    },
  },
});
