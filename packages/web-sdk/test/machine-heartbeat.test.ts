/**
 * 纯状态机心跳/死线/探活时序单测（02-02 Task 2，D-27 / T-02-08）。
 *
 * 三组时序（Task 2 acceptance：30s ping、10s pong 死线、5s 探活死线）：
 *  - pong 死线：TIMER(heartbeat) 武装 pongDeadline(10s) → 无 pong →
 *    TIMER(pongDeadline) → closeSocket(deadline) + reconnecting + 退避
 *    schedule（NAT/中间设备超时后的假活连接强制重连，T-02-08）；
 *  - 探活（D-27）：VISIBILITY(visible) → 立即 sendPing + schedule(probe,
 *    5s)；5s 内 pong → cancel(probe) 无重连；超时 → 强制重连续补拉——
 *    iOS 冻结恢复路径（逻辑完备不依赖真机验证）；
 *  - VISIBILITY(hidden) → 取消心跳周期（页面冻结省额度，恢复时探活接管）；
 *  - DESTROY → 全部在武定时器清除（D-18 资源释放，机器层）。
 */
import { describe, it, expect } from "vitest";
import {
  createMachine,
  HEARTBEAT_INTERVAL_MS,
  PONG_DEADLINE_MS,
  PROBE_DEADLINE_MS,
  type MachineAction,
  type TimerKind,
} from "../src/connection-machine";
import { msgFrame } from "./helpers";

function online(random: () => number = () => 0.5): ReturnType<typeof createMachine> {
  const m = createMachine({ random });
  m.input({ kind: "CONNECT" });
  m.input({ kind: "WS_OPEN" });
  return m;
}

function hasSchedule(
  acts: MachineAction[],
  timer: TimerKind,
  delayMs?: number,
): boolean {
  return acts.some(
    (a) =>
      a.kind === "schedule" &&
      a.timer === timer &&
      (delayMs === undefined || a.delayMs === delayMs),
  );
}

describe("心跳周期与 pong 死线（T-02-08 假活防线）", () => {
  it("常量锁定：30s 心跳 / 10s pong 死线 / 5s 探活死线", () => {
    expect(HEARTBEAT_INTERVAL_MS).toBe(30_000);
    expect(PONG_DEADLINE_MS).toBe(10_000);
    expect(PROBE_DEADLINE_MS).toBe(5_000);
  });

  it("pong 死线超时 → closeSocket(deadline) + reconnecting + 退避 schedule，心跳停摆", () => {
    const m = online(() => 0.5); // attempt=0 → 退避 delay = 0.5*500 = 250
    m.input({ kind: "TIMER", timer: "heartbeat" }); // sendPing + 武装 pongDeadline
    const acts = m.input({ kind: "TIMER", timer: "pongDeadline" });

    expect(acts.some((a) => a.kind === "closeSocket" && a.reason === "deadline")).toBe(true);
    expect(acts.some((a) => a.kind === "emitStatus" && a.status === "reconnecting")).toBe(true);
    expect(hasSchedule(acts, "reconnect", 250)).toBe(true);
    expect(acts.some((a) => a.kind === "cancel" && a.timer === "heartbeat")).toBe(true);
    // close 握手完成后迟到的 WS_CLOSE 不二次调度（deadline 路径已接管）。
    expect(m.input({ kind: "WS_CLOSE" })).toEqual([]);
  });

  it("pong 到达解除死线后，TIMER(pongDeadline) 为幽灵事件零动作", () => {
    const m = online();
    m.input({ kind: "TIMER", timer: "heartbeat" }); // 武装 pongDeadline
    m.input({ kind: "FRAME", result: { ok: true, frame: { v: 1, type: "pong" } } }); // 取消
    expect(m.input({ kind: "TIMER", timer: "pongDeadline" })).toEqual([]);
  });
});

describe("visibilitychange 探活（D-27）", () => {
  it("VISIBILITY(visible) → 立即 sendPing + schedule(probe, 5_000)，不断连", () => {
    const m = online();
    const acts = m.input({ kind: "VISIBILITY", visible: true });
    expect(acts.some((a) => a.kind === "sendPing")).toBe(true);
    expect(hasSchedule(acts, "probe", PROBE_DEADLINE_MS)).toBe(true);
    expect(acts.some((a) => a.kind === "closeSocket")).toBe(false);
    expect(acts.some((a) => a.kind === "emitStatus")).toBe(false);
  });

  it("探活 5s 内 pong → cancel(probe)，保持 online 无重连", () => {
    const m = online();
    m.input({ kind: "VISIBILITY", visible: true });
    const acts = m.input({ kind: "FRAME", result: { ok: true, frame: { v: 1, type: "pong" } } });
    expect(acts.some((a) => a.kind === "cancel" && a.timer === "probe")).toBe(true);
    expect(acts.some((a) => a.kind === "closeSocket")).toBe(false);
    expect(acts.some((a) => a.kind === "emitStatus")).toBe(false);
    // probe 已解除：幽灵 TIMER(probe) 零动作。
    expect(m.input({ kind: "TIMER", timer: "probe" })).toEqual([]);
  });

  it("探活超时 → 强制重连（closeSocket(deadline) + reconnecting + 退避）", () => {
    const m = online(() => 0.5);
    m.input({ kind: "VISIBILITY", visible: true });
    const acts = m.input({ kind: "TIMER", timer: "probe" });
    expect(acts.some((a) => a.kind === "closeSocket" && a.reason === "deadline")).toBe(true);
    expect(acts.some((a) => a.kind === "emitStatus" && a.status === "reconnecting")).toBe(true);
    expect(hasSchedule(acts, "reconnect", 250)).toBe(true);
  });

  it("强制重连恢复 online 后探活路径可重复使用", () => {
    const m = online(() => 0.5);
    m.input({ kind: "VISIBILITY", visible: true });
    m.input({ kind: "TIMER", timer: "probe" }); // 判死线
    m.input({ kind: "TIMER", timer: "reconnect" }); // 退避到点重试
    m.input({ kind: "WS_OPEN" }); // 恢复 online（attempt 归零）
    const acts = m.input({ kind: "VISIBILITY", visible: true });
    expect(acts.some((a) => a.kind === "sendPing")).toBe(true);
    expect(hasSchedule(acts, "probe", PROBE_DEADLINE_MS)).toBe(true);
  });

  it("探活 ping 期间收到消息帧照常投递（探活不阻塞业务）", () => {
    const m = online();
    m.input({ kind: "VISIBILITY", visible: true });
    const acts = m.input({ kind: "FRAME", result: { ok: true, frame: msgFrame(1) } });
    expect(acts.some((a) => a.kind === "emitMessage")).toBe(true);
  });
});

describe("VISIBILITY(hidden) 取消心跳周期（页面冻结省额度）", () => {
  it("hidden → cancel(heartbeat)，迟到的 heartbeat 幽灵不产 ping", () => {
    const m = online(); // WS_OPEN 已 arm heartbeat
    const acts = m.input({ kind: "VISIBILITY", visible: false });
    expect(acts.some((a) => a.kind === "cancel" && a.timer === "heartbeat")).toBe(true);
    expect(m.input({ kind: "TIMER", timer: "heartbeat" })).toEqual([]);
  });

  it("hidden 期间挂起的探活一并取消", () => {
    const m = online();
    m.input({ kind: "VISIBILITY", visible: true }); // arm probe
    const acts = m.input({ kind: "VISIBILITY", visible: false });
    expect(acts.some((a) => a.kind === "cancel" && a.timer === "probe")).toBe(true);
    expect(m.input({ kind: "TIMER", timer: "probe" })).toEqual([]);
  });

  it("非 online 态的 VISIBILITY 零动作（reconnecting 期间探活无意义）", () => {
    const m = createMachine({ random: () => 0.5 });
    m.input({ kind: "CONNECT" });
    m.input({ kind: "WS_CLOSE" }); // → reconnecting
    expect(m.input({ kind: "VISIBILITY", visible: true })).toEqual([]);
    expect(m.input({ kind: "VISIBILITY", visible: false })).toEqual([]);
  });
});

describe("DESTROY 清除全部在武定时器（D-18 机器层）", () => {
  it("heartbeat + pongDeadline 在武时 DESTROY → 全部 cancel + offline，此后零动作", () => {
    const m = online();
    m.input({ kind: "TIMER", timer: "heartbeat" }); // arm pongDeadline
    const acts = m.input({ kind: "DESTROY" });
    expect(acts.some((a) => a.kind === "cancel" && a.timer === "heartbeat")).toBe(true);
    expect(acts.some((a) => a.kind === "cancel" && a.timer === "pongDeadline")).toBe(true);
    expect(acts.some((a) => a.kind === "emitStatus" && a.status === "offline")).toBe(true);
    for (const timer of ["reconnect", "heartbeat", "pongDeadline", "probe"] as const) {
      expect(m.input({ kind: "TIMER", timer })).toEqual([]);
    }
    expect(m.input({ kind: "CONNECT" })).toEqual([]); // destroyed 不可复活
  });
});
