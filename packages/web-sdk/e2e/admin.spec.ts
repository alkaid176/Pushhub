/**
 * 管理页 E2E（03-01 切片一 + 03-02 切片二 + 03-03 切片三）：真浏览器（Chromium）
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
 * 切片三（03-03，KEY-04/KEY-02 端到端）覆盖：
 *  - SC2 重置踢连：双页观察——pageA 管理页走重置确认框（逐字契约抽查）→
 *    pageB viewer 被踢离开 online（Pitfall 5 红线：断言 dot-online 类名
 *    消失，勿断言进入 offline——SDK 退避重连永不 fatal）→ 新 Key 重连
 *    online 恢复且首拉含重置前 2 条消息（历史保留端到端证据）；
 *  - SC2 旧 Key 失效：重置后旧 channelKey 经 Upgrade 请求 → 401 invalid_key
 *    （本地无缓存立即生效；生产 ≤60s 为文档化语义）；
 *  - D-34 删除交互：前缀联动五要素（初始 disabled / 错误输入仍 disabled /
 *    正确前缀启用 / 删除后频道从列表消失 / 详情空态文案）。
 *
 * 切片四（03-04，ADM-03/SC3 端到端）覆盖：
 *  - D-40 历史渲染与消毒：3 条消息（Markdown 加粗 / 攻击样本 script+img
 *    onerror / 无 title 纯文本）→ 展开折叠区 → 首条 #seq 为最新（倒序）→
 *    加粗经 renderMarkdown 真路径成 strong → #history-list 无 script 元素、
 *    无 on* 属性（存储型 XSS 双纵深的前端侧证据，T-03-16）→ 无 title 不渲染
 *    标题行（strong 计数恰 1）→ 每条「未回复」徽标 → has_more=false 加载
 *    更多按钮 hidden；
 *  - D-40 空态与 API before 翻页抽查：空频道展开 → 空态文案；另建频道发
 *    3 条后 GET messages?before=<第 2 条 seq> 返回恰 [seq1]（keyset 抽查——
 *    完整矩阵在 admin-history.test.ts 集成测试）。
 *
 * 切片五（03-05，D-41 全链路 journey——CONTEXT specifics 核心用户旅程的
 * 自动化串联）：单个 test 走完管理员完整生命周期，步骤间不复用独立 test
 * 的 fixture（本 test 自建自删自证，删除即清理）：
 *  登录 → UI 建频道（唯一名）→ 片段卡三块 → UI 建 Send Key（标签
 *  journey-bot）→ 行与掩码 → 经该 Key 发消息（200）→ 历史区倒序首条可见
 *  +「未回复」徽标 → pageB viewer URL 参数连接 online → 重置确认框 →
 *  pageB 离开 online + 新 Key 明文展示块 → pageB 新 Key 重连（历史保留，
 *  首拉含前述消息）→ 吊销该 Key（确认框）→ 该 Key 发送 401 → 删除确认框
 *  输入频道名前缀 → 确认 → 频道从列表消失 + 详情空态。
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

// ---------------------------------------------------------------------------
// 切片三（03-03，KEY-04 重置踢连 / KEY-02 删除交互端到端）
// ---------------------------------------------------------------------------

/** Node 侧发消息（viewer.spec 同款；历史保留用例的对照数据源）。 */
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
    data: { text },
  });
  expect(resp.status()).toBe(200);
}

/** viewer 状态指示到 online（dot 类名驱动；本切片另写其反断言）。 */
async function waitViewerOnline(page: Page): Promise<void> {
  await page.waitForFunction(
    () => document.getElementById("status-dot")?.className.includes("dot-online") === true,
    null,
    { timeout: 15_000 },
  );
}

test("SC2 重置踢连端到端：viewer 被踢离开 online，新 Key 重连后历史完整保留", async ({
  page,
  context,
  request,
}) => {
  const { consoleErrors, pageErrors } = collectPageDiagnostics(page);
  const pageB = await context.newPage();
  const diagB = collectPageDiagnostics(pageB);

  const channel = await createChannel(request);
  // 重置前发 2 条消息（历史保留端到端的对照数据）。
  await sendMessage(request, channel.sendKey, "pre-reset message one");
  await sendMessage(request, channel.sendKey, "pre-reset message two");

  // pageB 以 URL 参数连 viewer（A5 注入路径）→ online。
  await pageB.goto(
    `/?server=${encodeURIComponent(BASE)}&key=${encodeURIComponent(channel.channelKey)}`,
  );
  await waitViewerOnline(pageB);

  // pageA 走重置确认框（逐字契约抽查：三句正文的核心句）。
  await loginAdmin(page);
  await selectChannel(page, channel.name);
  await page.locator("#btn-reset-channel-key").click();
  await expect(page.locator("#reset-dialog")).toBeVisible();
  await expect(page.locator("#reset-dialog-body")).toContainText("最长约 1 分钟");
  await expect(page.locator("#reset-dialog-body")).toContainText(
    "频道历史消息完整保留",
  );
  await page.locator("#btn-reset-confirm").click();

  // 201 后：新密钥明文一次性展示块 + 60s 双活窗口提示条。
  const display = page.locator('[data-testid="new-key-display"]');
  await expect(display).toBeVisible();
  const newKey = await display.locator(".key-value").first().textContent();
  expect(newKey).toMatch(/^phc_[0-9A-Za-z]{32}$/);
  expect(newKey).not.toBe(channel.channelKey);
  await expect(page.locator("#key-reset-hint")).toContainText("最长约 1 分钟");

  // 被踢断言（Pitfall 5 红线：SDK 对意外 close 一律退避重连永不 fatal——
  // 只断言 dot-online 类名消失，勿断言进入 offline/已断开文案；15s 窗口）。
  await pageB.waitForFunction(
    () =>
      (document.getElementById("status-dot")?.className ?? "").includes(
        "dot-online",
      ) === false,
    null,
    { timeout: 15_000 },
  );

  // 新 Key 重连（URL 参数覆盖 localStorage 缺省）：online 恢复 + 首拉含
  // 重置前 2 条消息——历史保留端到端证据（KEY-04/SC2）。
  await pageB.goto(
    `/?server=${encodeURIComponent(BASE)}&key=${encodeURIComponent(newKey!)}`,
  );
  await waitViewerOnline(pageB);
  await expect(
    pageB.locator("#messages .msg", { hasText: "pre-reset message one" }),
  ).toHaveCount(1);
  await expect(
    pageB.locator("#messages .msg", { hasText: "pre-reset message two" }),
  ).toHaveCount(1);

  expectNoCspViolations(consoleErrors, pageErrors);
  expectNoCspViolations(diagB.consoleErrors, diagB.pageErrors);
});

test("SC2 旧 Channel Key 失效：重置后旧 Key 经 Upgrade 请求 401 invalid_key（本地无缓存立即生效）", async ({
  request,
}) => {
  const channel = await createChannel(request);
  const resetResp = await request.post(
    `${BASE}/api/admin/channels/${channel.channelId}/reset-channel-key`,
    { headers: { Authorization: `Bearer ${ADMIN_KEY}` } },
  );
  expect(resetResp.status()).toBe(201);
  const newKey = ((await resetResp.json()) as { channelKey: string }).channelKey;
  expect(newKey).not.toBe(channel.channelKey);

  // 旧 Key 走 /api/ws/<旧>（Upgrade 头——与浏览器 WS 握手同形）→ 401。
  // 本地 wrangler dev 无边缘缓存，立即生效；生产 ≤60s 双活窗口为文档化语义。
  const denied = await request.get(`${BASE}/api/ws/${channel.channelKey}`, {
    headers: { Upgrade: "websocket", Connection: "Upgrade" },
  });
  expect(denied.status()).toBe(401);
  expect(((await denied.json()) as { error: { code: string } }).error.code).toBe(
    "invalid_key",
  );
});

test("D-34 删除交互：前缀联动（初始 disabled / 错误输入仍 disabled / 正确前缀启用）+ 删除后列表消失与空态", async ({
  page,
  request,
}) => {
  const { consoleErrors, pageErrors } = collectPageDiagnostics(page);

  const channel = await createChannel(request);
  await loginAdmin(page);
  await selectChannel(page, channel.name);

  await page.locator("#btn-delete-channel").click();
  const dlg = page.locator("#delete-dialog");
  await expect(dlg).toBeVisible();
  await expect(dlg.locator("#delete-dialog-title")).toContainText(
    `删除频道「${channel.name}」`,
  );
  await expect(dlg.locator("#delete-dialog-body")).toContainText(
    "硬删除不可恢复",
  );

  const delBtn = page.locator("#btn-delete-confirm");
  await expect(delBtn).toHaveText("我已理解后果，删除频道");

  // 五要素 1：初始 disabled（前缀联动门槛）。
  await expect(delBtn).toBeDisabled();

  // 五要素 2：错误输入（频道名反转片段——非前缀）仍 disabled。
  const wrongInput = channel.name.split("").reverse().join("");
  await dlg.locator("#delete-name-input").fill(wrongInput);
  await expect(delBtn).toBeDisabled();

  // 五要素 3：正确前缀（前 3 字符）启用。
  await dlg.locator("#delete-name-input").fill(channel.name.slice(0, 3));
  await expect(delBtn).toBeEnabled();

  // 五要素 4/5：确认 → 频道从列表消失 + 详情回空态文案。
  await delBtn.click();
  await expect(
    page.locator("#channel-list .channel-item", { hasText: channel.name }),
  ).toHaveCount(0);
  await expect(page.locator("#channel-detail")).toContainText(
    "在左侧选择一个频道查看详情。",
  );

  expectNoCspViolations(consoleErrors, pageErrors);
});

// ---------------------------------------------------------------------------
// 切片四（03-04，ADM-03/SC3——消息历史排障视图端到端）
// ---------------------------------------------------------------------------

/** 发消息并返回服务端分配的 seq（翻页抽查的游标数据源）。 */
async function sendMessageSeq(
  request: APIRequestContext,
  sendKey: string,
  text: string,
): Promise<number> {
  const resp = await request.post(`${BASE}/api/send`, {
    headers: {
      Authorization: `Bearer ${sendKey}`,
      "content-type": "application/json",
    },
    data: { text },
  });
  expect(resp.status()).toBe(200);
  return ((await resp.json()) as { seq: number }).seq;
}

test("D-40 历史渲染与消毒：倒序首条最新、renderMarkdown 真路径、攻击样本无害、未回复徽标、按钮隐藏", async ({
  page,
  request,
}) => {
  const { consoleErrors, pageErrors } = collectPageDiagnostics(page);

  const channel = await createChannel(request);
  // 三条消息均无 title：标题行渲染（strong 计数）断言的唯一 strong 来源是
  // 第 1 条正文的 **加粗**——无 title 不渲染标题行由此一次证明。
  await sendMessageSeq(request, channel.sendKey, "第一条含 **加粗词** 的消息");
  await sendMessageSeq(
    request,
    channel.sendKey,
    '<script>alert("xss")</script>后置文本 <img src=x onerror=alert(1)>',
  );
  await sendMessageSeq(request, channel.sendKey, "第三条无 title 纯文本");

  await loginAdmin(page);
  await selectChannel(page, channel.name);

  // 展开折叠区（首展懒加载 → GET messages 首页）。
  await page.locator("#history-details summary").click();
  const list = page.locator("#history-list");
  await expect(list.locator('[data-testid="history-msg"]')).toHaveCount(3);

  // 倒序：首条（列表最上）#seq 为第 3 条（最新）。
  await expect(list.locator(".hist-msg").first().locator(".hist-seq")).toHaveText(
    "#3",
  );
  await expect(list.locator(".hist-msg").nth(1).locator(".hist-seq")).toHaveText(
    "#2",
  );
  await expect(list.locator(".hist-msg").nth(2).locator(".hist-seq")).toHaveText(
    "#1",
  );

  // renderMarkdown 真路径：加粗语法成 strong 元素（非 textContent 硬编码）。
  await expect(list.locator("strong", { hasText: "加粗词" })).toHaveCount(1);
  // 无 title 不渲染标题行：全列表 strong 计数恰 1（即第 1 条正文的加粗词）。
  await expect(list.locator("strong")).toHaveCount(1);

  // 攻击样本消毒（T-03-16 前端侧证据）：无 script 元素、无 onerror 属性；
  // 附加 on* 属性全扫描（viewer.spec audit 同款）。
  await expect(list.locator("script")).toHaveCount(0);
  await expect(list.locator("[onerror]")).toHaveCount(0);
  const onAttrs = await list.evaluate((root) => {
    const hits: string[] = [];
    root.querySelectorAll("*").forEach((el) => {
      for (const a of el.getAttributeNames()) {
        if (/^on/i.test(a)) hits.push(`${el.tagName}@${a}`);
      }
    });
    return hits;
  });
  expect(onAttrs).toEqual([]);

  // answered 徽标：本期恒「未回复」（graytext 类）。
  await expect(list.locator(".badge-unanswered")).toHaveCount(3);
  await expect(list.locator(".badge-unanswered").first()).toHaveText("未回复");

  // has_more=false（3 条 < 缺省 50）：加载更多按钮隐藏。
  await expect(page.locator("#btn-history-more")).toBeHidden();

  expectNoCspViolations(consoleErrors, pageErrors);
});

test("D-40 空态与 API before 翻页抽查：空频道空态文案；before=<第 2 条 seq> 返回恰 [seq1]", async ({
  page,
  request,
}) => {
  const { consoleErrors, pageErrors } = collectPageDiagnostics(page);

  // 空频道：展开历史区 → 空态文案（UI-SPEC 逐字）。
  const emptyChannel = await createChannel(request);
  await loginAdmin(page);
  await selectChannel(page, emptyChannel.name);
  await page.locator("#history-details summary").click();
  await expect(page.locator("#history-list")).toContainText(
    "该频道还没有消息——Webhook 发送第一条消息后会显示在这里。",
  );

  // keyset API 抽查（完整矩阵在 admin-history.test.ts）：发 3 条后
  // before=<第 2 条 seq>（=2）→ 恰 [seq1]。
  const pageChannel = await createChannel(request);
  const seqs: number[] = [];
  for (const text of ["page-a", "page-b", "page-c"]) {
    seqs.push(await sendMessageSeq(request, pageChannel.sendKey, text));
  }
  expect(seqs).toEqual([1, 2, 3]);

  const resp = await request.get(
    `${BASE}/api/admin/channels/${pageChannel.channelId}/messages?before=${seqs[1]}`,
    { headers: { Authorization: `Bearer ${ADMIN_KEY}` } },
  );
  expect(resp.status()).toBe(200);
  const body = (await resp.json()) as {
    messages: { seq: number; text: string }[];
    has_more: boolean;
    oldest_kept_seq: number;
  };
  expect(body.messages).toHaveLength(1);
  expect(body.messages[0].seq).toBe(seqs[0]);
  expect(body.messages[0].text).toBe("page-a");
  expect(body.has_more).toBe(false);
  expect(body.oldest_kept_seq).toBe(1);

  expectNoCspViolations(consoleErrors, pageErrors);
});

// ---------------------------------------------------------------------------
// 切片五（03-05，D-41——核心用户旅程全链路串联，单 test 九步）
// ---------------------------------------------------------------------------

test("D-41 全链路 journey：登录→建频道→建 Send Key→发消息→历史→重置踢连→吊销 401→删除", async ({
  page,
  context,
  request,
}) => {
  const { consoleErrors, pageErrors } = collectPageDiagnostics(page);
  const pageB = await context.newPage();
  const diagB = collectPageDiagnostics(pageB);

  // ① 登录（正确 key）。
  await loginAdmin(page);

  // ② 建频道（唯一名，UI 路径）——自建自删自证，无 fixture 依赖。
  const name = `e2e-journey-${Date.now()}`;
  await page.locator("#channel-name-input").fill(name);
  await page.locator("#btn-create").click();
  const item = page.locator("#channel-list .channel-item", { hasText: name });
  await expect(item).toHaveCount(1);
  await expect(item).toHaveAttribute("aria-current", "true");

  // ③ 片段卡三块：发送方 curl / 客户端接入（Channel Key + 服务端地址）/ viewer 直达。
  const card = page.locator('[data-testid="snippet-card"]');
  await expect(card).toBeVisible();
  await expect(card).toContainText("已创建「" + name + "」");
  const blocks = card.locator(".snippet-block");
  await expect(blocks).toHaveCount(3);
  await expect(
    blocks.nth(0).locator(".snippet-block-label"),
  ).toHaveText("发送方接入（给机器人/脚本）");
  await expect(
    blocks.nth(1).locator(".snippet-block-label"),
  ).toHaveText("客户端接入（给接收端配置）");
  await expect(blocks.nth(2).locator(".snippet-block-label")).toHaveText(
    "网页端直达",
  );
  const curlText = await blocks.nth(0).locator(".snippet-code").textContent();
  expect(curlText).toContain("/api/send");
  const link = card.locator("a[target='_blank']");
  await expect(link).toHaveCount(1);
  const href = await link.getAttribute("href");
  expect(href).toContain("server=");
  expect(href).toContain("key=");

  // ④ 建 Send Key（标签 journey-bot，UI 路径）。
  await page.locator("#sendkey-label-input").fill("journey-bot");
  await page.locator("#btn-create-sendkey").click();

  // ⑤ 行与掩码：六要素行含标签，密钥默认 ^phs_.{3}….{4}$ 掩码。
  const row = page.locator('[data-testid="sendkey-row"]', {
    hasText: "journey-bot",
  });
  await expect(row).toHaveCount(1);
  const masked = await row.locator(".key-value").textContent();
  expect(masked).toMatch(/^phs_.{3}….{4}$/);

  // 完整 Key 从 Send Key 片段卡 curl 提取（201 唯一完整返回点——旅程中
  // 管理员复制片段交给机器人接入方即此路径）。频道片段卡（pendingSnippet）
  // 与 Send Key 片段卡同时挂在详情面板——按标题过滤到唯一目标。
  const skCard = page.locator('[data-testid="snippet-card"]', {
    hasText: "已创建 Send Key「journey-bot」",
  });
  await expect(skCard).toHaveCount(1);
  const skCurl = await skCard.locator(".snippet-code").textContent();
  const keyMatch = skCurl.match(/Bearer (phs_[0-9A-Za-z]{32})/);
  expect(keyMatch).not.toBeNull();
  const journeyKey = keyMatch![1];

  // ⑥ 经该 Send Key 发 1 条消息（200）——旅程核心环节：机器人 webhook 推送。
  const sendResp = await request.post(`${BASE}/api/send`, {
    headers: {
      Authorization: `Bearer ${journeyKey}`,
      "content-type": "application/json",
    },
    data: { text: "journey core message" },
  });
  expect(sendResp.status()).toBe(200);

  // ⑦ 展开历史区：该消息倒序首条可见 +「未回复」徽标（排障入口）。
  await page.locator("#history-details summary").click();
  const histList = page.locator("#history-list");
  await expect(histList.locator('[data-testid="history-msg"]')).toHaveCount(1);
  await expect(histList.locator(".hist-msg").first()).toContainText(
    "journey core message",
  );
  await expect(
    histList.locator(".hist-msg").first().locator(".badge-unanswered"),
  ).toHaveText("未回复");

  // Channel Key 经眼睛按钮揭示（D-29 路径——viewer 接入配置的取值方式）。
  const ckBlock = page.locator("#channel-detail .detail-block").first();
  await ckBlock.locator(".icon-btn").click();
  const channelKey = await ckBlock.locator(".key-value").textContent();
  expect(channelKey).toMatch(/^phc_[0-9A-Za-z]{32}$/);

  // ⑧ pageB viewer 以 URL 参数连接（客户端接入路径）→ online。
  await pageB.goto(
    `/?server=${encodeURIComponent(BASE)}&key=${encodeURIComponent(channelKey!)}`,
  );
  await waitViewerOnline(pageB);

  // ⑨ 重置 Channel Key：确认框（逐字契约抽查）→ 确认。
  await page.locator("#btn-reset-channel-key").click();
  await expect(page.locator("#reset-dialog")).toBeVisible();
  await expect(page.locator("#reset-dialog-body")).toContainText(
    "最长约 1 分钟",
  );
  await page.locator("#btn-reset-confirm").click();

  // ⑩ 断言三态其一/其二：pageB 被踢离开 online + 新 Key 明文展示块出现。
  await pageB.waitForFunction(
    () =>
      (document.getElementById("status-dot")?.className ?? "").includes(
        "dot-online",
      ) === false,
    null,
    { timeout: 15_000 },
  );
  const display = page.locator('[data-testid="new-key-display"]');
  await expect(display).toBeVisible();
  const newKey = await display.locator(".key-value").first().textContent();
  expect(newKey).toMatch(/^phc_[0-9A-Za-z]{32}$/);
  expect(newKey).not.toBe(channelKey);

  // ⑪ 三态其三：pageB 以新 Key 重连 online——历史保留（首拉含 ⑥ 的消息）。
  await pageB.goto(
    `/?server=${encodeURIComponent(BASE)}&key=${encodeURIComponent(newKey!)}`,
  );
  await waitViewerOnline(pageB);
  await expect(
    pageB.locator("#messages .msg", { hasText: "journey core message" }),
  ).toHaveCount(1);

  // ⑫ 吊销该 Send Key（确认框：标题含标签——有标签 Key 显示标签而非
  // 掩码（openRevokeDialog：rec.label ? label : mask），+ 逐字契约正文）。
  await page
    .locator('[data-testid="sendkey-row"]', { hasText: "journey-bot" })
    .locator(".revoke-btn")
    .click();
  await expect(page.locator("#revoke-dialog")).toBeVisible();
  await expect(page.locator("#revoke-dialog-title")).toContainText(
    "吊销 Send Key「journey-bot」？",
  );
  await expect(page.locator("#revoke-dialog-body")).toContainText(
    "此操作不可撤销",
  );
  await page.locator("#btn-revoke-confirm").click();
  await expect(
    page.locator('[data-testid="sendkey-row"]', { hasText: "journey-bot" }),
  ).toHaveCount(0);

  // ⑬ 被吊销 Key 下次调用即 401（泄露不互伤——本频道唯一业务 Key 已废）。
  const denied = await request.post(`${BASE}/api/send`, {
    headers: {
      Authorization: `Bearer ${journeyKey}`,
      "content-type": "application/json",
    },
    data: { text: "should be rejected" },
  });
  expect(denied.status()).toBe(401);
  expect(((await denied.json()) as { error: { code: string } }).error.code).toBe(
    "invalid_key",
  );

  // ⑭⑮ 删除确认框：输入频道名前缀启用 → 确认（one-way 操作的旅程终点）。
  await page.locator("#btn-delete-channel").click();
  const dlg = page.locator("#delete-dialog");
  await expect(dlg).toBeVisible();
  await expect(dlg.locator("#delete-dialog-title")).toContainText(
    `删除频道「${name}」`,
  );
  const delBtn = page.locator("#btn-delete-confirm");
  await expect(delBtn).toBeDisabled();
  await dlg.locator("#delete-name-input").fill(name.slice(0, 3));
  await expect(delBtn).toBeEnabled();
  await delBtn.click();

  // ⑯ 频道从列表消失 + 详情空态（本 test 自建的频道就此清理，零残留）。
  await expect(
    page.locator("#channel-list .channel-item", { hasText: name }),
  ).toHaveCount(0);
  await expect(page.locator("#channel-detail")).toContainText(
    "在左侧选择一个频道查看详情。",
  );

  expectNoCspViolations(consoleErrors, pageErrors);
  expectNoCspViolations(diagB.consoleErrors, diagB.pageErrors);
});
