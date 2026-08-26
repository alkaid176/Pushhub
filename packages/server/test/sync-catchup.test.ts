/**
 * D-09/D-10/D-11 补拉语义集成测试（01-04 Task 1，SRV-05）。
 *
 * 覆盖：
 *  - 首连即收首拉 history 帧（最近 INITIAL_FETCH=50 条，D-09）；
 *  - keyset 翻页（WHERE seq > since 升序 LIMIT，缺省 limit=200 恰一页 200 条，
 *    翻页续拉，零丢失零重复——220 条并集恰为 1..220，Set 断言）；
 *  - limit 钳制三态：缺省 200（翻页步已证）/ 越界值回 invalid_frame
 *    （01-02 冻结反例：sync-frame.negative.json "limit 0 / 501 -> invalid_frame"，
 *    与 fixture 逐字节一致——Flagged Assumption 按冻结契约落地而非静默钳制）/
 *    合法上限 500 单页全量；
 *  - oldest_kept_seq 诚实缺口标记（D-10）：since=0 早于 oldest_kept_seq 时不报错
 *    不断连，帧内 oldest_kept_seq 为实际最老 seq（真实缺口场景归 retention-alarm）；
 *  - 空频道首拉：messages 空数组、oldest_kept_seq=0、has_more=false；
 *  - 非法入站帧回 WsErrorFrame（invalid_version / invalid_frame）且连接保持。
 *
 * 发送策略（测试内注明，计划许可）：220 条经 DO /publish 内部端点直调
 * （X-PH-Verified 可信头），Send Key 以 i%8 轮换避开 30/min 窗口（每键 ≤ 28 条）。
 *
 * 隔离策略：套件 --max-workers=1 --no-isolate 共享存储——本文件全部频道经
 * crypto.randomUUID() 派生唯一 channelId（不经 KV，无需种键）。
 */
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { INITIAL_FETCH } from "@pushhub/shared";
import wsErrorFixtures from "@pushhub/shared/fixtures/ws-error-frame.json";

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

const WS_ERROR_INVALID_FRAME = wsErrorFixtures.find((f) => f.code === "invalid_frame");
const WS_ERROR_INVALID_VERSION = wsErrorFixtures.find((f) => f.code === "invalid_version");

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

async function connect(stub: DurableObjectStub): Promise<WebSocket> {
  const socket = getResponseWebSocket(
    await stub.fetch("https://do.pushhub.internal/ws", {
      headers: { Upgrade: "websocket", "X-PH-Verified": "1" },
    }),
  );
  socket.accept();
  return socket;
}

/** 等待下一帧并断言其为 history 形态（v/type/messages/oldest_kept_seq/has_more 全键）。 */
function nextHistory(socket: WebSocket, timeoutMs = 10_000): Promise<HistoryLike> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout waiting for WS frame")), timeoutMs);
    socket.addEventListener(
      "message",
      (event) => {
        clearTimeout(timer);
        const parsed = JSON.parse(event.data as string) as HistoryLike;
        expect(parsed.v).toBe(1);
        expect(parsed.type).toBe("history");
        expect(Object.keys(parsed).sort()).toEqual([
          "has_more",
          "messages",
          "oldest_kept_seq",
          "type",
          "v",
        ]);
        resolve(parsed);
      },
      { once: true },
    );
  });
}

/** 等待下一帧（原样解析，不做形态断言——error 帧等非 history 帧用）。 */
function nextRaw<T>(socket: WebSocket, timeoutMs = 10_000): Promise<T> {
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

function sendSync(socket: WebSocket, since: number | null, limit?: number): void {
  const frame: Record<string, unknown> = { v: 1, type: "sync", since };
  if (limit !== undefined) {
    frame.limit = limit;
  }
  socket.send(JSON.stringify(frame));
}

/** DO /publish 内部端点直调（可信头 + Send Key 轮换避开 30/min 限流窗口）。 */
function directPublish(stub: DurableObjectStub, text: string, sendKey: string): Promise<Response> {
  return stub.fetch("https://do.pushhub.internal/publish", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-PH-Verified": "1",
      "X-PH-Send-Key": sendKey,
    },
    body: JSON.stringify({ text }),
  });
}

describe("sync catch-up (D-09/D-10/D-11, SRV-05)", () => {
  it("220 条全链路：首拉 50 → keyset 翻页 200+20 → 零丢失零重复 → limit 三态 → oldest_kept_seq 诚实", async () => {
    const channelId = uniqueId().slice(0, 16);
    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(channelId));

    // 发 220 条（20 条一批 Promise.all；DO 单线程逐条处理，seq 分配原子）。
    const TOTAL = 220;
    for (let base = 0; base < TOTAL; base += 20) {
      const results = await Promise.all(
        Array.from({ length: Math.min(20, TOTAL - base) }, (_, j) => {
          const i = base + j;
          return directPublish(stub, `msg ${i + 1}`, `tsk-rot-${i % 8}`);
        }),
      );
      for (const r of results) {
        expect(r.status).toBe(200);
      }
    }

    // ---- 首拉（D-09）：最近 50 条 = seq 171..220 升序，has_more=true，oldest=1 ----
    const socket = await connect(stub);
    const initial = await nextHistory(socket);
    expect(initial.messages.length).toBe(INITIAL_FETCH);
    expect(initial.messages.map((m) => m.seq)).toEqual(
      Array.from({ length: INITIAL_FETCH }, (_, i) => 171 + i),
    );
    expect(initial.has_more).toBe(true);
    expect(initial.oldest_kept_seq).toBe(1);

    // ---- keyset 翻页（D-11）：缺省 limit=200 恰一页，续页 20 条收尾 ----
    sendSync(socket, 0); // 缺省 limit
    const page1 = await nextHistory(socket);
    expect(page1.messages.length).toBe(200);
    expect(page1.messages[0]!.seq).toBe(1);
    expect(page1.messages[199]!.seq).toBe(200);
    expect(page1.has_more).toBe(true);

    sendSync(socket, 200);
    const page2 = await nextHistory(socket);
    expect(page2.messages.length).toBe(20);
    expect(page2.messages[0]!.seq).toBe(201);
    expect(page2.messages[19]!.seq).toBe(220);
    expect(page2.has_more).toBe(false);

    // 零丢失零重复：三帧 seq 并集恰为 1..220（Set 大小断言，SRV-05 核心）。
    const allSeqs = [...initial.messages, ...page1.messages, ...page2.messages].map((m) => m.seq);
    expect(new Set(allSeqs).size).toBe(220);
    expect(Math.min(...allSeqs)).toBe(1);
    expect(Math.max(...allSeqs)).toBe(220);

    // 哑管道贯穿补拉路径（SRV-06 Prohibition）：按 seq 去重后 text 逐字透传，
    // 220 条原文全数到达（三帧覆盖区间重叠属翻页协议预期，零重复由 seq Set 证明）。
    const seqToText = new Map<number, string>();
    for (const m of [...initial.messages, ...page1.messages, ...page2.messages]) {
      seqToText.set(m.seq, m.text);
    }
    expect(seqToText.size).toBe(220);
    expect([...seqToText.values()].sort()).toEqual(
      Array.from({ length: 220 }, (_, i) => `msg ${i + 1}`).sort(),
    );
    // wid 全局唯一（补拉与扇出同源同构——每条消息一个 wid，D-05）。
    const allWids = [...initial.messages, ...page1.messages, ...page2.messages].map((m) => m.wid);
    expect(new Set(allWids).size).toBe(220);

    // ---- limit 钳制三态 ----
    // 超上限 999：01-02 冻结反例语义——invalid_frame 错误帧（与 fixture 逐字节一致），
    // 连接保持。Flagged Assumption 原文设想"钳制为 500 不报错"，但 sync-frame.
    // negative.json 已逐字节冻结 "limit exceeds SYNC_LIMIT_MAX (500) -> invalid_frame"
    // （协议 one-way 门，01-02 用户裁决 freeze）——按冻结契约落地。
    socket.send('{"v":1,"type":"sync","since":0,"limit":999}');
    expect(await nextRaw(socket)).toEqual(WS_ERROR_INVALID_FRAME);
    // 下限 0：同冻结反例（"limit is 0 -> invalid_frame"）。
    socket.send('{"v":1,"type":"sync","since":0,"limit":0}');
    expect(await nextRaw(socket)).toEqual(WS_ERROR_INVALID_FRAME);
    // 合法上限 500：单页全量 220 条（≤500），has_more=false。
    sendSync(socket, 0, 500);
    const bigPage = await nextHistory(socket);
    expect(bigPage.messages.length).toBe(220);
    expect(bigPage.has_more).toBe(false);
    // 缺省 200 已由 page1 断言（恰 200 条/页）。

    // ---- D-10 缺口诚实：since=0（<= oldest_kept_seq）不报错不断连，帧内
    //      oldest_kept_seq 为实际最老 seq（本频道无清理，oldest=1）。----
    sendSync(socket, 0, 1); // 顺带覆盖最小合法 limit=1（升序取 1 条 + has_more）
    const gapProbe = await nextHistory(socket);
    expect(gapProbe.messages.length).toBe(1);
    expect(gapProbe.messages[0]!.seq).toBe(1);
    expect(gapProbe.has_more).toBe(true);
    expect(gapProbe.oldest_kept_seq).toBe(1);

    socket.close(1000, "done");
  });

  it("空频道首连：history 帧 messages 空数组、oldest_kept_seq=0、has_more=false", async () => {
    const channelId = uniqueId().slice(0, 16);
    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(channelId));

    const socket = await connect(stub);
    const first = await nextHistory(socket);
    expect(first.messages).toEqual([]);
    expect(first.oldest_kept_seq).toBe(0);
    expect(first.has_more).toBe(false);

    // sync since=null 同首拉语义。
    sendSync(socket, null);
    const second = await nextHistory(socket);
    expect(second.messages).toEqual([]);
    expect(second.oldest_kept_seq).toBe(0);
    expect(second.has_more).toBe(false);

    socket.close(1000, "done");
  });

  it("非法入站帧：v:2 → invalid_version；非 JSON/未知 type/limit 越界 → invalid_frame；连接保持", async () => {
    const channelId = uniqueId().slice(0, 16);
    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(channelId));

    const socket = await connect(stub);
    await nextHistory(socket); // 排空首拉帧

    // v 不等于 1 → invalid_version（WsErrorFrame，与 fixture 逐字节一致）。
    socket.send('{"v":2,"type":"sync","since":null}');
    expect(await nextRaw(socket)).toEqual(WS_ERROR_INVALID_VERSION);

    // 非 JSON → invalid_frame。
    socket.send("this is not json");
    expect(await nextRaw(socket)).toEqual(WS_ERROR_INVALID_FRAME);

    // 未知 type → invalid_frame。
    socket.send('{"v":1,"type":"wat","since":null}');
    expect(await nextRaw(socket)).toEqual(WS_ERROR_INVALID_FRAME);

    // since 非法（负数）→ invalid_frame（冻结反例）。
    socket.send('{"v":1,"type":"sync","since":-1}');
    expect(await nextRaw(socket)).toEqual(WS_ERROR_INVALID_FRAME);

    // 连接保持：坏帧全部被忽略后，合法 sync 仍得到 history 响应。
    sendSync(socket, null);
    const ok = await nextHistory(socket);
    expect(ok.messages).toEqual([]);

    socket.close(1000, "done");
  });
});
