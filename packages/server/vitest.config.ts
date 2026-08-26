// 官方配置模式（Code Example 4）：
// cloudflareTest + wrangler.configPath —— compatibility_date 与全部 bindings
// 自动从 wrangler.jsonc 同步，无需手抄。
// 测试命令整体 --max-workers=1 --no-isolate（WS+DO 不支持按文件隔离，Pitfall 1），
// 由 package.json 的 test script 固化。
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: "./wrangler.jsonc",
      },
      // ADMIN_KEY 是 Worker secret（wrangler secret put，不在 wrangler.jsonc）：
      // 插件读不到——经 miniflare.bindings 注入测试专用值（仅测试环境，
      // 与生产 secret 无关，可安全入库；生产值绝不写入任何仓库文件）。
      miniflare: {
        bindings: {
          ADMIN_KEY: "test-admin-key-0123456789abcdef",
        },
      },
    }),
  ],
});
