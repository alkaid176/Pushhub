/**
 * Tracer E2E（05-01 Task 3，D-78）：「Webhook POST → 服务端扇出 → Rust tokio
 * 收帧 → 纯状态机 → Tauri event → 前端窗口显示」端到端真路径切片。
 *
 * 编排：playwright webServer 起 wrangler dev 真服务端（127.0.0.1:4911）→
 * createChannel 建频道 → writeTempConfig 写隔离配置 → launchDesktop 以
 * CDP 端口环境变量 spawn `pnpm tauri dev` 并注入 PH_CONFIG_PATH → 等窗口
 * online → POST /api/send 发 tracer-hello → 断言 5 秒内消息标题出现在窗口。
 *
 * 这是 D-59（纯状态机）/ D-60（连接归 Rust、前端纯展示）架构的端到端初证：
 * 前端窗口内不存在任何 WebSocket 构造（消息经 Rust 进程的连接到达）。
 */
import { test } from "@playwright/test";
import { BASE, createChannel, launchDesktop, rmTempConfig, sendMessage, writeTempConfig } from "./helpers";

test("tracer: Rust 持连接 → POST /api/send → 前端窗口 5 秒内显示消息标题", async ({ request }) => {
  const channel = await createChannel(request);
  const configPath = writeTempConfig(BASE, [
    { id: channel.channelId, name: "tracer", key: channel.channelKey },
  ]);
  // 随机高位 CDP 端口（Pitfall 10：避开其他 WebView2 应用的 9222 之类常用口）
  const cdpPort = 20000 + Math.floor(Math.random() * 20000);
  const desktop = await launchDesktop(cdpPort, { PH_CONFIG_PATH: configPath });

  try {
    // Rust 侧握手 → 状态机 online → ph://status → 窗口状态区（首次 cargo 编译
    // 慢由 timeout 覆盖；本断言只等运行时握手，给 30s）。
    await desktop.page.waitForFunction(
      () => document.getElementById("status")?.textContent === "online",
      null,
      { timeout: 30_000 },
    );

    // 真路径：Node 侧 POST /api/send → DO 扇出 → Rust tokio 收帧 → 状态机
    // EmitMessage → Tauri event ph://message → 前端 textContent 追加。
    await sendMessage(request, channel.sendKey, {
      title: "tracer-hello",
      text: "tracer e2e body — <img src=x onerror=alert(1)> 必须经 textContent 落地",
    });

    await desktop.page.waitForFunction(
      () =>
        document.getElementById("messages")?.textContent?.includes("tracer-hello") ===
        true,
      null,
      { timeout: 5_000 }, // 端到端 5 秒验收线（PLAN must_haves）
    );
  } finally {
    await desktop.cleanup();
    rmTempConfig(configPath);
  }
});
