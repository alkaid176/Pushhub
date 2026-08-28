/**
 * 测试页 E2E（04-04 Task 2）：真浏览器（Chromium）× 真 wrangler dev，测的是
 * 部署形态的测试页本身（packages/server/public/test.html + test.js，经静态
 * 资产分发）+ 本地 callback-receiver.mjs 子进程构成的完整回调链。
 *
 * 链路（key_links 第三条）：测试页操作 → wrangler dev DO 回调外呼 →
 * 127.0.0.1:4933 本地接收器验签（wrangler dev 的 workerd 允许 loopback 外呼
 * ——已由一次性 probe 实证；04-02 vitest-plugin 环境的 loopback 阻断不适用于
 * wrangler dev）。
 *
 * 覆盖（对应计划 behavior 四段）：
 *  - 全流程：连接（URL 参数注入）→ 构造（options×2 + callback_url）→ 发送 →
 *    流中出现消息与两个快捷按钮 → 点其一 → 按钮冻结 + 追加含选项文本的回复行
 *    → receiver 断言：恰一次 POST（D-43 恰首答一次）、Node 侧验签 ok:true、
 *    PushHub-Message-Id === 消息 wid、D-49 五字段 body；
 *  - 消毒：自定义回复含攻击样本（script/img onerror canary）→ DOM 无 script
 *    元素、无 on* 属性、canary 未执行（D-53 + T-04-15 渲染纪律）；
 *  - 失败查询：新频道无 failed 行 → 空态文案（D-58）；
 *  - 验签器：receiver 落盘的真实三头 + body → 三步全 PASS；篡改 body 末字符
 *    → 第 2/3 步 FAIL、第 1 步仍 PASS（时间窗不受 body 影响）。
 *
 * receiver 生命周期：beforeAll 以子进程拉起（--secret 用测试内创建频道所得
 * signingSecret + --json-log JSONL 落盘），afterAll 杀进程清文件。
 */
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = "http://127.0.0.1:4911";
const ADMIN_KEY = "e2e-admin-key"; // 仅存在于本地 wrangler dev 进程（--var 注入）
const RECEIVER_PORT = 4933; // CLAUDE.md 端口规约：非标准端口
const RECEIVER_URL = `http://127.0.0.1:${RECEIVER_PORT}/callback`;
const DISPLAY_NAME = "e2e-bot";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const receiverScript = join(repoRoot, "scripts", "callback-receiver.mjs");

/** receiver --json-log 落盘的单行结构（JSONL）。 */
interface ReceiverEntry {
  ts: number;
  method: string;
  url: string;
  headers: Record<string, string>;
  rawBody: string;
  result: { ok: boolean; reason?: string; wid?: string };
  verifyMs: number;
  duplicate: boolean;
}

interface ChannelInfo {
  channelId: string;
  channelKey: string;
  sendKey: string;
  signingSecret: string;
}

let channel: ChannelInfo;
let receiver: ChildProcess | null = null;
let jsonLogPath = "";

/** 读取 receiver JSONL 落盘（文件未创建即空数组——receiver 首次 POST 才写）。 */
function readReceiverLog(): ReceiverEntry[] {
  if (!existsSync(jsonLogPath)) return [];
  return readFileSync(jsonLogPath, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as ReceiverEntry);
}

/** 测试页在线等待（状态点 dot-online 类名，与 viewer E2E 同模式）。 */
async function waitTestPageOnline(page: Page): Promise<void> {
  await page.waitForFunction(
    () => document.getElementById("status-dot")?.className.includes("dot-online") === true,
    null,
    { timeout: 15_000 },
  );
}

/** 打开测试页（URL 参数注入连接 + 展示名）并填入 Send Key。 */
async function openTestPage(page: Page): Promise<void> {
  await page.goto(
    `/test.html?server=${encodeURIComponent(BASE)}&key=${encodeURIComponent(channel.channelKey)}&name=${encodeURIComponent(DISPLAY_NAME)}`,
  );
  await waitTestPageOnline(page);
  await page.locator("#send-key").fill(channel.sendKey);
}

test.describe.serial("测试页五区块 E2E（04-04 ADM-04/D-56/D-57/D-58）", () => {
  test.beforeAll(async ({ request }: { request: APIRequestContext }) => {
    // 建频道（admin.spec.ts 模式；201 完整返回点含 signingSecret——04-02 D-47）。
    const name = `e2e-testpage-${Date.now()}`;
    const resp = await request.post(`${BASE}/api/admin/channels`, {
      headers: {
        Authorization: `Bearer ${ADMIN_KEY}`,
        "content-type": "application/json",
      },
      data: { name },
    });
    expect(resp.status()).toBe(201);
    const created = (await resp.json()) as {
      channelId: string;
      channelKey: string;
      signingSecret: string;
      sendKeys: { key: string }[];
    };
    expect(created.channelKey).toMatch(/^phc_[0-9A-Za-z]{32}$/);
    expect(created.sendKeys[0].key).toMatch(/^phs_[0-9A-Za-z]{32}$/);
    expect(created.signingSecret).toMatch(/^phsig_[0-9A-Za-z]{32}$/);
    channel = {
      channelId: created.channelId,
      channelKey: created.channelKey,
      sendKey: created.sendKeys[0].key,
      signingSecret: created.signingSecret,
    };

    // 拉起 callback-receiver 子进程（D-57 验签参考实现即被测实体）。
    jsonLogPath = join(tmpdir(), `pushhub-e2e-receiver-${Date.now()}.jsonl`);
    receiver = spawn(
      process.execPath,
      [
        receiverScript,
        "--port",
        String(RECEIVER_PORT),
        "--secret",
        channel.signingSecret,
        "--json-log",
        jsonLogPath,
      ],
      { stdio: "inherit" },
    );
    // 等待监听：GET / 返回 405（仅收 POST）即已在听。
    const deadline = Date.now() + 15_000;
    for (;;) {
      try {
        const probe = await fetch(`http://127.0.0.1:${RECEIVER_PORT}/`);
        if (probe.status === 405) break;
      } catch {
        // 尚未监听——继续轮询。
      }
      if (Date.now() > deadline) {
        throw new Error(`callback-receiver 未在 15s 内监听 ${RECEIVER_PORT}（脚本存在？）`);
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  });

  test.afterAll(async () => {
    receiver?.kill();
    if (jsonLogPath !== "") {
      try {
        rmSync(jsonLogPath, { force: true });
      } catch {
        // 清理失败不影响结果。
      }
    }
  });

  test("全流程：构造（options+callback_url）→ 发送 → 流 → 点击回复 → 冻结 → receiver 恰一次 POST 且验签 ok", async ({
    page,
  }) => {
    await openTestPage(page);

    // 构造消息：title/text/options×2/callback_url 指本地 receiver。
    await page.locator("#msg-title").fill("e2e 回调链");
    await page.locator("#msg-text").fill("部署完成通知——**点击下方选项回复**");
    await page.locator("#msg-option-1").fill("确认上线");
    await page.locator("#msg-option-2").fill("暂缓");
    await page.locator("#msg-callback-url").fill(RECEIVER_URL);
    await page.locator("#btn-send").click();

    // 消息出现在流中 + 两个快捷按钮（title 经 textContent 加粗在 head）。
    const msgLi = page.locator("#messages li.msg").first();
    await expect(msgLi).toBeVisible({ timeout: 10_000 });
    const optionBtns = msgLi.locator("button.msg-option-btn");
    await expect(optionBtns).toHaveCount(2);
    await expect(msgLi.locator(".msg-body strong")).toHaveText("点击下方选项回复");
    await expect(msgLi.locator(".msg-head strong")).toHaveText("e2e 回调链");
    const wid = await msgLi.getAttribute("data-wid");
    expect(wid).toMatch(/^m_[0-9A-Za-z]+$/);
    // 发送结果行（SendResult id 即 wid）。
    await expect(page.locator("#send-result")).toContainText(`id=${wid}`);

    // 点击第一个快捷选项（hub.reply selected_option 路径）。
    await optionBtns.first().click();

    // 按钮冻结（全部两个）+ 回复行（前缀 textContent / 内容含选项文本）。
    await expect(optionBtns.first()).toBeDisabled();
    await expect(optionBtns.nth(1)).toBeDisabled();
    const answeredLine = msgLi.locator(".answered-line");
    await expect(answeredLine).toBeVisible();
    await expect(answeredLine.locator(".answered-prefix")).toHaveText(
      `已由${DISPLAY_NAME}回复：`,
    );
    await expect(answeredLine.locator(".answered-content")).toHaveText("确认上线");

    // receiver 断言：收到恰一次 POST、Node 侧验签 ok:true、message-id === wid。
    const waitDeadline = Date.now() + 10_000;
    while (
      Date.now() < waitDeadline &&
      !readReceiverLog().some((e) => e.method === "POST" && e.result.ok)
    ) {
      await page.waitForTimeout(200);
    }
    // 宽限窗：D-43 恰首答一次——首投成功（2xx）后不应有重试 POST。
    await page.waitForTimeout(1_500);
    const posts = readReceiverLog().filter((e) => e.method === "POST");
    expect(posts.length).toBe(1);
    expect(posts[0].result.ok).toBe(true);
    expect(posts[0].duplicate).toBe(false);
    expect(posts[0].headers["pushhub-message-id"]).toBe(wid);
    expect(posts[0].result.wid).toBe(wid);
    // D-49 五字段 body。
    const body = JSON.parse(posts[0].rawBody) as {
      message_id: string;
      reply: string;
      replied_by: string;
      replied_at: number;
      channel_id: string;
    };
    expect(body.message_id).toBe(wid);
    expect(body.reply).toBe("确认上线");
    expect(body.replied_by).toBe(DISPLAY_NAME);
    expect(typeof body.replied_at).toBe("number");
    expect(body.channel_id).toBe(channel.channelId);
  });

  test("消毒：自定义回复含攻击样本 → DOM 无 script/on* 执行痕迹（D-53/T-04-15）", async ({
    page,
  }) => {
    await openTestPage(page);

    // 本条消息不带 callback_url（不影响全流程用例的恰一次 POST 断言语境）。
    await page.locator("#msg-text").fill("消毒验证目标消息");
    await page.locator("#btn-send").click();
    const msgLi = page.locator("#messages li.msg").first();
    await expect(msgLi).toBeVisible({ timeout: 10_000 });

    // 自定义回复（hub.reply text 路径）：攻击样本 + Markdown 加粗并存——
    // 加粗成 strong 证明内容确实经过 renderMarkdown 管道（而非被整段丢弃）。
    const attack =
      '<script>window.__phXss=1</script><img src=x onerror="window.__phXss=1">后置**消毒**文本';
    await msgLi.locator("input.msg-reply-input").fill(attack);
    await msgLi.locator("button.msg-reply-btn").click();

    const answeredLine = msgLi.locator(".answered-line");
    await expect(answeredLine).toBeVisible({ timeout: 10_000 });
    await expect(answeredLine.locator(".answered-content strong")).toHaveText("消毒");
    // 回复后自定义输入也冻结（answered 状态回写）。
    await expect(msgLi.locator("input.msg-reply-input")).toBeDisabled();

    // DOM 审计：#messages 无 script 元素、无 on* 属性、canary 未执行。
    const audit = await page.evaluate(() => {
      const root = document.getElementById("messages");
      if (root === null) throw new Error("#messages missing");
      const onAttrs: string[] = [];
      root.querySelectorAll("*").forEach((el) => {
        for (const a of el.getAttributeNames()) {
          if (/^on/i.test(a)) onAttrs.push(`${el.tagName}@${a}`);
        }
      });
      return {
        scripts: root.querySelectorAll("script").length,
        imgs: root.querySelectorAll("img").length,
        onAttrs,
        xssCanary: (window as unknown as { __phXss?: number }).__phXss ?? null,
      };
    });
    expect(audit.scripts).toBe(0);
    expect(audit.imgs).toBe(0);
    expect(audit.onAttrs).toEqual([]);
    expect(audit.xssCanary).toBeNull();
  });

  test("失败查询：新频道无 failed 行 → 空态（D-58）", async ({ page }) => {
    // URL 参数预填 Channel Key（查询鉴权域）；无需等待 WS 在线。
    await page.goto(
      `/test.html?server=${encodeURIComponent(BASE)}&key=${encodeURIComponent(channel.channelKey)}`,
    );
    await page.locator("#btn-failures").click();
    await expect(page.locator("#failures-result .empty-state")).toContainText(
      "无失败记录",
      { timeout: 10_000 },
    );
  });

  test("验签器：真实三头+body 三步全 PASS；篡改 body → 第 2/3 步 FAIL（D-56）", async ({
    page,
  }) => {
    // 从 receiver 落盘取真实回调（全流程用例产生）。
    const entry = readReceiverLog().find((e) => e.method === "POST" && e.result.ok);
    expect(entry).toBeDefined();

    await page.goto("/test.html");
    await page.locator("#verify-secret").fill(channel.signingSecret);
    await page.locator("#verify-message-id").fill(entry!.headers["pushhub-message-id"]);
    await page.locator("#verify-timestamp").fill(entry!.headers["pushhub-timestamp"]);
    await page.locator("#verify-signature").fill(entry!.headers["pushhub-signature"]);
    await page.locator("#verify-rawbody").fill(entry!.rawBody);
    await page.locator("#btn-verify").click();

    // 合法输入：三步全 PASS。
    await expect(page.locator("#verify-step-1")).toContainText("PASS", { timeout: 5_000 });
    await expect(page.locator("#verify-step-2")).toContainText("PASS");
    await expect(page.locator("#verify-step-3")).toContainText("PASS");

    // 篡改 body 末字符：第 1 步（时间窗）仍 PASS——ts 未动；
    // 第 2 步（HMAC 重算一致）与第 3 步（常时比较）FAIL——签名覆盖字节。
    const last = entry!.rawBody.endsWith("6") ? "7" : "6";
    await page.locator("#verify-rawbody").fill(entry!.rawBody.slice(0, -1) + last);
    await page.locator("#btn-verify").click();
    await expect(page.locator("#verify-step-1")).toContainText("PASS", { timeout: 5_000 });
    await expect(page.locator("#verify-step-2")).toContainText("FAIL");
    await expect(page.locator("#verify-step-3")).toContainText("FAIL");
  });
});
