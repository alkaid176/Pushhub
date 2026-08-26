/**
 * SRV-06 群聊语义集成测试（01-04 Task 2）。
 *
 * 覆盖：
 *  - 三客户端同频道：每条新消息三端同帧到达（v/wid/seq/text 逐字段相等）；
 *  - 断开一端不影响其余端继续收消息（扇出与补拉均不依赖在线列表——
 *    Flagged Assumption SRV-06：成员变更不产生系统广播帧）；
 *  - 断开期间的消息经重连 sync since 补拉完整到达：离线窗口 5 条恰补 5 条，
 *    seq 连续（零丢失零重复）；
 *  - 死连接不中断其余端收件：直接 close 一端后继续发消息，其余端照收
 *    （publish 扇出的 try/catch 死连接清理分支有效——close 事件到达前的
 *    竞态窗口由该分支兜底，其余端收件不受影响是可稳定断言的行为）。
 *
 * 帧监听铁律（workerd 同 isolate 实证）：message 事件不排队——监听器必须
 * 在触发动作（publish/send）之前、且与 accept() 之间零 await 挂好，否则
 * 事件即发即弃。connect() 内部同步预挂首帧监听；多连接场景先全部建连
 * （各自监听已挂）再统一 await。
 *
 * 发送路径：全部经真实 Worker 入口（KV 预检 → DO publish），单 Send Key
 * 共 8 条 << 30/min 窗口（限流策略注明：无需轮换）。
 *
 * 隔离策略：--max-workers=1 --no-isolate 共享存储——频道名经
 * crypto.randomUUID() 派生唯一。
 */
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { KEY_PREFIX_CH, KEY_PREFIX_SEND } from "../src/keys";

interface MessageLike {
  v: number;
  type: string;
  wid: string;
  seq: number;
  text: string;
}

interface HistoryLike {
  v: number;
  type: string;
  messages: MessageLike[];
  oldest_kept_seq: number;
  has_more: boolean;
}

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

/**
 * 连接并同步预挂首帧监听（accept 与 addEventListener 之间零 await——
 * 首拉 history 帧在升级路径已入队，任何间隔 await 都可能让事件即发即弃）。
 */
async function connect(
  stub: DurableObjectStub,
): Promise<{ socket: WebSocket; firstFrame: Promise<HistoryLike> }> {
  const socket = getResponseWebSocket(
    await stub.fetch("https://do.pushhub.internal/ws", {
      headers: { Upgrade: "websocket", "X-PH-Verified": "1" },
    }),
  );
  socket.accept();
  return { socket, firstFrame: nextFrame<HistoryLike>(socket) };
}

/** 种入唯一频道（ch:/sk: 两键指向同一 channelId）。 */
async function seedChannel(): Promise<{ channelId: string; sendKey: string }> {
  const channelId = uniqueId().slice(0, 16);
  const channelKey = `tch_${uniqueId()}`;
  const sendKey = `tsk_${uniqueId()}`;
  await env.KV.put(
    KEY_PREFIX_CH + channelKey,
    JSON.stringify({ channelId, name: "group-semantics", createdAt: Date.now() }),
  );
  await env.KV.put(KEY_PREFIX_SEND + sendKey, JSON.stringify({ channelId }));
  return { channelId, sendKey };
}

function sendRequest(sendKey: string, text: string): Promise<Response> {
  return exports.default.fetch(
    new Request("https://example.com/api/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${sendKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ text }),
    }),
    env,
  );
}

describe("group chat semantics (SRV-06)", () => {
  it("三端同帧互通 → 断开不影响其余端 → 重连补拉恰为离线窗口 5 条 → 死连接不中断收件", async () => {
    const { channelId, sendKey } = await seedChannel();
    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(channelId));

    // 1. 首条消息（此时零连接，仅落库；成为后续连接的首拉内容）。
    const resp1 = await sendRequest(sendKey, "msg-1");
    expect(resp1.status).toBe(200);
    const body1 = (await resp1.json()) as { id: string; seq: number };
    expect(body1.seq).toBe(1);

    // 2. 三客户端连接（首帧监听已在 connect 内预挂）→ 各收含 seq=1 的首拉。
    const a = await connect(stub);
    const b = await connect(stub);
    const c = await connect(stub);
    for (const initial of await Promise.all([a.firstFrame, b.firstFrame, c.firstFrame])) {
      expect(initial.type).toBe("history");
      expect(initial.messages.map((m) => m.seq)).toEqual([1]);
    }

    // 3. 每条新消息三端同帧到达：先挂三路监听，再经 Worker 入口发送。
    const pendingA = nextFrame<MessageLike>(a.socket);
    const pendingB = nextFrame<MessageLike>(b.socket);
    const pendingC = nextFrame<MessageLike>(c.socket);
    const resp2 = await sendRequest(sendKey, "msg-2");
    expect(resp2.status).toBe(200);
    const body2 = (await resp2.json()) as { id: string; seq: number };
    const [frameA, frameB, frameC] = await Promise.all([pendingA, pendingB, pendingC]);
    for (const frame of [frameA, frameB, frameC]) {
      expect(frame.v).toBe(1);
      expect(frame.type).toBe("message");
      expect(frame.wid).toBe(body2.id);
      expect(frame.seq).toBe(2);
      expect(frame.text).toBe("msg-2");
    }

    // 4. 断开 B → 其余两端继续正常收消息：离线窗口 5 条全部到达 A/C。
    b.socket.close(1000, "offline");
    const OFFLINE_COUNT = 5;
    const offlineSeqs: number[] = [];
    for (let i = 3; i < 3 + OFFLINE_COUNT; i++) {
      const toAPromise = nextFrame<MessageLike>(a.socket);
      const toCPromise = nextFrame<MessageLike>(c.socket);
      const resp = await sendRequest(sendKey, `offline-${i}`);
      expect(resp.status).toBe(200);
      const body = (await resp.json()) as { seq: number };
      offlineSeqs.push(body.seq);
      const [toA, toC] = await Promise.all([toAPromise, toCPromise]);
      expect(toA.seq).toBe(body.seq);
      expect(toC.seq).toBe(body.seq);
      expect(toA.text).toBe(`offline-${i}`);
      expect(toC.text).toBe(`offline-${i}`);
    }

    // 5. B 重连：首拉（监听已预挂）→ sync since=2 恰补 5 条、seq 连续。
    const b2 = await connect(stub);
    const b2InitialFrame = await b2.firstFrame;
    expect(b2InitialFrame.type).toBe("history");
    const catchUpPromise = nextFrame<HistoryLike>(b2.socket);
    b2.socket.send(JSON.stringify({ v: 1, type: "sync", since: 2 }));
    const catchUp = await catchUpPromise;
    expect(catchUp.type).toBe("history");
    expect(catchUp.messages.map((m) => m.seq)).toEqual(offlineSeqs);
    expect(catchUp.messages.length).toBe(OFFLINE_COUNT);
    expect(catchUp.messages.map((m) => m.text)).toEqual(
      Array.from({ length: OFFLINE_COUNT }, (_, i) => `offline-${i + 3}`),
    );

    // 6. 死连接不中断其余端收件：close A 后立即发消息，C 与 B' 照收
    //    （服务端扇出 try/catch 对已死连接收集后清理，不中断循环）。
    a.socket.close(1000, "dead");
    const pendingC2 = nextFrame<MessageLike>(c.socket);
    const pendingB2 = nextFrame<MessageLike>(b2.socket);
    const resp8 = await sendRequest(sendKey, "after-death");
    expect(resp8.status).toBe(200);
    const body8 = (await resp8.json()) as { seq: number };
    expect(body8.seq).toBe(8); // 7 条历史 + 1
    const [frameC2, frameB3] = await Promise.all([pendingC2, pendingB2]);
    expect(frameC2.seq).toBe(8);
    expect(frameC2.text).toBe("after-death");
    expect(frameB3.seq).toBe(8);
    expect(frameB3.text).toBe("after-death");

    c.socket.close(1000, "done");
    b2.socket.close(1000, "done");
  });
});
