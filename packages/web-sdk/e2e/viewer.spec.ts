/**
 * 查看器 E2E（02-03 Task 2）：真浏览器（Chromium）× 真 wrangler dev，
 * 测的是部署形态的查看器页面本身（packages/server/public/index.html +
 * viewer.js，经静态资产分发——非测试内拼页面）。
 *
 * 覆盖（对应计划验收）：
 *  - SC1：URL 参数注入接入（?server=…&key=…，研究 A5）→ 状态指示 online →
 *    Node 侧发含 Markdown 强调语法的消息 → 消息流出现该条且 strong 元素
 *    存在（renderMarkdown 真路径，非 textContent）；
 *  - SC3 终验：点击攻击样本按钮 → 展示区 DOM 无 script、无 on* 属性、
 *    锚元素带 rel 含 noopener noreferrer；
 *  - D-24：goto 无参数路径 → 表单值从 localStorage 恢复（且无参数不自动连接）；
 *  - D-10 分隔线：经 __pushhubViewer.feedHistory 单测式驱动（与
 *    on("history") 同一真实代码路径）——oldest_kept_seq=1 不渲染、
 *    保留窗口缺口语义渲染、且只渲染一次。
 */
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";

const BASE = "http://127.0.0.1:4911";
const ADMIN_KEY = "e2e-admin-key"; // 仅存在于本地 wrangler dev 进程（--var 注入）

interface ChannelInfo {
  channelKey: string;
  sendKey: string;
  channelId: string;
}

async function createChannel(request: APIRequestContext): Promise<ChannelInfo> {
  const name = `e2e-viewer-${Date.now()}`;
  const resp = await request.post(`${BASE}/api/admin/channels`, {
    headers: {
      Authorization: `Bearer ${ADMIN_KEY}`,
      "content-type": "application/json",
    },
    data: { name },
  });
  expect(resp.status()).toBe(201);
  const channel = (await resp.json()) as ChannelInfo;
  expect(channel.channelKey).toMatch(/^phc_[0-9A-Za-z]{32}$/);
  expect(channel.sendKey).toMatch(/^phs_[0-9A-Za-z]{32}$/);
  return channel;
}

async function sendMessage(
  request: APIRequestContext,
  sendKey: string,
  text: string,
): Promise<void> {
  const resp = await request.post(`${BASE}/api/send`, {
    headers: {
      Authorization: `Bearer ${sendKey}`,
      "content-type": "application/json",
    },
    data: { title: "viewer e2e", text },
  });
  expect(resp.status()).toBe(200);
}

/** 状态指示到 online（dot 类名驱动，viewer.js 的 status 四态映射）。 */
async function waitViewerOnline(page: Page): Promise<void> {
  await page.waitForFunction(
    () => document.getElementById("status-dot")?.className.includes("dot-online") === true,
    null,
    { timeout: 15_000 },
  );
}

test("SC1+SC3+D-24：URL 参数接入 → Markdown 渲染 → 攻击样本 → localStorage 恢复 → 分隔线", async ({
  page,
  request,
}) => {
  const channel = await createChannel(request);

  // ---- SC1：URL 参数注入接入（A5）→ 状态指示 online ----
  const viewerUrl = `/?server=${encodeURIComponent(BASE)}&key=${encodeURIComponent(channel.channelKey)}`;
  await page.goto(viewerUrl);
  await waitViewerOnline(page);
  expect(await page.locator("#status-text").textContent()).toBe("已连接");

  // ---- SC1：含 Markdown 强调语法的消息 → strong 元素（渲染真路径）----
  await sendMessage(request, channel.sendKey, "查看器 **加粗词** 消息");
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll("#messages .msg-body strong")].some(
        (el) => el.textContent === "加粗词",
      ),
    null,
    { timeout: 10_000 },
  );
  // title 加粗（textContent 管道）与时间戳也在消息卡上。
  await expect(page.locator("#messages li.msg strong", { hasText: "viewer e2e" })).toHaveCount(1);

  // ---- SC3 终验：攻击样本按钮 → 展示区 DOM 无害 ----
  const buttons = page.locator("#attack-buttons button");
  await expect(buttons).toHaveCount(3);
  for (let i = 0; i < 3; i++) await buttons.nth(i).click();
  await expect(page.locator("#attack-out .attack-sample")).toHaveCount(3);

  const audit = await page.evaluate(() => {
    const out = document.getElementById("attack-out");
    if (out === null) throw new Error("#attack-out missing");
    const onAttrs: string[] = [];
    const badHrefs: string[] = [];
    out.querySelectorAll("*").forEach((el) => {
      for (const a of el.getAttributeNames()) {
        if (/^on/i.test(a)) onAttrs.push(`${el.tagName}@${a}`);
      }
    });
    const anchors = [...out.querySelectorAll("a")];
    for (const a of anchors) {
      const href = a.getAttribute("href");
      if (href !== null) {
        const lower = href.trim().toLowerCase();
        if (lower.startsWith("javascript:") || lower.startsWith("data:")) badHrefs.push(href);
      }
    }
    return {
      scripts: out.querySelectorAll("script").length,
      onAttrs,
      badHrefs,
      anchors: anchors.map((a) => a.getAttribute("rel") ?? ""),
    };
  });
  expect(audit.scripts).toBe(0);
  expect(audit.onAttrs).toEqual([]);
  expect(audit.badHrefs).toEqual([]);
  expect(audit.anchors.length).toBeGreaterThan(0);
  for (const rel of audit.anchors) {
    expect(rel).toContain("noopener");
    expect(rel).toContain("noreferrer");
  }

  // ---- D-24：无参数路径 → 表单值从 localStorage 恢复（且不自动连接）----
  await page.goto("/");
  await expect(page.locator("#server-url")).toHaveValue(BASE);
  await expect(page.locator("#channel-key")).toHaveValue(channel.channelKey);
  expect(await page.locator("#status-text").textContent()).toBe("未连接");

  // ---- D-10 分隔线（__pushhubViewer.feedHistory 单测式驱动，真实代码路径）----
  // 场景 1：oldest_kept_seq=1（MIN(seq)=1 等价从未清理）→ 不渲染分隔线。
  await page.evaluate(() => {
    (
      window as unknown as {
        __pushhubViewer: {
          feedHistory(f: {
            messages: { seq: number; text: string; created_at: number }[];
            oldest_kept_seq: number;
            has_more: boolean;
          }): void;
        };
      }
    ).__pushhubViewer.feedHistory({
      messages: [{ seq: 10, text: "未清理频道的消息", created_at: Date.now() }],
      oldest_kept_seq: 1,
      has_more: false,
    });
  });
  expect(await page.locator("#messages li.separator").count()).toBe(0);

  // 场景 2：保留窗口缺口（oldest_kept_seq=30，宿主已见到 seq 30）→ 渲染分隔线。
  await page.evaluate(() => {
    (
      window as unknown as {
        __pushhubViewer: {
          feedHistory(f: {
            messages: { seq: number; text: string; created_at: number }[];
            oldest_kept_seq: number;
            has_more: boolean;
          }): void;
        };
      }
    ).__pushhubViewer.feedHistory({
      messages: [
        { seq: 30, text: "保留窗口最底部", created_at: Date.now() },
        { seq: 31, text: "次旧消息", created_at: Date.now() },
      ],
      oldest_kept_seq: 30,
      has_more: false,
    });
  });
  expect(await page.locator("#messages li.separator").count()).toBe(1);
  expect(await page.locator("#messages li.separator").textContent()).toContain(
    "更早的消息已被清理",
  );

  // 场景 3：只渲染一次——再喂一个同样带缺口的帧，分隔线数不变。
  await page.evaluate(() => {
    (
      window as unknown as {
        __pushhubViewer: {
          feedHistory(f: {
            messages: { seq: number; text: string; created_at: number }[];
            oldest_kept_seq: number;
            has_more: boolean;
          }): void;
        };
      }
    ).__pushhubViewer.feedHistory({
      messages: [{ seq: 32, text: "后续帧", created_at: Date.now() }],
      oldest_kept_seq: 30,
      has_more: false,
    });
  });
  expect(await page.locator("#messages li.separator").count()).toBe(1);
});

test("WR-03：localStorage 全禁环境查看器正常加载（回退缺省，无未捕获异常）", async ({
  page,
}) => {
  // 收集页面未捕获错误（断言点之一：读取侧无防护时 SecurityError 直通夭折）。
  const pageErrors: Error[] = [];
  page.on("pageerror", (err) => pageErrors.push(err));

  // addInitScript 在页面任何脚本之前运行（Playwright 语义）——读取拦截先于
  // viewer.js 执行，模拟浏览器存储策略全禁（隐私模式 / cookie 策略全禁）。
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      get() {
        throw new DOMException("denied", "SecurityError");
      },
    });
  });

  await page.goto("/");

  // 优先级链 url 参数 || localStorage || 缺省：localStorage 抛异常时 server
  // 回退页面 origin、key 留空（免填功能降级，与写入侧防护对齐）。
  await expect(page.locator("#server-url")).toHaveValue(BASE);
  await expect(page.locator("#channel-key")).toHaveValue("");
  // D-24 既有语义不变：无参数不自动连接。
  expect(await page.locator("#status-text").textContent()).toBe("未连接");
  expect(pageErrors).toEqual([]);
});
