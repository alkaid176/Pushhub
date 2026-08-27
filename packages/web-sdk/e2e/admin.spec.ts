/**
 * 管理页 E2E 切片一（03-01 Task 3，D-41 沿用 D-26 模式）：真浏览器（Chromium）
 * × 真 wrangler dev，测的是部署形态的管理页本身（packages/server/public/
 * admin.html + admin.js，经静态资产分发；挂既有 playwright.config.ts
 * webServer，零新配置）。
 *
 * 覆盖（对应计划验收）：
 *  - D-28 登录反例：错误 Admin Key → 错误条含 invalid_key + 停留登录屏障
 *    （#app hidden 在位）；
 *  - D-28/D-39 正路径：正确 key 登录 → 列表加载 → UI 建频道 → 列表新增 +
 *    选中态（aria-current）→ 片段卡三块（curl 块含 /api/send 与该频道
 *    sendKeys[0].key 完整值——经 API 侧 GET 对照；viewer 链接含 server=/key=
 *    参数 + noopener）→ 复制按钮 data-copied 反馈（Pitfall 6：grantPermissions）；
 *  - D-29 掩码与揭示：默认 ^phc_.{3}….{4}$ → 眼睛切换完整 36 字符 →
 *    backstop：揭示态 #channel-detail scrollWidth ≤ clientWidth（overflow-wrap:
 *    anywhere 生效，UI Considerations overflow held-out 断言）；
 *  - SC4 标记头对照（02-03 先例）：request 上下文 GET /admin.html 200 且
 *    无 x-ph-worker（资产命中零 Worker 请求）vs GET /api/admin/channels
 *    x-ph-worker: 1（API 必经 Worker）——程序化双证据。
 *
 * 每个 test 结束断言无 CSP 违规（Pitfall 3 警示信号：页面渲染但零交互）：
 * 收集 console 错误与 pageerror，出现 CSP 关键字即 fail。注意 401 fetch 在
 * Chromium 会记 console error（Failed to load resource…）——那是正常网络
 * 日志，只有 CSP 关键字才是违规信号。
 */
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";

const BASE = "http://127.0.0.1:4911";
const ADMIN_KEY = "e2e-admin-key"; // 仅存在于本地 wrangler dev 进程（--var 注入）

interface ChannelInfo {
  channelId: string;
  channelKey: string;
  sendKey: string;
  name: string;
}

/** API 侧建频道（掩码 test 的选中数据源；响应结构为 03-01 演进后的 sendKeys[]）。 */
async function createChannel(request: APIRequestContext): Promise<ChannelInfo> {
  const name = `e2e-admin-${Date.now()}`;
  const resp = await request.post(`${BASE}/api/admin/channels`, {
    headers: {
      Authorization: `Bearer ${ADMIN_KEY}`,
      "content-type": "application/json",
    },
    data: { name },
  });
  expect(resp.status()).toBe(201);
  const channel = (await resp.json()) as {
    channelId: string;
    channelKey: string;
    name: string;
    sendKeys: { key: string }[];
  };
  expect(channel.channelKey).toMatch(/^phc_[0-9A-Za-z]{32}$/);
  expect(channel.sendKeys[0].key).toMatch(/^phs_[0-9A-Za-z]{32}$/);
  return {
    channelId: channel.channelId,
    channelKey: channel.channelKey,
    sendKey: channel.sendKeys[0].key,
    name: channel.name,
  };
}

/** 登录并等待列表离开加载态（进入主界面 + 首次 GET 完成）。 */
async function loginAdmin(page: Page): Promise<void> {
  await page.goto("/admin.html");
  await expect(page.locator("#login-form")).toBeVisible();
  await page.locator("#admin-key-input").fill(ADMIN_KEY);
  await page.locator("#btn-login").click();
  await expect(page.locator("#app")).toBeVisible();
  await page.waitForFunction(
    () => {
      const list = document.getElementById("channel-list");
      return list !== null && (list.textContent ?? "").indexOf("加载中") === -1;
    },
    null,
    { timeout: 15_000 },
  );
}

/** 收集 console 错误与页面未捕获异常（CSP 违规检测的数据源）。 */
function collectPageDiagnostics(
  page: Page,
): { consoleErrors: string[]; pageErrors: string[] } {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => pageErrors.push(err.message));
  return { consoleErrors, pageErrors };
}

/** Pitfall 3：CSP 关键字出现即 fail（admin.html 原样复制 viewer 的 CSP meta，script-src 'self' 禁 inline）。 */
function expectNoCspViolations(
  consoleErrors: string[],
  pageErrors: string[],
): void {
  const all = [...consoleErrors, ...pageErrors];
  const cspHits = all.filter((t) => /content-security-policy|csp/i.test(t));
  expect(cspHits, `CSP violation detected: ${cspHits.join(" | ")}`).toEqual([]);
}

test("D-28 登录反例：错误 Admin Key → 错误条含 invalid_key，主界面保持隐藏", async ({
  page,
}) => {
  const { consoleErrors, pageErrors } = collectPageDiagnostics(page);

  await page.goto("/admin.html");
  // 无 pushhub.admin 存储 → 仅登录卡可见（#app hidden）。
  await expect(page.locator("#login-form")).toBeVisible();
  await expect(page.locator("#app")).toBeHidden();

  await page.locator("#admin-key-input").fill("definitely-not-the-admin-key");
  await page.locator("#btn-login").click();

  // 401 特例文案：信封 code 透传 + 停留登录屏障。
  await expect(page.locator("#error-bar")).toBeVisible();
  await expect(page.locator("#error-bar")).toContainText("invalid_key");
  await expect(page.locator("#error-bar")).toContainText("请重新输入");
  await expect(page.locator("#app")).toBeHidden();

  expectNoCspViolations(consoleErrors, pageErrors);
});

test("D-28/D-39 登录+创建+片段卡：curl 块含完整 Send Key，viewer 链接参数 + noopener，复制反馈", async ({
  page,
  request,
}) => {
  const { consoleErrors, pageErrors } = collectPageDiagnostics(page);

  await loginAdmin(page);

  // UI 建频道（D-37/D-38：maxlength=64 + required 由 HTML 承担）。
  const name = `e2e-admin-ui-${Date.now()}`;
  await page.locator("#channel-name-input").fill(name);
  await page.locator("#btn-create").click();

  // 列表出现该频道且选中态（3px 绿色指示条对应 aria-current）。
  const item = page.locator("#channel-list .channel-item", { hasText: name });
  await expect(item).toHaveCount(1);
  await expect(item).toHaveAttribute("aria-current", "true");

  // 片段卡（D-39 三块，data-testid 锚点）。
  const card = page.locator('[data-testid="snippet-card"]');
  await expect(card).toBeVisible();
  await expect(card).toContainText("已创建「" + name + "」");

  // API 侧对照：curl 块的 sendKey 与 GET 列表返回的完整值全等。
  const listResp = await request.get(`${BASE}/api/admin/channels`, {
    headers: { Authorization: `Bearer ${ADMIN_KEY}` },
  });
  expect(listResp.status()).toBe(200);
  const listBody = (await listResp.json()) as {
    channels: { name: string; channelKey: string; sendKeys: { key: string }[] }[];
  };
  const created = listBody.channels.find((c) => c.name === name);
  expect(created).toBeDefined();
  expect(created!.sendKeys[0].key).toMatch(/^phs_[0-9A-Za-z]{32}$/);

  const curlText = await card.locator(".snippet-code").textContent();
  expect(curlText).toContain("/api/send");
  expect(curlText).toContain(created!.sendKeys[0].key);
  expect(curlText).toContain("Authorization: Bearer " + created!.sendKeys[0].key);

  // 第 3 块 viewer 直达链接：server=/key= 查询参数（channelKey 全值 URL 编码）+ noopener。
  const link = card.locator("a[target='_blank']");
  await expect(link).toHaveCount(1);
  const href = await link.getAttribute("href");
  expect(href).toContain("server=");
  expect(href).toContain(`key=${encodeURIComponent(created!.channelKey)}`);
  const rel = await link.getAttribute("rel");
  expect(rel).toContain("noopener");
  expect(rel).toContain("noreferrer");

  // 复制反馈（Pitfall 6：Chromium 剪贴板读写需授权；writeText 落地后按钮置
  // data-copied 属性）。
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const copyBtn = card.locator(".copy-btn").first();
  await copyBtn.click();
  await expect(copyBtn).toHaveAttribute("data-copied", "");

  expectNoCspViolations(consoleErrors, pageErrors);
});

test("D-29 掩码与揭示：默认 phc_ 前 7 字符掩码，眼睛切换完整 36 字符，不撑破详情面板", async ({
  page,
  request,
}) => {
  const { consoleErrors, pageErrors } = collectPageDiagnostics(page);

  const channel = await createChannel(request);
  await loginAdmin(page);

  // 选中频道 → 详情渲染。
  await page.locator("#channel-list .channel-item", { hasText: channel.name }).click();
  await expect(
    page.locator("#channel-detail h2", { hasText: channel.name }),
  ).toBeVisible();

  // Channel Key 默认掩码：key.slice(0,7) + "…" + key.slice(-4)。
  const ckBlock = page.locator("#channel-detail .detail-block").first();
  const keyValue = ckBlock.locator(".key-value");
  const masked = await keyValue.textContent();
  expect(masked).toMatch(/^phc_.{3}….{4}$/);

  // 点眼睛 → 完整 36 字符（textContent 切换，禁 innerHTML 写密钥）。
  await ckBlock.locator(".icon-btn").click();
  const revealed = await keyValue.textContent();
  expect(revealed).toBe(channel.channelKey);
  expect(revealed).toMatch(/^phc_[0-9A-Za-z]{32}$/);

  // backstop（UI Considerations overflow held-out）：揭示态长密钥以
  // overflow-wrap: anywhere 呈现，不撑破 #channel-detail 布局。
  const dims = await page.evaluate(() => {
    const el = document.getElementById("channel-detail");
    if (el === null) throw new Error("#channel-detail missing");
    return { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth };
  });
  expect(dims.scrollWidth).toBeLessThanOrEqual(dims.clientWidth);

  expectNoCspViolations(consoleErrors, pageErrors);
});

test("SC4 标记头对照：/admin.html 资产命中零 Worker 请求，API 必经 Worker（stampMarker 双证据）", async ({
  request,
}) => {
  // 资产命中：直接由静态资产分发（asset-first），响应无 Worker 标记头。
  const assetResp = await request.get(`${BASE}/admin.html`);
  expect(assetResp.status()).toBe(200);
  expect(assetResp.headers()["x-ph-worker"]).toBeUndefined();

  // API：必经 Worker（无资产可命中），响应带 x-ph-worker: 1（02-03 机制）。
  const apiResp = await request.get(`${BASE}/api/admin/channels`, {
    headers: { Authorization: `Bearer ${ADMIN_KEY}` },
  });
  expect(apiResp.status()).toBe(200);
  expect(apiResp.headers()["x-ph-worker"]).toBe("1");
});
