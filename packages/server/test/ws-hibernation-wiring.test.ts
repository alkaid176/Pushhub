/**
 * SRV-04 Hibernation 接线集成测试（01-04 Task 2，官方 Code Example 3 模式）。
 *
 * 覆盖（evictDurableObject 模拟生产休眠/驱逐，默认 webSockets:"hibernate"）：
 *  - auto-response 生效：客户端发 v:1 ping 字面量帧即得 v:1 pong 字面量帧
 *    （setWebSocketAutoResponse 零唤醒层，字节精确匹配）；
 *  - 驱逐后 ping 仍得 pong（Pitfall 3 回归：auto-response 配置跨驱逐存活，
 *    构造器唤醒重跑时重设）；
 *  - 驱逐后发布消息，既有连接（休眠句柄）仍收到 message 帧
 *    （getWebSockets 跨驱逐持有休眠连接——扇出不依赖 DO 实例内存）；
 *  - attachment 跨驱逐完整恢复：deserializeAttachment 的 clientId 与驱逐前一致。
 *
 * 帧监听铁律（workerd 同 isolate 实证）：message 事件不排队——必须在触发
 * 动作（publish/send）之前挂好监听器，否则事件即发即弃。全部读取点遵循
 * attach-then-trigger 次序。
 *
 * 发送路径：DO /publish 内部端点直调（可信头），1 条消息，无限流压力。
 *
 * 隔离策略：--max-workers=1 --no-isolate 共享存储——频道名经
 * crypto.randomUUID() 派生唯一（不经 KV，无需种键）。
 */
import { env } from "cloudflare:workers";
// evictDurableObject/runInDurableObject 经 cloudflare:test（env 在
// cloudflare:workers——插件将运行时绑定与测试工具分离，01-03 实证）。
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// 与 chat-room.ts PING_FRAME/PONG_FRAME 逐字节一致（协议层心跳字面量，D-07）。
const PING_FRAME = '{"v":1,"type":"ping"}';
const PONG_FRAME = '{"v":1,"type":"pong"}';

interface MessageLike {
  v: number;
  type: string;
  wid: string;
  seq: number;
  text: string;
}

interface ConnectionAttachment {
  clientId: string;
  connectedAt: number;
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

/** 等待下一帧并 JSON 解析。 */
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

/** 等待下一帧原文（不解析——pong 字面量需字节精确比对）。 */
function nextRawFrame(socket: WebSocket, timeoutMs = 10_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout waiting for WS frame")), timeoutMs);
    socket.addEventListener(
      "message",
      (event) => {
        clearTimeout(timer);
        resolve(event.data as string);
      },
      { once: true },
    );
  });
}

function readAttachments(stub: DurableObjectStub): Promise<ConnectionAttachment[]> {
  return runInDurableObject(
    stub,
    (_obj: unknown, state: DurableObjectState) =>
      state.getWebSockets().map((ws) => ws.deserializeAttachment() as ConnectionAttachment),
  );
}

describe("WS hibernation wiring (SRV-04)", () => {
  it("evict 驱逐后：ping 仍获 pong、新消息仍达休眠连接、attachment 完整恢复", async () => {
    const channelId = uniqueId().slice(0, 16);
    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(channelId));

    // 1. 客户端 A 连接——首拉 history 帧已在升级路径入队，accept 后即挂监听收取。
    const socket = getResponseWebSocket(
      await stub.fetch("https://do.pushhub.internal/ws", {
        headers: { Upgrade: "websocket", "X-PH-Verified": "1" },
      }),
    );
    socket.accept();
    const initialPromise = nextFrame(socket);
    const initial = await initialPromise;
    expect((initial as { type: string }).type).toBe("history");

    // 2. ping 字面量 → pong 字面量（auto-response 零唤醒自动应答，字节精确）。
    const pong1Promise = nextRawFrame(socket);
    socket.send(PING_FRAME);
    expect(await pong1Promise).toBe(PONG_FRAME);

    // 3. 驱逐前读取 attachment（每连接状态）。
    const before = await readAttachments(stub);
    expect(before.length).toBe(1);
    expect(typeof before[0]!.clientId).toBe("string");
    expect(Number.isFinite(before[0]!.connectedAt)).toBe(true);

    // 4. 驱逐 DO（webSockets:"hibernate"——连接休眠存活，实例状态清空）。
    await evictDurableObject(stub);

    // 5. 驱逐后 ping 仍得 pong（auto-response 跨驱逐存活——Pitfall 3 回归）。
    const pong2Promise = nextRawFrame(socket);
    socket.send(PING_FRAME);
    expect(await pong2Promise).toBe(PONG_FRAME);

    // 6. 驱逐后发布消息：先挂监听再 publish——休眠连接句柄仍被扇出
    //    （getWebSockets 跨驱逐持有，消息到达唤醒路径与生产一致）。
    const deliveryPromise = nextFrame<MessageLike>(socket);
    const publishResp = await stub.fetch("https://do.pushhub.internal/publish", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-PH-Verified": "1",
        "X-PH-Send-Key": `tsk-hib-${uniqueId()}`,
      },
      body: JSON.stringify({ text: "post-eviction message" }),
    });
    expect(publishResp.status).toBe(200);
    const publishBody = (await publishResp.json()) as { seq: number };
    expect(publishBody.seq).toBe(1);

    const delivered = await deliveryPromise;
    expect(delivered.v).toBe(1);
    expect(delivered.type).toBe("message");
    expect(delivered.seq).toBe(1);
    expect(delivered.text).toBe("post-eviction message");

    // 7. 驱逐后 attachment 恢复：clientId/connectedAt 与驱逐前一致。
    const after = await readAttachments(stub);
    expect(after.length).toBe(1);
    expect(after[0]!.clientId).toBe(before[0]!.clientId);
    expect(after[0]!.connectedAt).toBe(before[0]!.connectedAt);

    socket.close(1000, "done");
  });
});
