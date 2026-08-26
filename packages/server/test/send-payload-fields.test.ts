/**
 * SRV-02 字段全量透传集成测试（01-03 Task 1）。
 *
 * 断言：带 options 三项 + callback_url + click_url + priority:"high" 的载荷
 * → WS 客户端收到的 message 帧逐字段等于发送值（原样透传）；
 * text 含 Markdown 语法与尖括号标签字符时帧内 text 逐字节等于原文
 * （哑管道证据——服务端不解析不消毒不改写）；省略可选字段时帧中无该键
 * （省略语义，永不为空数组）；帧键集与冻结 MessageFrame 全集精确一致。
 */
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { PROTOCOL_VERSION } from "@pushhub/shared";

import { KEY_PREFIX_CH, KEY_PREFIX_SEND } from "../src/keys";

function uniqueId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

function getResponseWebSocket(response: Response): WebSocket {
  const socket = response.webSocket;
  if (socket === null || socket === undefined) {
    throw new TypeError("Expected WebSocket response");
  }
  return socket;
}

function nextMessage(socket: WebSocket, timeoutMs = 10_000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("timeout waiting for WS frame")),
      timeoutMs,
    );
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

/** 种入唯一频道并返回两把凭据：sendKey 发消息 / channelKey 走 WS。 */
async function seedChannel(): Promise<{ channelId: string; sendKey: string }> {
  const channelId = uniqueId().slice(0, 16);
  const channelKey = `tch_${uniqueId()}`;
  const sendKey = `tsk_${uniqueId()}`;
  await env.KV.put(
    KEY_PREFIX_CH + channelKey,
    JSON.stringify({ channelId, name: "payload-fields", createdAt: Date.now() }),
  );
  await env.KV.put(KEY_PREFIX_SEND + sendKey, JSON.stringify({ channelId }));
  return { channelId, sendKey };
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

describe("POST /api/send payload field passthrough (SRV-02)", () => {
  it("全字段载荷 → message 帧逐字段等于发送值；text 逐字节哑管道", async () => {
    const { channelId, sendKey } = await seedChannel();

    // 先开 WS 连接再发消息（扇出只达在线连接）。
    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(channelId));
    const socket = getResponseWebSocket(
      await stub.fetch("https://do.pushhub.internal/ws", {
        headers: { Upgrade: "websocket", "X-PH-Verified": "1" },
      }),
    );
    socket.accept();

    // 01-04 起连接即收首拉 history 帧（D-09）——排空后再监听 message 帧
    //（此刻频道为空：messages 空数组）。
    const initialHistory = await nextMessage(socket);
    expect(initialHistory.type).toBe("history");

    // text 含 Markdown 语法 + 尖括号标签字符 + URL + 反引号——哑管道逐字节透传。
    const sentText = "# 标题 *emphasis* <script>alert(1)</script> `code` [link](https://example.com/x?a=1&b=2)";
    const sentOptions = ["确认", "重试", "升级"];
    const sentCallback = "https://ci.example.com/hooks/pushhub-callback?sig=abc";
    const sentClick = "https://ci.example.com/runs/8123";
    const framePromise = nextMessage(socket);

    const resp = await sendRequest(sendKey, {
      title: "Deploy finished",
      text: sentText,
      options: sentOptions,
      callback_url: sentCallback,
      click_url: sentClick,
      priority: "high",
    });
    expect(resp.status).toBe(200);
    const sendBody = (await resp.json()) as { id: string; seq: number };

    const frame = await framePromise;
    // 帧键集与冻结 MessageFrame 全字段全集精确一致（15 键全出现）。
    expect(Object.keys(frame).sort()).toEqual([
      "answered", "answered_at", "answered_by", "answered_content",
      "callback_url", "click_url", "created_at", "options",
      "priority", "seq", "text", "title", "type", "v", "wid",
    ]);
    expect(frame.v).toBe(PROTOCOL_VERSION);
    expect(frame.type).toBe("message");
    expect(frame.wid).toBe(sendBody.id);
    expect(frame.seq).toBe(sendBody.seq);
    expect(frame.title).toBe("Deploy finished");
    // 哑管道断言：text 逐字节等于原文（不解析 Markdown、不动尖括号）。
    expect(frame.text).toBe(sentText);
    expect(frame.options).toEqual(sentOptions);
    expect(frame.callback_url).toBe(sentCallback);
    expect(frame.click_url).toBe(sentClick);
    expect(frame.priority).toBe("high");
    expect(frame.answered).toBe(false);
    expect(frame.answered_by).toBe(null);
    expect(frame.answered_at).toBe(null);
    expect(frame.answered_content).toBe(null);
    expect(Number.isInteger(frame.created_at)).toBe(true);

    // 第二条：省略全部可选字段 → 帧中无对应键（省略语义；options 永不为空数组）。
    const frame2Promise = nextMessage(socket);
    const resp2 = await sendRequest(sendKey, { text: "bare" });
    expect(resp2.status).toBe(200);
    const frame2 = await frame2Promise;
    expect(Object.keys(frame2).sort()).toEqual([
      "answered", "answered_at", "answered_by", "answered_content",
      "created_at", "priority", "seq", "text", "type", "v", "wid",
    ]);
    expect("options" in frame2).toBe(false);
    expect("callback_url" in frame2).toBe(false);
    expect("click_url" in frame2).toBe(false);
    expect("title" in frame2).toBe(false);
    expect(frame2.priority).toBe("normal"); // 缺省归一
    expect(frame2.text).toBe("bare");

    socket.close(1000, "done");
  });

  it("空 options 数组归一为省略：帧中无 options 键（SRV-02 省略语义）", async () => {
    const { channelId, sendKey } = await seedChannel();
    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(channelId));
    const socket = getResponseWebSocket(
      await stub.fetch("https://do.pushhub.internal/ws", {
        headers: { Upgrade: "websocket", "X-PH-Verified": "1" },
      }),
    );
    socket.accept();

    // 排空首拉 history 帧（D-09，01-04 起 accept 后立即推送）。
    const initialHistory = await nextMessage(socket);
    expect(initialHistory.type).toBe("history");

    const framePromise = nextMessage(socket);
    const resp = await sendRequest(sendKey, { text: "empty options", options: [] });
    expect(resp.status).toBe(200);
    const frame = await framePromise;
    expect("options" in frame).toBe(false);
    expect(frame.text).toBe("empty options");

    socket.close(1000, "done");
  });
});
