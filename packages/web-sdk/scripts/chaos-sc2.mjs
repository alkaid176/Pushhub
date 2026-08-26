#!/usr/bin/env node
/**
 * SC2 生产部署混沌验证脚本（02-03 Task 3 动作 5）——一次性 harness，
 * **不并入自动化测试套件**（生产域名不进自动化测试，D-26），仅在需要
 * "每次部署即免费混沌测试"演练时手动运行。
 *
 * 流程：
 *   1. admin API 建专用频道（chaos-sc2-<时间戳>）；
 *   2. Chromium 打开生产查看器 /?server=…&key=…（URL 参数注入），等 status online；
 *   3. 发一条基线消息并确认 DOM 出现（部署前活链路）；
 *   4. 经 window.__pushhub 调试句柄挂 status/message/history 收集器（D-24）；
 *   5. 执行 `pnpm run deploy`（部署必然断开全量 WS），部署进行期间发消息 #1、
 *      部署结束后发消息 #2；
 *   6. 轮询最长 90s（覆盖 60s 退避上限）断言：出现过 reconnecting、当前回到
 *      online、2 条消息各恰好出现一次（事件层 + DOM 层零重复）、li.msg 总数
 *      恰为基线+2。输出 CHAOS PASS 与部署 Version ID。
 *
 * 用法（在 packages/web-sdk 下）：
 *   node scripts/chaos-sc2.mjs --url https://pushhub.dyun.org --admin-key <secret> \
 *        --expect-version 0.1.8
 * 前置：root package.json version 已改为 --expect-version 的值（本脚本部署的
 * 就是该版本；不匹配即中止，防部署错版本）。
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const args = process.argv.slice(2);
function arg(name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : "";
}
const BASE = arg("url").replace(/\/+$/, "");
const ADMIN_KEY = arg("admin-key");
const EXPECT_VERSION = arg("expect-version");
if (!BASE || !ADMIN_KEY || !EXPECT_VERSION) {
  console.error(
    "usage: node scripts/chaos-sc2.mjs --url https://pushhub.dyun.org --admin-key <secret> --expect-version <ver>",
  );
  process.exit(2);
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const rootVersion = JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf8")).version;
if (rootVersion !== EXPECT_VERSION) {
  console.error(`ABORT: root package.json version ${rootVersion} != --expect-version ${EXPECT_VERSION}`);
  process.exit(2);
}

function fail(step, detail) {
  console.error(`FAIL [${step}]: ${detail}`);
  process.exit(1);
}

async function createChannel() {
  const name = `chaos-sc2-${Date.now()}`;
  const resp = await fetch(`${BASE}/api/admin/channels`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ADMIN_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (resp.status !== 201) fail("admin-create", `${resp.status}: ${await resp.text()}`);
  const channel = await resp.json();
  console.log(`OK [admin-create]: channel "${name}"`);
  return channel;
}

async function send(sendKey, text) {
  const resp = await fetch(`${BASE}/api/send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${sendKey}`, "content-type": "application/json" },
    body: JSON.stringify({ title: "chaos-sc2", text }),
  });
  if (resp.status !== 200) fail("send", `${resp.status}: ${await resp.text()}`);
  return resp.json();
}

function runDeploy() {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("pnpm run deploy", { cwd: REPO_ROOT, shell: true });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("error", reject);
    child.on("close", (code) => resolvePromise({ code, out }));
  });
}

function count(haystack, needle) {
  return haystack.reduce((n, t) => (t === needle ? n + 1 : n), 0);
}

const stamp = Date.now();
const MSG_BASE = `chaos baseline ${stamp}`;
const MSG1 = `chaos during-deploy #1 ${stamp}`;
const MSG2 = `chaos after-deploy #2 ${stamp}`;

const channel = await createChannel();
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.goto(
    `${BASE}/?server=${encodeURIComponent(BASE)}&key=${encodeURIComponent(channel.channelKey)}`,
  );

  // 部署前：等查看器 status → online，基线消息经活链路出现。
  await page.waitForFunction(
    () => document.getElementById("status-dot")?.className.includes("dot-online") === true,
    null,
    { timeout: 30_000 },
  );
  console.log("OK [viewer-online]: status → online（0.1.7 查看器接入）");
  await send(channel.sendKey, MSG_BASE);
  await page.waitForFunction(
    (t) => [...document.querySelectorAll("#messages li")].some((li) => li.textContent?.includes(t)),
    MSG_BASE,
    { timeout: 15_000 },
  );
  console.log("OK [baseline]: 基线消息已渲染（部署前活链路）");

  // D-24 调试句柄挂收集器（此后所有 status 变迁与消息文本入库）。
  await page.evaluate(() => {
    const hub = window.__pushhub;
    window.__chaos = { statuses: [], texts: [] };
    hub.on("status", (s) => window.__chaos.statuses.push(s));
    hub.on("message", (m) => window.__chaos.texts.push(m.text));
    hub.on("history", (h) => {
      for (const m of h.messages) window.__chaos.texts.push(m.text);
    });
  });

  // 部署（必然断开全量 WS）——进行期间发 #1，结束后发 #2。
  const deployStart = Date.now();
  const deployPromise = runDeploy();
  await send(channel.sendKey, MSG1);
  console.log("OK [send-during-deploy]: #1 已发（部署进行中）");
  const deploy = await deployPromise;
  const deployMs = Date.now() - deployStart;
  if (deploy.code !== 0) fail("deploy", `exit ${deploy.code}: ${deploy.out.slice(-500)}`);
  const versionId = deploy.out.match(/Current Version ID:\s*(\S+)/)?.[1] ?? "unknown";
  console.log(`OK [deploy]: exit 0 in ${deployMs}ms, Version ID ${versionId}`);
  await send(channel.sendKey, MSG2);
  console.log("OK [send-after-deploy]: #2 已发");

  // 轮询最长 90s（覆盖 60s 退避上限）。
  const deadline = deployStart + 90_000;
  let snap = null;
  for (;;) {
    snap = await page.evaluate(() => ({
      dot: document.getElementById("status-dot")?.className ?? "",
      statuses: window.__chaos.statuses,
      texts: window.__chaos.texts,
      msgCount: document.querySelectorAll("#messages li.msg").length,
    }));
    const recovered =
      snap.statuses.includes("reconnecting") &&
      snap.dot.includes("dot-online") &&
      count(snap.texts, MSG1) === 1 &&
      count(snap.texts, MSG2) === 1 &&
      snap.msgCount === 3;
    if (recovered) break;
    if (Date.now() > deadline) {
      fail(
        "recover",
        `90s 内未恢复。dot=${snap.dot} statuses=[${snap.statuses}] msg1×${count(snap.texts, MSG1)} msg2×${count(snap.texts, MSG2)} li.msg=${snap.msgCount}`,
      );
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  const recoverMs = Date.now() - deployStart;
  console.log(`OK [recover]: ${recoverMs}ms 后回到 online；status 轨迹（部署后）= [${snap.statuses.join(" → ")}]`);
  console.log(
    `OK [no-dup-no-loss]: #1×${count(snap.texts, MSG1)} #2×${count(snap.texts, MSG2)}（事件层各恰 1 次）、DOM li.msg=${snap.msgCount}（基线 1 + 恰 2，零重复零丢失）`,
  );
  console.log(`CHAOS PASS (version ${EXPECT_VERSION}, Version ID ${versionId})`);
} finally {
  await browser.close();
}
