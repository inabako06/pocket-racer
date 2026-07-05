import { defineConfig } from "vite";

// シンプルな Vite 設定。Three.js / cannon-es は npm から解決される。
export default defineConfig({
  // 相対パス配信（GitHub Pages のサブパス /pocket-racer/ でも、
  // ローカルプレビューでもそのまま動くように）。
  base: "./",
  server: {
    open: true,
  },
  build: {
    target: "es2020",
  },
});
