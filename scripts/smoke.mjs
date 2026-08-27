#!/usr/bin/env node
/**
 * PushHub 生产冒烟脚本（D-15 checklist ①②③④ 自动化部分——01-05 定稿版）。
 *
 * 零依赖：Node 22 原生 fetch + 全局 WebSocket。
 * （Node API 仅用于本脚本与服务端代码无关——服务端零 Node 依赖约束不受影响。）
 *
 * 用法：
 *   PH_SMOKE_URL=https://... PH_ADMIN_KEY=<secret> node scripts/smoke.mjs
 *   node scripts/smoke.mjs --url https://pushhub.<subdomain>.workers.dev --admin-key <secret>
 *
 * 流程（生产路径全真实——建频道走 admin API，不再经 wrangler kv 种键）：
 *   ① POST /api/admin/channels（Bearer ADMIN_KEY）建临时冒烟频道拿三件套
 *      （频道名含时间戳，可重复运行不冲突）；先以错误 Admin Key 断言 401
 *      （D-13 生产路径反例）
 *   ② POST /api/send（返回的 Send Key）断言 200 且响应含 id 与 seq；
 *      WS 全链路实收 v:1 message 帧并打印端到端延迟毫秒（验收 < 2000ms）
 *      （首连即收首拉 history 帧，D-09）
 *   ③ 记录 last_seq 后断开 → 断开期间再发 2 条 → 重连 + sync since 补拉
 *      恰补 2 条且 seq 连续（断线补拉零丢失零重复）
 *   ④ 反例两枚：无效 Send Key → 401 invalid_key；超限载荷（text 32769 字符）
 *      → 413 payload_too_large（D-02 契约）
 *   全部通过输出 SMOKE OK；任何一步失败非零退出
 */
const args = process.argv.slice(2);
let baseUrl = process.env.PH_SMOKE_URL ?? "";
let adminKey = process.env.PH_ADMIN_KEY ?? "";
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--url" && args[i + 1]) {
    baseUrl = args[i + 1];
    i++;
  } else if (args[i] === "--admin-key" && args[i + 1]) {
    adminKey = args[i + 1];
    i++;
  }
}
if (!baseUrl || !adminKey) {
  console.error("usage: PH_SMOKE_URL=<url> PH_ADMIN_KEY=<secret> node scripts/smoke.mjs  (or --url/--admin-key)");
  process.exit(2);
}
baseUrl = baseUrl.replace(/\/+$/, "");
const wsOrigin = baseUrl.replace(/^http/, "ws");

const TEXT_2 = "## second message\n\nsmoke **fanout** check";

function fail(step, detail) {
  console.error(`FAIL [${step}]: ${detail}`);
  process.exit(1);
}

async function send(text, bearer) {
  return fetch(`${baseUrl}/api/send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify({ title: "smoke", text }),
  });
}

/** ① 建频道：错误 Admin Key 先验 401（D-13 生产反例），再真实建临时频道。 */
async function createChannel() {
  const bad = await fetch(`${baseUrl}/api/admin/channels`, {
    method: "POST",
    headers: { Authorization: "Bearer definitely-not-the-admin-key", "content-type": "application/json" },
    body: JSON.stringify({ name: "smoke-negative" }),
  });
  if (bad.status !== 401) fail("admin-auth", `wrong admin key: expected 401, got ${bad.status}: ${await bad.text()}`);
  const badBody = await bad.json();
  if (badBody?.error?.code !== "invalid_key") fail("admin-auth", `bad envelope: ${JSON.stringify(badBody)}`);
  console.log("OK [admin-auth]: wrong admin key -> 401 + error.code=invalid_key");

  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
  const name = `smoke-${stamp}`;
  const resp = await fetch(`${baseUrl}/api/admin/channels`, {
    method: "POST",
    headers: { Authorization: `Bearer ${adminKey}`, "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (resp.status !== 201) fail("admin-create", `expected 201, got ${resp.status}: ${await resp.text()}`);
  const channel = await resp.json();
  if (!/^phc_[0-9A-Za-z]{32}$/.test(channel.channelKey)) fail("admin-create", `bad channelKey: ${JSON.stringify(channel.channelKey)}`);
  if (!/^phs_[0-9A-Za-z]{32}$/.test(channel.sendKeys[0].key)) fail("admin-create", `bad sendKey: ${JSON.stringify(channel.sendKeys[0].key)}`);
  if (!/^[0-9A-Za-z]{16}$/.test(channel.channelId)) fail("admin-create", `bad channelId: ${JSON.stringify(channel.channelId)}`);
  console.log(`OK [admin-create]: channel "${name}" (id ${channel.channelId}) -> phc_/phs_ keys minted`);
  return channel;
}

const channel = await createChannel();
const CHANNEL_KEY = channel.channelKey;
const SEND_KEY = channel.sendKeys[0].key;

// ---- ② 第一条消息：POST /api/send 断言 200 且含 id 与 seq ----
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
console.log(`OK [send-1]: 200 id=${body1.id} seq=${body1.seq} (admin-created Send Key works immediately)`);

// ---- WS 全链路（D-15 ②③）----
// 连接方式：open 前预挂 message 监听，帧按序入数组（服务端在升级路径即推送
// 首拉 history 帧——open 回调后再挂监听会丢即发即弃的首帧）。

// 首连：立即收首拉 history 帧（D-09，01-04 起 accept 后服务端即刻推送）。
const frames1 = [];
const socket = new WebSocket(`${wsOrigin}/api/ws/${CHANNEL_KEY}`);
socket.addEventListener("message", (ev) => {
  try { frames1.push(JSON.parse(ev.data)); } catch { frames1.push({ _unparseable: String(ev.data) }); }
});
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("timeout waiting for WS open")), 10_000);
  socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
  socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("WS error/open failed")); }, { once: true });
}).catch((err) => fail("ws-open", err.message));
console.log("OK [ws-open]: connected (admin-created Channel Key works immediately)");

const initialDeadline = Date.now() + 10_000;
while (frames1.length === 0) {
  if (Date.now() > initialDeadline) fail("ws-initial-history", "timeout waiting for initial history frame");
  await new Promise((r) => setTimeout(r, 50));
}
const initialFrame = frames1.shift();
if (initialFrame.v !== 1 || initialFrame.type !== "history" || !Array.isArray(initialFrame.messages)) {
  fail("ws-initial-history", `bad initial frame: ${JSON.stringify(initialFrame).slice(0, 200)}`);
}
if (initialFrame.messages.length > 50) fail("ws-initial-history", `INITIAL_FETCH exceeded: ${initialFrame.messages.length}`);
if (typeof initialFrame.oldest_kept_seq !== "number") fail("ws-initial-history", `bad oldest_kept_seq: ${JSON.stringify(initialFrame).slice(0, 200)}`);
console.log(`OK [ws-initial-history]: ${initialFrame.messages.length} messages, oldest_kept_seq=${initialFrame.oldest_kept_seq}, has_more=${initialFrame.has_more}`);

// 第二条消息：实收 v:1 message 帧 + 端到端延迟（帧已由预挂监听按序收集）。
const t0 = Date.now();
const resp2 = await send(TEXT_2, SEND_KEY);
if (resp2.status !== 200) fail("send-2", `expected 200, got ${resp2.status}: ${await resp2.text()}`);
const body2 = await resp2.json();

const msgDeadline = Date.now() + 10_000;
while (frames1.length === 0) {
  if (Date.now() > msgDeadline) fail("ws-receive", "timeout waiting for message frame");
  await new Promise((r) => setTimeout(r, 50));
}
const frame = frames1.shift();
const latencyMs = Date.now() - t0;
if (frame.v !== 1) fail("ws-receive", `frame v !== 1: ${JSON.stringify(frame)}`);
if (frame.type !== "message") fail("ws-receive", `frame type !== message: ${JSON.stringify(frame).slice(0, 200)}`);
if (frame.seq !== body2.seq) fail("ws-receive", `frame.seq ${frame.seq} !== send seq ${body2.seq}`);
if (frame.text !== TEXT_2) fail("ws-receive", `text mismatch (dumb-pipe violation): ${JSON.stringify(frame.text)}`);
console.log(`OK [ws-receive]: v:1 frame seq=${frame.seq} wid=${frame.wid} text verbatim match`);
console.log(`LATENCY: ${latencyMs}ms (webhook POST -> WS client receipt)`);
if (latencyMs >= 2000) fail("ws-receive", `end-to-end latency ${latencyMs}ms >= 2000ms (acceptance #1)`);

// ---- ③ 记录 last_seq 并主动断开（D-15 ③ 演练起点）----
const lastSeq = body2.seq;
socket.close(1000, "smoke disconnect");
console.log(`OK [ws-disconnect]: closed with last_seq=${lastSeq}`);

// 断开期间再发 2 条。
const resp3 = await send("offline message #1", SEND_KEY);
if (resp3.status !== 200) fail("offline-send", `expected 200, got ${resp3.status}: ${await resp3.text()}`);
const body3 = await resp3.json();
const resp4 = await send("offline message #2", SEND_KEY);
if (resp4.status !== 200) fail("offline-send", `expected 200, got ${resp4.status}: ${await resp4.text()}`);
const body4 = await resp4.json();
if (body4.seq !== body3.seq + 1) fail("offline-send", `seq not contiguous: ${body3.seq} -> ${body4.seq}`);
console.log(`OK [offline-send]: 2 messages while disconnected (seq ${body3.seq}, ${body4.seq})`);

// 重连 → 首拉 history → sync since=lastSeq 恰补 2 条（断线补拉零丢失）。
const frames2 = [];
const socket2 = new WebSocket(`${wsOrigin}/api/ws/${CHANNEL_KEY}`);
socket2.addEventListener("message", (ev) => {
  try { frames2.push(JSON.parse(ev.data)); } catch { frames2.push({ _unparseable: String(ev.data) }); }
});
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("timeout waiting for WS reopen")), 10_000);
  socket2.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
  socket2.addEventListener("error", () => { clearTimeout(timer); reject(new Error("WS reopen failed")); }, { once: true });
}).catch((err) => fail("ws-reconnect", err.message));
console.log("OK [ws-reconnect]: reconnected");

const initial2Deadline = Date.now() + 10_000;
while (frames2.length === 0) {
  if (Date.now() > initial2Deadline) fail("ws-catchup", "timeout waiting for reconnect initial history");
  await new Promise((r) => setTimeout(r, 50));
}
const initial2 = frames2.shift();
if (initial2.type !== "history") fail("ws-catchup", `expected initial history after reconnect, got: ${JSON.stringify(initial2).slice(0, 200)}`);

socket2.send(JSON.stringify({ v: 1, type: "sync", since: lastSeq }));
const syncDeadline = Date.now() + 10_000;
while (frames2.length === 0) {
  if (Date.now() > syncDeadline) fail("ws-catchup", "timeout waiting for sync history response");
  await new Promise((r) => setTimeout(r, 50));
}
const caught = frames2.shift();
if (caught.type !== "history") fail("ws-catchup", `expected history response, got: ${JSON.stringify(caught).slice(0, 200)}`);
if (caught.messages.length !== 2) {
  fail("ws-catchup", `expected exactly 2 caught-up messages, got ${caught.messages.length}: seqs=${caught.messages.map((m) => m.seq).join(",")}`);
}
const caughtSeqs = caught.messages.map((m) => m.seq);
if (caughtSeqs[0] !== body3.seq || caughtSeqs[1] !== body4.seq) {
  fail("ws-catchup", `caught seqs [${caughtSeqs.join(",")}] !== expected [${body3.seq},${body4.seq}]`);
}
if (caught.messages.some((m) => m.seq <= lastSeq)) fail("ws-catchup", "caught message with seq <= lastSeq (duplicate/no-loss violation)");
if (caught.messages[0].text !== "offline message #1" || caught.messages[1].text !== "offline message #2") {
  fail("ws-catchup", `caught texts mismatch: ${JSON.stringify(caught.messages.map((m) => m.text))}`);
}
console.log(`OK [ws-catchup]: sync since=${lastSeq} -> exactly 2 messages (seq ${caughtSeqs.join(",")}), zero loss zero dup`);
socket2.close(1000, "smoke done");

// ---- ④ 反例两枚：无效 Send Key 401 + 超限载荷 413 ----
const respBad = await send("# should fail", `invalid_${Date.now()}`);
if (respBad.status !== 401) fail("invalid-key", `expected 401, got ${respBad.status}`);
const errBody = await respBad.json();
if (errBody?.error?.code !== "invalid_key") fail("invalid-key", `bad envelope: ${JSON.stringify(errBody)}`);
console.log("OK [invalid-key]: 401 + error.code=invalid_key");

// 超限载荷（text 32769 字符，D-02 上限 32768）。
const oversizedText = "a".repeat(32769);
let respBig;
try {
  respBig = await fetch(`${baseUrl}/api/send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${SEND_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ text: oversizedText }),
  });
} catch (err) {
  fail("oversized", `fetch failed: ${err.message}`);
}
if (respBig.status !== 413) {
  fail("oversized", `expected 413, got ${respBig.status}: ${await respBig.text()}`);
}
const bigBody = await respBig.json();
if (bigBody?.error?.code !== "payload_too_large") {
  fail("oversized", `bad envelope: ${JSON.stringify(bigBody)}`);
}
console.log("OK [oversized]: 413 + error.code=payload_too_large (32769-char text rejected at edge)");

// ---- 全绿 ----
console.log("SMOKE OK");
