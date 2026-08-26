#!/usr/bin/env node
/**
 * PushHub 生产冒烟脚本（D-15 自动化部分 ①②③ 的当前切片版）—— 01-01 Task 3。
 *
 * 零依赖：Node 22 原生 fetch + 全局 WebSocket + child_process。
 * （Node API 仅用于本脚本与服务端代码无关——服务端零 Node 依赖约束不受影响。）
 *
 * 用法：
 *   node scripts/smoke.mjs --url https://pushhub.<subdomain>.workers.dev
 *   PH_SMOKE_URL=https://... node scripts/smoke.mjs
 *
 * 流程：
 *   a. 经 npx wrangler kv key put 种入冒烟用 ch:/sk: 两键（固定 channelId "smoketest"，
 *      可重复运行：覆盖式种入；KV namespace id 自行从 packages/server/wrangler.jsonc 解析）
 *   b. POST /api/send（Bearer 冒烟 Send Key）断言 200 且响应含 id 与 seq
 *   c. 打开 WS /api/ws/<channelKey>，再发第二条消息，断言收到 v:1 message 帧且 text
 *      一致，打印端到端延迟毫秒数（验收 1 的量化证据）
 *   d. 断言无效 Send Key 得 401 + code: invalid_key 信封
 *   e. 全部通过输出 SMOKE OK；任何一步失败非零退出
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = join(HERE, "..", "packages", "server");

// ---- 参数：--url <worker-url> 或 PH_SMOKE_URL ----
const args = process.argv.slice(2);
let baseUrl = process.env.PH_SMOKE_URL ?? "";
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--url" && args[i + 1]) {
    baseUrl = args[i + 1];
    i++;
  }
}
if (!baseUrl) {
  console.error("usage: node scripts/smoke.mjs --url <worker-url>  (or set PH_SMOKE_URL)");
  process.exit(2);
}
baseUrl = baseUrl.replace(/\/+$/, "");
const wsOrigin = baseUrl.replace(/^http/, "ws");

// ---- 从 wrangler.jsonc 解析 KV namespace id（剔除 // 行注释后正则取 kv_namespaces.id）----
const wranglerRaw = readFileSync(join(SERVER_DIR, "wrangler.jsonc"), "utf8");
const wranglerStripped = wranglerRaw.replace(/^[ \t]*\/\/.*$/gm, "");
const kvMatch = /"kv_namespaces"\s*:\s*\[[\s\S]*?"id"\s*:\s*"([0-9a-f]+)"/.exec(wranglerStripped);
if (!kvMatch) {
  console.error("FAIL: cannot parse kv_namespaces id from packages/server/wrangler.jsonc");
  process.exit(2);
}
const NAMESPACE_ID = kvMatch[1];

// ---- 冒烟固定频道与密钥 ----
const CHANNEL_ID = "smoketest";
const CHANNEL_KEY = "ph_smoke_channel_v1";
const SEND_KEY = "ph_smoke_send_v1";
const TEXT_2 = "## second message\n\nsmoke **fanout** check";

function fail(step, detail) {
  console.error(`FAIL [${step}]: ${detail}`);
  process.exit(1);
}

// ---- a. 种入 ch:/sk: 两键（值经临时文件 --path 传入，规避跨 shell 引号问题）----
function kvPut(key, value) {
  const tmp = join(mkdtempSync(join(tmpdir(), "ph-smoke-")), "value.json");
  try {
    writeFileSync(tmp, JSON.stringify(value));
    execFileSync(
      "npx",
      [
        "wrangler", "kv", "key", "put", key,
        `--path=${tmp}`,
        `--namespace-id=${NAMESPACE_ID}`,
        "--remote",
      ],
      { cwd: SERVER_DIR, stdio: ["ignore", "pipe", "pipe"], timeout: 120_000, shell: true },
    );
  } catch (err) {
    fail("kv-seed", `wrangler kv key put ${key} failed: ${err.stderr?.toString() ?? err.message}`);
  } finally {
    rmSync(dirname(tmp), { recursive: true, force: true });
  }
}

kvPut(`ch:${CHANNEL_KEY}`, { channelId: CHANNEL_ID, name: "smoke", createdAt: Date.now() });
kvPut(`sk:${SEND_KEY}`, { channelId: CHANNEL_ID });
console.log(`OK [kv-seed]: ch:${CHANNEL_KEY} + sk:${SEND_KEY} -> channelId "${CHANNEL_ID}" (ns ${NAMESPACE_ID})`);

// ---- b. 第一条消息：POST /api/send 断言 200 且含 id 与 seq ----
async function send(text, bearer) {
  const resp = await fetch(`${baseUrl}/api/send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify({ title: "smoke", text }),
  });
  return resp;
}

let resp1;
try {
  resp1 = await send("# hello smoke", SEND_KEY);
} catch (err) {
  fail("send-1", `fetch failed: ${err.message}`);
}
if (resp1.status !== 200) fail("send-1", `expected 200, got ${resp1.status}: ${await resp1.text()}`);
const body1 = await resp1.json();
if (typeof body1.id !== "string" || !body1.id.startsWith("m_")) fail("send-1", `bad id: ${JSON.stringify(body1)}`);
if (typeof body1.seq !== "number" || body1.seq < 1) fail("send-1", `bad seq: ${JSON.stringify(body1)}`);
console.log(`OK [send-1]: 200 id=${body1.id} seq=${body1.seq}`);

// ---- c. WS 连接 + 第二条消息 + 端到端延迟 ----
const socket = new WebSocket(`${wsOrigin}/api/ws/${CHANNEL_KEY}`);
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("timeout waiting for WS open")), 10_000);
  socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
  socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("WS error/open failed")); }, { once: true });
}).catch((err) => fail("ws-open", err.message));
console.log("OK [ws-open]: connected");

function wsNextFrame(timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for WS frame (${timeoutMs}ms)`)), timeoutMs);
    socket.addEventListener("message", (ev) => {
      clearTimeout(timer);
      try { resolve(JSON.parse(ev.data)); } catch { reject(new Error("non-JSON WS frame")); }
    }, { once: true });
  });
}

const framePromise = wsNextFrame(10_000);
const t0 = Date.now();
const resp2 = await send(TEXT_2, SEND_KEY);
if (resp2.status !== 200) fail("send-2", `expected 200, got ${resp2.status}: ${await resp2.text()}`);
const body2 = await resp2.json();

let frame;
try {
  frame = await framePromise;
} catch (err) {
  fail("ws-receive", err.message);
}
const latencyMs = Date.now() - t0;
if (frame.v !== 1) fail("ws-receive", `frame v !== 1: ${JSON.stringify(frame)}`);
if (frame.seq !== body2.seq) fail("ws-receive", `frame.seq ${frame.seq} !== send seq ${body2.seq}`);
if (frame.text !== TEXT_2) fail("ws-receive", `text mismatch (dumb-pipe violation): ${JSON.stringify(frame.text)}`);
console.log(`OK [ws-receive]: v:1 frame seq=${frame.seq} wid=${frame.wid} text verbatim match`);
console.log(`LATENCY: ${latencyMs}ms (webhook POST -> WS client receipt)`);
if (latencyMs >= 2000) fail("ws-receive", `end-to-end latency ${latencyMs}ms >= 2000ms (acceptance #1)`);
socket.close(1000, "smoke done");

// ---- d. 无效 Send Key -> 401 + invalid_key 信封 ----
const respBad = await send("# should fail", `invalid_${Date.now()}`);
if (respBad.status !== 401) fail("invalid-key", `expected 401, got ${respBad.status}`);
const errBody = await respBad.json();
if (errBody?.error?.code !== "invalid_key") fail("invalid-key", `bad envelope: ${JSON.stringify(errBody)}`);
console.log("OK [invalid-key]: 401 + error.code=invalid_key");

// ---- e. 全绿 ----
console.log("SMOKE OK");
