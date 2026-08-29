/**
 * SC3 回复链 E2E（05-06 Task 3）：真服务端（wrangler dev）× 真 WebView
 * （CDP 驱动 tauri dev）——「消息渲染 → 点击快捷选项 → answered 徽标实时
 * 出现 + 回复冻结 → 第二条消息独立 → 自定义输入回复 → answered」全链。
 *
 * 断言面（acceptance）：
 *  - 快捷回复 → answered 徽标（含回复内容「确认」）；
 *  - answered 后快捷按钮与输入均冻结（disabled 属性路径，RPL-05）；
 *  - 第二条消息未 answered 且第一条徽标保持（消息间独立性）；
 *  - 无 options 消息不渲染快捷按钮；空输入发送禁用；
 *  - 可选加强（已实现）：裸 WS 客户端（Node 22 原生 WebSocket）连同一频道
 *    收 answered 帧——群内实时同步的第三方证据。
 */
import { test, expect } from "@playwright/test";
import { BASE, createChannel, launchDesktop, rmTempConfig, sendMessage, writeTempConfig } from "./helpers";

/** 裸观察者：连同一频道收集 answered 帧（第三方证据——与窗口渲染互不依赖）。 */
function startAnsweredWatcher(channelKey: string): { answered: () => string[]; stop: () => void } {
  const seen: string[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:4911/api/ws/${channelKey}`);
  ws.addEventListener("message", (ev: MessageEvent) => {
    try {
      const frame = JSON.parse(String(ev.data)) as { type?: string; wid?: string };
      if (frame.type === "answered" && frame.wid !== undefined) seen.push(frame.wid);
    } catch {
      // 非 JSON 帧（如 pong）忽略。
    }
  });
  return { answered: () => seen, stop: () => ws.close() };
}

/** 等待指定 wid 的 answered 徽标出现且含预期内容（服务端扇出 → ph://answered）。 */
async function waitAnswered(
  page: import("@playwright/test").Page,
  wid: string,
  contentPart: string,
): Promise<void> {
  await page.waitForFunction(
    (arg: { wid: string; part: string }) => {
      const line = document.querySelector(`.msg[data-wid="${arg.wid}"] .answered-line`);
      return (
        line !== null &&
        !line.hasAttribute("hidden") &&
        (line.textContent ?? "").includes(arg.part)
      );
    },
    { wid, part: contentPart },
    { timeout: 15_000 },
  );
}

test("reply-chain: 快捷回复→answered 实时可见+冻结；第二条自定义回复独立", async ({ request }) => {
  const channel = await createChannel(request);
  const configPath = writeTempConfig(BASE, [
    { id: channel.channelId, name: "reply-e2e", key: channel.channelKey },
  ]);
  // 随机高位 CDP 端口（Pitfall 10）。
  const cdpPort = 20000 + Math.floor(Math.random() * 20000);
  const desktop = await launchDesktop(cdpPort, { PH_CONFIG_PATH: configPath });
  const watcher = startAnsweredWatcher(channel.channelKey);

  try {
    await desktop.page.waitForFunction(
      () => document.getElementById("status")?.textContent === "online",
      null,
      { timeout: 30_000 },
    );

    // 消息 1：两个快捷选项 + callback_url（观察用——服务端哑管道透传）。
    const m1 = await sendMessage(request, channel.sendKey, {
      title: "部署完成通知",
      text: "版本已发布——请选择处置动作",
      options: ["确认", "重试"],
      callback_url: "https://callback-observe.example/hook",
    });
    const row1 = desktop.page.locator(`#messages .msg[data-wid="${m1.id}"]`);
    await row1.waitFor({ timeout: 10_000 });

    // 点击选中消息 → 回复区展开：两个快捷按钮 + 空输入发送禁用。
    await row1.click();
    const replyArea = desktop.page.locator("#reply-area");
    await expect(replyArea).toBeVisible();
    await expect(replyArea.locator("button.quick-option")).toHaveCount(2);
    await expect(replyArea.locator("button.reply-send")).toBeDisabled();

    // 点击「确认」快捷选项 → invoke reply → 服务端扇出 answered → 徽标。
    await replyArea.locator("button.quick-option", { hasText: "确认" }).click();
    await waitAnswered(desktop.page, m1.id, "确认");

    // answered 冻结（disabled 属性路径）：快捷按钮×2 + 输入框均禁用。
    await expect(replyArea.locator("button.quick-option[disabled]")).toHaveCount(2);
    await expect(replyArea.locator("textarea.reply-input[disabled]")).toHaveCount(1);

    // 消息 2（不同 wid，无 options）：未 answered；消息 1 徽标保持。
    const m2 = await sendMessage(request, channel.sendKey, {
      title: "无选项消息",
      text: "本条无快捷选项——走自定义回复",
    });
    const row2 = desktop.page.locator(`#messages .msg[data-wid="${m2.id}"]`);
    await row2.waitFor({ timeout: 10_000 });
    await expect(row1.locator(".answered-line")).toBeVisible();
    await expect(row1.locator(".answered-line")).toContainText("确认");
    await expect(row2.locator(".answered-line")).toBeHidden();

    // 选中消息 2：无快捷按钮（空态纪律）+ 空输入禁用 → 填入后启用 → 发送。
    await row2.click();
    await expect(replyArea.locator("button.quick-option")).toHaveCount(0);
    const input = replyArea.locator("textarea.reply-input");
    const sendBtn = replyArea.locator("button.reply-send");
    await expect(sendBtn).toBeDisabled();
    await input.fill("自定义回复——链路验证");
    await expect(sendBtn).toBeEnabled();
    await sendBtn.click();
    await waitAnswered(desktop.page, m2.id, "自定义回复");

    // 消息独立性复证：消息 1 徽标仍为「确认」。
    await expect(row1.locator(".answered-line")).toContainText("确认");

    // 第三方证据：裸 WS 客户端收到两条 answered 帧（群内实时同步）。
    const seen = watcher.answered();
    expect(seen).toContain(m1.id);
    expect(seen).toContain(m2.id);
  } finally {
    watcher.stop();
    await desktop.cleanup();
    rmTempConfig(configPath);
  }
});
