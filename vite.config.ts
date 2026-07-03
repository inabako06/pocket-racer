import { defineConfig } from "vite";

// シンプルな Vite 設定。Three.js / cannon-es は npm から解決される。
export default defineConfig({
  server: {
    open: true,
  },
  build: {
    target: "es2020",
  },
});
