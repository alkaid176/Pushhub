/**
 * SC1-b/WIN-01 关窗不断线 E2E（05-07 Task 2）：隐藏窗口（模拟关窗——
 * CloseRequested 被拦截为 hide 的同一 window.hide 路径）期间消息照常进入
 * Rust 缓冲；恢复窗口后经快照重建（切换频道 → channel_snapshot 并集合并）
 * 包含断窗期间全部消息。
 *
 * 隐藏/恢复手段：经 CDP page.evaluate 调 __TAURI_INTERNALS__.invoke
 * （plugin:window|hide/show，label main——capabilities 已授权最小权限
 * allow-hide；与 05-06 allow-show/set-focus 同款先例）。通知路径不在此
 * 断言（OS 层 winrt toast——阶段末 UAT 人工项）。
 *
 * 断言面（acceptance）：
 *  - hide 后 is_visible=false（真实隐藏生效）；
 *  - 隐藏期间 sendMessage 2 条 → 消息进 Rust 缓冲（连接归 Rust 进程，
 *    不依赖窗口可见性）；
 *  - show 后切换到另一频道再切回（触发 channel_snapshot 全量重建路径）：
 *    既有 1 条 + 断窗期间 2 条全部可见且 seq 升序。
 */
import { test, expect } from "@playwright/test";
import { BASE, createChannel, launchDesktop, rmTempConfig, sendMessage, writeTempConfig } from "./helpers";

test("SC1-b: 隐藏窗口期间消息进缓冲 → 恢复后快照重建含断窗期间全部消息", async ({ request }) => {
  const channelA = await createChannel(request);
  const channelB = await createChannel(request);
  const configPath = writeTempConfig(BASE, [
    { id: channelA.channelId, name: "main-win", key: channelA.channelKey },
    { id: channelB.channelId, name: "switch-target", key: channelB.channelKey },
  ]);
  const cdpPort = 20000 + Math.floor(Math.random() * 20000);
  const desktop = await launchDesktop(cdpPort, { PH_CONFIG_PATH: configPath });

  try {
    const page = desktop.page;
    const isVisible = () =>
      page.evaluate(
        () => (window as unknown as {
          __TAURI_INTERNALS__: { invoke(cmd: string, args: object): Promise<boolean> };
        }).__TAURI_INTERNALS__.invoke("plugin:window|is_visible", { label: "main" }),
      );

    // 1) 在线 + 既有 1 条（隐藏前基线）。
    await page.waitForFunction(
      () => document.getElementById("status")?.textContent === "online",
      null,
      { timeout: 30_000 },
    );
    const base = await sendMessage(request, channelA.sendKey, {
      title: "close-window e2e",
      text: "before-hide",
    });
    await page
      .locator(`#messages .msg[data-seq="${base.seq}"]`)
      .waitFor({ timeout: 15_000 });

    // 2) 隐藏窗口（模拟关窗——CloseRequested 拦截后的同一 hide 路径）。
    await page.evaluate(() =>
      (window as unknown as {
        __TAURI_INTERNALS__: { invoke(cmd: string, args: object): Promise<unknown> };
      }).__TAURI_INTERNALS__.invoke("plugin:window|hide", { label: "main" }),
    );
    expect(await isVisible()).toBe(false);

    // 3) 断窗期间 2 条：消息进 Rust 缓冲（连接归 Rust 进程——窗口可见性无关）。
    const h1 = await sendMessage(request, channelA.sendKey, {
      title: "close-window e2e",
      text: "hidden-period-1",
    });
    const h2 = await sendMessage(request, channelA.sendKey, {
      title: "close-window e2e",
      text: "hidden-period-2",
    });
    // Rust 侧收帧入缓冲的稳定等待（缓冲与 WebView 渲染相互独立——1.5s 覆盖
    // 本地链路收帧；最终断言不依赖此窗口期 DOM 状态）。
    await page.waitForTimeout(1_500);

    // 4) 恢复窗口。
    await page.evaluate(() =>
      (window as unknown as {
        __TAURI_INTERNALS__: { invoke(cmd: string, args: object): Promise<unknown> };
      }).__TAURI_INTERNALS__.invoke("plugin:window|show", { label: "main" }),
    );
    expect(await isVisible()).toBe(true);

    // 5) 快照重建路径：切到频道 B 再切回 A（channel_snapshot 全量重建 + 并集合并）。
    await page.locator(`.channel-item[data-id="${channelB.channelId}"]`).click();
    await page
      .locator(`.channel-item[data-id="${channelA.channelId}"]`)
      .click();

    // 6) 断窗期间全部消息可见（快照重建后）：3 条全集、升序、零重复（SC1-b）。
    const expected = [base.seq, h1.seq, h2.seq].sort((a, b) => a - b);
    await page.waitForFunction(
      (n) => document.querySelectorAll("#messages .msg[data-seq]").length >= n,
      expected.length,
      { timeout: 15_000 },
    );
    const seqs = await page.evaluate(() =>
      Array.from(document.querySelectorAll("#messages .msg[data-seq]")).map((el) =>
        Number((el as HTMLElement).dataset.seq),
      ),
    );
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(seqs).toEqual(expected);
    const body = await page.evaluate(() => document.getElementById("messages")?.textContent ?? "");
    expect(body).toContain("before-hide");
    expect(body).toContain("hidden-period-1");
    expect(body).toContain("hidden-period-2");
  } finally {
    await desktop.cleanup();
    rmTempConfig(configPath);
  }
});
