/**
 * 回调投递全链路集成测试（04-02 Task 3，RPL-03/RPL-04/KEY-06/D-43/D-49/D-50）。
 *
 * 覆盖（七组，per PLAN behavior）：
 *  1. 首答恰一次 POST：三头（PushHub-Message-Id / PushHub-Timestamp /
 *     PushHub-Signature）齐、timestamp 为毫秒数字符串、Node node:crypto
 *     createHmac 重算 HMAC-SHA256 hex 逐字符一致（跨实现交叉验证）、body 为
 *     D-49 五字段 JSON；
 *  2. body 字节冻结（Pitfall 4）：同一 callbacks 行多次投递 rawBody 逐字节
 *     一致、timestamp/签名逐次不同（重试新签，approve-contract）；
 *  3. 重试档位 1s/2m/10m/30m 推进 + CALLBACK_MAX_ATTEMPTS=5 封顶落 failed
 *     （final_failed_at + last_error）；
 *  4. meta 无 signing_secret → 回调行直接 failed、last_error 为
 *     "no signing secret"（Pitfall 8 防静默消失）、接收器零 POST；
 *  5. alarm 双职责并存（Pitfall 1 警戒线）：到期重试已分发 + 保留清理已执行
 *     + retention_due 推进 +24h；二次 alarm 后 getAlarm 为 min(下一重试,
 *     新 retention_due)——分钟级而非 +24h 常数；
 *  6. D-43 恰首答一次：二次 reply 被拒 → callbacks 表恰一行、恰一次 POST；
 *  7. （retention-alarm.test.ts 既有用例——本文件外，重构不得破坏。）
 *
 * 回调拦截技术（A2/A4 spike 结论后的既定路线，2026-08-28 实证）：
 *  - A2：@cloudflare/vitest-plugin@1.1.0 的 cloudflare:test 无 fetchMock 导出；
 *  - A4：workerd DO 外呼 fetch 到外部主机可达，但 loopback（localhost /
 *    127.0.0.1 / [::1]）全部 "Network connection lost"（沙箱阻断）——本地
 *    node:http 接收器路线在本环境不可行且跨机器不可靠；
 *  - 采用：runInDurableObject 在 DO isolate 内把 globalThis.fetch 替换为
 *    sentinel 路径记录器（CALLBACK_PATH_MARK 外的请求透传真 fetch——对同
 *    isolate 其他流量零影响）。记录器捕获的是 dispatchDueCallbacks 传给
 *    fetch() 的精确 URL/headers/body 字符串，验签交叉验证强度不降；mock
 *    返回真 Response 对象，resp.ok / body.cancel() 路径照常被行使。
 *
 * 隔离策略：--max-workers=1 --no-isolate 共享存储——频道名经
 * crypto.randomUUID() 派生唯一；记录器按 sentinel 路径过滤 + 每次安装重置。
 */
import { env, exports } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

const TEST_ADMIN_KEY = "test-admin-key-0123456789abcdef";

/** 回调 URL sentinel 路径段：记录器只拦截含此段的请求（其余透传真 fetch）。 */
const CALLBACK_PATH_MARK = "/__ph_callback_probe";

const DAY_MS = 24 * 60 * 60 * 1000;

function uniqueSuffix(): string {
  return crypto.randomUUID().slice(0, 8);
}

// ---------------------------------------------------------------------------
// 请求辅助（经真实 Worker 入口覆盖 index.ts 分发链）
// ---------------------------------------------------------------------------

function adminRequest(
  method: string,
  path: string,
  options?: { body?: string; key?: string | null },
): Promise<Response> {
  const headers: Record<string, string> = {};
  const key = options?.key === undefined ? TEST_ADMIN_KEY : options.key;
  if (key !== null) headers.Authorization = `Bearer ${key}`;
  if (options?.body !== undefined) headers["content-type"] = "application/json";
  return exports.default.fetch(
    new Request(`https://example.com${path}`, {
      method,
      headers,
      body: options?.body,
    }),
    env,
  );
}

function sendRequest(sendKey: string, body: unknown): Promise<Response> {
  return exports.default.fetch(
    new Request("https://example.com/api/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${sendKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
    env,
  );
}

function wsRequest(channelKey: string): Promise<Response> {
  return exports.default.fetch(
    new Request(`https://example.com/api/ws/${channelKey}`, {
      headers: { Upgrade: "websocket", Connection: "Upgrade" },
    }),
    env,
  );
}

interface CreatedChannel {
  channelId: string;
  channelKey: string;
  signingSecret?: string;
  sendKeys: { key: string }[];
}

async function createChannelViaApi(name: string): Promise<CreatedChannel> {
  const resp = await adminRequest("POST", "/api/admin/channels", {
    body: JSON.stringify({ name }),
  });
  expect(resp.status).toBe(201);
  return (await resp.json()) as CreatedChannel;
}

function stubFor(channelId: string): DurableObjectStub {
  return env.CHANNELS.get(env.CHANNELS.idFromName(channelId));
}

// ---------------------------------------------------------------------------
// WS 帧辅助（attach-before-trigger 铁律：监听先挂再触发）
// ---------------------------------------------------------------------------

function nextFrame<T = Record<string, unknown>>(socket: WebSocket, timeoutMs = 10_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout waiting for WS frame")), timeoutMs);
    socket.addEventListener(
      "message",
      (event) => {
        clearTimeout(timer);
        resolve(JSON.parse(event.data as string) as T);
      },
      { once: true },
    );
  });
}

/** 收集接下来 n 帧（多帧断言的计数收集器——单 socket 多监听器互踩教训）。 */
async function nextFrames<T = Record<string, unknown>>(socket: WebSocket, n: number, timeoutMs = 10_000): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const frames: T[] = [];
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${n} WS frames, got ${frames.length}`)), timeoutMs);
    socket.addEventListener("message", (event) => {
      frames.push(JSON.parse(event.data as string) as T);
      if (frames.length >= n) {
        clearTimeout(timer);
        resolve(frames);
      }
    });
  });
}

/** 经 Worker 入口连接并消费首拉 history 帧，返回就绪 socket。 */
async function connectAndConsumeHistory(channelKey: string): Promise<WebSocket> {
  const resp = await wsRequest(channelKey);
  expect(resp.status).toBe(101);
  const socket = resp.webSocket!;
  socket.accept();
  const initial = await nextFrame(socket);
  expect(initial.type).toBe("history");
  return socket;
}

// ---------------------------------------------------------------------------
// 回调记录器（DO isolate 内的 global fetch 替换，sentinel 路径外透传）
// ---------------------------------------------------------------------------

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  ts: number;
}

/** 安装/重置记录器（behavior 控制对 sentinel 请求的响应状态码）。 */
async function installCallbackRecorder(
  stub: DurableObjectStub,
  behavior?: { status: number },
): Promise<void> {
  const statusCode = behavior?.status ?? 200;
  const mark = CALLBACK_PATH_MARK;
  await runInDurableObject(stub, () => {
    const g = globalThis as unknown as {
      __phRealFetch?: typeof fetch;
      __phCallbackCalls?: RecordedCall[];
      __phCallbackStatus?: number;
      fetch: typeof fetch;
    };
    if (g.__phRealFetch === undefined) {
      g.__phRealFetch = g.fetch;
      g.__phCallbackCalls = [];
      g.__phCallbackStatus = 200;
      g.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        if (!url.includes(mark)) {
          return g.__phRealFetch!(input, init);
        }
        const headers: Record<string, string> = {};
        const source =
          init?.headers !== undefined
            ? new Headers(init.headers)
            : input instanceof Request
              ? input.headers
              : new Headers();
        source.forEach((v, k) => {
          headers[k] = v;
        });
        g.__phCallbackCalls!.push({
          url,
          method: init?.method ?? "GET",
          headers,
          body: typeof init?.body === "string" ? init.body : null,
          ts: Date.now(),
        });
        return new Response("{}", {
          status: g.__phCallbackStatus ?? 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch;
    }
    g.__phCallbackStatus = statusCode;
    g.__phCallbackCalls = [];
  });
}

async function readCallbackCalls(stub: DurableObjectStub): Promise<RecordedCall[]> {
  return runInDurableObject(
    stub,
    () =>
      (globalThis as unknown as { __phCallbackCalls?: RecordedCall[] })
        .__phCallbackCalls ?? [],
  );
}

/** 轮询直到记录器收到至少 n 次调用（reply 尾部 dispatch 是异步完成的）。 */
async function waitForCalls(stub: DurableObjectStub, n: number, timeoutMs = 5_000): Promise<RecordedCall[]> {
  const start = Date.now();
  for (;;) {
    const calls = await readCallbackCalls(stub);
    if (calls.length >= n) {
      return calls;
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timeout waiting for ${n} callback calls, got ${calls.length}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

// ---------------------------------------------------------------------------
// DO 存储种子/读取辅助
// ---------------------------------------------------------------------------

interface CallbackRow {
  wid: string;
  url: string;
  body: string;
  attempts: number;
  next_attempt_at: number;
  status: string;
  last_error: string | null;
  created_at: number;
  final_failed_at: number | null;
}

interface SeedOptions {
  wid: string;
  url?: string;
  body?: string;
  attempts: number;
  /** 种入即过期（next_attempt_at = now - 1000）。 */
  due?: boolean;
}

/** 种 callbacks 行（缺省 sentinel URL + D-49 形态 body）。 */
async function seedCallbackRow(stub: DurableObjectStub, opts: SeedOptions): Promise<void> {
  const url = opts.url ?? `http://callback.test${CALLBACK_PATH_MARK}`;
  const body =
    opts.body ??
    JSON.stringify({
      message_id: opts.wid,
      reply: "ok",
      replied_by: null,
      replied_at: 1750000000000,
      channel_id: "ch-seeded",
    });
  const attempts = opts.attempts;
  const due = opts.due ?? true;
  await runInDurableObject(
    stub,
    (_obj: unknown, state: DurableObjectState) => {
      state.storage.sql.exec(
        "INSERT OR REPLACE INTO callbacks (wid, url, body, attempts, next_attempt_at, status, created_at) " +
          "VALUES (?1, ?2, ?3, ?4, ?5, 'pending', ?6)",
        opts.wid,
        url,
        body,
        attempts,
        due ? Date.now() - 1000 : Date.now() + 60_000,
        Date.now(),
      );
    },
  );
}

/** 种 meta.signing_secret（直连 DO 的测试路径不经 Worker /ws 转发头）。 */
async function seedMetaSecret(stub: DurableObjectStub): Promise<string> {
  const secret = `phsig_${"s".repeat(32)}`;
  await runInDurableObject(
    stub,
    (_obj: unknown, state: DurableObjectState) => {
      state.storage.sql.exec(
        "INSERT INTO meta (k, v) VALUES ('signing_secret', ?1) ON CONFLICT(k) DO UPDATE SET v = ?1",
        secret,
      );
    },
  );
  return secret;
}

/** 确保已有已调度 alarm（种行测试不经 reply 入队路径，需显式播种）。 */
async function ensureAlarm(stub: DurableObjectStub): Promise<void> {
  await runInDurableObject(
    stub,
    (_obj: unknown, state: DurableObjectState) => state.storage.setAlarm(Date.now()),
  );
}

/** 把指定 wid 的重试行拨回到期（模拟档位等待结束）。 */
async function fastForwardDue(stub: DurableObjectStub, wid: string): Promise<void> {
  await runInDurableObject(
    stub,
    (_obj: unknown, state: DurableObjectState) => {
      state.storage.sql.exec(
        "UPDATE callbacks SET next_attempt_at = ?2 WHERE wid = ?1",
        wid,
        Date.now() - 1000,
      );
    },
  );
}

async function readCallbackRows(stub: DurableObjectStub): Promise<CallbackRow[]> {
  return runInDurableObject(
    stub,
    (_obj: unknown, state: DurableObjectState) =>
      state.storage.sql
        .exec(
          "SELECT wid, url, body, attempts, next_attempt_at, status, last_error, created_at, final_failed_at FROM callbacks",
        )
        .toArray() as unknown as CallbackRow[],
  );
}

async function readMetaValue(stub: DurableObjectStub, key: string): Promise<string | null> {
  const rows = await runInDurableObject(
    stub,
    (_obj: unknown, state: DurableObjectState) =>
      state.storage.sql.exec("SELECT v FROM meta WHERE k = ?1", key).toArray() as unknown as {
        v: string;
      }[],
  );
  return rows.length > 0 ? rows[0].v : null;
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

describe("回调投递（04-02 Task 3）", () => {
  it("首答恰一次 POST：三头齐、毫秒 timestamp、Node 重算 HMAC 逐字符一致、D-49 五字段", { timeout: 20_000 }, async () => {
    const channel = await createChannelViaApi(`cb-first-${uniqueSuffix()}`);
    const stub = stubFor(channel.channelId);
    await installCallbackRecorder(stub, { status: 200 });

    // 经 Worker 入口连接 WS：meta.signing_secret 落盘（Task 1 链路——secret
    // 先于任何回调就位的论证前提）。
    const socket = await connectAndConsumeHistory(channel.channelKey);

    const callbackUrl = `http://callback.test${CALLBACK_PATH_MARK}?v=first`;
    const sendResp = await sendRequest(channel.sendKeys[0].key, {
      text: "deploy finished",
      options: ["确认", "忽略"],
      callback_url: callbackUrl,
    });
    expect(sendResp.status).toBe(200);
    const { id: wid } = (await sendResp.json()) as { id: string };

    const messageFrame = await nextFrame<{ type: string; wid: string; options?: string[] }>(socket);
    expect(messageFrame.type).toBe("message");
    expect(messageFrame.wid).toBe(wid);

    socket.send(
      JSON.stringify({ v: 1, type: "reply", wid, selected_option: "确认", by: "alice" }),
    );
    const [ack, answered] = await nextFrames<{ type: string; code?: string }>(socket, 2);
    expect(ack.type).toBe("ack");
    expect(answered.type).toBe("answered");

    const calls = await waitForCalls(stub, 1);
    expect(calls.length).toBe(1);
    const call = calls[0];
    expect(call.url).toBe(callbackUrl);
    expect(call.method).toBe("POST");
    expect(call.headers["content-type"]).toBe("application/json");
    // 三头（D-48/approve-contract 定稿）。
    expect(call.headers["pushhub-message-id"]).toBe(wid);
    const ts = call.headers["pushhub-timestamp"];
    expect(typeof ts).toBe("string");
    expect(ts).toMatch(/^\d{13,}$/); // 毫秒数字符串（Q2 定稿毫秒口径）
    // D-49 五字段（恰五键）。
    const body = call.body!;
    const parsed = JSON.parse(body) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual([
      "channel_id",
      "message_id",
      "replied_at",
      "replied_by",
      "reply",
    ]);
    expect(parsed.message_id).toBe(wid);
    expect(parsed.reply).toBe("确认");
    expect(parsed.replied_by).toBe("alice");
    expect(typeof parsed.replied_at).toBe("number");
    expect(parsed.channel_id).toBe(channel.channelId);
    // Node 交叉验签（KEY-06）：HMAC-SHA256(secret, ts + "." + rawBody) hex。
    const expected = createHmac("sha256", channel.signingSecret!)
      .update(`${ts}.${body}`)
      .digest("hex");
    expect(call.headers["pushhub-signature"]).toBe(expected);

    socket.close(1000, "done");
  });

  it("body 字节冻结（Pitfall 4）：同一行多次投递 rawBody 逐字节一致、timestamp/签名逐次新", { timeout: 20_000 }, async () => {
    const channel = await createChannelViaApi(`cb-freeze-${uniqueSuffix()}`);
    const stub = stubFor(channel.channelId);
    const secret = await seedMetaSecret(stub);
    await installCallbackRecorder(stub, { status: 500 });

    const body = JSON.stringify({
      message_id: "m_freeze",
      reply: "重试字节冻结",
      replied_by: "bob",
      replied_at: 1750000000000,
      channel_id: "ch-freeze",
    });
    await seedCallbackRow(stub, { wid: "m_freeze", body, attempts: 0 });
    await ensureAlarm(stub);

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await waitForCalls(stub, 1);

    // 隔开毫秒位（两次投递 timestamp 必不同——不同毫秒）。
    await new Promise((r) => setTimeout(r, 20));
    await fastForwardDue(stub, "m_freeze");
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const calls = await waitForCalls(stub, 2);

    expect(calls[0].body).toBe(body);
    expect(calls[1].body).toBe(body); // 入队预序列化，重试字节逐次不变
    expect(calls[0].headers["pushhub-timestamp"]).not.toBe(
      calls[1].headers["pushhub-timestamp"],
    );
    expect(calls[0].headers["pushhub-signature"]).not.toBe(
      calls[1].headers["pushhub-signature"],
    );
    // 两次投递的签名都与 Node 重算一致（重试新签不破坏验签，Pitfall 4 反面）。
    for (const call of calls) {
      const expected = createHmac("sha256", secret)
        .update(`${call.headers["pushhub-timestamp"]}.${call.body}`)
        .digest("hex");
      expect(call.headers["pushhub-signature"]).toBe(expected);
    }
  });

  it("重试档位 1s/2m/10m/30m 推进；attempts 达 5 封顶落 failed（final_failed_at + last_error）", { timeout: 20_000 }, async () => {
    const channel = await createChannelViaApi(`cb-tier-${uniqueSuffix()}`);
    const stub = stubFor(channel.channelId);
    await seedMetaSecret(stub);
    await installCallbackRecorder(stub, { status: 500 });

    const DELAYS = [1_000, 120_000, 600_000, 1_800_000];
    for (let n = 0; n < 4; n++) {
      await seedCallbackRow(stub, { wid: `m_tier_${n}`, attempts: n });
    }
    // attempts=4 → 本次为第 5 次 → 失败即封顶。
    await seedCallbackRow(stub, { wid: "m_cap", attempts: 4 });
    await ensureAlarm(stub);

    const before = Date.now();
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const rows = await readCallbackRows(stub);
    for (let n = 0; n < 4; n++) {
      const row = rows.find((r) => r.wid === `m_tier_${n}`)!;
      expect(row.attempts, `m_tier_${n} attempts`).toBe(n + 1);
      expect(row.status, `m_tier_${n} status`).toBe("pending");
      expect(row.next_attempt_at - before, `m_tier_${n} next`).toBeGreaterThanOrEqual(DELAYS[n]);
      expect(row.next_attempt_at - before, `m_tier_${n} next upper`).toBeLessThanOrEqual(
        DELAYS[n] + 10_000,
      );
    }
    const cap = rows.find((r) => r.wid === "m_cap")!;
    expect(cap.attempts).toBe(5);
    expect(cap.status).toBe("failed");
    expect(cap.final_failed_at).not.toBeNull();
    expect(cap.last_error).toContain("500");

    await waitForCalls(stub, 5); // 4 档位行 + 1 封顶行 = 恰 5 次 POST
  });

  it("meta 无 signing_secret：回调行直接 failed、last_error 为 no signing secret、零 POST（Pitfall 8）", { timeout: 20_000 }, async () => {
    const channel = await createChannelViaApi(`cb-nosecret-${uniqueSuffix()}`);
    const stub = stubFor(channel.channelId);
    await installCallbackRecorder(stub, { status: 200 });

    // 直连 DO 建立 WS（不经 Worker 转发头 → meta 无 signing_secret——模拟
    // 0.1.12 前遗留频道未补发状态）。
    const wsResp = await stub.fetch("https://do.pushhub.internal/ws", {
      headers: { Upgrade: "websocket", "X-PH-Verified": "1" },
    });
    expect(wsResp.status).toBe(101);
    const socket = wsResp.webSocket!;
    socket.accept();
    await nextFrame(socket); // history 首拉

    const pubResp = await stub.fetch("https://do.pushhub.internal/publish", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-PH-Verified": "1",
        "X-PH-Send-Key": `cb-nosecret-${uniqueSuffix()}`,
      },
      body: JSON.stringify({
        text: "no secret channel",
        callback_url: `http://callback.test${CALLBACK_PATH_MARK}?v=nosecret`,
      }),
    });
    expect(pubResp.status).toBe(200);
    const { id: wid } = (await pubResp.json()) as { id: string };

    const messageFrame = await nextFrame<{ type: string; wid: string }>(socket);
    expect(messageFrame.wid).toBe(wid);
    socket.send(JSON.stringify({ v: 1, type: "reply", wid, text: "人类回复" }));
    const [ack, answered] = await nextFrames<{ type: string }>(socket, 2);
    expect(ack.type).toBe("ack");
    expect(answered.type).toBe("answered");

    const rows = await readCallbackRows(stub);
    const row = rows.find((r) => r.wid === wid)!;
    expect(row.status).toBe("failed");
    expect(row.last_error).toBe("no signing secret");
    expect(row.final_failed_at).not.toBeNull();

    // 可见不静默：零外呼（无 secret 不签名不投递）。
    await new Promise((r) => setTimeout(r, 300));
    expect((await readCallbackCalls(stub)).length).toBe(0);
    socket.close(1000, "done");
  });

  it("alarm 双职责并存（Pitfall 1）：到期重试已分发 + 保留清理已执行 + retention_due 推进；二次 alarm 后 getAlarm 为 min 量级非 +24h 常数", { timeout: 30_000 }, async () => {
    const channel = await createChannelViaApi(`cb-coexist-${uniqueSuffix()}`);
    const stub = stubFor(channel.channelId);
    await seedMetaSecret(stub);
    await installCallbackRecorder(stub, { status: 500 });

    // 种 501 条消息（seq 1..501——保留清理可观察：清后 MIN(seq)=2）+ 过期限流桶
    // + 过期 retention_due + 过期重试行。
    await runInDurableObject(
      stub,
      (_obj: unknown, state: DurableObjectState) => {
        const sql = state.storage.sql;
        for (let i = 1; i <= 501; i++) {
          sql.exec(
            "INSERT INTO messages (seq, wid, text, priority, answered, created_at) VALUES (?1, ?2, 'coexist', 'normal', 0, ?3)",
            i,
            `m_co_${i}`,
            Date.now(),
          );
        }
        sql.exec(
          "INSERT OR REPLACE INTO rate_sends (send_key, window_start, count) VALUES ('coexist-expired', ?1, 3)",
          Date.now() - DAY_MS - 3_600_000,
        );
        sql.exec(
          "INSERT INTO meta (k, v) VALUES ('retention_due', ?1) ON CONFLICT(k) DO UPDATE SET v = ?1",
          String(Date.now() - 1000),
        );
      },
    );
    await seedCallbackRow(stub, { wid: "m_coexist", attempts: 0 });
    await ensureAlarm(stub);

    expect(await runDurableObjectAlarm(stub)).toBe(true);

    // 重试已分发（失败 500 → attempts=1）。
    await waitForCalls(stub, 1);
    const rowsAfter = await readCallbackRows(stub);
    const retryRow = rowsAfter.find((r) => r.wid === "m_coexist")!;
    expect(retryRow.attempts).toBe(1);

    // 保留清理已执行（不被重试 alarm 吞噬）：MIN(seq)=2 + 过期桶已删。
    const minRow = await runInDurableObject(
      stub,
      (_obj: unknown, state: DurableObjectState) =>
        state.storage.sql.exec("SELECT MIN(seq) AS m FROM messages").one() as unknown as {
          m: number | null;
        },
    );
    expect(minRow.m).toBe(2);
    const bucket = await runInDurableObject(
      stub,
      (_obj: unknown, state: DurableObjectState) =>
        state.storage.sql
          .exec("SELECT send_key FROM rate_sends WHERE send_key = 'coexist-expired'")
          .toArray() as unknown as unknown[],
    );
    expect(bucket.length).toBe(0);

    // retention_due 已推进 +24h（不被重试顺延吞噬）。
    const due = await readMetaValue(stub, "retention_due");
    expect(due).not.toBeNull();
    expect(Number(due)).toBeGreaterThan(Date.now());
    expect(Number(due)).toBeLessThanOrEqual(Date.now() + DAY_MS + 60_000);

    // 二次 alarm：dispatch 跳过（next=+1s 未到）、retention 不再执行；尾部
    // scheduleNextAlarm → getAlarm = min(+1s 重试, +24h retention) ≈ 秒级——
    // Pitfall 1 警戒线：不得仍是 +24h 常数。
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const alarm = await runInDurableObject(
      stub,
      (_obj: unknown, state: DurableObjectState) => state.storage.getAlarm(),
    );
    expect(alarm).not.toBeNull();
    expect(alarm!).toBeGreaterThan(Date.now());
    expect(alarm!).toBeLessThan(Date.now() + 60_000);
  });

  it("D-43 恰首答一次：二次 reply 被拒 → callbacks 表恰一行、接收器恰一次 POST", { timeout: 20_000 }, async () => {
    const channel = await createChannelViaApi(`cb-once-${uniqueSuffix()}`);
    const stub = stubFor(channel.channelId);
    await installCallbackRecorder(stub, { status: 200 });

    const socketA = await connectAndConsumeHistory(channel.channelKey);
    const socketB = await connectAndConsumeHistory(channel.channelKey);

    const sendResp = await sendRequest(channel.sendKeys[0].key, {
      text: "only first reply counts",
      options: ["OK"],
      callback_url: `http://callback.test${CALLBACK_PATH_MARK}?v=once`,
    });
    expect(sendResp.status).toBe(200);
    const { id: wid } = (await sendResp.json()) as { id: string };

    // A 先答（A 收 ack+answered；B 收 answered）。
    await nextFrame<{ type: string; wid: string }>(socketA); // message
    await nextFrame<{ type: string; wid: string }>(socketB); // message
    socketA.send(JSON.stringify({ v: 1, type: "reply", wid, selected_option: "OK", by: "a" }));
    const [ack, answered] = await nextFrames<{ type: string }>(socketA, 2);
    expect(ack.type).toBe("ack");
    expect(answered.type).toBe("answered");
    await nextFrame<{ type: string }>(socketB); // answered 扇出

    // B 二次答 → already_replied 错误帧（不断连）。
    socketB.send(JSON.stringify({ v: 1, type: "reply", wid, selected_option: "OK", by: "b" }));
    const errFrame = await nextFrame<{ type: string; code?: string }>(socketB);
    expect(errFrame.type).toBe("error");
    expect(errFrame.code).toBe("already_replied");

    // 恰一次投递 + 表恰一行（且 delivered）。
    const calls = await waitForCalls(stub, 1);
    expect(calls.length).toBe(1);
    await new Promise((r) => setTimeout(r, 300));
    expect((await readCallbackCalls(stub)).length).toBe(1);
    const rows = await readCallbackRows(stub);
    expect(rows.filter((r) => r.wid === wid).length).toBe(1);
    expect(rows[0].status).toBe("delivered");

    socketA.close(1000, "done");
    socketB.close(1000, "done");
  });
});
