/**
 * 断连混沌 E2E（02-02 Task 3，SC2/WEB-04）：真浏览器 × 真 wrangler dev。
 *
 * 断连手段（02-01 A1 spike 结论：context.setOffline(true) 不关闭 Chromium
 * 已建立的 WS——WINDOWS.md #4）：页面在 SDK 加载前包装 WebSocket 构造器
 * 捕获底层 socket 实例，测试直接对真实 socket 调 close() 模拟意外断连
 * （非 disconnect()——验证不经用户调用的断线也走自动重连）。
 *
 * 三用例：
 *  1. SC2 核心：意外断连 → status reconnecting → 断连窗口发 2 条 → 自动
 *     重连 + sync 补拉恰 2 条、seq 连续、全部收到 seq 零重复（宿主无感续收）；
 *  2. 大缺口（Pitfall 5）：55 条积压（>首拉 50）→ 接入吃首拉 + has_more
 *     翻页补齐 → 断连再发 5 条 → 恢复后 60 条全到零重复；
 *  3. 被动断连恢复：确认在线 → 底层 socket close → 自动恢复 → 新消息照常到达。
 *
 * 退避窗口确定性：断连前页面内 Math.random 打补丁为 0.99（机器缺省随机源
 * 经属性查找获取——见 connection-machine.ts），attempt 0 的重连延迟 ≈ 495ms，
 * 保证断连窗口内完成 Node 侧 fetch 发送（smoke.mjs:51-57 同款思路——Node
 * fetch 不受浏览器侧影响）。
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
  const name = `e2e-reconnect-${Date.now()}`;
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
): Promise<{ seq: number }> {
  const resp = await request.post(`${BASE}/api/send`, {
    headers: {
      Authorization: `Bearer ${sendKey}`,
      "content-type": "application/json",
    },
    data: { title: "reconnect e2e", text },
  });
  expect(resp.status()).toBe(200);
  return (await resp.json()) as { seq: number };
}

/** 两行接入页面 + 预挂事件收集器 + WebSocket 构造器包装（捕获底层 socket）。 */
const PAGE_HTML = (key: string) => `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"></head>
<body>
  <div id="out"></div>
  <script src="${BASE}/pushhub.js"></script>
  <script>
    window.__ev = { status: [], message: [], history: [], error: [] };
    // spike 结论（02-01 A1）：setOffline 不关已建立 WS——捕获 SDK 的底层
    // socket 实例，测试对真实 socket close() 模拟意外断连。
    window.__sockets = [];
    const RealWebSocket = window.WebSocket;
    window.WebSocket = class extends RealWebSocket {
      constructor(...args) {
        super(...args);
        window.__sockets.push(this);
      }
    };
    const hub = new PushHub("${BASE}", "${key}");
    hub.on("status", (s) => window.__ev.status.push(s));
    hub.on("message", (m) => window.__ev.message.push(m));
    hub.on("history", (h) => window.__ev.history.push(h));
    hub.on("error", (e) => window.__ev.error.push(e));
    window.__hub = hub;
  </script>
</body>
</html>`;

// ---- 页面侧收集器（waitForFunction/evaluate 内联执行的纯函数） ----

interface EvShape {
  status: string[];
  message: { seq: number; text: string }[];
  history: { messages: { seq: number; text: string }[]; has_more: boolean }[];
  error: unknown[];
}

/** 宿主视角全部已见 seq（message 事件 + history.messages 的并集）。 */
function allSeqsFn(): number[] {
  const ev = (window as unknown as { __ev: EvShape }).__ev;
  return [
    ...ev.message.map((m) => m.seq),
    ...ev.history.flatMap((h) => h.messages.map((m) => m.seq)),
  ];
}

async function allSeqs(page: Page): Promise<number[]> {
  return page.evaluate(allSeqsFn);
}

async function waitOnline(page: Page, times = 1): Promise<void> {
  await page.waitForFunction(
    (n) => {
      const ev = (window as unknown as { __ev: EvShape }).__ev;
      return ev.status.filter((s) => s === "online").length >= n;
    },
    times,
    { timeout: 15_000 },
  );
}

async function waitReconnecting(page: Page): Promise<void> {
  await page.waitForFunction(
    () => (window as unknown as { __ev: EvShape }).__ev.status.includes("reconnecting"),
    null,
    { timeout: 10_000 },
  );
}

async function waitTextArrived(page: Page, text: string): Promise<void> {
  await page.waitForFunction(
    (t) => {
      const ev = (window as unknown as { __ev: EvShape }).__ev;
      return (
        ev.message.some((m) => m.text === t) ||
        ev.history.some((h) => h.messages.some((m) => m.text === t))
      );
    },
    text,
    { timeout: 10_000 },
  );
}

/** 断连前注入：退避随机数固定 0.99（attempt 0 → ~495ms 重连窗口）。 */
async function pinBackoff(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { Math: { random(): number } }).Math.random = () => 0.99;
  });
}

/** 关闭当前活跃（OPEN）的底层 socket——意外断连（非 disconnect()）。
 *
 * 实证（02-02 调试）：无参 close() 在 wrangler dev 代理层下 Close 帧握手
 * 不完成（socket 永卡 CLOSING、onclose 不触发）；带 code+reason 的
 * close(1000, ...) 握手正常——本地 dev 代理层怪癖，生产冒烟（smoke.mjs
 * Node 侧 close）无此问题。
 */
async function closeLiveSocket(page: Page): Promise<void> {
  const closed = await page.evaluate(() => {
    const sockets = (window as unknown as { __sockets: { readyState: number; close(): void }[] })
      .__sockets;
    const live = sockets.filter((s) => s.readyState === 1);
    if (live.length === 0) return false;
    live[live.length - 1].close(1000, "e2e unexpected disconnect");
    return true;
  });
  expect(closed).toBe(true);
}

async function destroyHub(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __hub: { destroy(): void } }).__hub.destroy();
  });
}

test("SC2：意外断连 → 自动重连 → 补拉恰 2 条零重复（宿主无感续收）", async ({ page, request }) => {
  const channel = await createChannel(request);
  await page.setContent(PAGE_HTML(channel.channelKey));
  await waitOnline(page, 1);

  // 基线消息确认链路（首拉 history 已随 accept 到达）。
  const base = await sendMessage(request, channel.sendKey, "baseline before disconnect");
  await waitTextArrived(page, "baseline before disconnect");
  const seqsBefore = await allSeqs(page);
  expect(seqsBefore.length).toBeGreaterThan(0);

  await pinBackoff(page);
  await closeLiveSocket(page);
  await waitReconnecting(page);

  // 断连窗口内 Node 侧并行发 2 条（fetch 不受浏览器断连影响，smoke.mjs 同款）。
  const [r1, r2] = await Promise.all([
    sendMessage(request, channel.sendKey, "offline message #1"),
    sendMessage(request, channel.sendKey, "offline message #2"),
  ]);

  // 自动恢复：status 第二次 online。
  await waitOnline(page, 2);

  // 恰补 2 条：断连期间的 2 条全部到达（live 或补拉路径均合法）。
  await waitTextArrived(page, "offline message #1");
  await waitTextArrived(page, "offline message #2");

  const seqsAfter = await allSeqs(page);
  // 零重复：宿主视角（message + history.messages 并集）无重复 seq。
  expect(new Set(seqsAfter).size).toBe(seqsAfter.length);
  // 新增恰为断连期间 2 条的 seq。
  const before = new Set(seqsBefore);
  const fresh = seqsAfter.filter((s) => !before.has(s));
  expect(fresh.sort((a, b) => a - b)).toEqual([r1.seq, r2.seq].sort((a, b) => a - b));
  // 全程无 error 事件（断连恢复是例行路径，不是错误）。
  const errors = await page.evaluate(
    () => (window as unknown as { __ev: EvShape }).__ev.error.length,
  );
  expect(errors).toBe(0);
  await destroyHub(page);
});

test("大缺口补拉（Pitfall 5）：55 条积压 + 断连期间 5 条 → 恢复后 60 条全到零重复", async ({ page, request }) => {
  // KEY-05 限流（每 Send Key 每分钟 30 条）：55 条分两批，跨固定窗口
  // （第一批 30 条后等窗口滚动），单用例超时上调。
  test.setTimeout(150_000);
  const channel = await createChannel(request);
  // 频道先积压 55 条（> 首拉 50——只吃首拉会静默丢最前 5 条）。
  for (let i = 1; i <= 30; i++) {
    await sendMessage(request, channel.sendKey, `gap-${i}`);
  }
  await page.waitForTimeout(61_000); // 固定窗口（RATE_WINDOW_MS=60s）滚动
  for (let i = 31; i <= 55; i++) {
    await sendMessage(request, channel.sendKey, `gap-${i}`);
  }

  await page.setContent(PAGE_HTML(channel.channelKey));
  await waitOnline(page, 1);

  // 首拉 50 + sync since=0 补齐 1..55（谓词在页面上下文执行——内联收集）。
  await page.waitForFunction(
    () => {
      const ev = (window as unknown as { __ev: EvShape }).__ev;
      const seqs = [
        ...ev.message.map((m) => m.seq),
        ...ev.history.flatMap((h) => h.messages.map((m) => m.seq)),
      ];
      return new Set(seqs).size >= 55;
    },
    null,
    { timeout: 15_000 },
  );
  const afterInitial = await allSeqs(page);
  expect(new Set(afterInitial).size).toBe(afterInitial.length);
  // 翻页路径真实触发：>50 积压使首拉 history 带 has_more=true。
  const sawHasMore = await page.evaluate(
    () => (window as unknown as { __ev: EvShape }).__ev.history.some((h) => h.has_more === true),
  );
  expect(sawHasMore).toBe(true);

  await pinBackoff(page);
  await closeLiveSocket(page);
  await waitReconnecting(page);
  for (let i = 56; i <= 60; i++) {
    await sendMessage(request, channel.sendKey, `gap-${i}`);
  }
  await waitOnline(page, 2);

  // 60 条全到：seq 恰为 1..60 且零重复（谓词在页面上下文执行——内联收集）。
  await page.waitForFunction(
    () => {
      const ev = (window as unknown as { __ev: EvShape }).__ev;
      const seqs = [
        ...ev.message.map((m) => m.seq),
        ...ev.history.flatMap((h) => h.messages.map((m) => m.seq)),
      ];
      return new Set(seqs).size >= 60;
    },
    null,
    { timeout: 15_000 },
  );
  const seqs = await allSeqs(page);
  expect(seqs).toHaveLength(60);
  expect(new Set(seqs).size).toBe(60);
  expect([...seqs].sort((a, b) => a - b)).toEqual(
    Array.from({ length: 60 }, (_, i) => 1 + i),
  );
  await destroyHub(page);
});

test("被动断连恢复：底层 socket close（非 disconnect()）→ 自动恢复后新消息照常到达", async ({ page, request }) => {
  const channel = await createChannel(request);
  await page.setContent(PAGE_HTML(channel.channelKey));
  await waitOnline(page, 1);

  const before = await sendMessage(request, channel.sendKey, "before unexpected close");
  await waitTextArrived(page, "before unexpected close");

  await pinBackoff(page);
  await closeLiveSocket(page);
  await waitReconnecting(page);
  await waitOnline(page, 2);

  // 恢复后新消息照常实时到达。
  const after = await sendMessage(request, channel.sendKey, "after recovery");
  await waitTextArrived(page, "after recovery");

  const seqs = await allSeqs(page);
  expect(new Set(seqs).size).toBe(seqs.length);
  expect(seqs).toContain(before.seq);
  expect(seqs).toContain(after.seq);
  const errors = await page.evaluate(
    () => (window as unknown as { __ev: EvShape }).__ev.error.length,
  );
  expect(errors).toBe(0);
  await destroyHub(page);
});
