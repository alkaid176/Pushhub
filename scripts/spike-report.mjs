#!/usr/bin/env node
/**
 * PushHub SC1 spike 报告生成器（D-85——次日看结论：把人工判断压缩为"看判定行"）。
 *
 * 零依赖：Node 22 + node:fs。（自动化的是对照与渲染，不是断言——结论仍由人工读报告，
 * 06-RESEARCH §Validation Architecture AND-06 manual-only 口径。）
 *
 * 用法：
 *   node scripts/spike-report.mjs --send-log <path> --device-log <path> [--out <path>]
 *   node scripts/spike-report.mjs --send-log <path> --device-log <name>=<path> --device-log <name2>=<path2> --out report.md
 *   node scripts/spike-report.mjs --self-test        # 内置样例自证（不读文件），退出码 0/1
 *
 * 输入：
 *   --send-log   spike-send.mjs 的发送记录 JSONL（字段契约见 spike-send.mjs 头注：
 *                ts/hourIndex/title/status("sent"|"send_failed")/httpStatus/wid/seq/nonce/error）
 *   --device-log 设备 SpikeLog JSONL（06-01 service/SpikeLog.kt 导出，可多次传入；
 *                name=path 形式命名设备，裸路径以文件名（去扩展）为设备名）。
 *                事件结构 {ts, type: "status"|"message_arrived", channel, status?, wid?, seq?}——
 *                ts 兼容 ISO 字符串与 epoch 毫秒数两种写法；仅 message_arrived 参与对照。
 *   --out        报告输出文件路径（缺省 stdout）
 *
 * 对照逻辑：
 *   - 以发送记录的 hourIndex 为主轴逐条对照；
 *   - 每条 sent 消息在设备日志中查找到达事件：① wid 精确匹配（服务器消息 id 主键）
 *     优先；② 无 wid 或未命中时按时间窗兜底（|设备 ts - 发送 ts| <= 120s 取最近一条）；
 *     每条设备到达事件只消费一次（防一条到达事件匹配多条发送）；
 *   - send_failed（发送侧失败）单列，不计入到达率分母；
 *   - 未知格式行（非 JSON 对象）跳过且计数，不崩溃。
 *
 * 输出（markdown）：设备名小节 + 逐小时矩阵（小时/发送时刻/发送状态/收到时刻/延迟秒/判定）
 * + 断线小时列表（发送成功但未收到的连续区间合并）+ 结论行（到达 N/N 判定 PASS /
 * 到达 N/M 判定 FAIL 附失败小时）；多设备时附总表与整体判定。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

const MATCH_WINDOW_MS = 120_000; // 时间窗兜底匹配阈值（±120s）

const USAGE = `usage: node scripts/spike-report.mjs --send-log <path> --device-log <path>[=name] [--out <path>]
       node scripts/spike-report.mjs --self-test

  --send-log    spike-send.mjs 的发送记录 JSONL 路径
  --device-log  设备 SpikeLog JSONL 路径；name=path 形式命名设备，可多次传入（多设备出总表）
  --out         报告输出文件路径（缺省 stdout）
  --self-test   内置固定样例自证（全到达 PASS / 第 5 小时未到达 FAIL 等），退出码 0/1`;

function usageExit(reason) {
  if (reason) console.error(`参数错误: ${reason}`);
  console.error(USAGE);
  process.exit(2);
}

/** 解析 JSONL：非 JSON 对象行（含不可解析行/数组/标量行）跳过并计数；空行忽略。 */
function parseJsonl(text) {
  const rows = [];
  let skipped = 0;
  for (const line of String(text).split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      const v = JSON.parse(t);
      if (v && typeof v === "object" && !Array.isArray(v)) { rows.push(v); continue; }
    } catch { /* 未知格式行——跳过计数 */ }
    skipped++;
  }
  return { rows, skipped };
}

/** ts 宽容解析：number 按 epoch 毫秒、string 按 Date.parse；不可解析返回 NaN。 */
function tsToMs(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") return Date.parse(v);
  return NaN;
}

/**
 * 为一条 sent 发送记录查找匹配的设备到达事件。
 * 返回 { idx, via: "wid"|"window" } | null；via 标记命中方式（报告规则行可核对）。
 */
function findArrival(rec, arrivals, used) {
  const sendTs = tsToMs(rec.ts);
  if (rec.wid) {
    for (let i = 0; i < arrivals.length; i++) {
      if (!used.has(i) && arrivals[i].wid === rec.wid) return { idx: i, via: "wid" };
    }
  }
  if (Number.isNaN(sendTs)) return null;
  let bestIdx = -1;
  let bestDelta = Infinity;
  for (let i = 0; i < arrivals.length; i++) {
    if (used.has(i)) continue;
    const evTs = tsToMs(arrivals[i].ts);
    if (Number.isNaN(evTs)) continue;
    const delta = Math.abs(evTs - sendTs);
    if (delta <= MATCH_WINDOW_MS && delta < bestDelta) { bestDelta = delta; bestIdx = i; }
  }
  return bestIdx >= 0 ? { idx: bestIdx, via: "window" } : null;
}

/** 单设备对照：返回逐小时行与统计（arrived/sentTotal/failedSends/missedHours/连续区间）。 */
function analyzeDevice(sendRecords, deviceRows) {
  const arrivals = deviceRows.filter((r) => r.type === "message_arrived" && r.ts !== undefined);
  const used = new Set();
  const rows = sendRecords.map((rec) => {
    const hour = typeof rec.hourIndex === "number" ? rec.hourIndex : "?";
    if (rec.status !== "sent") {
      return { hour, ts: rec.ts, sendStatus: "send_failed", arrivedAt: null, latencyS: null, verdict: "send_failed", via: null };
    }
    const hit = findArrival(rec, arrivals, used);
    if (hit) {
      used.add(hit.idx);
      const sendMs = tsToMs(rec.ts);
      const evMs = tsToMs(arrivals[hit.idx].ts);
      const latencyMs = Number.isNaN(sendMs) || Number.isNaN(evMs) ? NaN : evMs - sendMs;
      return {
        hour,
        ts: rec.ts,
        sendStatus: "sent",
        arrivedAt: arrivals[hit.idx].ts,
        latencyS: Number.isNaN(latencyMs) ? null : Math.max(0, Math.round(latencyMs / 1000)),
        verdict: "arrived",
        via: hit.via,
      };
    }
    return { hour, ts: rec.ts, sendStatus: "sent", arrivedAt: null, latencyS: null, verdict: "missed", via: null };
  });
  const sentTotal = rows.filter((r) => r.sendStatus === "sent").length;
  const arrived = rows.filter((r) => r.verdict === "arrived").length;
  const failedSends = rows.filter((r) => r.verdict === "send_failed").length;
  const missedHours = rows.filter((r) => r.verdict === "missed" && typeof r.hour === "number").map((r) => r.hour);
  return {
    rows, sentTotal, arrived, failedSends, missedHours,
    ranges: hourRanges(missedHours),
    pass: sentTotal > 0 && arrived === sentTotal,
  };
}

/** 断线小时合并为连续区间（[5,6,8] → ["5-6", "8"]）。 */
function hourRanges(hours) {
  if (hours.length === 0) return [];
  const sorted = [...hours].sort((a, b) => a - b);
  const ranges = [];
  let start = sorted[0];
  let prev = sorted[0];
  const flush = () => ranges.push(start === prev ? `${start}` : `${start}-${prev}`);
  for (const h of sorted.slice(1)) {
    if (h === prev + 1) { prev = h; continue; }
    flush();
    start = prev = h;
  }
  flush();
  return ranges;
}

/** 渲染整份 markdown 报告。devices: [{name, rows, skipped}]；meta: 报告头信息。 */
function renderReport(sendRecords, devices, meta) {
  const L = [];
  L.push("# PushHub SC1 spike 报告", "");
  L.push(`- 生成时间：${meta.generatedAt}`);
  L.push(`- 发送记录：${meta.sendLogName}（${sendRecords.length} 条，跳过 ${meta.sendSkipped} 行未知格式）`);
  L.push(`- 匹配规则：wid 精确匹配优先，时间窗 ±${MATCH_WINDOW_MS / 1000}s 兜底；每条设备到达事件只消费一次；send_failed 单列不计入分母`, "");
  const summary = [];
  for (const dev of devices) {
    const r = analyzeDevice(sendRecords, dev.rows);
    L.push(`## 设备：${dev.name}`, "");
    if (dev.skipped > 0) L.push(`> 设备日志跳过 ${dev.skipped} 行未知格式行`, "");
    L.push("| 小时 | 发送时刻 (UTC) | 发送状态 | 设备收到时刻 (UTC) | 延迟 (s) | 判定 |");
    L.push("|------|---------------|----------|-------------------|----------|------|");
    for (const row of r.rows) {
      const verdict = row.verdict === "arrived" ? "到达" : row.verdict === "missed" ? "未到达" : "发送侧失败";
      L.push(`| ${row.hour} | ${row.ts ?? "—"} | ${row.sendStatus} | ${row.arrivedAt ?? "—"} | ${row.latencyS ?? "—"} | ${verdict} |`);
    }
    L.push("");
    L.push("### 断线小时（发送成功但设备未收到）", "");
    if (r.ranges.length > 0) L.push(`第 ${r.ranges.join("、")} 小时`);
    else L.push("无——全部发送成功的消息均有到达记录");
    L.push("");
    const failNote = r.sentTotal === 0 ? "（全部发送侧失败，无有效分母）" : `（发送侧失败 ${r.failedSends} 条单列不计入分母）`;
    L.push(`**结论：** 到达 ${r.arrived}/${r.sentTotal}${failNote}——判定 **${r.pass ? "PASS" : "FAIL"}**${r.pass ? "" : `，未到达小时：${r.missedHours.join(", ")}`}`, "");
    summary.push({ name: dev.name, arrived: r.arrived, sentTotal: r.sentTotal, pass: r.pass });
  }
  if (devices.length > 1) {
    L.push("## 总表", "");
    L.push("| 设备 | 到达 | 判定 |");
    L.push("|------|------|------|");
    for (const s of summary) L.push(`| ${s.name} | ${s.arrived}/${s.sentTotal} | ${s.pass ? "PASS" : "FAIL"} |`);
    L.push("");
    const passCount = summary.filter((s) => s.pass).length;
    L.push(`**整体判定：${passCount}/${summary.length} 设备 PASS——${passCount === summary.length ? "PASS" : "FAIL"}**`, "");
  }
  return L.join("\n");
}

// ---- --self-test 固定样例（不读文件、不依赖真机）----

function sampleSendRecords(hours, { failHours = [], baseMs = Date.UTC(2026, 7, 29, 16, 0, 0) } = {}) {
  const recs = [];
  for (let h = 0; h <= hours; h++) {
    const ts = new Date(baseMs + h * 3_600_000).toISOString();
    const base = {
      ts, hourIndex: h, title: `[spike] 第 ${h}/${hours} 小时 00:00`,
      httpStatus: 200, wid: `m_spike_${h}`, seq: h + 1, nonce: "abcd1234", error: null,
    };
    recs.push(failHours.includes(h)
      ? { ...base, status: "send_failed", httpStatus: null, wid: null, seq: null, error: "TypeError: fetch failed" }
      : { ...base, status: "sent" });
  }
  return recs;
}

function sampleDeviceRows(sendRecords, { skipHours = [], offsetMs = 3_000 } = {}) {
  const rows = [];
  for (const rec of sendRecords) {
    if (rec.status !== "sent" || skipHours.includes(rec.hourIndex)) continue;
    rows.push({ ts: new Date(tsToMs(rec.ts) + offsetMs).toISOString(), type: "message_arrived", channel: "spike-01", wid: rec.wid, seq: rec.seq });
  }
  // 混入 status 事件（对照逻辑应忽略）
  rows.push({ ts: sendRecords[0].ts, type: "status", channel: "spike-01", status: "online" });
  return rows;
}

function runSelfTest() {
  let ok = true;
  const check = (name, cond, detail) => {
    if (cond) console.log(`PASS [${name}] ${detail ?? ""}`);
    else { ok = false; console.error(`FAIL [${name}] ${detail ?? ""}`); }
  };
  const meta = { generatedAt: "2026-08-30T00:00:00.000Z", sendLogName: "self-test", sendSkipped: 0 };

  // 样例 A：8 条消息（hourIndex 0..7）全到达 → PASS
  const recsA = sampleSendRecords(7);
  const reportA = renderReport(recsA, [{ name: "sample-A", rows: sampleDeviceRows(recsA), skipped: 0 }], meta);
  check("A-verdict", reportA.includes("**PASS**"), "全到达样例应产出 PASS 判定行");
  check("A-count", reportA.includes("到达 8/8"), "应显示 到达 8/8");
  check("A-no-miss", reportA.includes("无——全部发送成功的消息均有到达记录"), "断线小时应为无");

  // 样例 B：8 条中第 5 小时未到达 → FAIL + 断线小时 5
  const recsB = sampleSendRecords(7);
  const reportB = renderReport(recsB, [{ name: "sample-B", rows: sampleDeviceRows(recsB, { skipHours: [5] }), skipped: 0 }], meta);
  check("B-verdict", reportB.includes("**FAIL**"), "第 5 小时未到达样例应产出 FAIL 判定行");
  check("B-hour", reportB.includes("第 5 小时"), "断线小时列表应含第 5 小时");
  check("B-count", reportB.includes("到达 7/8"), "应显示 到达 7/8");
  check("B-missed-hours", reportB.includes("未到达小时：5"), "结论行应附失败小时 5");

  // 样例 C：8 条中 1 条发送侧失败（hour 2）单列、分母 7 全到达 → PASS 7/7
  const recsC = sampleSendRecords(7, { failHours: [2] });
  const reportC = renderReport(recsC, [{ name: "sample-C", rows: sampleDeviceRows(recsC), skipped: 0 }], meta);
  check("C-denominator", reportC.includes("到达 7/7"), "send_failed 不计入分母（7/7 而非 7/8）");
  check("C-verdict", reportC.includes("**PASS**"), "分母内全到达应 PASS");
  check("C-listed", reportC.includes("发送侧失败 1 条单列不计入分母"), "发送侧失败应单列显示");
  check("C-row", /\| 2 \|[^|]*\| send_failed \| — \| — \| 发送侧失败 \|/.test(reportC), "逐小时表应含 hour 2 send_failed 行");

  // 样例 D：未知格式行跳过且计数（不崩溃）
  const mixed = [
    JSON.stringify({ ts: "2026-08-30T00:00:00Z", type: "status", channel: "x", status: "online" }),
    "not-json-at-all",
    JSON.stringify([1, 2, 3]),
    JSON.stringify("plain string"),
    "",
    JSON.stringify({ ts: "2026-08-30T00:01:00Z", type: "status", channel: "x", status: "offline" }),
  ].join("\n");
  const parsed = parseJsonl(mixed);
  check("D-skip", parsed.skipped === 3 && parsed.rows.length === 2, `未知格式行应跳过且计数（skipped=${parsed.skipped} rows=${parsed.rows.length}，期望 3/2）`);

  // 样例 E：设备事件无 wid → 时间窗 ±120s 兜底匹配
  const recE = { ts: new Date(Date.UTC(2026, 7, 29, 17, 0, 0)).toISOString(), hourIndex: 1, title: "t", status: "sent", httpStatus: 200, wid: "m_x1", seq: 2, nonce: "n", error: null };
  const devE = [{ ts: new Date(Date.UTC(2026, 7, 29, 17, 0, 10)).toISOString(), type: "message_arrived", channel: "spike", seq: 2 }];
  const rE = analyzeDevice([recE], devE);
  check("E-window", rE.rows[0].verdict === "arrived" && rE.rows[0].via === "window", "无 wid 事件应经时间窗匹配到达");

  // 样例 F：超出 ±120s 窗口不得匹配
  const devF = [{ ts: new Date(Date.UTC(2026, 7, 29, 17, 10, 0)).toISOString(), type: "message_arrived", channel: "spike", seq: 2 }];
  const rF = analyzeDevice([recE], devF);
  check("F-window-miss", rF.rows[0].verdict === "missed", "超出 ±120s 窗口的事件不得匹配");

  // 样例 G：epoch 毫秒 ts 写法兼容（06-01 SpikeLog ts 格式未定稿的双兼容防线）
  const devG = [{ ts: Date.UTC(2026, 7, 29, 17, 0, 5), type: "message_arrived", channel: "spike", wid: "m_x1" }];
  const rG = analyzeDevice([recE], devG);
  check("G-epoch-ts", rG.rows[0].verdict === "arrived" && rG.rows[0].latencyS === 5, "epoch 毫秒 ts 应可解析并计延迟 5s");

  // 样例 H：一条到达事件不得匹配两条发送（单次消费）
  const recsH = [recE, { ...recE, hourIndex: 2, wid: "m_x2", seq: 3 }];
  const devH = [{ ts: recE.ts, type: "message_arrived", channel: "spike", wid: "m_x1" }];
  const rH = analyzeDevice(recsH, devH);
  check("H-single-consume", rH.rows[0].verdict === "arrived" && rH.rows[1].verdict === "missed", "同一到达事件只消费一次");

  // 样例 I：多设备总表
  const reportI = renderReport(recsA, [
    { name: "huawei", rows: sampleDeviceRows(recsA), skipped: 0 },
    { name: "xiaomi", rows: sampleDeviceRows(recsA, { skipHours: [3] }), skipped: 0 },
  ], meta);
  check("I-summary", reportI.includes("## 总表") && reportI.includes("1/2 设备 PASS——FAIL"), "多设备应输出总表与整体判定");

  console.log(ok ? "SELF-TEST OK" : "SELF-TEST FAILED");
  process.exit(ok ? 0 : 1);
}

// ---- CLI 解析与主流程 ----
const args = process.argv.slice(2);
const opts = { sendLog: null, deviceLogs: [], out: null, selfTest: false };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  const next = args[i + 1];
  if (a === "--self-test") { opts.selfTest = true; }
  else if (a === "--send-log" && next) { opts.sendLog = next; i++; }
  else if (a === "--device-log" && next) {
    const v = next;
    const eq = v.indexOf("=");
    opts.deviceLogs.push(eq > 0 ? { name: v.slice(0, eq), path: v.slice(eq + 1) } : { name: null, path: v });
    i++;
  }
  else if (a === "--out" && next) { opts.out = next; i++; }
  else usageExit(`未知或残缺参数: ${a}`);
}

if (opts.selfTest) runSelfTest();
if (!opts.sendLog) usageExit("必须提供 --send-log（spike-send.mjs 的发送记录 JSONL）");
if (opts.deviceLogs.length === 0) usageExit("至少提供一个 --device-log（或 --device-log name=path 命名多设备）");

let sendText;
try {
  sendText = readFileSync(opts.sendLog, "utf8");
} catch (err) {
  console.error(`读取发送记录失败：${opts.sendLog}（${err.message}）`);
  process.exit(1);
}
const sendParsed = parseJsonl(sendText);
if (sendParsed.rows.length === 0) {
  console.error(`发送记录无有效行：${opts.sendLog}（跳过 ${sendParsed.skipped} 行未知格式）`);
  process.exit(1);
}
sendParsed.rows.sort((a, b) => (typeof a.hourIndex === "number" ? a.hourIndex : Infinity) - (typeof b.hourIndex === "number" ? b.hourIndex : Infinity));

const devices = [];
for (const d of opts.deviceLogs) {
  let text;
  try {
    text = readFileSync(d.path, "utf8");
  } catch (err) {
    console.error(`读取设备日志失败：${d.path}（${err.message}）`);
    process.exit(1);
  }
  const parsed = parseJsonl(text);
  devices.push({ name: d.name ?? basename(d.path).replace(/\.jsonl$/, ""), rows: parsed.rows, skipped: parsed.skipped });
}

const report = renderReport(sendParsed.rows, devices, {
  generatedAt: new Date().toISOString(),
  sendLogName: opts.sendLog,
  sendSkipped: sendParsed.skipped,
});

if (opts.out) {
  writeFileSync(opts.out, `${report}\n`, "utf8");
  console.log(`报告已写入 ${opts.out}`);
} else {
  console.log(report);
}
