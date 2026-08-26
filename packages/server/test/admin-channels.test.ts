/**
 * KEY-01/D-12/D-13 集成测试：Admin API 建频道/列表 + 三级密钥闭环与隔离。
 *
 * 覆盖（must_haves 全量）：
 *  - D-13 鉴权：错误 Admin Key / 缺头 -> 401 invalid_key（与业务密钥同码）；
 *    ADMIN_KEY 未配置 -> 500 server_error（Flagged Assumption，最小信息量）；
 *    长度不等的 Key（前缀正确但截断/超长）同样 401——两段式比较的长度前置分支。
 *  - D-12 创建：POST /api/admin/channels -> 201 三件套
 *    （channelId 16 字符、channelKey phc_+32、sendKey phs_+32、name/createdAt 回显）；
 *    name 缺失 / 超 64 字符 -> 400 invalid_body；非 JSON -> 400 invalid_json。
 *  - 三级闭环：创建返回的 Send Key 立即经 /api/send 得 200、Channel Key 立即
 *    连 WS 收首拉 history 帧（经真实 Worker 入口，KV 三前缀写读闭环）。
 *  - 列表：GET /api/admin/channels 含刚建频道且元数据完整；游标分页
 *    （pageSize=1 时跨多页拉全——listChannels 循环不漏）。
 *  - 权限隔离（KEY-01 双向 + Admin 不通用）：Channel Key 发送 -> 401、
 *    Send Key 连 WS -> 401、Admin Key 发送 -> 401、Admin Key 连 WS -> 401。
 *
 * 同 isolate 帧监听铁律（01-04）：客户端侧 accept() 后服务端首拉帧仍在
 * 发送缓冲——await nextMessage 模式即可（send-payload-fields 同式）。
 */
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { handleAdminApi } from "../src/admin";
import { listChannels } from "../src/keys";

/** 必须与 vitest.config.ts miniflare.bindings 注入值一致（测试专用，非生产 secret）。 */
const TEST_ADMIN_KEY = "test-admin-key-0123456789abcdef";

function uniqueSuffix(): string {
  return crypto.randomUUID().slice(0, 8);
}

/** 经真实 Worker 入口发 Admin API 请求（覆盖 index.ts 路由 + admin.ts 处理器）。 */
function adminRequest(
  method: string,
  body?: string,
  key: string | null = TEST_ADMIN_KEY,
  path = "/api/admin/channels",
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (key !== null) headers.Authorization = `Bearer ${key}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  return exports.default.fetch(
    new Request(`https://example.com${path}`, { method, headers, body }),
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
  // Upgrade 头必备：DO /ws 依据其判定 WS 升级（缺失走 404 分支——
  // 经 Worker 入口的真升级请求与浏览器同形）。
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
  sendKey: string;
  name: string;
  createdAt: number;
}

async function createChannelViaApi(name: string): Promise<CreatedChannel> {
  const resp = await adminRequest("POST", JSON.stringify({ name }));
  expect(resp.status).toBe(201);
  return (await resp.json()) as CreatedChannel;
}

describe("Admin API 鉴权（D-13）", () => {
  it("错误 Admin Key / 缺头 / 长度不匹配 -> 401 invalid_key（与业务密钥同码）", async () => {
    await expectErrorEnvelope(await adminRequest("GET", undefined, "wrong-key-entirely"), 401, "invalid_key");
    await expectErrorEnvelope(await adminRequest("GET", undefined, null), 401, "invalid_key");
    // 前缀正确但长度不同：两段式比较的长度前置分支（不进 timingSafeEqual）。
    await expectErrorEnvelope(await adminRequest("GET", undefined, TEST_ADMIN_KEY.slice(0, 10)), 401, "invalid_key");
    await expectErrorEnvelope(await adminRequest("GET", undefined, TEST_ADMIN_KEY + "xx"), 401, "invalid_key");
    // 非 Bearer 方案同样拒绝。
    await expectErrorEnvelope(
      await exports.default.fetch(
        new Request("https://example.com/api/admin/channels", {
          headers: { Authorization: `Basic ${TEST_ADMIN_KEY}` },
        }),
        env,
      ),
      401,
      "invalid_key",
    );
  });

  it("ADMIN_KEY 未配置 -> 500 server_error（Flagged Assumption：不泄漏配置细节）", async () => {
    const envWithoutAdmin = { KV: env.KV, CHANNELS: env.CHANNELS, ASSETS: env.ASSETS } as Env;
    const resp = await handleAdminApi(
      new Request("https://example.com/api/admin/channels", {
        headers: { Authorization: `Bearer ${TEST_ADMIN_KEY}` },
      }),
      envWithoutAdmin,
    );
    await expectErrorEnvelope(resp, 500, "server_error");
  });
});

describe("POST /api/admin/channels 建频道（D-12）", () => {
  it("201 三件套：phc_/phs_ 前缀 + 恰 32 字符、channelId 16 字符、name/createdAt 回显", async () => {
    const channel = await createChannelViaApi("build-alerts");
    expect(channel.channelKey).toMatch(/^phc_[0-9A-Za-z]{32}$/);
    expect(channel.channelKey.length).toBe(4 + 32);
    expect(channel.sendKey).toMatch(/^phs_[0-9A-Za-z]{32}$/);
    expect(channel.sendKey.length).toBe(4 + 32);
    expect(channel.channelId).toMatch(/^[0-9A-Za-z]{16}$/);
    expect(channel.name).toBe("build-alerts");
    expect(Number.isInteger(channel.createdAt)).toBe(true);
  });

  it("name 缺失 / 非字符串 / 超 64 字符 -> 400 invalid_body；非 JSON -> 400 invalid_json", async () => {
    await expectErrorEnvelope(await adminRequest("POST", JSON.stringify({})), 400, "invalid_body");
    await expectErrorEnvelope(await adminRequest("POST", JSON.stringify({ name: 42 })), 400, "invalid_body");
    await expectErrorEnvelope(
      await adminRequest("POST", JSON.stringify({ name: "x".repeat(65) })),
      400,
      "invalid_body",
    );
    await expectErrorEnvelope(await adminRequest("POST", "not-json{{{"), 400, "invalid_json");
  });
});

describe("三级密钥闭环（KEY-01 端到端）", () => {
  it("创建的 Send Key 立即可发、Channel Key 立即可连：发送 200 + WS 首拉 history 帧", async () => {
    const channel = await createChannelViaApi(`chain-${uniqueSuffix()}`);

    // Send Key -> /api/send 200（sk: 前缀写读闭环）。
    const sendResp = await sendRequest(channel.sendKey, { text: "created via admin api" });
    expect(sendResp.status).toBe(200);
    const sendBody = (await sendResp.json()) as { id: string; seq: number };
    expect(sendBody.seq).toBeGreaterThanOrEqual(1);

    // Channel Key -> WS 升级 + 首拉 history 帧含刚发的消息（ch: 前缀闭环 + D-09）。
    const wsResp = await wsRequest(channel.channelKey);
    expect(wsResp.status).toBe(101);
    const socket = wsResp.webSocket;
    expect(socket).not.toBeNull();
    socket!.accept();
    const initial = await nextMessage(socket!);
    expect(initial.type).toBe("history");
    const messages = initial.messages as Array<{ seq: number; text: string }>;
    expect(messages.some((m) => m.seq === sendBody.seq && m.text === "created via admin api")).toBe(true);
    socket!.close(1000, "done");
  });
});

describe("GET /api/admin/channels 列表（D-12）", () => {
  it("含刚建频道且元数据完整（id: 反向索引）", async () => {
    const channel = await createChannelViaApi(`list-check-${uniqueSuffix()}`);
    const resp = await adminRequest("GET");
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { channels: CreatedChannel[] };
    const found = body.channels.find((c) => c.channelId === channel.channelId);
    expect(found).toBeDefined();
    expect(found).toEqual(channel);
  });

  it("游标分页：pageSize=1 时跨多页拉全不漏", async () => {
    const created: CreatedChannel[] = [];
    for (let i = 0; i < 3; i++) {
      created.push(await createChannelViaApi(`page-${uniqueSuffix()}-${i}`));
    }
    const records = await listChannels(env, { pageSize: 1 });
    const ids = records.map((r) => r.channelId);
    for (const c of created) {
      expect(ids).toContain(c.channelId);
    }
    expect(records.length).toBeGreaterThanOrEqual(3);
  });
});

describe("三级密钥权限隔离（KEY-01 双向断言）", () => {
  it("Channel Key 不能发、Send Key 不能连、Admin Key 既不能发也不能连", async () => {
    const channel = await createChannelViaApi(`isolation-${uniqueSuffix()}`);

    // Channel Key 当 Send Key 用 -> 401（ch: 命中的键不在 sk: 键空间）。
    await expectErrorEnvelope(
      await sendRequest(channel.channelKey, { text: "should be rejected" }),
      401,
      "invalid_key",
    );
    // Send Key 当 Channel Key 用 -> 401（无 WS 升级）。
    const wsDenied = await wsRequest(channel.sendKey);
    expect(wsDenied.status).toBe(401);
    expect(wsDenied.webSocket).toBeNull();
    await expectErrorEnvelope(wsDenied, 401, "invalid_key");
    // Admin Key 不在业务键空间：发送与 WS 连接均拒。
    await expectErrorEnvelope(
      await sendRequest(TEST_ADMIN_KEY, { text: "admin cannot send" }),
      401,
      "invalid_key",
    );
    const adminWs = await wsRequest(TEST_ADMIN_KEY);
    expect(adminWs.webSocket).toBeNull();
    await expectErrorEnvelope(adminWs, 401, "invalid_key");
  });
});
