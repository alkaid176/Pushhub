/**
 * E2E 扇出集成测试（SRV-01/03/04，官方 fixture 模式——Code Example 3）。
 *
 * 接入路径（Task 1 裁决 approve-plugin）：
 *   import { env, exports } from "cloudflare:workers"  —— @cloudflare/vitest-plugin 路径；
 *   exports.default.fetch() 直调 Worker 入口处理器。
 * 退路（若曾裁决 use-fallback）：@cloudflare/vitest-pool-workers 以 SELF 等价方式
 *   fetch 入口（import { SELF, env } from "cloudflare:test"; await SELF.fetch(...)），
 *   其余断言不变。
 *
 * 隔离策略：套件整体 --max-workers=1 --no-isolate 共享存储（WS+DO 不支持按文件隔离，
 * Pitfall 1）——本文件以 crypto.randomUUID() 派生唯一频道名/key 做隔离。
 */
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { KEY_PREFIX_CH, KEY_PREFIX_SEND } from "../src/keys";

function getResponseWebSocket(response: Response): WebSocket {
  const socket = response.webSocket;
  if (socket === null || socket === undefined) {
    throw new TypeError("Expected WebSocket response");
  }
  return socket;
}

/** 等待下一条 WS message 帧（带超时，避免挂死测试进程）。 */
function nextFrame(socket: WebSocket, timeoutMs = 10_000): Promise<{ v: number; type?: string; wid?: string; seq?: number; text?: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout waiting for WS frame")), timeoutMs);
    socket.addEventListener("message", (event) => {
      clearTimeout(timer);
      resolve(JSON.parse(event.data as string));
    }, { once: true });
  });
}

/** 唯一化辅助：no-isolate 共享存储下的文件间隔离手段。 */
function uniqueId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

describe("ws fanout (walking skeleton)", () => {
  it("POST /api/send -> SQLite 落库(seq=1) -> 双 WS 客户端实收 seq=2 的 v:1 帧（text 逐字一致）", async () => {
    // 1. 唯一频道 + 种入 ch:/sk: 两键（指向同一 channelId）。
    const channelId = uniqueId().slice(0, 16);
    const channelKey = `tch_${uniqueId()}`;
    const sendKey = `tsk_${uniqueId()}`;
    await env.KV.put(
      KEY_PREFIX_CH + channelKey,
      JSON.stringify({ channelId, name: "fanout-test", createdAt: Date.now() }),
    );
    await env.KV.put(KEY_PREFIX_SEND + sendKey, JSON.stringify({ channelId }));

    // 原文含 Markdown 与原始 HTML——服务端是哑管道，扇出必须逐字一致（Prohibition #1）。
    const text1 = "# first\n\nhello *world* <b>raw</b>";
    const text2 = "second **message** with `code`";

    // 2. 第一条消息：Worker 入口 -> KV 预检 -> DO publish（此时零 WS 连接，仅落库）。
    const sendResp1 = await exports.default.fetch(
      new Request("https://example.com/api/send", {
        method: "POST",
        headers: { Authorization: `Bearer ${sendKey}`, "content-type": "application/json" },
        body: JSON.stringify({ text: text1 }),
      }),
      env,
    );
    expect(sendResp1.status).toBe(200);
    const body1 = await sendResp1.json() as { id: string; seq: number };
    expect(body1.id.startsWith("m_")).toBe(true);
    expect(body1.id.length).toBe(18); // m_ + 16 字符（D-05）
    expect(body1.seq).toBe(1);

    // 3. 两条客户端 WS 经 DO 升级（官方 fixture 模式：Upgrade 头 + response.webSocket + accept）。
    const id = env.CHANNELS.idFromName(channelId);
    const stub = env.CHANNELS.get(id);
    const upgradeInit = { headers: { Upgrade: "websocket", "X-PH-Verified": "1" } };
    const socket1 = getResponseWebSocket(
      await stub.fetch("https://do.pushhub.internal/ws", upgradeInit),
    );
    const socket2 = getResponseWebSocket(
      await stub.fetch("https://do.pushhub.internal/ws", upgradeInit),
    );
    socket1.accept();
    socket2.accept();

    // 4. 第二条消息：双客户端均应收到 v:1 message 帧，seq=2，text 逐字一致。
    const received1 = nextFrame(socket1);
    const received2 = nextFrame(socket2);
    const sendResp2 = await exports.default.fetch(
      new Request("https://example.com/api/send", {
        method: "POST",
        headers: { Authorization: `Bearer ${sendKey}`, "content-type": "application/json" },
        body: JSON.stringify({ text: text2 }),
      }),
      env,
    );
    expect(sendResp2.status).toBe(200);
    const body2 = await sendResp2.json() as { id: string; seq: number };
    expect(body2.seq).toBe(2);

    const [frame1, frame2] = await Promise.all([received1, received2]);
    for (const frame of [frame1, frame2]) {
      expect(frame.v).toBe(1); // D-07：全帧带版本
      expect(frame.seq).toBe(2);
      expect(frame.text).toBe(text2); // 哑管道：逐字一致
      expect(frame.wid).toBe(body2.id);
    }
    expect(frame1.text).toBe(frame2.text); // 两客户端收到同一条消息

    socket1.close(1000, "done");
    socket2.close(1000, "done");
  });

  it("无效 Send Key 的 /api/send 返回 401 + invalid_key 信封（Worker 层即拒绝）", async () => {
    const resp = await exports.default.fetch(
      new Request("https://example.com/api/send", {
        method: "POST",
        headers: {
          Authorization: `Bearer nope_${uniqueId()}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ text: "should be rejected" }),
      }),
      env,
    );
    expect(resp.status).toBe(401);
    const body = await resp.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe("invalid_key");
    expect(typeof body.error.message).toBe("string");
  });

  it("无效 Channel Key 的 WS 握手返回 401 + invalid_key 信封（不创建 DO stub，防 DoS T-01-02）", async () => {
    const resp = await exports.default.fetch(
      new Request(`https://example.com/api/ws/nope_${uniqueId()}`),
      env,
    );
    expect(resp.status).toBe(401);
    const body = await resp.json() as { error: { code: string } };
    expect(body.error.code).toBe("invalid_key");
  });
});
