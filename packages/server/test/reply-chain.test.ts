/**
 * 回复链端到端集成测试（04-01 Task 1，RPL-01/RPL-02/RPL-05——D-42~D-46/D-51~D-53）。
 *
 * 六组用例：
 *  1. reply → ack（恰 v/type/wid 三键）+ 双客户端 answered 扇出全量断言；
 *  2. 二次 reply → already_replied 错误帧且连接保持；
 *  3. 不存在 wid → not_found 错误帧（与 already_replied 严格区分，D-42）；
 *  4. 双客户端竞态（零间隔双发）→ 恰一方 ack、另一方 already_replied（D-44）；
 *  5. 白名单外 / 恰一同真 / 同假 / by 超一字符 → invalid_frame 且连接保持
 *     （D-46/D-53——结构层与域级两类拒绝共用错误码）；
 *  6. answered_by 随 by 自报（缺省 null，D-51/D-53）+ answered_content 为
 *     回复原文透传（RPL-02——Markdown 渲染消毒是客户端侧职责）。
 *
 * 沿用 retention-alarm.test.ts 基建：directPublish 可信头直调 DO + nextFrame
 * attach-then-trigger 监听（workerd 同 isolate 实证：message 事件不排队，
 * 监听必须先于触发挂上）+ crypto.randomUUID 派生唯一频道名隔离
 * （--max-workers=1 --no-isolate 共享存储）。
 */
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { BY_MAX } from "@pushhub/shared";

interface AckLike {
  v: number;
  type: string;
  wid: string;
}

interface AnsweredLike {
  v: number;
  type: string;
  wid: string;
  seq: number;
  answered: boolean;
  answered_by: string | null;
  answered_at: number;
  answered_content: string | null;
}

interface ErrorLike {
  v: number;
  type: string;
  code: string;
  message: string;
}

interface HistoryLike {
  v: number;
  type: string;
  messages: Array<Record<string, unknown>>;
}

type Frame = Record<string, unknown>;

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

/** 收集 count 帧（到达序）——多帧断言与竞态用；单帧即 count=1。 */
function nextFrames<T = Frame>(socket: WebSocket, count: number, timeoutMs = 10_000): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const frames: T[] = [];
    const onMessage = (event: { data: unknown }): void => {
      frames.push(JSON.parse(event.data as string) as T);
      if (frames.length >= count) {
        cleanup();
        resolve(frames);
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timeout waiting for ${count} WS frame(s); got ${frames.length}`));
    }, timeoutMs);
    function cleanup(): void {
      clearTimeout(timer);
      socket.removeEventListener("message", onMessage as EventListener);
    }
    socket.addEventListener("message", onMessage as EventListener);
  });
}

function nextFrame<T = Frame>(socket: WebSocket, timeoutMs = 10_000): Promise<T> {
  return nextFrames<T>(socket, 1, timeoutMs).then((frames) => frames[0]);
}

/** DO /publish 内部端点直调（可信头 + 唯一 Send Key 避开 30/min 限流窗口）。 */
function directPublish(stub: DurableObjectStub, body: unknown, sendKey: string): Promise<Response> {
  return stub.fetch("https://do.pushhub.internal/publish", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-PH-Verified": "1",
      "X-PH-Send-Key": sendKey,
    },
    body: JSON.stringify(body),
  });
}

/**
 * 连接并消费首拉 history 帧（accept 与监听间零 await——铁律）；返回的
 * socket 无未决帧，调用方随后的监听/触发时序确定。
 */
async function connect(stub: DurableObjectStub): Promise<WebSocket> {
  const socket = getResponseWebSocket(
    await stub.fetch("https://do.pushhub.internal/ws", {
      headers: { Upgrade: "websocket", "X-PH-Verified": "1" },
    }),
  );
  socket.accept();
  const first = nextFrame<HistoryLike>(socket);
  const history = await first;
  expect(history.type).toBe("history");
  return socket;
}

/** 发布一条消息并返回 {wid, seq}。 */
async function publishOne(
  stub: DurableObjectStub,
  body: Record<string, unknown>,
): Promise<{ wid: string; seq: number }> {
  const resp = await directPublish(stub, body, `tsk-rc-${uniqueId()}`);
  expect(resp.status).toBe(200);
  return (await resp.json()) as { wid: string; seq: number };
}

function replyFrame(body: Record<string, unknown>): string {
  return JSON.stringify({ v: 1, type: "reply", ...body });
}

describe("reply chain (04-01)", () => {
  it("reply → ack 恰三键 + A/B 双客户端 answered 扇出全量断言", { timeout: 15_000 }, async () => {
    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(`rc1-${uniqueId().slice(0, 16)}`));
    const { wid, seq } = await publishOne(stub, {
      text: "deploy finished",
      options: ["Acknowledge", "Retry"],
    });

    const socketA = await connect(stub);
    const socketB = await connect(stub);

    // 监听先挂（attach-then-trigger）：A 依次收 ack、answered（同 handler 内
    // 先单发后扇出，同 socket 顺序保持）；B 收 answered。
    const ackPromise = nextFrame<AckLike>(socketA);
    const answeredAPromise = nextFrame<AnsweredLike>(socketA);
    const answeredBPromise = nextFrame<AnsweredLike>(socketB);
    socketA.send(replyFrame({ wid, selected_option: "Acknowledge", by: "ops-laptop" }));

    const ack = await ackPromise;
    expect(Object.keys(ack).sort()).toEqual(["type", "v", "wid"]);
    expect(ack).toEqual({ v: 1, type: "ack", wid });

    const answeredA = await answeredAPromise;
    const answeredB = await answeredBPromise;
    for (const answered of [answeredA, answeredB]) {
      expect(Object.keys(answered).sort()).toEqual([
        "answered", "answered_at", "answered_by", "answered_content",
        "seq", "type", "v", "wid",
      ]);
      expect(answered.v).toBe(1);
      expect(answered.type).toBe("answered");
      expect(answered.wid).toBe(wid);
      expect(answered.seq).toBe(seq);
      expect(answered.answered).toBe(true);
      expect(answered.answered_by).toBe("ops-laptop");
      expect(typeof answered.answered_at).toBe("number");
      expect(answered.answered_content).toBe("Acknowledge");
    }

    socketA.close(1000, "done");
    socketB.close(1000, "done");
  });

  it("二次 reply → already_replied 错误帧，连接保持", { timeout: 15_000 }, async () => {
    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(`rc2-${uniqueId().slice(0, 16)}`));
    const { wid } = await publishOne(stub, {
      text: "first reply wins",
      options: ["Acknowledge", "Retry"],
    });

    const socketA = await connect(stub);
    const socketB = await connect(stub);

    // A 先答成功（消费 A 的 ack+answered 与 B 的 answered 扇出）。
    const aFrames = nextFrames(socketA, 2);
    const bFanout = nextFrame<AnsweredLike>(socketB);
    socketA.send(replyFrame({ wid, selected_option: "Acknowledge" }));
    const [a1, a2] = await aFrames;
    expect(a1.type).toBe("ack");
    expect(a2.type).toBe("answered");
    expect((await bFanout).type).toBe("answered");

    // B 对同 wid 二次回复：already_replied（D-42 与 not_found 严格区分）。
    const errPromise = nextFrame<ErrorLike>(socketB);
    socketB.send(replyFrame({ wid, selected_option: "Retry" }));
    const err = await errPromise;
    expect(err.type).toBe("error");
    expect(err.code).toBe("already_replied");
    expect(err.v).toBe(1);
    expect(typeof err.message).toBe("string");

    // 连接仍开：sync → history 应答（拒绝不踢线，D-46 宽容语义）。
    const histPromise = nextFrame<HistoryLike>(socketB);
    socketB.send(JSON.stringify({ v: 1, type: "sync", since: null }));
    const hist = await histPromise;
    expect(hist.type).toBe("history");
    expect(hist.messages.length).toBe(1);

    socketA.close(1000, "done");
    socketB.close(1000, "done");
  });

  it("不存在 wid 的 reply → not_found 错误帧，连接保持", { timeout: 15_000 }, async () => {
    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(`rc3-${uniqueId().slice(0, 16)}`));
    const socket = await connect(stub);

    const errPromise = nextFrame<ErrorLike>(socket);
    socket.send(replyFrame({ wid: "m_nosuchmessage0000", text: "ghost reply" }));
    const err = await errPromise;
    expect(err.type).toBe("error");
    expect(err.code).toBe("not_found");
    expect(err.v).toBe(1);

    const histPromise = nextFrame<HistoryLike>(socket);
    socket.send(JSON.stringify({ v: 1, type: "sync", since: null }));
    expect((await histPromise).type).toBe("history");

    socket.close(1000, "done");
  });

  it("双客户端竞态零间隔双发 → 恰一方 ack、另一方 already_replied，无双成功", { timeout: 15_000 }, async () => {
    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(`rc4-${uniqueId().slice(0, 16)}`));
    const { wid } = await publishOne(stub, {
      text: "race target",
      options: ["Acknowledge", "Retry"],
    });

    const socketA = await connect(stub);
    const socketB = await connect(stub);

    // 零间隔双发（两 send 间零 await）；监听先挂。
    const framesAPromise = nextFrames(socketA, 2);
    const framesBPromise = nextFrames(socketB, 2);
    socketA.send(replyFrame({ wid, selected_option: "Acknowledge", by: "client-A" }));
    socketB.send(replyFrame({ wid, selected_option: "Retry", by: "client-B" }));

    const framesA = await framesAPromise;
    const framesB = await framesBPromise;

    // DO 单线程先到先得（D-44）：胜者 [ack, answered]，败者 [answered(胜者扇出), error]。
    const aWins = framesA[0].type === "ack";
    const winner = aWins ? framesA : framesB;
    const loser = aWins ? framesB : framesA;
    expect(winner[0].type).toBe("ack");
    expect(winner[0].wid).toBe(wid);
    const winnerAnswered = winner[1] as AnsweredLike;
    expect(winnerAnswered.type).toBe("answered");
    expect(winnerAnswered.answered_by).toBe(aWins ? "client-A" : "client-B");
    expect(loser[0].type).toBe("answered");
    expect(loser[1].type).toBe("error");
    expect((loser[1] as ErrorLike).code).toBe("already_replied");

    // 双成功为零：两客户端合计恰 1 ack、恰 1 already_replied、恰 2 answered。
    const all = [...framesA, ...framesB];
    expect(all.filter((f) => f.type === "ack").length).toBe(1);
    expect(all.filter((f) => f.type === "answered").length).toBe(2);
    expect(all.filter((f) => (f as ErrorLike).code === "already_replied").length).toBe(1);

    socketA.close(1000, "done");
    socketB.close(1000, "done");
  });

  it("白名单外 / 同真 / 同假 / by 超一字符 → invalid_frame，连接保持", { timeout: 15_000 }, async () => {
    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(`rc5-${uniqueId().slice(0, 16)}`));
    const { wid } = await publishOne(stub, {
      text: "invalid targets",
      options: ["Acknowledge"],
    });
    const socket = await connect(stub);

    const badReplies: Array<Record<string, unknown>> = [
      { wid, selected_option: "NotInOptions" },                 // 白名单外（DO 域级）
      { wid, selected_option: "Acknowledge", text: "both" },    // 同真（结构层）
      { wid },                                                   // 同假（结构层）
      { wid, selected_option: "Acknowledge", by: "b".repeat(BY_MAX + 1) }, // by 超一字符（结构层）
    ];
    const errorsPromise = nextFrames<ErrorLike>(socket, badReplies.length);
    for (const bad of badReplies) {
      socket.send(replyFrame(bad));
    }
    const errors = await errorsPromise;
    for (const err of errors) {
      expect(err.type).toBe("error");
      expect(err.code).toBe("invalid_frame");
      expect(err.v).toBe(1);
    }

    // 四连拒后连接仍开：sync → history 应答。
    const histPromise = nextFrame<HistoryLike>(socket);
    socket.send(JSON.stringify({ v: 1, type: "sync", since: null }));
    expect((await histPromise).type).toBe("history");

    socket.close(1000, "done");
  });

  it("answered_by 随 by 自报（缺省 null）；answered_content 原文透传（RPL-02）", { timeout: 15_000 }, async () => {
    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(`rc6-${uniqueId().slice(0, 16)}`));
    const withOptions = await publishOne(stub, { text: "named reply", options: ["OK"] });
    const noOptions = await publishOne(stub, { text: "anonymous markdown reply" });
    const socket = await connect(stub);

    // 带 by：answered_by 为自报展示名（D-51——服务端不验证直接存）。
    const f1 = nextFrames(socket, 2);
    socket.send(replyFrame({ wid: withOptions.wid, selected_option: "OK", by: "运维笔记本" }));
    const [, ans1] = (await f1) as AnsweredLike[];
    expect(ans1.type).toBe("answered");
    expect(ans1.answered_by).toBe("运维笔记本");
    expect(ans1.answered_content).toBe("OK");

    // 不带 by：answered_by null（匿名回复，D-53）；自定义 text 的 Markdown
    // 原文透传（RPL-02——服务端哑管道，不转义不解析）。
    const f2 = nextFrames(socket, 2);
    socket.send(replyFrame({ wid: noOptions.wid, text: "custom **markdown** `reply`" }));
    const [, ans2] = (await f2) as AnsweredLike[];
    expect(ans2.type).toBe("answered");
    expect(ans2.answered_by).toBe(null);
    expect(ans2.answered_content).toBe("custom **markdown** `reply`");

    socket.close(1000, "done");
  });
});
