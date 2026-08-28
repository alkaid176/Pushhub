// Vite 配置（05-01 Task 2，D-75）：原生 TS 无框架插件（CLAUDE.md Desktop 栈锁定）。
// port 1420 strictPort 对齐 tauri.conf.json build.devUrl（参照工程模式，去 React 插件）。
// watch 忽略 src-tauri/：Rust 侧编译产物不触发前端 HMR 重载。
import { defineConfig } from "vite";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
});
