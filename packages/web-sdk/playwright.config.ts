// Playwright E2E 编排（02-01，RESEARCH Pattern 4，D-26：本地真 DO/真 KV/真 WS）。
// - webServer 前置构建再起服务（Pitfall 9：E2E 测的是构建产物 pushhub.js，
//   不 build 则 /pushhub.js 404）；
// - wrangler dev --var ADMIN_KEY 只存在于本地 dev 进程，不触生产 secret；
// - baseURL 一律 127.0.0.1 禁 localhost（Pitfall 6：IPv6 绕道致就绪误判）；
// - timeout 60s：esbuild 构建 + wrangler dev 启动窗口。
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  use: {
    baseURL: "http://127.0.0.1:4911",
  },
  webServer: {
    command:
      "pnpm --filter @pushhub/web-sdk run build && pnpm --filter @pushhub/server exec wrangler dev --port 4911 --ip 127.0.0.1 --var ADMIN_KEY:e2e-admin-key",
    url: "http://127.0.0.1:4911/",
    reuseExistingServer: true,
    stdout: "ignore",
    timeout: 60_000,
  },
  timeout: 60_000,
});
