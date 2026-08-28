/**
 * KEY-04/D-33 集成测试：重置 Channel Key（踢连 + 历史保留 + 分级隔离）。
 *
 * 覆盖（must_haves 前 5 条全量）：
 *  - 201 {channelKey}：新 phc_+32 恰 36 字符、与旧值不同；name/sendKeys/
 *    createdAt 原样保留（id: 反向索引经列表对照）；
 *  - 踢连：重置前已建立的 WS 连接（accept + 首拉已收）收到 close 事件，
 *    code 1008、reason "channel key reset"（attach-before-trigger 铁律：
 *    close 监听在触发重置之前预挂——01-04 同 isolate 帧监听先例）；
 *  - 旧 Key 失效：重置后旧 channelKey 走 wsRequest -> 401 invalid_key
 *    （本地 miniflare KV 无缓存层，强一致确定性成立；生产为 ≤60s 边缘
 *    缓存双活窗口——keys.ts 文档化行为，非测试覆盖目标）；
 *  - 历史保留：重置前发的 2 条消息在重置后（新 Key 连接）首拉 history 帧
 *    全量可见（messages 表不动——DO 内数据与 Channel Key 无关）；
 *  - 分级隔离（KEY-04）：重置后原 Send Key 仍可 POST /api/send 200
 *    （重置只动 Channel Key，Send Key 互不影响）；
 *  - 边界：不存在 channelId -> 404 not_found；无鉴权 -> 401（checkAdminAuth
 *    先于路由判定）。
 *
 * 隔离策略：--max-workers=1 --no-isolate 共享存储——频道名经
 * crypto.randomUUID() 派生唯一（admin-channels 同款）。
 */
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

/** 必须与 vitest.config.ts miniflare.bindings 注入值一致（测试专用，非生产 secret）。 */
const TEST_ADMIN_KEY = "test-admin-key-0123456789abcdef";

function uniqueSuffix(): string {
  return crypto.randomUUID().slice(0, 8);
}

/** 经真实 Worker 入口发 Admin API 请求（覆盖 index.ts 前缀分发 + admin.ts 路由）。 */
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
  // Upgrade 头必备：DO /ws 依据其判定 WS 升级（经 Worker 入口的真升级请求与浏览器同形）。
  return exports.default.fetch(
    new Request(`https://example.com/api/ws/${channelKey}`, {
      headers: { Upgrade: "websocket", Connection: "Upgrade" },
    }),
    env,
  );
}

function nextMessage(socket: WebSocket, timeoutMs = 10_000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout waiting for WS frame")), timeoutMs);
    socket.addEventListener(
      "message",
      (event) => {
        clearTimeout(timer);
        resolve(JSON.parse(event.data as string) as Record<string, unknown>);
      },
      { once: true },
    );
  });
}

/**
 * 预挂 close 监听并返回 Promise（attach-before-trigger 铁律：必须在触发
 * 重置之前调用本函数挂上监听，再等待返回的 Promise）。
 */
function nextClose(socket: WebSocket, timeoutMs = 10_000): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout waiting for WS close")), timeoutMs);
    socket.addEventListener(
      "close",
      (event) => {
        clearTimeout(timer);
        resolve({ code: event.code, reason: event.reason });
      },
      { once: true },
    );
  });
}

async function expectErrorEnvelope(
  resp: Response,
  status: number,
  code: string,
): Promise<void> {
  expect(resp.status).toBe(status);
  const body = (await resp.json()) as { error: { code: string } };
  expect(body.error.code).toBe(code);
}

interface CreatedChannel {
  channelId: string;
  channelKey: string;
  sendKeys: { key: string; label: string | null; createdAt: number }[];
  name: string;
  createdAt: number;
}

async function createChannelViaApi(name: string): Promise<CreatedChannel> {
  const resp = await adminRequest("POST", "/api/admin/channels", {
    body: JSON.stringify({ name }),
  });
  expect(resp.status).toBe(201);
  return (await resp.json()) as CreatedChannel;
}

/** GET 列表中找该频道（id: 反向索引数据源——保留性断言的对照面）。 */
async function findChannelInList(channelId: string): Promise<CreatedChannel> {
  const resp = await adminRequest("GET", "/api/admin/channels");
  expect(resp.status).toBe(200);
  const body = (await resp.json()) as { channels: CreatedChannel[] };
  const found = body.channels.find((c) => c.channelId === channelId);
  expect(found).toBeDefined();
  return found!;
}

describe("POST reset-channel-key（D-33 / KEY-04）", () => {
  it("201 {channelKey}：新 phc_ 恰 36 字符且与旧值不同；name/sendKeys/createdAt 原样保留", async () => {
    const channel = await createChannelViaApi(`rk-reset-${uniqueSuffix()}`);
    // 追加第二个带标签 Key，保留性断言覆盖多元素 sendKeys 数组。
    const extra = await adminRequest(
      "POST",
      `/api/admin/channels/${channel.channelId}/send-keys`,
      { body: JSON.stringify({ label: "keep-me" }) },
    );
    expect(extra.status).toBe(201);
    // 基线在追加第二个 Key 之后建立（保留性断言的对照面含全部 2 个 Key）。
    const baseline = await findChannelInList(channel.channelId);
    expect(baseline.sendKeys).toHaveLength(2);

    const resp = await adminRequest(
      "POST",
      `/api/admin/channels/${channel.channelId}/reset-channel-key`,
    );
    expect(resp.status).toBe(201);
    const body = (await resp.json()) as { channelKey: string };
    expect(body.channelKey).toMatch(/^phc_[0-9A-Za-z]{32}$/);
    expect(body.channelKey.length).toBe(4 + 32);
    expect(body.channelKey).not.toBe(channel.channelKey);

    // id: 反向索引对照：新 channelKey 已生效，name/sendKeys/createdAt 原样保留。
    const listed = await findChannelInList(channel.channelId);
    expect(listed.channelKey).toBe(body.channelKey);
    expect(listed.name).toBe(baseline.name);
    expect(listed.createdAt).toBe(baseline.createdAt);
    expect(listed.sendKeys).toEqual(baseline.sendKeys);
  });

  it("踢连 close 1008 + 旧 Key 401 + 历史保留 + Send Key 存活（SC2/KEY-04 服务端侧）", async () => {
    const channel = await createChannelViaApi(`rk-kick-${uniqueSuffix()}`);
    const sendKey = channel.sendKeys[0].key;

    // 重置前发 2 条消息（历史保留的对照数据）。
    expect((await sendRequest(sendKey, { text: "before-reset-1" })).status).toBe(200);
    expect((await sendRequest(sendKey, { text: "before-reset-2" })).status).toBe(200);

    // 旧 Key 建立 WS 连接（accept + 首拉已收）。
    const wsResp = await wsRequest(channel.channelKey);
    expect(wsResp.status).toBe(101);
    const socket = wsResp.webSocket!;
    expect(socket).not.toBeNull();
    socket.accept();
    const initial = await nextMessage(socket);
    expect(initial.type).toBe("history");

    // attach-before-trigger：close 监听先挂，再触发重置。
    const closePromise = nextClose(socket);

    const resetResp = await adminRequest(
      "POST",
      `/api/admin/channels/${channel.channelId}/reset-channel-key`,
    );
    expect(resetResp.status).toBe(201);
    const { channelKey: newKey } = (await resetResp.json()) as { channelKey: string };
    expect(newKey).not.toBe(channel.channelKey);

    // 被踢：close 事件 code 1008（policy violation，planner 裁定值）+ reason。
    const closeInfo = await closePromise;
    expect(closeInfo.code).toBe(1008);
    expect(closeInfo.reason).toBe("channel key reset");

    // 旧 Key 新建连接被拒 401（本地 miniflare 强一致；生产 ≤60s 窗口为文档化语义）。
    const denied = await wsRequest(channel.channelKey);
    expect(denied.status).toBe(401);
    expect(denied.webSocket).toBeNull();
    await expectErrorEnvelope(denied, 401, "invalid_key");

    // 历史保留（KEY-04/SC2）：新 Key 连接首拉 history 帧含重置前 2 条消息。
    const wsResp2 = await wsRequest(newKey);
    expect(wsResp2.status).toBe(101);
    const socket2 = wsResp2.webSocket!;
    socket2.accept();
    const history = await nextMessage(socket2);
    expect(history.type).toBe("history");
    const texts = (history.messages as { text: string }[]).map((m) => m.text);
    expect(texts).toContain("before-reset-1");
    expect(texts).toContain("before-reset-2");
    socket2.close(1000, "done");

    // 分级隔离（KEY-04）：重置只动 Channel Key，原 Send Key 照常可发。
    const sendAfter = await sendRequest(sendKey, { text: "after-reset-send" });
    expect(sendAfter.status).toBe(200);
  });

  it("不存在 channelId -> 404 not_found；无鉴权 -> 401 invalid_key", async () => {
    const channel = await createChannelViaApi(`rk-edge-${uniqueSuffix()}`);
    // 不存在的 channelId（格式合法 16 字符但 id: miss）。
    await expectErrorEnvelope(
      await adminRequest("POST", `/api/admin/channels/${"q".repeat(16)}/reset-channel-key`),
      404,
      "not_found",
    );
    // 无 Authorization：鉴权先于路由判定（不暴露路径存在性）。
    await expectErrorEnvelope(
      await adminRequest(
        "POST",
        `/api/admin/channels/${channel.channelId}/reset-channel-key`,
        { key: null },
      ),
      401,
      "invalid_key",
    );
  });

  it("WR-02 代际接线（W-1 回归）：kick-all 携带新 Key 落盘代际——DO 直连伪造旧 Key 转发被 401 拒绝", async () => {
    const channel = await createChannelViaApi(`rk-gen-${uniqueSuffix()}`);
    const oldKey = channel.channelKey;

    // 重置（admin.ts kick-all 转发必须携带 X-PH-Channel-Key——代际落盘）。
    const resetResp = await adminRequest(
      "POST",
      `/api/admin/channels/${channel.channelId}/reset-channel-key`,
    );
    expect(resetResp.status).toBe(201);
    const { channelKey: newKey } = (await resetResp.json()) as { channelKey: string };

    // 模拟「KV 缓存窗口内旧 Key 解析成功」的 Worker 转发：绕过 Worker 层
    // ch: 预检，直接以旧 Key 值打 DO /ws（X-PH-Verified 可信头 + 旧代际）。
    // 代际比对不匹配必须 401——这是 WR-02 修复的全链路（miniflare 无缓存
    // 层，本地旧 Key 走 Worker 入口会先在 ch: 解析就 401，测不到 DO 侧，
    // 故必须 DO 直连）。
    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(channel.channelId));
    const staleForward = await stub.fetch("https://do.pushhub.internal/ws", {
      headers: {
        Upgrade: "websocket",
        Connection: "Upgrade",
        "X-PH-Verified": "1",
        "X-PH-Channel-Key": oldKey,
      },
    });
    expect(staleForward.status).toBe(401);
    expect(staleForward.webSocket).toBeNull();

    // 反例：新代际值放行 101（代际行确实被 kick-all 写入了新值——若
    // admin.ts 未接线，两请求都会 401 或都 101，测试即失真）。
    const freshForward = await stub.fetch("https://do.pushhub.internal/ws", {
      headers: {
        Upgrade: "websocket",
        Connection: "Upgrade",
        "X-PH-Verified": "1",
        "X-PH-Channel-Key": newKey,
      },
    });
    expect(freshForward.status).toBe(101);
    freshForward.webSocket!.accept();
    freshForward.webSocket!.close(1000, "done");
  });
});
