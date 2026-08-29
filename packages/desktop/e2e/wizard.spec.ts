/**
 * WIN-06 向导全流程 E2E（05-07 Task 2）：首启无配置（PH_CONFIG_PATH 指向
 * 不存在文件）→ 内嵌向导呈现 → 失败路径（不可达地址 + 错误密钥被拒、保存
 * 保持禁用、无配置持久化）→ 成功路径（验证通过 → 保存并进入 → 主界面
 * online）→ 复用同一表单添加至 8 频道 → 第 9 个添加在 UI 层被拒
 * （channel_limit_reached 上限提示，MAX_CHANNELS=8）。
 *
 * 表单 DOM 复用 05-06 mountWizard（#overlay .panel-card 三输入 + 验证/保存
 * 按钮 + .form-feedback 内联反馈）；所有频道共用同一真实 Channel Key
 * （服务端群聊语义——同一密钥多连接合法，E2E 免重复建频道）。
 */
import { test, expect, type Page } from "@playwright/test";
import { BASE, createChannel, launchDesktop } from "./helpers";
// 类型注：工作区未装 @types/node（02-05 既定取舍——行级 @ts-expect-error 压制）。
// @ts-expect-error -- 工作区未装 @types/node
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
// @ts-expect-error -- 工作区未装 @types/node
import { tmpdir } from "node:os";
// @ts-expect-error -- 工作区未装 @types/node
import { join } from "node:path";

/** 三输入选择器（placeholder 定位——05-06 mountWizard 定型的表单 DOM）。 */
const SEL_SERVER = '#overlay input[placeholder="https://pushhub.dyun.org"]';
const SEL_NAME = '#overlay input[placeholder="如：告警群"]';
const SEL_KEY = '#overlay input[placeholder="phc_ 开头的通知密钥"]';
const SEL_SAVE = "#overlay button.btn-primary";

async function fillForm(page: Page, name: string, key: string, server?: string): Promise<void> {
  if (server !== undefined) {
    await page.locator(SEL_SERVER).fill(server);
  }
  await page.locator(SEL_NAME).fill(name);
  await page.locator(SEL_KEY).fill(key);
}

/** 验证按钮以文案定位（add 模式下取消按钮同为非 primary——class 无法区分）。 */
async function clickVerify(page: Page): Promise<void> {
  await page.locator("#overlay .form-actions button", { hasText: "验证连通" }).click();
}

/** 等待内联反馈包含预期文案（ok/err 皆同一定位器）。 */
async function waitFeedback(page: Page, part: string): Promise<void> {
  await page.waitForFunction(
    (p) => {
      const el = document.querySelector("#overlay .form-feedback");
      return el !== null && !el.hasAttribute("hidden") && (el.textContent ?? "").includes(p);
    },
    part,
    { timeout: 15_000 },
  );
}

/** 等待向导关闭（保存成功路径——overlay 隐藏即表单销毁）。 */
async function waitOverlayHidden(page: Page): Promise<void> {
  await page.waitForFunction(
    () => (document.getElementById("overlay") as HTMLElement).hidden,
    null,
    { timeout: 15_000 },
  );
}

test("wizard: 首启向导失败/成功双路径 + 添加至 8 频道 + 第 9 个 UI 层拒绝", async ({ request }) => {
  test.setTimeout(180_000);

  const channel = await createChannel(request);
  const badKey = `phc_${"0".repeat(32)}`; // 格式合法但错误——服务端 401 拒握手
  const dir = mkdtempSync(join(tmpdir(), "pushhub-e2e-"));
  const configPath = join(dir, "config.json"); // 不写入——首启无配置场景

  const cdpPort = 20000 + Math.floor(Math.random() * 20000);
  const desktop = await launchDesktop(cdpPort, { PH_CONFIG_PATH: configPath });

  try {
    const page = desktop.page;
    const overlay = page.locator("#overlay");

    // ---- 首启：向导表单呈现（无配置 → initial 模式）----
    await overlay.waitFor({ timeout: 15_000 });
    await expect(overlay.locator(".panel-title")).toHaveText("欢迎使用 PushHub");

    // ---- 失败路径 ①：服务端地址不可达（死端口——连接拒绝即回，网络不可达分支）----
    await fillForm(page, "向导测试", channel.channelKey, "http://127.0.0.1:49999");
    await clickVerify(page);
    await waitFeedback(page, "网络不可达");

    // ---- 失败路径 ②：地址正确 + 错误 Channel Key（密钥拒绝分支 handshake_rejected）----
    await fillForm(page, "向导测试", badKey, BASE);
    await clickVerify(page);
    await waitFeedback(page, "服务端拒绝连接");
    // 保存保持禁用（未验证通过）+ 无配置持久化。
    await expect(page.locator(SEL_SAVE)).toBeDisabled();
    expect(existsSync(configPath), "失败路径无配置持久化").toBe(false);

    // ---- 成功路径：正确密钥 → 验证通过 → 保存并进入 → 主界面 + online ----
    await fillForm(page, "首频道", channel.channelKey);
    await clickVerify(page);
    await waitFeedback(page, "连接成功");
    await expect(page.locator(SEL_SAVE)).toBeEnabled();
    await page.locator(SEL_SAVE).click();
    await waitOverlayHidden(page);
    await expect(page.locator("#channel-list .channel-item")).toHaveCount(1);
    await page.waitForFunction(
      () => document.getElementById("status")?.textContent === "online",
      null,
      { timeout: 30_000 },
    );

    // ---- 复用同一表单添加频道至 8（同一 Channel Key——服务端群聊多连接语义）----
    for (let i = 2; i <= 8; i++) {
      await page.locator("#btn-add-channel").click();
      await overlay.waitFor({ timeout: 5_000 });
      await expect(overlay.locator(".panel-title")).toHaveText("添加频道");
      await fillForm(page, `频道${i}`, channel.channelKey, BASE);
      await clickVerify(page);
      await waitFeedback(page, "连接成功");
      await page.locator(SEL_SAVE).click();
      await waitOverlayHidden(page);
      await expect(page.locator("#channel-list .channel-item")).toHaveCount(i);
    }

    // ---- 第 9 个：UI 层拒绝（add_channel 返回 channel_limit_reached → 上限提示）----
    await page.locator("#btn-add-channel").click();
    await overlay.waitFor({ timeout: 5_000 });
    await fillForm(page, "第九频道", channel.channelKey, BASE);
    await clickVerify(page);
    await waitFeedback(page, "连接成功");
    await page.locator(SEL_SAVE).click();
    await waitFeedback(page, "最多 8 个频道");
    // 表单保持打开（保存失败不关窗）+ 侧栏仍 8 个频道。
    await expect(overlay).toBeVisible();
    await expect(page.locator("#channel-list .channel-item")).toHaveCount(8);

    // ---- 持久化面：配置文件落盘且恰 8 频道 ----
    const persisted = JSON.parse(readFileSync(configPath, "utf8")) as {
      server: string;
      channels: unknown[];
    };
    expect(persisted.server).toBe(BASE);
    expect(persisted.channels).toHaveLength(8);
  } finally {
    await desktop.cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});
