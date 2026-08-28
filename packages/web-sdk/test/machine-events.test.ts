/**
 * 纯状态机事件映射单测（02-02 Task 1，WEB-02/WEB-04）。
 *
 * Task 1 acceptance 四类映射 + 翻页硬上限：
 *  1. history 过滤投递：重连首拉 → emitHistory(messages 经去重过滤后) +
 *     sendSync(since=连接前游标 syncBase, limit=SYNC_LIMIT_DEFAULT)——
 *     "on(\"history\") 载荷的 messages 永远只含宿主未见消息"（D-16×D-17
 *     交集语义）且 oldest_kept_seq/has_more 原样透传（D-16 帧结构不加工）；
 *  2. message 去重：未见 seq → emitMessage；重复 seq → 零输出（D-17）；
 *  3. pong 死线重置：TIMER(heartbeat) → sendPing + arm(pongDeadline, 10s) +
 *     re-arm(heartbeat, 30s)；FRAME(pong) → cancel(pongDeadline)；
 *  4. 服务端 WsErrorFrame 透传（非致命，连接保持）与坏帧静默丢弃；
 *  5. SYNC_PAGE_MAX=100 翻页硬上限：超限放弃 + emitError（T-02-06 防异常
 *     死循环，prohibition 单测覆盖要求）；
 *  6. 04-03 answered/ack 映射：answered → 恰一 emitAnswered（去重路径之外）；
 *     ack → 零动作（Q4 静默消费）。
 */
import { describe, it, expect } from "vitest";
import {
  createMachine,
  HEARTBEAT_INTERVAL_MS,
  PONG_DEADLINE_MS,
  SYNC_PAGE_MAX,
  type MachineAction,
} from "../src/connection-machine";
import { msgFrame, historyFrame } from "./helpers";
import { SYNC_LIMIT_DEFAULT, type AnsweredFrame } from "@pushhub/shared";

/**
 * 04-03：最小合法 answered 帧（04-01 冻结字段集）——本地构造而非 fixtures
 * import：状态机测试关注帧→动作映射，帧守卫契约由 frames.test.ts 吃 golden
 * fixtures 独立锁定（helpers.ts 同款分工纪律）。
 */
function answeredFrame(overrides: Partial<AnsweredFrame> = {}): AnsweredFrame {
  return {
    v: 1,
    type: "answered",
    wid: "m_ansFrame000001",
    seq: 7,
    answered: true,
    answered_by: "运维笔记本",
    answered_at: 1_756_185_660_000,
    answered_content: "确认",
    ...overrides,
  };
}

function connectOnline(): ReturnType<typeof createMachine> {
  const m = createMachine();
  m.input({ kind: "CONNECT" });
  m.input({ kind: "WS_OPEN" });
  return m;
}

describe("history 过滤投递 + sendSync（D-16×D-17 交集）", () => {
  it("重连首拉：emitHistory 只含未见消息，oldest_kept_seq/has_more 原样，sendSync(since=连接前游标)", () => {
    const m = createMachine();
    m.input({ kind: "CONNECT" });
    // 第一段连接：实时见过 seq 1..10。
    m.input({ kind: "WS_OPEN" });
    for (let seq = 1; seq <= 10; seq++) {
      m.input({ kind: "FRAME", result: { ok: true, frame: msgFrame(seq) } });
    }
    // 意外断连 → 退避 → 重连成功。
    m.input({ kind: "WS_CLOSE" });
    m.input({ kind: "TIMER", timer: "reconnect" });
    const openActs = m.input({ kind: "WS_OPEN" });
    expect(openActs).toEqual([
      { kind: "schedule", timer: "heartbeat", delayMs: HEARTBEAT_INTERVAL_MS },
      { kind: "emitStatus", status: "online" },
    ]);

    // 服务端 accept 即重推最近若干条（此处 8..15，交叠 8..10 已见）。
    const batch = [];
    for (let seq = 8; seq <= 15; seq++) batch.push(msgFrame(seq));
    const acts = m.input({
      kind: "FRAME",
      result: { ok: true, frame: historyFrame(batch, 8, false) },
    });

    const hist = acts.find((a) => a.kind === "emitHistory");
    expect(hist).toBeDefined();
    if (hist?.kind === "emitHistory") {
      expect(hist.frame.messages.map((x) => x.seq)).toEqual([11, 12, 13, 14, 15]);
      expect(hist.frame.oldest_kept_seq).toBe(8); // 原样透传（D-16）
      expect(hist.frame.has_more).toBe(false); // 原样透传（D-16）
    }
    const sync = acts.find((a) => a.kind === "sendSync");
    expect(sync).toBeDefined();
    if (sync?.kind === "sendSync") {
      expect(sync.since).toBe(10); // syncBase：WS_OPEN 瞬间的游标快照（02-01 决策 #5）
      expect(sync.limit).toBe(SYNC_LIMIT_DEFAULT);
    }
  });

  it("翻页：has_more=true 的后续 history → sendSync(since=dedup.last) 续翻", () => {
    const m = connectOnline();
    // 首拉（has_more=true）→ 无条件 sync since=syncBase=0。
    let acts = m.input({
      kind: "FRAME",
      result: { ok: true, frame: historyFrame([msgFrame(1), msgFrame(2)], 1, true) },
    });
    let sync = acts.filter((a) => a.kind === "sendSync");
    expect(sync.length).toBe(1);
    if (sync[0]?.kind === "sendSync") expect(sync[0].since).toBe(0);

    // 翻页响应（3..5，has_more=true）→ 以本批最大 seq 为新 since。
    acts = m.input({
      kind: "FRAME",
      result: { ok: true, frame: historyFrame([msgFrame(3), msgFrame(4), msgFrame(5)], 1, true) },
    });
    sync = acts.filter((a) => a.kind === "sendSync");
    expect(sync.length).toBe(1);
    if (sync[0]?.kind === "sendSync") expect(sync[0].since).toBe(5);

    // 追平（has_more=false）→ 不再 sync。
    acts = m.input({
      kind: "FRAME",
      result: { ok: true, frame: historyFrame([msgFrame(6)], 1, false) },
    });
    expect(acts.some((a) => a.kind === "sendSync")).toBe(false);
    expect(acts.some((a) => a.kind === "emitHistory")).toBe(true);
  });

  it("SYNC_PAGE_MAX=100：连续 has_more 翻页达上限后放弃并 emitError（T-02-06）", () => {
    expect(SYNC_PAGE_MAX).toBe(100);
    const m = connectOnline();
    // 首拉 has_more=true → syncCount=1。
    let acts = m.input({
      kind: "FRAME",
      result: { ok: true, frame: historyFrame([msgFrame(1)], 1, true) },
    });
    expect(acts.filter((a) => a.kind === "sendSync").length).toBe(1);
    // 再翻 99 页（syncCount 2..100）——每批恰一个 sendSync。
    for (let i = 2; i <= 100; i++) {
      acts = m.input({
        kind: "FRAME",
        result: { ok: true, frame: historyFrame([msgFrame(i)], 1, true) },
      });
      expect(acts.filter((a) => a.kind === "sendSync").length).toBe(1);
    }
    // 第 101 批仍 has_more=true → 放弃：emitError、零 sendSync。
    acts = m.input({
      kind: "FRAME",
      result: { ok: true, frame: historyFrame([msgFrame(101)], 1, true) },
    });
    expect(acts.filter((a) => a.kind === "sendSync").length).toBe(0);
    const err = acts.find((a) => a.kind === "emitError");
    expect(err).toBeDefined();
    if (err?.kind === "emitError") {
      expect(err.error.code).toBe("sync_page_limit");
      expect(err.error.fatal).toBeUndefined(); // 非致命：连接保持，只放弃翻页
    }
    // 放弃后正常收尾（has_more=false）仍照常投递。
    acts = m.input({
      kind: "FRAME",
      result: { ok: true, frame: historyFrame([], 1, false) },
    });
    expect(acts.some((a) => a.kind === "emitHistory")).toBe(true);
    expect(acts.some((a) => a.kind === "sendSync")).toBe(false);
  });
});

describe("message 去重（D-17 宿主永不见重复）", () => {
  it("未见 seq → emitMessage；重复 seq → 零输出", () => {
    const m = connectOnline();
    // 吃掉首拉（空频道）避免 sendSync 干扰断言。
    m.input({ kind: "FRAME", result: { ok: true, frame: historyFrame([], 0, false) } });

    const a1 = m.input({ kind: "FRAME", result: { ok: true, frame: msgFrame(1) } });
    expect(a1.filter((a) => a.kind === "emitMessage").length).toBe(1);

    const a2 = m.input({ kind: "FRAME", result: { ok: true, frame: msgFrame(1) } });
    expect(a2).toEqual([]);
  });
});

describe("pong 死线重置（心跳机制）", () => {
  it("TIMER(heartbeat) → sendPing + arm(pongDeadline,10s) + re-arm(heartbeat,30s)", () => {
    const m = connectOnline();
    const acts = m.input({ kind: "TIMER", timer: "heartbeat" });
    expect(acts.some((a) => a.kind === "sendPing")).toBe(true);
    expect(
      acts.some(
        (a) =>
          a.kind === "schedule" && a.timer === "pongDeadline" && a.delayMs === PONG_DEADLINE_MS,
      ),
    ).toBe(true);
    expect(
      acts.some(
        (a) =>
          a.kind === "schedule" && a.timer === "heartbeat" && a.delayMs === HEARTBEAT_INTERVAL_MS,
      ),
    ).toBe(true);
  });

  it("FRAME(pong) → cancel(pongDeadline)，且不误伤心跳周期", () => {
    const m = connectOnline();
    m.input({ kind: "TIMER", timer: "heartbeat" }); // 武装 pongDeadline
    const acts = m.input({ kind: "FRAME", result: { ok: true, frame: { v: 1, type: "pong" } } });
    expect(acts.some((a) => a.kind === "cancel" && a.timer === "pongDeadline")).toBe(true);
    expect(acts.some((a) => a.kind === "cancel" && a.timer === "heartbeat")).toBe(false);
  });
});

describe("error 帧透传与坏帧丢弃", () => {
  it("服务端 WsErrorFrame → emitError 透传（非致命，连接保持）", () => {
    const m = connectOnline();
    const acts = m.input({
      kind: "FRAME",
      result: {
        ok: true,
        frame: { v: 1, type: "error", code: "invalid_frame", message: "Ignored malformed frame." },
      },
    });
    const err = acts.find((a) => a.kind === "emitError");
    expect(err).toBeDefined();
    if (err?.kind === "emitError") {
      expect(err.error.code).toBe("invalid_frame");
      expect(err.error.message).toBe("Ignored malformed frame.");
      expect(err.error.fatal).toBeUndefined();
    }
    expect(acts.some((a) => a.kind === "closeSocket" || a.kind === "emitStatus")).toBe(false);
  });

  it("非致命坏帧（不可解析/结构违例）→ 静默零动作", () => {
    const m = connectOnline();
    expect(
      m.input({ kind: "FRAME", result: { ok: false, fatal: false, message: "unparseable frame" } }),
    ).toEqual([]);
  });
});

describe("04-03：answered/ack 帧→动作映射（reply 闭环）", () => {
  it("answered 帧 → 恰一个 emitAnswered 动作且携带原帧", () => {
    const m = connectOnline();
    // 吃掉首拉（空频道）避免 sendSync 干扰断言。
    m.input({ kind: "FRAME", result: { ok: true, frame: historyFrame([], 0, false) } });
    const f = answeredFrame();
    const acts = m.input({ kind: "FRAME", result: { ok: true, frame: f } });
    const emitted = acts.filter((a) => a.kind === "emitAnswered");
    expect(emitted.length).toBe(1);
    if (emitted[0]?.kind === "emitAnswered") {
      expect(emitted[0].frame).toEqual(f); // 原帧逐字段透传（D-16 帧不加工）
    }
  });

  it("ack 帧 → 零动作输出（Q4 定稿：ack 静默消费，无公共事件）", () => {
    const m = connectOnline();
    m.input({ kind: "FRAME", result: { ok: true, frame: historyFrame([], 0, false) } });
    const acts = m.input({
      kind: "FRAME",
      result: { ok: true, frame: { v: 1, type: "ack", wid: "m_ansFrame000001" } },
    });
    expect(acts).toEqual([]);
  });

  it("同 wid 两次 answered 帧 → 两次 emitAnswered（answered 路径与 SeqDedup 完全隔离）", () => {
    const m = connectOnline();
    m.input({ kind: "FRAME", result: { ok: true, frame: historyFrame([], 0, false) } });
    const f = answeredFrame();
    const a1 = m.input({ kind: "FRAME", result: { ok: true, frame: f } });
    const a2 = m.input({ kind: "FRAME", result: { ok: true, frame: f } });
    expect(a1.filter((a) => a.kind === "emitAnswered").length).toBe(1);
    expect(a2.filter((a) => a.kind === "emitAnswered").length).toBe(1);
  });
});
