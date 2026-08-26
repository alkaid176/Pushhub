/**
 * Tracer E2E（02-01 Task 3）：真浏览器（Chromium）× 真 wrangler dev
 * （真 DO/真 KV/真 WS，D-26）端到端验证 SC1/SC3 + setOffline spike（A1）。
 *
 * 编排对照 scripts/smoke.mjs 已验证流程：
 *  - setup 经 admin API 建临时频道（频道名含时间戳可重复跑，Bearer 本地
 *    dev 专用 ADMIN_KEY）→ phc_/phs_ 正则断言；
 *  - 页面两行接入（SC1 原文形态）：script src=/pushhub.js（构建产物，经
 *    wrangler 静态资产分发）+ new PushHub(serverUrl, channelKey)；
 *  - Node 侧 request POST /api/send 后 2000ms 内 message 事件且 text 逐字
 *    一致（验收线对齐 < 2s）；
 *  - 攻击样本经 PushHub.renderMarkdown 后 innerHTML 入容器，DOM 断言无害
 *    （SC3 真浏览器层——jsdom 单测之外的第二层）；
 *  - spike（A1）：context.setOffline(true) 观察 status 是否迁移到重连态
 *    （WS 是否被 Chromium 关闭）——只观察不断言，结论记入 SUMMARY 供
 *    02-02 断连混沌用例消费。
 *
 * 时序纪律（smoke.mjs:104-113 教训）：事件收集器在 new PushHub 之前预挂，
 * 即发即弃首帧（accept 即推首拉 history）不丢。
 */
import { test, expect, type APIRequestContext } from "@playwright/test";

const BASE = "http://127.0.0.1:4911";
const ADMIN_KEY = "e2e-admin-key"; // 仅存在于本地 wrangler dev 进程（--var 注入）

interface ChannelInfo {
  channelKey: string;
  sendKey: string;
  channelId: string;
}

async function createChannel(request: APIRequestContext): Promise<ChannelInfo> {
  const name = `e2e-tracer-${Date.now()}`;
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
    data: { title: "tracer e2e", text },
  });
  expect(resp.status()).toBe(200);
}

/** 两行接入页面（SC1 原文形态）+ 预挂事件收集器。 */
const PAGE_HTML = (key: string) => `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8" /></head>
<body>
  <div id="out"></div>
  <script src="${BASE}/pushhub.js"></script>
  <script>
    window.__ev = { status: [], message: [], history: [], error: [] };
    const hub = new PushHub("${BASE}", "${key}");
    hub.on("status", (s) => window.__ev.status.push(s));
    hub.on("message", (m) => window.__ev.message.push(m));
    hub.on("history", (h) => window.__ev.history.push(h));
    hub.on("error", (e) => window.__ev.error.push(e));
    window.__hub = hub;
  </script>
</body>
</html>`;

const ATTACK_SAMPLES = [
  "<script>alert(1)</script>after",
  '<img src=x onerror=alert(1)>',
  "[x](javascript:alert(1))",
  "[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)",
  '<a href="https://ok.example" onclick="alert(1)">safe</a>',
  "<svg onload=alert(1)></svg>",
  '<iframe src="https://evil.example"></iframe>',
];

test("SC1+SC3：两行接入 → 2s 内实收消息 → 攻击样本渲染无害", async ({ page, request }) => {
  const channel = await createChannel(request);
  await page.setContent(PAGE_HTML(channel.channelKey));

  // status → online（首连：connecting → online；首拉 history 随 accept 即推）。
  await page.waitForFunction(
    () => (window as unknown as { __ev: { status: string[] } }).__ev.status.includes("online"),
    null,
    { timeout: 15_000 },
  );

  // 首拉 history 已消化（服务端 accept 即推，D-09）——窗口内至少收到一次 history 事件。
  await page.waitForFunction(
    () =>
      (window as unknown as { __ev: { history: unknown[] } }).__ev.history.length > 0,
    null,
    { timeout: 5_000 },
  );

  // SC1：POST /api/send → 2000ms 内 message 事件且 text 逐字一致（哑管道语义）。
  const sentText = "tracer **e2e** message\n\nsecond line with 中文与符号 <b>";
  const t0 = Date.now();
  await sendMessage(request, channel.sendKey, sentText);
  await page.waitForFunction(
    (txt) =>
      (window as unknown as { __ev: { message: { text: string }[] } }).__ev.message.some(
        (m) => m.text === txt,
      ),
    sentText,
    { timeout: 2_000 },
  );
  const latency = Date.now() - t0;
  console.log(`[tracer] SC1 end-to-end latency: ${latency}ms (acceptance < 2000ms)`);

  // SC3 真浏览器层：renderMarkdown 输出经 innerHTML 写入容器后 DOM 无害。
  await page.evaluate((samples: string[]) => {
    const out = document.getElementById("out");
    if (out === null) throw new Error("#out missing");
    const PushHubCtor = (window as unknown as { PushHub: { renderMarkdown(t: string): string } })
      .PushHub;
    for (const s of samples) {
      const div = document.createElement("div");
      div.innerHTML = PushHubCtor.renderMarkdown(s);
      out.appendChild(div);
    }
  }, ATTACK_SAMPLES);

  const audit = await page.evaluate(() => {
    const out = document.getElementById("out");
    if (out === null) throw new Error("#out missing");
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
        if (lower.startsWith("javascript:") || lower.startsWith("data:")) {
          badHrefs.push(href);
        }
      }
    }
    const anchorsOk = anchors.every(
      (a) =>
        a.getAttribute("target") === "_blank" &&
        (a.getAttribute("rel") ?? "").includes("noopener") &&
        (a.getAttribute("rel") ?? "").includes("noreferrer"),
    );
    return {
      scripts: out.querySelectorAll("script").length,
      iframes: out.querySelectorAll("iframe").length,
      onAttrs,
      badHrefs,
      anchorsOk,
      anchorCount: anchors.length,
      errors: (window as unknown as { __ev: { error: unknown[] } }).__ev.error.length,
    };
  });
  expect(audit.scripts).toBe(0);
  expect(audit.iframes).toBe(0);
  expect(audit.onAttrs).toEqual([]);
  expect(audit.badHrefs).toEqual([]);
  expect(audit.anchorCount).toBeGreaterThan(0);
  expect(audit.anchorsOk).toBe(true);
  // tracer 主链路不应出现 error 事件（无 fatal 帧、无坏帧）。
  expect(audit.errors).toBe(0);

  await page.evaluate(() => {
    (window as unknown as { __hub: { destroy(): void } }).__hub.destroy();
  });
});

test("spike A1：setOffline 是否关闭已建立 WS（只观察不断言，结论记 SUMMARY）", async ({ page, context, request }) => {
  const channel = await createChannel(request);
  await page.setContent(PAGE_HTML(channel.channelKey));
  await page.waitForFunction(
    () => (window as unknown as { __ev: { status: string[] } }).__ev.status.includes("online"),
    null,
    { timeout: 15_000 },
  );

  await context.setOffline(true);
  const observed = await page.evaluate(
    () =>
      new Promise<{ statuses: string[]; closed: boolean }>((resolve) => {
        const start = Date.now();
        const check = (): void => {
          const ev = (window as unknown as { __ev: { status: string[] } }).__ev;
          const moved = ev.status.includes("reconnecting") || ev.status.includes("offline");
          if (moved || Date.now() - start > 8_000) {
            resolve({ statuses: [...ev.status], closed: moved });
          } else {
            setTimeout(check, 200);
          }
        };
        check();
      }),
  );
  console.log(
    `[spike setOffline] WS closed by Chromium: ${observed.closed}; observed statuses: ${observed.statuses.join(" -> ")}`,
  );

  await context.setOffline(false);
  // 观察恢复（不作为通过条件）：若 WS 被关闭，退避重连应在网络恢复后回到 online。
  const recovered = await page
    .waitForFunction(
      () => {
        const ev = (window as unknown as { __ev: { status: string[] } }).__ev;
        return ev.status.filter((s) => s === "online").length >= 2;
      },
      null,
      { timeout: 20_000 },
    )
    .then(() => true)
    .catch(() => false);
  console.log(`[spike setOffline] reconnected to online after offline cleared: ${recovered}`);

  await page.evaluate(() => {
    (window as unknown as { __hub: { destroy(): void } }).__hub.destroy();
  });
});
