// @vitest-environment jsdom
/**
 * PushHub adapter 生命周期测试（02-02 Task 2，D-18 资源释放完备）。
 *
 * 覆盖 adapter 层接线（机器层语义已由 machine-*.test.ts 锁定，此处验证
 * 翻译正确性与资源释放）：
 *  - 心跳周期经 fake timers 真实走通：30s 一 ping，字节逐字等于服务端
 *    auto-response 匹配串（Pitfall 4 回归）；
 *  - visibilitychange 监听注册（D-27 探活入口）与页面回前台立即探活；
 *  - destroy()/disconnect() 后无残留定时器、监听移除、不再创建 socket。
 *
 * WebSocket 以 FakeWebSocket stub（记录 send/close，open 事件由测试手动触发）
 * ——jsdom 环境无真实 WS 服务端。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PushHub } from "../src/pushhub";
import { HEARTBEAT_INTERVAL_MS } from "../src/connection-machine";

const PING_LITERAL = '{"v":1,"type":"ping"}';

class FakeWebSocket {
  static readonly CONNECTING = 0 as const;
  static readonly OPEN = 1 as const;
  static readonly CLOSING = 2 as const;
  static readonly CLOSED = 3 as const;
  readyState = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly sent: string[] = [];
  closedWith: { code?: number; reason?: string } | null = null;
  constructor(public url: string) {}
  send(data: string): void {
    this.sent.push(data);
  }
  close(code?: number, reason?: string): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.closedWith = { code, reason };
  }
}

const instances: FakeWebSocket[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  instances.length = 0;
  const Recording = class extends FakeWebSocket {
    constructor(url: string) {
      super(url);
      instances.push(this);
    }
  };
  vi.stubGlobal("WebSocket", Recording);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function openHub(): { hub: PushHub; ws: FakeWebSocket } {
  const hub = new PushHub("http://127.0.0.1:4911", `phc_${"k".repeat(32)}`);
  expect(instances.length).toBe(1); // 构造即连（D-18）
  const ws = instances[0]!;
  ws.readyState = FakeWebSocket.OPEN;
  ws.onopen?.(); // → machine WS_OPEN → online + arm heartbeat
  return { hub, ws };
}

describe("心跳接线（fake timers 驱动真实 setTimeout）", () => {
  it("online 后每 30s 一 ping，字节逐字等于 auto-response 匹配串", () => {
    const { ws } = openHub();
    expect(ws.sent).toEqual([]); // open 后未立即 ping（等首个周期）
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    expect(ws.sent).toEqual([PING_LITERAL]);
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    expect(ws.sent).toEqual([PING_LITERAL, PING_LITERAL]);
  });

  it("意外 close（非 disconnect）→ 自动重连创建新 socket", () => {
    const { ws } = openHub();
    ws.readyState = FakeWebSocket.CLOSED;
    ws.onclose?.();
    vi.advanceTimersByTime(60_000); // 退避窗口（jitter 上限内）
    expect(instances.length).toBe(2); // 重连 socket 已创建
  });
});

describe("visibilitychange 接线（D-27 探活）", () => {
  it("构造注册监听；页面回前台（visible）→ 立即探活 ping", () => {
    const addSpy = vi.spyOn(document, "addEventListener");
    const { ws } = openHub();
    expect(addSpy).toHaveBeenCalledWith("visibilitychange", expect.any(Function));

    // jsdom 默认 visibilityState === "visible"：dispatch 即模拟回前台。
    document.dispatchEvent(new Event("visibilitychange"));
    expect(ws.sent).toEqual([PING_LITERAL]); // 探活 ping 立即发出（不等 30s 周期）
  });

  it("探活 ping 后 5s 死线：无 pong → 强制重连", () => {
    const { ws } = openHub();
    document.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(5_000); // PROBE_DEADLINE_MS
    expect(ws.closedWith).not.toBeNull(); // closeSocket(deadline) 已执行
    vi.advanceTimersByTime(60_000);
    expect(instances.length).toBe(2); // 自动重连
  });
});

describe("资源释放（D-18）", () => {
  it("destroy() → 定时器全清 + visibilitychange 移除 + status offline + 不再复活", () => {
    const removeSpy = vi.spyOn(document, "removeEventListener");
    const { hub, ws } = openHub();
    const statuses: string[] = [];
    hub.on("status", (s) => statuses.push(s));

    expect(vi.getTimerCount()).toBe(1); // heartbeat 在武
    hub.destroy();

    expect(vi.getTimerCount()).toBe(0); // 无残留定时器
    expect(removeSpy).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
    expect(statuses).toContain("offline");
    expect(ws.closedWith).not.toBeNull(); // 主动关闭已发起

    // 销毁后定时器不复活、不再创建 socket、事件不再发射。
    vi.advanceTimersByTime(120_000);
    expect(instances.length).toBe(1);
  });

  it("disconnect() → 停止重连（退避定时器清除），可再 connect 恢复", () => {
    const { hub, ws } = openHub();
    ws.readyState = FakeWebSocket.CLOSED;
    ws.onclose?.(); // 意外断开 → 退避武装
    hub.disconnect(); // 用户主动断开 → 取消退避
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(120_000);
    expect(instances.length).toBe(1); // 不重连

    hub.connect(); // 可恢复（D-18）
    expect(instances.length).toBe(2);
  });
});
