/**
 * 纯状态机 fatal 路径单测（02-02 Task 1，T-02-04 / D-07 客户端严格方向）。
 *
 * v !== 1 的帧（parseServerFrame 判 fatal）→ emitError(fatal:true) +
 * closeSocket + emitStatus("offline")；此后任何 TIMER / WS_CLOSE / FRAME
 * 都不再输出 createSocket（不重连——服务端比客户端新，重连无意义，Pitfall 10
 * 方向记忆：服务端宽容忽略坏帧，客户端严格即断）。
 * CONNECT 仍可手动恢复（02-01 语义保持：用户显式 connect() 清除 fatal 态）。
 */
import { describe, it, expect } from "vitest";
import { createMachine, type MachineAction } from "../src/connection-machine";
import { msgFrame } from "./helpers";

const FATAL_V2 = {
  ok: false as const,
  fatal: true as const,
  message: "unsupported protocol version: 2",
};

function online(): ReturnType<typeof createMachine> {
  const m = createMachine();
  m.input({ kind: "CONNECT" });
  m.input({ kind: "WS_OPEN" });
  return m;
}

describe("v!==1 fatal：断连 + 报错 + 不再重连（D-07）", () => {
  it("fatal 帧 → emitError(fatal) + closeSocket(fatal) + emitStatus offline", () => {
    const m = online();
    const acts = m.input({ kind: "FRAME", result: FATAL_V2 });

    const err = acts.find((a) => a.kind === "emitError");
    expect(err).toBeDefined();
    if (err?.kind === "emitError") {
      expect(err.error.fatal).toBe(true);
      expect(err.error.message).toContain("unsupported protocol version");
    }
    expect(
      acts.some((a) => a.kind === "closeSocket" && a.reason === "fatal"),
    ).toBe(true);
    expect(
      acts.some((a) => a.kind === "emitStatus" && a.status === "offline"),
    ).toBe(true);
  });

  it("fatal 后任何 TIMER 触发都不再 createSocket（心跳/死线/探活/重连全哑火）", () => {
    const m = online();
    m.input({ kind: "FRAME", result: FATAL_V2 });
    const followups: MachineAction[] = [
      ...m.input({ kind: "TIMER", timer: "heartbeat" }),
      ...m.input({ kind: "TIMER", timer: "pongDeadline" }),
      ...m.input({ kind: "TIMER", timer: "probe" }),
      ...m.input({ kind: "TIMER", timer: "reconnect" }),
    ];
    expect(followups.some((a) => a.kind === "createSocket")).toBe(false);
    // fatal 后机器不再产生任何动作（含定时器调度——不会自我复活）。
    expect(followups).toEqual([]);
  });

  it("fatal 后 WS_CLOSE（close 握手完成事件）零动作", () => {
    const m = online();
    m.input({ kind: "FRAME", result: FATAL_V2 });
    expect(m.input({ kind: "WS_CLOSE" })).toEqual([]);
  });

  it("fatal 后的 message 帧不投递（离线态不消费帧）", () => {
    const m = online();
    m.input({ kind: "FRAME", result: FATAL_V2 });
    expect(m.input({ kind: "FRAME", result: { ok: true, frame: msgFrame(1) } })).toEqual([]);
  });

  it("CONNECT 手动恢复：用户显式重连清除 fatal 态（02-01 语义保持）", () => {
    const m = online();
    m.input({ kind: "FRAME", result: FATAL_V2 });
    const acts = m.input({ kind: "CONNECT" });
    expect(acts.some((a) => a.kind === "createSocket")).toBe(true);
    expect(
      acts.some((a) => a.kind === "emitStatus" && a.status === "connecting"),
    ).toBe(true);
  });
});
