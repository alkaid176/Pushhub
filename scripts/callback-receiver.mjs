#!/usr/bin/env node
/**
 * PushHub 回调接收器——验签参考实现（04-04，D-57/SC5）。
 *
 * 双重交付：
 *  - SC5 验收证据：生产测试页发通知 → 人工回复 → 本接收器打印验签 OK 续行；
 *  - 发送方可拷贝的参考实现：三步验签（缺头即拒 → 时间窗 → HMAC 重算 +
 *    两段式常时比较）+ message_id 幂等去重语义演示（去重责任在接收方，
 *    SC5——服务端 at-least-once 投递，重试会造成重复 POST）。
 *
 * 签名契约（04-02 approve-contract，KEY-06）：
 *   PushHub-Message-Id / PushHub-Timestamp（毫秒 epoch）/ PushHub-Signature
 *   sig = HMAC-SHA256(signingSecret, timestamp + "." + rawBody) hex
 *   容忍窗 300000ms（超窗拒收）
 *
 * 零依赖：Node 22 内置 node:http + node:crypto（脚本非服务端代码，Node
 * 专有 API 约束不适用于 scripts/——smoke.mjs 同款模式）。
 *
 * 用法：
 *   node scripts/callback-receiver.mjs --port 4933 --secret phsig_xxx
 *   node scripts/callback-receiver.mjs --secret phsig_xxx            # 默认端口 4933
 *   PH_SIGNING_SECRET=phsig_xxx node scripts/callback-receiver.mjs   # secret 走环境变量
 *   node scripts/callback-receiver.mjs --json-log callbacks.jsonl …  # 每请求一行 JSON 落盘
 *
 * 行为（五路径）：
 *   缺任一签名头        -> 400 { ok:false, reason: "missing headers" }
 *   timestamp 超窗      -> 400 { ok:false, reason: "timestamp outside tolerance" }
 *   伪造/篡改签名       -> 400 { ok:false, reason: "signature mismatch" }
 *   合法回调            -> 200 { ok:true, message_id, duplicate:false } + 打印验签耗时
 *   同 message_id 再来  -> 200 { ok:true, duplicate:true } + DUPLICATE 标记
 *                          （验签仍执行、ok 仍 true——幂等消化是接收方责任）
 *
 * 安全注：日志不打印 secret 本体（T-04-18）——只打印长度与前缀 + 短指纹
 * （HMAC 摘要前 8 位，供核对粘贴是否正确而不泄露值）。
 */
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";

const TOLERANCE_MS = 300_000;

// ---- CLI 参数（--port/--secret/--json-log；secret 亦可经 PH_SIGNING_SECRET）----
const args = process.argv.slice(2);
let port = 4933; // CLAUDE.md 端口规约：非标准端口
let secret = process.env.PH_SIGNING_SECRET ?? "";
let jsonLogPath = "";
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--port" && args[i + 1]) {
    port = Number(args[i + 1]);
    i++;
  } else if (args[i] === "--secret" && args[i + 1]) {
    secret = args[i + 1];
    i++;
  } else if (args[i] === "--json-log" && args[i + 1]) {
    jsonLogPath = args[i + 1];
    i++;
  } else if (args[i] === "--help" || args[i] === "-h") {
    console.log("usage: node scripts/callback-receiver.mjs [--port 4933] (--secret phsig_… | PH_SIGNING_SECRET env) [--json-log path.jsonl]");
    process.exit(0);
  }
}
if (!secret) {
  console.error("usage: node scripts/callback-receiver.mjs --port <port> --secret <phsig_…>  (secret 亦可经 PH_SIGNING_SECRET 环境变量)");
  process.exit(2);
}
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`invalid --port: ${port}`);
  process.exit(2);
}

/** secret 指纹（不泄露本体）：长度 + 前 6 字符 + HMAC 摘要前 8 hex。 */
const secretFingerprint =
  `${secret.slice(0, 6)}… len=${secret.length} ` +
  `fp=${createHmac("sha256", "pushhub-receiver-fingerprint").update(secret).digest("hex").slice(0, 8)}`;

/**
 * 三步验签（D-48/D-56 口径；headers 键一律小写——Node http 规范化行为）。
 * 返回判别联合：{ ok:false, reason } | { ok:true, wid }。
 */
function verify(rawBody, headers) {
  const ts = headers["pushhub-timestamp"];
  const sig = headers["pushhub-signature"];
  const wid = headers["pushhub-message-id"];
  if (!ts || !sig || !wid) {
    return { ok: false, reason: "missing headers" };
  }
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum) || Math.abs(Date.now() - tsNum) > TOLERANCE_MS) {
    return { ok: false, reason: "timestamp outside tolerance" };
  }
  const expected = createHmac("sha256", secret).update(`${ts}.${rawBody}`).digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(sig, "utf8");
  // 两段式常时比较：长度不等直接拒（不进 timingSafeEqual——其长度不等抛错）。
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "signature mismatch" };
  }
  return { ok: true, wid };
}

/** message_id 幂等记忆（首次见到的时间；SC5——去重责任在接收方）。 */
const seenMessageIds = new Map();

const server = createServer((req, res) => {
  if (req.method !== "POST") {
    res.writeHead(405, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, reason: "POST only" }));
    return;
  }
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const rawBody = Buffer.concat(chunks).toString("utf8");
    const t0 = process.hrtime.bigint();
    const result = verify(rawBody, req.headers);
    const verifyMs = Number(process.hrtime.bigint() - t0) / 1_000_000;

    let duplicate = false;
    if (result.ok) {
      if (seenMessageIds.has(result.wid)) {
        duplicate = true;
      } else {
        seenMessageIds.set(result.wid, Date.now());
      }
    }

    // 人类可读结构化日志（SC5 终端证据 + 三头/body 可直接拷贝进测试页验签器）。
    const loggedWid = result.ok ? result.wid : (req.headers["pushhub-message-id"] ?? "(none)");
    console.log(`REQ ${new Date().toISOString()} POST ${req.url} from ${req.socket.remoteAddress ?? "?"}`);
    console.log(`  PushHub-Message-Id: ${req.headers["pushhub-message-id"] ?? "(missing)"}`);
    console.log(`  PushHub-Timestamp: ${req.headers["pushhub-timestamp"] ?? "(missing)"}`);
    console.log(`  PushHub-Signature: ${req.headers["pushhub-signature"] ?? "(missing)"}`);
    console.log(`  Body: ${rawBody}`);
    if (result.ok) {
      console.log(`${duplicate ? "DUPLICATE" : "OK"} message_id=${result.wid} verify_ms=${verifyMs.toFixed(3)} duplicate=${duplicate}`);
    } else {
      console.log(`FAIL message_id=${loggedWid} reason=${result.reason} verify_ms=${verifyMs.toFixed(3)}`);
    }

    // 机器可读落盘（JSONL；E2E 断言与脚本化消费）。
    if (jsonLogPath !== "") {
      try {
        appendFileSync(
          jsonLogPath,
          JSON.stringify({
            ts: Date.now(),
            method: "POST",
            url: req.url,
            headers: {
              "pushhub-message-id": req.headers["pushhub-message-id"] ?? null,
              "pushhub-timestamp": req.headers["pushhub-timestamp"] ?? null,
              "pushhub-signature": req.headers["pushhub-signature"] ?? null,
            },
            rawBody,
            result,
            verifyMs,
            duplicate,
          }) + "\n",
        );
      } catch (err) {
        console.error(`JSON-LOG WRITE FAIL: ${String(err)}`);
      }
    }

    const status = result.ok ? 200 : 400;
    const responseBody = result.ok
      ? { ok: true, message_id: result.wid, duplicate }
      : { ok: false, reason: result.reason };
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(responseBody));
  });
});

server.listen(port, "0.0.0.0", () => {
  console.log(`PushHub callback-receiver listening on http://0.0.0.0:${port}`);
  console.log(`  tolerance=${TOLERANCE_MS}ms  secret=${secretFingerprint}`);
  console.log(`  json-log: ${jsonLogPath === "" ? "off" : jsonLogPath}`);
  console.log("  （粘贴三头 + Body 到 https://<server>/test.html ④验签器可交叉验证）");
});

// 优雅关闭（E2E afterAll / 终端 Ctrl+C）。
function shutdown() {
  server.close(() => process.exit(0));
  // close() 只等存量连接结束；兜底 1s 后强退。
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
