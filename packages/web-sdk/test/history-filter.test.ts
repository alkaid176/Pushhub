/**
 * D-16×D-17 交集语义完整测试（02-02 Task 2，02-01 开放问题 2 定稿）。
 *
 * 契约措辞（02-03 将写入 README API 文档）：
 *   "on(\"history\") 载荷的 messages 永远只含宿主未见消息"；
 *   帧类型/字段/oldest_kept_seq/has_more 原样透传（D-16 无 SDK 私有加工）。
 * shouldDeliver 是 message 与 history 双路径的唯一过滤闸门（T-02-07：
 * 构造交叠批次不能把重复消息送进宿主）。
 */
import { describe, it, expect } from "vitest";
import { createMachine, type MachineAction } from "../src/connection-machine";
import { msgFrame, historyFrame } from "./helpers";

/** 建立在线连接并预置已见 seq（实时 message 帧逐条喂入）。 */
function onlineWithSeen(seqs: number[]): ReturnType<typeof createMachine> {
  const m = createMachine();
  m.input({ kind: "CONNECT" });
  m.input({ kind: "WS_OPEN" });
  for (const seq of seqs) {
    m.input({ kind: "FRAME", result: { ok: true, frame: msgFrame(seq) } });
  }
  return m;
}

/** 宿主视角收集：emitMessage 与 emitHistory.messages 的全部 seq。 */
function collectHostSeqs(acts: MachineAction[], sink: number[]): void {
  for (const a of acts) {
    if (a.kind === "emitMessage") sink.push(a.message.seq);
    if (a.kind === "emitHistory") {
      for (const m of a.frame.messages) sink.push(m.seq);
    }
  }
}

describe("交叠批次过滤（D-16×D-17 交集唯一实现点）", () => {
  it("预置已见 {1..30}，喂 history {20..50} → messages 恰为 {31..50}，oldest_kept_seq/has_more 原样", () => {
    const m = onlineWithSeen(Array.from({ length: 30 }, (_, i) => 1 + i));
    const batch = [];
    for (let seq = 20; seq <= 50; seq++) batch.push(msgFrame(seq));

    const acts = m.input({
      kind: "FRAME",
      result: { ok: true, frame: historyFrame(batch, 20, true) },
    });

    const hist = acts.find((a) => a.kind === "emitHistory");
    expect(hist).toBeDefined();
    if (hist?.kind === "emitHistory") {
      expect(hist.frame.messages.map((x) => x.seq)).toEqual(
        Array.from({ length: 20 }, (_, i) => 31 + i),
      );
      // 帧结构原样透传（D-16：无 SDK 私有加工）。
      expect(hist.frame.oldest_kept_seq).toBe(20);
      expect(hist.frame.has_more).toBe(true);
      expect(hist.frame.v).toBe(1);
      expect(hist.frame.type).toBe("history");
    }
  });

  it("全批已见的 history → messages 为空数组但帧仍发出（D-10 分隔线语义保留）", () => {
    const m = onlineWithSeen([5, 6, 7]);
    const acts = m.input({
      kind: "FRAME",
      result: { ok: true, frame: historyFrame([msgFrame(5), msgFrame(6), msgFrame(7)], 5, false) },
    });
    const hist = acts.find((a) => a.kind === "emitHistory");
    expect(hist).toBeDefined();
    if (hist?.kind === "emitHistory") {
      expect(hist.frame.messages).toEqual([]);
      expect(hist.frame.oldest_kept_seq).toBe(5);
      expect(hist.frame.has_more).toBe(false);
    }
  });
});

describe("完整重连序列宿主零重复（T-02-07 / D-17）", () => {
  it("实时 1..30 → 断连 → 重连首拉 1..35 交叠 → 宿主恰见 1..35 无重复", () => {
    const m = createMachine();
    m.input({ kind: "CONNECT" });
    const hostSeqs: number[] = [];

    // 第一段连接：实时收 1..30。
    collectHostSeqs(m.input({ kind: "WS_OPEN" }), hostSeqs);
    for (let seq = 1; seq <= 30; seq++) {
      collectHostSeqs(m.input({ kind: "FRAME", result: { ok: true, frame: msgFrame(seq) } }), hostSeqs);
    }

    // 意外断连 → 退避 → 重连（服务端部署断连场景）。
    m.input({ kind: "WS_CLOSE" });
    m.input({ kind: "TIMER", timer: "reconnect" });
    collectHostSeqs(m.input({ kind: "WS_OPEN" }), hostSeqs);

    // 重连首拉：服务端重推最近 50（此处 1..35，前 30 已见）。
    const batch = [];
    for (let seq = 1; seq <= 35; seq++) batch.push(msgFrame(seq));
    const openActs = m.input({
      kind: "FRAME",
      result: { ok: true, frame: historyFrame(batch, 1, false) },
    });
    collectHostSeqs(openActs, hostSeqs);

    // 首拉后无条件 sync（since=连接前游标 30）返回 31..35 再交叠一次。
    const sync = openActs.find((a) => a.kind === "sendSync");
    expect(sync).toBeDefined();
    if (sync?.kind === "sendSync") expect(sync.since).toBe(30);
    collectHostSeqs(
      m.input({
        kind: "FRAME",
        result: {
          ok: true,
          frame: historyFrame(
            Array.from({ length: 5 }, (_, i) => msgFrame(31 + i)),
            1,
            false,
          ),
        },
      }),
      hostSeqs,
    );

    // 宿主视角：恰 1..35 各一次，零重复（Set 尺寸 = 数组长度）。
    expect(hostSeqs).toEqual(Array.from({ length: 35 }, (_, i) => 1 + i));
    expect(new Set(hostSeqs).size).toBe(hostSeqs.length);
  });
});
