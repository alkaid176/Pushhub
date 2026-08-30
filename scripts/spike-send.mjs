#!/usr/bin/env node
/**
 * PushHub SC1 spike 定时发消息脚本（D-85 脚本化验证——06-02 交付，06-05 全量启动）。
 *
 * 零依赖：Node 22 原生 fetch + node:fs/node:path。（Node API 仅用于本脚本，
 * 与服务端代码无关——服务端零 Node 依赖约束不受影响。）
 *
 * 用法：
 *   PUSHHUB_SPIKE_SEND_KEY=<secret> node scripts/spike-send.mjs [--hours 8] [--interval-min 60]
 *   node scripts/spike-send.mjs --send-key <secret> --url https://pushhub.dyun.org --hours 8
 *   node scripts/spike-send.mjs --dry-run --hours 1        # 自证模式：不需要密钥，不发送不落盘
 *
 * 行为（D-85：脚本自动化执行，人工次日只看结论）：
 *   - 启动即发第 0 条（hourIndex=0），此后每 --interval-min 分钟发一条直到
 *     --hours 上限，共 hours+1 条；各条按启动时刻绝对对齐（单条重试耗时不漂移）。
 *   - 每条 title 形如 "[tag] 第 N/H 小时 HH:mm"（本地时间），text 含完整 ISO
 *     时间戳、序号与随机 nonce（区分同小时重发）——次日报告可区分第几小时断线。
 *   - 发送经 POST /api/send（Authorization: Bearer <Send Key>，同 smoke.mjs 模式）。
 *   - 每条结果追加写 scripts/.spike-out/send-<启动时间戳>.jsonl——这是
 *     spike-report.mjs 的发送侧输入，字段契约见下方 RECORD 注释（改动双侧同步）。
 *   - 单条失败重试 1 次（间隔 5s），仍失败记 send_failed 后继续下一轮——
 *     发送侧失败与接收侧失败以 status 字段区分（报告侧前者单列不计入分母）。
 *   - 全部发送失败时退出码 1；参数缺失/非法退出码 2。
 *
 * RECORD 发送记录 JSONL 字段契约（spike-report.mjs 消费方）：
 *   ts         string          ISO-8601 发送发起时刻
 *   hourIndex  number          小时序号（0..hours；0 为启动即发的首条）
 *   title      string          消息标题（含 tag 与小时序号，供人眼核对）
 *   status     "sent"|"send_failed"  发送侧成功/失败
 *   httpStatus number|null     HTTP 状态码（网络异常为 null）
 *   wid        string|null     服务器返回消息 id（m_ 前缀）——报告侧 wid 精确匹配主键
 *   seq        number|null     服务器返回频道内序号
 *   nonce      string          随机 8 hex（区分同小时重发）
 *   error      string|null     失败摘要（经 redact 脱敏，不含任何密钥形态）
 *
 * 密钥纪律（T-06-02-01，prohibition AND-06/privacy）：
 *   - Send Key 仅经 --send-key 或环境变量 PUSHHUB_SPIKE_SEND_KEY 传入，绝不硬编码；
 *   - 错误摘要经 redact() 处理（密钥值出现处替换为 ***）；错误路径不回显
 *     Authorization 头（fetch 异常只取 name/message，HTTP 非 200 只取状态码与
 *     响应体前 200 字符）；JSONL 记录与 stdout 均不含任何密钥形态。
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const USAGE = `usage: node scripts/spike-send.mjs [--url <base-url>] --send-key <secret> [--hours N] [--interval-min M] [--tag T] [--dry-run]
       PUSHHUB_SPIKE_SEND_KEY=<secret> node scripts/spike-send.mjs [options]

  --url           服务端基址（默认 https://pushhub.dyun.org）
  --send-key      频道 Send Key（缺省回退环境变量 PUSHHUB_SPIKE_SEND_KEY；两者皆无退出码 2）
  --hours         总小时数（默认 8；共发 hours+1 条——第 0 条立即发送）
  --interval-min  发送间隔分钟（默认 60）
  --tag           消息标记前缀（默认 spike）
  --dry-run       打印载荷与时间计划，不发送不落盘（不需要密钥）`;

function usageExit(reason) {
  if (reason) console.error(`参数错误: ${reason}`);
  console.error(USAGE);
  process.exit(2);
}

// ---- CLI 解析（同 smoke.mjs 模式：CLI 参数优先，环境变量回退）----
const args = process.argv.slice(2);
const opts = {
  url: "https://pushhub.dyun.org",
  sendKey: process.env.PUSHHUB_SPIKE_SEND_KEY ?? "",
  hours: 8,
  intervalMin: 60,
  tag: "spike",
  dryRun: false,
};
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  const next = args[i + 1];
  if (a === "--url" && next) { opts.url = next; i++; }
  else if (a === "--send-key" && next) { opts.sendKey = next; i++; }
  else if (a === "--hours" && next !== undefined) { opts.hours = Number(next); i++; }
  else if (a === "--interval-min" && next !== undefined) { opts.intervalMin = Number(next); i++; }
  else if (a === "--tag" && next) { opts.tag = next; i++; }
  else if (a === "--dry-run") { opts.dryRun = true; }
  else usageExit(`未知或残缺参数: ${a}`);
}
if (!Number.isInteger(opts.hours) || opts.hours < 0 || opts.hours > 24 * 30) {
  usageExit(`--hours 须为 0..720 的整数（当前 ${args.includes("--hours") ? opts.hours : "默认 8"}）`);
}
if (!Number.isFinite(opts.intervalMin) || opts.intervalMin <= 0 || opts.intervalMin > 24 * 60) {
  usageExit(`--interval-min 须为 0..1440 的正数（当前 ${opts.intervalMin}）`);
}

/** 密钥脱敏（T-06-02-01）：文本中出现的每个敏感值替换为 ***（短于 4 字符的值跳过防误伤）。 */
function redact(text, secrets) {
  let out = String(text);
  for (const s of secrets) {
    if (typeof s === "string" && s.length >= 4) out = out.split(s).join("***");
  }
  return out;
}

/** 构造 hours+1 条载荷（按启动时刻绝对对齐：hour N 计划时刻 = start + N * interval）。 */
function buildPayloads(hours, tag, startEpoch, intervalMs) {
  const items = [];
  for (let h = 0; h <= hours; h++) {
    const at = startEpoch + h * intervalMs;
    const d = new Date(at);
    const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    const nonce = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
    const title = `[${tag}] 第 ${h}/${hours} 小时 ${hhmm}`;
    const text = `${tag} message hourIndex=${h}/${hours}\nISO ${d.toISOString()}\nnonce ${nonce}`;
    items.push({ hourIndex: h, plannedAt: at, title, text, nonce });
  }
  return items;
}

/**
 * 单条发送（同 smoke.mjs 的 /api/send 模式）。
 * 错误摘要不含 Authorization 头：fetch 异常只取 name/message；HTTP 非 200 只取
 * 状态码与响应体前 200 字符——两者均由调用方再经 redact() 脱敏后落盘/打印。
 */
async function postMessage(url, sendKey, title, text) {
  let resp;
  try {
    resp = await fetch(`${url}/api/send`, {
      method: "POST",
      headers: { Authorization: `Bearer ${sendKey}`, "content-type": "application/json" },
      body: JSON.stringify({ title, text }),
    });
  } catch (err) {
    return { httpStatus: null, ok: false, wid: null, seq: null, error: `${err.name}: ${err.message}` };
  }
  let body = null;
  let raw = "";
  try { raw = await resp.text(); body = JSON.parse(raw); } catch { /* 非 JSON 响应体 */ }
  if (resp.status === 200) {
    return {
      httpStatus: 200,
      ok: true,
      wid: typeof body?.id === "string" ? body.id : null,
      seq: typeof body?.seq === "number" ? body.seq : null,
      error: null,
    };
  }
  return { httpStatus: resp.status, ok: false, wid: null, seq: null, error: `HTTP ${resp.status}: ${raw.slice(0, 200) || "(空响应体)"}` };
}

// ---- dry-run：打印载荷与时间计划，不发送不落盘（自证模式，不需要密钥）----
const baseUrl = opts.url.replace(/\/+$/, "");
const startEpoch = Date.now();
const intervalMs = Math.round(opts.intervalMin * 60_000);
const payloads = buildPayloads(opts.hours, opts.tag, startEpoch, intervalMs);

if (opts.dryRun) {
  console.log(`[dry-run] url=${baseUrl} tag=${opts.tag} hours=${opts.hours} interval-min=${opts.intervalMin}`);
  console.log(`[dry-run] 共 ${payloads.length} 条（hourIndex 0..${opts.hours}），不发送不落盘`);
  console.log(`[dry-run] 实发时记录文件：scripts/.spike-out/send-<启动时间戳>.jsonl`);
  for (const p of payloads) {
    console.log(`[dry-run] hour ${p.hourIndex} 计划 ${new Date(p.plannedAt).toISOString()} body=${JSON.stringify({ title: p.title, text: p.text })}`);
  }
  process.exit(0);
}

// ---- 密钥检查（dry-run 之后的正门：两者皆无 → 退出码 2）----
if (!opts.sendKey) {
  console.error("缺少 Send Key：经 --send-key 或环境变量 PUSHHUB_SPIKE_SEND_KEY 传入（管理页建 spike 频道后取该频道 Send Key，用户密码库管理，勿入库）");
  usageExit();
}

const SECRETS = [opts.sendKey];
const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(SCRIPTS_DIR, ".spike-out");
const OUT_FILE = join(OUT_DIR, `send-${new Date(startEpoch).toISOString().replace(/[:.]/g, "-")}.jsonl`);
mkdirSync(OUT_DIR, { recursive: true });

console.log(`spike-send 启动：${baseUrl}，共 ${payloads.length} 条（hourIndex 0..${opts.hours}），间隔 ${opts.intervalMin} 分钟`);
console.log(`发送记录：${OUT_FILE}`);

const records = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const p of payloads) {
  const wait = p.plannedAt - Date.now();
  if (wait > 0) {
    console.log(`[hour ${p.hourIndex}/${opts.hours}] 等待 ${Math.round(wait / 1000)}s（计划 ${new Date(p.plannedAt).toISOString()}）`);
    await sleep(wait);
  }
  const sentAt = new Date();
  let result = await postMessage(baseUrl, opts.sendKey, p.title, p.text);
  let attempts = 1;
  if (!result.ok) {
    console.log(`[hour ${p.hourIndex}] 发送失败（${redact(result.error, SECRETS)}），5s 后重试 1 次`);
    await sleep(5_000);
    result = await postMessage(baseUrl, opts.sendKey, p.title, p.text);
    attempts = 2;
  }
  const status = result.ok ? "sent" : "send_failed";
  const rec = {
    ts: sentAt.toISOString(),
    hourIndex: p.hourIndex,
    title: p.title,
    status,
    httpStatus: result.httpStatus,
    wid: result.wid,
    seq: result.seq,
    nonce: p.nonce,
    error: result.ok ? null : redact(result.error, SECRETS),
  };
  appendFileSync(OUT_FILE, `${JSON.stringify(rec)}\n`);
  records.push(rec);
  console.log(`[hour ${p.hourIndex}] ${status} httpStatus=${rec.httpStatus}${rec.wid ? ` wid=${rec.wid}` : ""}（第 ${attempts} 次尝试）`);
}

const sentCount = records.filter((r) => r.status === "sent").length;
if (records.length > 0 && sentCount === 0) {
  console.error(`SPIKE SEND FAILED：${records.length} 条全部发送失败（记录：${OUT_FILE}）`);
  process.exit(1);
}
console.log(`SPIKE SEND DONE：${sentCount}/${records.length} 条发送成功，记录：${OUT_FILE}`);
