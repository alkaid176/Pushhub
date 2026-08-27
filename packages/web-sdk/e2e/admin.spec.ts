/**
 * 管理页 E2E（03-01 切片一 + 03-02 切片二）：真浏览器（Chromium）
 * × 真 wrangler dev，测的是部署形态的管理页本身（packages/server/public/
 * admin.html + admin.js，经静态资产分发；挂既有 playwright.config.ts
 * webServer，零新配置）。
 *
 * 切片一（03-01，D-41 沿用 D-26 模式）覆盖：
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
 * 切片二（03-02，KEY-03 端到端）覆盖：
 *  - D-30 建带标签 Key：UI 输入 deploy-bot 创建 → sendkey-row 含标签与掩码 →
 *    片段卡 curl 块含完整新 Key（API 侧对照）→ 眼睛揭示 36 字符 → 复制反馈；
 *  - D-32 吊销链路：两 Key 先证可用 → 确认框逐字文案（含「最长约 1 分钟」）→
 *    确认 → 行消失 → 被吊销 Key API 发送 401 invalid_key → 其余 Key 仍 200
 *    （泄露不互伤，KEY-03 核心）；
 *  - D-31 上限态：API 直建 + UI 建循环至 10 → 按钮 disabled + 提示可见 →
 *    第 11 个 API 直建 400 body.error.code === send_key_limit（双层防线）。
 *
 * 每个 test 结束断言无 CSP 违规（Pitfall 3 警示信号：页面渲染但零交互）：
 * 收集 console 错误与 pageerror，出现 CSP 关键字即 fail。注意 401/400 fetch 在
 * Chromium 会记 console error（Failed to load resource…）——那是正常网络
 * 日志，只有 CSP 关键字才是违规信号。
 */
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";

const BASE = "http://127.0.0.1:4911";
const ADMIN_KEY = "e2e-admin-key"; // 仅存在于本地 wrangler dev 进程（--var 注入）

/** 与 admin.js maskKey 同式（D-29：slice(0,7) + "…" + slice(-4)）。 */
function maskKey(key: string): string {
  return key.slice(0, 7) + "…" + key.slice(-4);
}

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

/** API 侧建 Send Key（上限/吊销测试的直建路径；label 省略 = 无标签）。 */
async function createSendKeyApi(
  request: APIRequestContext,
  channelId: string,
  label?: string,
): Promise<string> {
  const resp = await request.post(
    `${BASE}/api/admin/channels/${channelId}/send-keys`,
    {
      headers: {
        Authorization: `Bearer ${ADMIN_KEY}`,
        "content-type": "application/json",
      },
      data: label === undefined ? {} : { label },
    },
  );
  expect(resp.status()).toBe(201);
  const rec = (await resp.json()) as { key: string };
  expect(rec.key).toMatch(/^phs_[0-9A-Za-z]{32}$/);
  return rec.key;
}

/** 选中频道并等详情渲染（列表项点击 → #channel-detail 出现该频道名标题）。 */
async function selectChannel(page: Page, name: string): Promise<void> {
  await page.locator("#channel-list .channel-item", { hasText: name }).click();
  await expect(
    page.locator("#channel-detail h2", { hasText: name }),
  ).toBeVisible();
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

// ---------------------------------------------------------------------------
// 切片二（03-02，KEY-03 端到端）
// ---------------------------------------------------------------------------

test("D-30 建带标签 Key：sendkey-row 含标签与掩码，片段卡 curl 含完整 Key，眼睛揭示，复制反馈", async ({
  page,
  request,
}) => {
  const { consoleErrors, pageErrors } = collectPageDiagnostics(page);

  const channel = await createChannel(request);
  await loginAdmin(page);
  await selectChannel(page, channel.name);

  // UI 建带标签 Send Key（D-30：label 可选 ≤64）。
  await page.locator("#sendkey-label-input").fill("deploy-bot");
  await page.locator("#btn-create-sendkey").click();

  // 行出现且六要素在位：标签文本 + 掩码（^phs_.{3}….{4}$）。
  const row = page.locator('[data-testid="sendkey-row"]', {
    hasText: "deploy-bot",
  });
  await expect(row).toHaveCount(1);
  const masked = await row.locator(".key-value").textContent();
  expect(masked).toMatch(/^phs_.{3}….{4}$/);

  // API 侧对照：列表该频道 sendKeys 含此带标签 Key——curl 块的完整值全等。
  const listResp = await request.get(`${BASE}/api/admin/channels`, {
    headers: { Authorization: `Bearer ${ADMIN_KEY}` },
  });
  expect(listResp.status()).toBe(200);
  const listBody = (await listResp.json()) as {
    channels: {
      channelId: string;
      sendKeys: { key: string; label: string | null }[];
    }[];
  };
  const listed = listBody.channels.find(
    (c) => c.channelId === channel.channelId,
  );
  expect(listed).toBeDefined();
  const created = listed!.sendKeys.find((r) => r.label === "deploy-bot");
  expect(created).toBeDefined();
  expect(created!.key).toMatch(/^phs_[0-9A-Za-z]{32}$/);

  // 片段卡（D-39 变体：仅第 1 块）curl 含完整新 Key（201 是唯一完整返回点）。
  const card = page.locator('[data-testid="snippet-card"]');
  await expect(card).toBeVisible();
  const curlText = await card.locator(".snippet-code").textContent();
  expect(curlText).toContain("/api/send");
  expect(curlText).toContain("Authorization: Bearer " + created!.key);

  // 眼睛揭示 → 完整 36 字符（textContent 切换，禁 innerHTML 写密钥）。
  await row.locator(".icon-btn").click();
  await expect(row.locator(".key-value")).toHaveText(created!.key);

  // 复制反馈（Pitfall 6：grantPermissions 先行）。
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const copyBtn = row.locator(".copy-btn");
  await copyBtn.click();
  await expect(copyBtn).toHaveAttribute("data-copied", "");

  expectNoCspViolations(consoleErrors, pageErrors);
});

test("D-32 吊销链路：确认框逐字文案 → 行消失 → 被吊销 Key 401 → 其余 Key 仍 200（泄露不互伤）", async ({
  page,
  request,
}) => {
  const { consoleErrors, pageErrors } = collectPageDiagnostics(page);

  const channel = await createChannel(request);
  const revokedKey = channel.sendKey; // 初始 Key（未命名）
  const siblingKey = await createSendKeyApi(
    request,
    channel.channelId,
    "monitor-script",
  );

  // 先证明两 Key 均可用（KEY-03 的"互不影响"以可用为前提）。
  for (const key of [revokedKey, siblingKey]) {
    const resp = await request.post(`${BASE}/api/send`, {
      headers: {
        Authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      data: { text: "pre-revoke probe" },
    });
    expect(resp.status()).toBe(200);
  }

  await loginAdmin(page);
  await selectChannel(page, channel.name);
  await expect(page.locator('[data-testid="sendkey-row"]')).toHaveCount(2);

  // 对未命名 Key（初始 Key）走吊销确认框：标题含掩码、正文逐字契约。
  const targetRow = page.locator('[data-testid="sendkey-row"]', {
    hasText: "未命名",
  });
  await expect(targetRow).toHaveCount(1);
  await targetRow.locator(".revoke-btn").click();

  await expect(page.locator("#revoke-dialog")).toBeVisible();
  await expect(page.locator("#revoke-dialog-title")).toContainText(
    "吊销 Send Key「" + maskKey(revokedKey) + "」？",
  );
  await expect(page.locator("#revoke-dialog-body")).toContainText(
    "最长约 1 分钟",
  );
  await expect(page.locator("#revoke-dialog-body")).toContainText(
    "此操作不可撤销",
  );

  await page.locator("#btn-revoke-confirm").click();

  // 行消失：仅剩 monitor-script 行。
  await expect(page.locator('[data-testid="sendkey-row"]')).toHaveCount(1);
  await expect(page.locator('[data-testid="sendkey-row"]')).toContainText(
    "monitor-script",
  );

  // 被吊销 Key 下次调用 401 invalid_key（本地强一致；生产 ≤60s 窗口为文档化语义）。
  const denied = await request.post(`${BASE}/api/send`, {
    headers: {
      Authorization: `Bearer ${revokedKey}`,
      "content-type": "application/json",
    },
    data: { text: "should be rejected" },
  });
  expect(denied.status()).toBe(401);
  expect(((await denied.json()) as { error: { code: string } }).error.code).toBe(
    "invalid_key",
  );

  // 同频道其余 Key 照常可发——KEY-03 核心：单独吊销不互伤。
  const alive = await request.post(`${BASE}/api/send`, {
    headers: {
      Authorization: `Bearer ${siblingKey}`,
      "content-type": "application/json",
    },
    data: { text: "still works" },
  });
  expect(alive.status()).toBe(200);

  expectNoCspViolations(consoleErrors, pageErrors);
});

test("D-31 上限态：循环建至 10 个 → 按钮 disabled + 提示可见；第 11 个 API 直建 400 send_key_limit", async ({
  page,
  request,
}) => {
  const { consoleErrors, pageErrors } = collectPageDiagnostics(page);

  const channel = await createChannel(request); // 初始 1 个
  // API 直建 7 个（避免 UI 循环点击过慢）→ 8 个。
  for (let i = 0; i < 7; i++) {
    await createSendKeyApi(request, channel.channelId, `api-bot-${i}`);
  }

  await loginAdmin(page);
  await selectChannel(page, channel.name);
  await expect(page.locator('[data-testid="sendkey-row"]')).toHaveCount(8);

  // UI 建 2 个（一带标签一空输入，两条路径都走到）→ 10 个。
  await page.locator("#sendkey-label-input").fill("ui-bot-1");
  await page.locator("#btn-create-sendkey").click();
  await expect(page.locator('[data-testid="sendkey-row"]')).toHaveCount(9);

  await page.locator("#sendkey-label-input").fill("");
  await page.locator("#btn-create-sendkey").click();
  await expect(page.locator('[data-testid="sendkey-row"]')).toHaveCount(10);

  // 上限态（D-31 UI 层）：按钮 disabled + 相邻提示。
  await expect(page.locator("#btn-create-sendkey")).toBeDisabled();
  const hint = page.locator("#sendkey-limit-hint");
  await expect(hint).toBeVisible();
  await expect(hint).toHaveText("已达上限（10 个）");

  // API 层双保险：第 11 个直建 400，body.error.code === send_key_limit。
  const resp11 = await request.post(
    `${BASE}/api/admin/channels/${channel.channelId}/send-keys`,
    {
      headers: {
        Authorization: `Bearer ${ADMIN_KEY}`,
        "content-type": "application/json",
      },
      data: { label: "eleventh" },
    },
  );
  expect(resp11.status()).toBe(400);
  expect(((await resp11.json()) as { error: { code: string } }).error.code).toBe(
    "send_key_limit",
  );

  expectNoCspViolations(consoleErrors, pageErrors);
});
