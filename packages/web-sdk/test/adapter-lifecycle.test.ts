// @vitest-environment jsdom
/**
 * PushHub adapter 生命周期测试（02-02 Task 2，D-18 资源释放完备）。
 *
 * 覆盖 adapter 层接线（机器层语义已由 machine-*.test.ts 锁定，此处验证
 * 翻译正确性与资源释放）：
 *  - 心跳周期经 fake timers 真实走通：30s 一 ping，字节逐字等于服务端
 *    auto-response 匹配串（Pitfall 4 回归）；pong 回喂后死线解除周期存活；
 *  - visibilitychange 监听注册（D-27 探活入口）与页面回前台立即探活；
 *  - destroy()/disconnect() 后无残留定时器、监听移除、不再创建 socket；
 *  - 畸形 serverUrl（WebSocket 构造同步抛）容错（02-04 WR-04）：构造不抛，
 *    延迟一跳后 error(fatal) + status offline，fatal 不重连；
 *  - 04-03 reply()/answered 接线：online 发帧（恰一载荷字节断言）、
 *    connecting/offline fail-fast（not_connected）、载荷同真/同假本地拒绝
 *    （invalid_frame）、answered 入站分发与 ack 全静默（Q4）。
 *
 * WebSocket 以 FakeWebSocket stub（记录 send/close，open/pong 事件由测试
 * 手动触发）——jsdom 环境无真实 WS 服务端。
 *
 * 纪律：每个用例结尾 destroy——泄漏的 hub 会把 visibilitychange handler
 * 留在 document 上跨用例串扰（D-18 同款问题，测试侧也必须守约）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PushHub } from "../src/pushhub";
import { HEARTBEAT_INTERVAL_MS } from "../src/connection-machine";
import answeredPositive from "@pushhub/shared/fixtures/answered-frame.positive.json";

const PING_LITERAL = '{"v":1,"type":"ping"}';
const PONG_LITERAL = '{"v":1,"type":"pong"}';

class FakeWebSocket {
  static readonly CONNECTING = 0 as const;
  static readonly OPEN = 1 as const;
  static readonly CLOSING = 2 as const;
  static readonly CLOSED = 3 as const;
  readyState: number = FakeWebSocket.CONNECTING;
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
let activeHub: PushHub | null = null;

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
  activeHub?.destroy();
  activeHub = null;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function openHub(): { hub: PushHub; ws: FakeWebSocket } {
  const hub = new PushHub("http://127.0.0.1:4911", `phc_${"k".repeat(32)}`);
  activeHub = hub;
  expect(instances.length).toBe(1); // 构造即连（D-18）
  const ws = instances[0]!;
  ws.readyState = FakeWebSocket.OPEN;
  ws.onopen?.(); // → machine WS_OPEN → online + arm heartbeat
  return { hub, ws };
}

describe("心跳接线（fake timers 驱动真实 setTimeout）", () => {
  it("online 后每 30s 一 ping（pong 回喂解除死线），字节逐字等于 auto-response 匹配串", () => {
    const { ws } = openHub();
    expect(ws.sent).toEqual([]); // open 后未立即 ping（等首个周期）
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    expect(ws.sent).toEqual([PING_LITERAL]);
    // 服务端 auto-response 回 pong（零唤醒）——pongDeadline 解除，周期存活。
    ws.onmessage?.({ data: PONG_LITERAL });
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    expect(ws.sent).toEqual([PING_LITERAL, PING_LITERAL]);
  });

  it("意外 close（非 disconnect）→ 自动重连创建新 socket", () => {
    const { ws } = openHub();
    ws.readyState = FakeWebSocket.CLOSED;
    ws.onclose?.();
    vi.advanceTimersByTime(60_000); // 退避窗口（jitter 上限 500ms 内）
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
    expect(instances.length).toBe(2); // 自动重连恰一次
  });
});

describe("畸形 serverUrl 容错（WR-04，02-04）", () => {
  it("WebSocket 构造抛 SyntaxError：构造不抛，延迟一跳后 error(fatal, connect_failed) + status offline，不再创建 socket", () => {
    let constructions = 0;
    vi.stubGlobal(
      "WebSocket",
      class {
        constructor(_url: string) {
          constructions += 1;
          throw new SyntaxError("invalid url");
        }
      },
    );
    const key = `phc_${"k".repeat(32)}`;
    const hub = new PushHub("not a url", key); // 构造不抛（WR-04 核心）
    activeHub = hub;

    const errors: Array<{ message: string; code?: string; fatal?: boolean }> = [];
    const statuses: string[] = [];
    hub.on("error", (e) => errors.push(e));
    hub.on("status", (s) => statuses.push(s));

    // 构造期同步零事件——延迟一跳派发保证宿主 on() 注册先于事件（D-18 时序）。
    expect(errors).toEqual([]);
    expect(statuses).toEqual([]);

    vi.advanceTimersByTime(0); // 触发 setTimeout(..., 0)
    expect(constructions).toBe(1); // 恰一次构造尝试
    expect(errors.length).toBe(1);
    expect(errors[0].fatal).toBe(true);
    expect(errors[0].code).toBe("connect_failed");
    // 密钥纪律：错误文案不含 Channel Key 子串（wsUrl 路径段含密钥，不得内嵌）。
    expect(errors[0].message).not.toContain("phc_");
    expect(errors[0].message).not.toContain(key);
    expect(statuses).toEqual(["offline"]);

    // fatal 不重连：长窗口内不再创建新 socket、不再追加错误。
    vi.advanceTimersByTime(120_000);
    expect(constructions).toBe(1);
    expect(errors.length).toBe(1);
    expect(vi.getTimerCount()).toBe(0); // 无残留定时器
  });
});

describe("04-03 reply() 发送与 fail-fast（WEB-03，Pattern 7——reply 不进状态机）", () => {
  it("online 回复 selected_option + by：恰一次 send，帧 v/type/wid + 恰一载荷键 + by", () => {
    const { hub, ws } = openHub();
    hub.reply("wid1", { selected_option: "确认" }, "运维笔记本");
    expect(ws.sent.length).toBe(1);
    // toEqual 深比较双向：多余/缺失键均失败——同时锁定恰一载荷与 by 在位。
    expect(JSON.parse(ws.sent[0]!)).toEqual({
      v: 1,
      type: "reply",
      wid: "wid1",
      selected_option: "确认",
      by: "运维笔记本",
    });
  });

  it("text 变体（匿名）：帧含 text、无 selected_option、无 by 键", () => {
    const { hub, ws } = openHub();
    hub.reply("wid1", { text: "**done**" });
    expect(ws.sent.length).toBe(1);
    expect(JSON.parse(ws.sent[0]!)).toEqual({
      v: 1,
      type: "reply",
      wid: "wid1",
      text: "**done**",
    });
  });

  it("fail-fast（connecting）：构造未 open 即 reply → error(not_connected)，不 send，不抛异常", () => {
    const hub = new PushHub("http://127.0.0.1:4911", `phc_${"k".repeat(32)}`);
    activeHub = hub;
    expect(instances.length).toBe(1); // 构造即连（socket 已建、未 open）
    const errors: Array<{ message: string; code?: string; fatal?: boolean }> = [];
    hub.on("error", (e) => errors.push(e));
    expect(() => hub.reply("wid1", { text: "hi" })).not.toThrow();
    expect(instances[0]!.sent).toEqual([]); // 不排队不发帧
    expect(errors.length).toBe(1);
    expect(errors[0].code).toBe("not_connected");
  });

  it("fail-fast（offline）：disconnect 后 reply → error(not_connected)，不 send，不抛异常", () => {
    const { hub, ws } = openHub();
    hub.disconnect();
    const errors: Array<{ message: string; code?: string; fatal?: boolean }> = [];
    hub.on("error", (e) => errors.push(e));
    expect(() => hub.reply("wid1", { text: "hi" })).not.toThrow();
    expect(ws.sent).toEqual([]);
    expect(errors.length).toBe(1);
    expect(errors[0].code).toBe("not_connected");
  });

  it("本地防御：载荷同真或同假 → error(invalid_frame)，不 send（服务端权威校验的前置）", () => {
    const { hub, ws } = openHub();
    const errors: Array<{ message: string; code?: string }> = [];
    hub.on("error", (e) => errors.push(e));
    // SDK 以 JS 分发（IIFE 产物），宿主可能传入类型外载荷——运行时防御必须独立于类型层。
    hub.reply("w", { selected_option: "a", text: "b" } as { selected_option: string }); // 同真
    hub.reply("w", {} as { text: string }); // 同假
    expect(errors.length).toBe(2);
    expect(errors.map((e) => e.code)).toEqual(["invalid_frame", "invalid_frame"]);
    expect(ws.sent).toEqual([]);
  });

  it("answered 帧入站 → on(\"answered\") 收到帧；ack 帧入站 → 五事件全静默（Q4）", () => {
    const { hub, ws } = openHub();
    const counts = { message: 0, history: 0, status: 0, error: 0, answered: 0 };
    hub.on("message", () => counts.message++);
    hub.on("history", () => counts.history++);
    hub.on("status", () => counts.status++);
    hub.on("error", () => counts.error++);
    const received: unknown[] = [];
    hub.on("answered", (f) => {
      counts.answered++;
      received.push(f);
    });

    // ack 入站：无任何公共事件（answered 扇出即公共确认信号，Q4 定稿）。
    ws.onmessage?.({ data: '{"v":1,"type":"ack","wid":"m_2E9fKm3PqR7vXyZa"}' });
    expect(counts).toEqual({ message: 0, history: 0, status: 0, error: 0, answered: 0 });

    // answered 入站（04-01 冻结 fixture 第一条：自报展示名形态）。
    ws.onmessage?.({ data: JSON.stringify(answeredPositive[0]) });
    expect(counts).toEqual({ message: 0, history: 0, status: 0, error: 0, answered: 1 });
    const a = received[0] as {
      wid: string;
      seq: number;
      answered_by: string | null;
      answered_at: number;
      answered_content: string | null;
    };
    expect(a.wid).toBe("m_2E9fKm3PqR7vXyZa");
    expect(a.seq).toBe(42);
    expect(a.answered_by).toBe("运维笔记本");
    expect(a.answered_at).toBe(1756185660000);
    expect(a.answered_content).toBe("Acknowledge");
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
    activeHub = null; // 已销毁，afterEach 不再重复 destroy

    expect(vi.getTimerCount()).toBe(0); // 无残留定时器
    expect(removeSpy).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
    expect(statuses).toContain("offline");
    expect(ws.closedWith).not.toBeNull(); // 主动关闭已发起

    // 销毁后定时器不复活、不再创建 socket。
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
