/**
 * PushHub —— Web SDK 公开 API 类（02-01 tracer，02-02 重构为状态机 adapter）。
 *
 * 公开契约（Task 2 checkpoint:decision 用户裁决 approve-recommended，one-way）：
 *  - 构造函数恰两参 new PushHub(serverUrl, channelKey)，构造即自动连接（D-18）；
 *  - on 四事件（D-16）：message（实时帧逐条）/ history（补拉批次，messages
 *    已按去重窗口过滤——D-16×D-17 交集语义：宿主永不见重复消息，帧结构
 *    oldest_kept_seq/has_more 原样透传）/ status / error；
 *  - status 枚举 "connecting" | "online" | "reconnecting" | "offline"；
 *  - error 载荷 { message: string; code?: string; fatal?: boolean }；
 *  - connect() / disconnect() / destroy()；静态 PushHub.renderMarkdown(text)
 *    （D-19 纯函数辅助，SDK 无 UI 无 DOM 所有权）。
 *
 * 02-02 架构（connection-machine.ts 纯状态机 + 本文件薄 adapter）：
 *  - WS onopen/onclose/onmessage、定时器到点全部翻译为 machine.input 事件；
 *  - machine 输出动作映射到真实 WebSocket / setTimeout / on 回调发射；
 *  - 退避曲线、fatal、去重、重连确定序列、心跳死线全部语义在纯状态机层
 *    单测全覆盖（machine-*.test.ts）——本文件只做接线，Phase 5 Tauri
 *    移植按同构方式对接 Rust 状态机。
 *
 * 关键实现锚点（全部 read-source 核实）：
 *  - PING 字符串常量逐字节等于服务端 setWebSocketAutoResponse 匹配串
 *    （packages/server/src/chat-room.ts:44，Pitfall 4：运行时对象序列化会
 *    键序反转导致 auto-response 失配，烧请求额度）；
 *  - 服务端 accept 即推首拉 history（最近 50 条，chat-room.ts:377）——
 *    机器以"连接前游标"为 sync 基准补拉，去重窗口消化交叠（Pitfall 5）；
 *  - 意外 close → full jitter 指数退避重连（cap 60_000ms，SC2）；
 *  - v!==1 fatal 帧 → error(fatal) + 断连且不再重连（D-07 客户端严格）；
 *  - 畸形 serverUrl → WebSocket 构造器同步抛被 openSocket 捕获，经
 *    setTimeout(0) 延迟派发 WS_FAIL → error(fatal, connect_failed) +
 *    status offline，不重连（WR-04/02-04）；
 *  - 错误事件载荷绝不包含 Channel Key 子串（密钥即身份，不进日志/错误——
 *    与 server/src/index.ts 同款纪律）。
 */
import { PROTOCOL_VERSION, type HistoryFrame, type MessageFrame } from "@pushhub/shared";
import { parseServerFrame } from "./frames";
import {
  createMachine,
  type MachineAction,
  type MachineEvent,
  type TimerKind,
  type PushHubStatus,
  type PushHubErrorPayload,
} from "./connection-machine";
import { renderMarkdown } from "./render/render-markdown";

// 公开类型表面不变（02-01 one-way 契约；定义上提到 connection-machine 供
// 状态机与 adapter 共用，此处 re-export 保持宿主 import 路径兼容）。
export type { PushHubStatus, PushHubErrorPayload } from "./connection-machine";

/** D-16 事件名枚举。 */
export type PushHubEvent = "message" | "history" | "status" | "error";

type MessageListener = (message: MessageFrame) => void;
type HistoryListener = (frame: HistoryFrame) => void;
type StatusListener = (status: PushHubStatus) => void;
type ErrorListener = (error: PushHubErrorPayload) => void;

/**
 * 心跳出站帧（Pitfall 4）：逐字节等于服务端 auto-response 匹配串
 * '{"v":1,"type":"ping"}'——字符串常量直发，禁运行时对象序列化构造。
 */
const PING = '{"v":1,"type":"ping"}';

export class PushHub {
  /** D-19：渲染辅助纯函数（静态方法形态暴露给宿主）。 */
  static readonly renderMarkdown = renderMarkdown;

  private readonly wsUrl: string;
  private readonly listeners: Record<
    PushHubEvent,
    Set<MessageListener | HistoryListener | StatusListener | ErrorListener>
  > = {
    message: new Set(),
    history: new Set(),
    status: new Set(),
    error: new Set(),
  };

  private readonly machine = createMachine();
  private ws: WebSocket | null = null;
  private readonly timers = new Map<TimerKind, ReturnType<typeof setTimeout>>();
  private visibilityHandler: (() => void) | null = null;

  /**
   * 构造即连（D-18，SC1 两行接入体验）。
   * WS URL：http→ws 前缀替换 + 去尾部斜杠 + encodeURIComponent 密钥
   * （Pitfall 7：服务端逐段 decodeURIComponent，键含保留字符必须先编码）。
   * 同时注册 visibilitychange（D-27 探活：页面回前台立即 ping + 5s 死线）；
   * destroy() 时移除（D-18 资源释放完备）。document 不存在的环境（SSR 导入
   * 等）跳过注册——SDK 目标环境是浏览器。
   */
  constructor(serverUrl: string, channelKey: string) {
    this.wsUrl =
      serverUrl.replace(/^http/, "ws").replace(/\/+$/, "") +
      "/api/ws/" +
      encodeURIComponent(channelKey);
    if (typeof document !== "undefined") {
      this.visibilityHandler = () => {
        this.dispatch({
          kind: "VISIBILITY",
          visible: document.visibilityState === "visible",
        });
      };
      document.addEventListener("visibilitychange", this.visibilityHandler);
    }
    this.dispatch({ kind: "CONNECT" });
  }

  on(name: "message", cb: MessageListener): this;
  on(name: "history", cb: HistoryListener): this;
  on(name: "status", cb: StatusListener): this;
  on(name: "error", cb: ErrorListener): this;
  on(
    name: PushHubEvent,
    cb: MessageListener | HistoryListener | StatusListener | ErrorListener,
  ): this {
    this.listeners[name].add(cb);
    return this;
  }

  /** 主动连接（disconnect 后可再连恢复，D-18）。 */
  connect(): void {
    this.dispatch({ kind: "CONNECT" });
  }

  /** 主动断开并停止重连（可再 connect 恢复，D-18）。 */
  disconnect(): void {
    this.dispatch({ kind: "DISCONNECT" });
  }

  /** disconnect + 移除全部监听 + 释放资源（SPA 卸载内存安全，D-18）。 */
  destroy(): void {
    this.dispatch({ kind: "DESTROY" });
    if (this.visibilityHandler !== null && typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.visibilityHandler);
      this.visibilityHandler = null;
    }
    this.listeners.message.clear();
    this.listeners.history.clear();
    this.listeners.status.clear();
    this.listeners.error.clear();
  }

  // ---- adapter：事件进 / 动作出 ----

  private dispatch(event: MachineEvent): void {
    for (const action of this.machine.input(event)) {
      this.apply(action);
    }
  }

  private apply(action: MachineAction): void {
    switch (action.kind) {
      case "createSocket":
        this.openSocket();
        return;
      case "closeSocket":
        this.closeSocket(action.reason);
        return;
      case "sendPing":
        if (this.ws !== null && this.ws.readyState === WebSocket.OPEN) {
          try {
            this.ws.send(PING);
          } catch {
            // 发送失败（即将 close）——close/死线路径接管。
          }
        }
        return;
      case "sendSync":
        if (this.ws !== null && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(
            JSON.stringify({
              v: PROTOCOL_VERSION,
              type: "sync",
              since: action.since,
              limit: action.limit,
            }),
          );
        }
        return;
      case "schedule": {
        const existing = this.timers.get(action.timer);
        if (existing !== undefined) clearTimeout(existing);
        this.timers.set(
          action.timer,
          setTimeout(() => {
            this.timers.delete(action.timer);
            this.dispatch({ kind: "TIMER", timer: action.timer });
          }, action.delayMs),
        );
        return;
      }
      case "cancel": {
        const timer = this.timers.get(action.timer);
        if (timer !== undefined) {
          clearTimeout(timer);
          this.timers.delete(action.timer);
        }
        return;
      }
      case "emitStatus":
        this.emit("status", action.status);
        return;
      case "emitMessage":
        this.emit("message", action.message);
        return;
      case "emitHistory":
        this.emit("history", action.frame);
        return;
      case "emitError":
        this.emit("error", action.error);
        return;
    }
  }

  // ---- adapter：WebSocket 接线 ----

  private openSocket(): void {
    // 陈旧 socket 防护（重连竞态）：createSocket 只会在旧连接已死后触发，
    // 防御性兜底——detach 旧句柄全部回调后再关，迟到事件不再进机器。
    if (this.ws !== null) {
      const stale = this.ws;
      stale.onopen = null;
      stale.onmessage = null;
      stale.onclose = null;
      stale.onerror = () => {};
      try {
        stale.close(1000, "superseded");
      } catch {
        // 已关闭。
      }
    }
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.wsUrl);
    } catch {
      // WR-04（02-04）：畸形 serverUrl 使 WebSocket 构造器同步抛（唯一抛出
      // 源——构造函数不做 URL 预校验双路径）。不得同步 dispatch：构造即连
      // （D-18）时序下，构造函数内的同步 emitError 会在宿主 on() 注册前丢失
      // （查看器卡"连接中"的另一半根因）——延迟一跳派发，保证构造已返回、
      // 宿主监听已挂。this.ws 保持 null。错误文案为静态英文描述，不内嵌
      // wsUrl（路径段含 Channel Key——密钥即身份，不进错误载荷）。
      setTimeout(() => {
        this.dispatch({
          kind: "WS_FAIL",
          message: "failed to construct WebSocket for serverUrl",
        });
      }, 0);
      return;
    }
    this.ws = ws;
    // 监听器在 new 后同步挂齐（attach-before-trigger：服务端在升级路径即推
    // 首拉 history，open 回调后再挂监听会丢即发即弃首帧——smoke.mjs 教训）。
    ws.onopen = () => {
      if (this.ws === ws) this.dispatch({ kind: "WS_OPEN" });
    };
    ws.onmessage = (ev: MessageEvent) => {
      if (this.ws === ws) {
        this.dispatch({ kind: "FRAME", result: parseServerFrame(String(ev.data)) });
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return; // 已被新连接取代
      this.ws = null;
      this.dispatch({ kind: "WS_CLOSE" });
    };
    // onerror 不发事件载荷（浏览器 error 事件无可用信息且可能含 URL——
    // 密钥在路径段，绝不外泄）；close 事件必然跟随。
    ws.onerror = () => {};
  }

  private closeSocket(reason: "manual" | "fatal" | "deadline"): void {
    if (this.ws === null) return;
    const code = reason === "fatal" ? 1002 : reason === "deadline" ? 4000 : 1000;
    const why =
      reason === "fatal"
        ? "protocol version mismatch"
        : reason === "deadline"
          ? "heartbeat deadline"
          : "client disconnect";
    try {
      this.ws.close(code, why);
    } catch {
      // 已关闭的 socket 再 close 抛错——吞掉。
    }
  }

  // ---- 内部：事件发射 ----

  private emit(name: "message", payload: MessageFrame): void;
  private emit(name: "history", payload: HistoryFrame): void;
  private emit(name: "status", payload: PushHubStatus): void;
  private emit(name: "error", payload: PushHubErrorPayload): void;
  private emit(
    name: PushHubEvent,
    payload: MessageFrame | HistoryFrame | PushHubStatus | PushHubErrorPayload,
  ): void {
    const set = this.listeners[name] as Set<(p: unknown) => void>;
    for (const cb of set) {
      try {
        cb(payload);
      } catch {
        // 宿主回调异常不毒害 SDK 连接——吞掉继续下一监听器。
      }
    }
  }
}
