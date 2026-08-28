// Playwright E2E 编排（05-01 Task 2，D-78）：wrangler dev 真服务端 + CDP 驱动 Tauri WebView2。
// - webServer 块 verbatim 复用 web-sdk 模式：ADMIN_KEY 经 --var 仅存本地 dev 进程；
// - baseURL 一律 127.0.0.1 禁 localhost（web-sdk Pitfall 6：IPv6 绕道致就绪误判）；
// - workers 1 + fullyParallel false：每份 spec 自行 spawn tauri dev（独占 WebView2 CDP 端口），
//   并行实例会互相干扰（Pitfall 10）；
// - timeout 180s：tauri dev 首跑含完整 cargo 编译（Task 2 的 cargo build 已预热缓存）。
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  use: {
    baseURL: "http://127.0.0.1:4911",
  },
  webServer: {
    command:
      "pnpm --filter @pushhub/server exec wrangler dev --port 4911 --ip 127.0.0.1 --var ADMIN_KEY:e2e-admin-key",
    url: "http://127.0.0.1:4911/",
    reuseExistingServer: true,
    stdout: "ignore",
    timeout: 60_000,
  },
  workers: 1,
  fullyParallel: false,
  timeout: 180_000,
});
