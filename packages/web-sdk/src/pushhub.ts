/**
 * PushHub —— Web SDK 公开 API 类（02-01 tracer，D-16/D-18 定稿表面）。
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
 * 关键实现锚点（全部 read-source 核实）：
 *  - PING 字符串常量逐字节等于服务端 setWebSocketAutoResponse 匹配串
 *    （packages/server/src/chat-room.ts:44，Pitfall 4：运行时对象序列化会
 *    键序反转导致 auto-response 失配，烧请求额度）；
 *  - 服务端 accept 即推首拉 history（最近 50 条，chat-room.ts:377）——
 *    SDK 以"连接前游标"为 sync 基准补拉，去重窗口消化交叠（Pitfall 5：
 *    首拉只覆盖 50 条，缺口更大必须主动 sync）；
 *  - 意外 close → full jitter 指数退避重连（cap 60_000ms，SC2）；
 *  - v!==1 fatal 帧 → error(fatal) + 断连且不再重连（D-07 客户端严格）；
 *  - 错误事件载荷绝不包含 Channel Key 子串（密钥即身份，不进日志/错误——
 *    与 server/src/index.ts 同款纪律）。
 */
import {
  PROTOCOL_VERSION,
  SYNC_LIMIT_DEFAULT,
  type HistoryFrame,
  type MessageFrame,
} from "@pushhub/shared";
import { parseServerFrame } from "./frames";
import { SeqDedup } from "./dedup";
import { renderMarkdown } from "./render/render-markdown";

/** Task 2 定稿：status 枚举（one-way 公开契约）。 */
export type PushHubStatus = "connecting" | "online" | "reconnecting" | "offline";

/** Task 2 定稿：error 事件载荷（one-way 公开契约）。 */
export interface PushHubErrorPayload {
  message: string;
  code?: string;
  fatal?: boolean;
}

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

/** 心跳间隔（A2 建议值：30s 一 ping，零计费保活）。 */
const HEARTBEAT_INTERVAL_MS = 30_000;

/** 重连退避（SC2 锁定 cap 60s；base 500ms 为 A2 建议值）。 */
const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 60_000;

/** full jitter（AWS Exponential Backoff and Jitter 标准形）。 */
function backoffDelay(attempt: number): number {
  return (
    Math.random() * Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt)
  );
}

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
  private readonly dedup = new SeqDedup();

  private ws: WebSocket | null = null;
  private statusValue: PushHubStatus = "offline";
  private heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private attempt = 0;
  /** 连接打开瞬间的游标快照——首拉后的 sync 基准（缺口可能深于首拉 50 条）。 */
  private syncBase = 0;
  private awaitingInitialHistory = false;
  private manuallyClosed = false;
  private fatalStopped = false;
  private destroyed = false;

  /**
   * 构造即连（D-18，SC1 两行接入体验）。
   * WS URL：http→ws 前缀替换 + 去尾部斜杠 + encodeURIComponent 密钥
   * （Pitfall 7：服务端逐段 decodeURIComponent，键含保留字符必须先编码）。
   */
  constructor(serverUrl: string, channelKey: string) {
    this.wsUrl =
      serverUrl.replace(/^http/, "ws").replace(/\/+$/, "") +
      "/api/ws/" +
      encodeURIComponent(channelKey);
    this.connect();
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
    if (this.destroyed) return;
    this.manuallyClosed = false;
    this.fatalStopped = false;
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    if (
      this.ws !== null &&
      (this.ws.readyState === WebSocket.OPEN ||
        this.ws.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }
    this.openSocket();
  }

  /** 主动断开并停止重连（可再 connect 恢复，D-18）。 */
  disconnect(): void {
    this.manuallyClosed = true;
    this.stopHeartbeat();
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    if (this.ws !== null) {
      try {
        this.ws.close(1000, "client disconnect");
      } catch {
        // 已关闭的 socket 再 close 抛错——吞掉。
      }
    }
    this.setStatus("offline");
  }

  /** disconnect + 移除全部监听 + 释放资源（SPA 卸载内存安全，D-18）。 */
  destroy(): void {
    this.disconnect();
    this.destroyed = true;
    this.listeners.message.clear();
    this.listeners.history.clear();
    this.listeners.status.clear();
    this.listeners.error.clear();
  }

  // ---- 内部：连接生命周期 ----

  private openSocket(): void {
    this.setStatus("connecting");
    const ws = new WebSocket(this.wsUrl);
    this.ws = ws;
    // 监听器在 new 后同步挂齐（attach-before-trigger：服务端在升级路径即推
    // 首拉 history，open 回调后再挂监听会丢即发即弃首帧——smoke.mjs 教训）。
    ws.onopen = () => this.handleOpen();
    ws.onmessage = (ev: MessageEvent) => this.handleRawFrame(String(ev.data));
    ws.onclose = () => this.handleClose();
    // onerror 不发事件载荷（浏览器 error 事件无可用信息且可能含 URL——
    // 密钥在路径段，绝不外泄）；close 事件必然跟随。
    ws.onerror = () => {};
  }

  private handleOpen(): void {
    if (this.destroyed) return;
    this.attempt = 0;
    this.awaitingInitialHistory = true;
    this.syncBase = this.dedup.last;
    this.setStatus("online");
    this.startHeartbeat();
  }

  private handleClose(): void {
    this.stopHeartbeat();
    this.ws = null;
    if (this.destroyed || this.manuallyClosed || this.fatalStopped) {
      this.setStatus("offline");
      return;
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    this.setStatus("reconnecting");
    const delay = backoffDelay(this.attempt);
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.openSocket();
    }, delay);
  }

  // ---- 内部：心跳 ----

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws !== null && this.ws.readyState === WebSocket.OPEN) {
        try {
          this.ws.send(PING);
        } catch {
          // 发送失败（即将 close）——close 处理器接管重连。
        }
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  // ---- 内部：帧处理 ----

  private handleRawFrame(raw: string): void {
    if (this.destroyed) return;
    const result = parseServerFrame(raw);
    if (!result.ok) {
      if (result.fatal) {
        // D-07 客户端侧职责：断连 + 报错 + 不再重连（Pitfall 10 方向：
        // 服务端宽容忽略坏帧，客户端严格即断——服务端比客户端新，重连无意义）。
        this.fatalStopped = true;
        this.emit("error", { message: result.message, fatal: true });
        this.stopHeartbeat();
        if (this.ws !== null) {
          try {
            this.ws.close(1002, "protocol version mismatch");
          } catch {
            // 已关闭。
          }
        }
        this.setStatus("offline");
      }
      // 非致命：静默丢弃（不可解析 / 未知 type / 结构违例）。
      return;
    }
    const frame = result.frame;
    switch (frame.type) {
      case "message":
        if (this.dedup.shouldDeliver(frame.seq)) {
          this.emit("message", frame);
        }
        return;
      case "history":
        this.handleHistory(frame);
        return;
      case "pong":
        // auto-response 回帧，零动作（心跳死线判定在 02-02）。
        return;
      case "error":
        // 服务端 WS 错误帧（invalid_frame/invalid_version 等）——非致命，
        // 透传给宿主；载荷不含 Channel Key（服务端错误文案为通用文案）。
        this.emit("error", { message: frame.message, code: frame.code });
        return;
    }
  }

  /**
   * history 批次：messages 经去重窗口过滤后发 history 事件（D-16×D-17 交集
   * 语义：帧结构原样，messages 只含宿主未见消息）。
   * 随后：首拉 → 无条件发 sync since=连接前游标（缺口可深于首拉 50 条，
   * Pitfall 5）；翻页 → has_more 时以当前游标续拉。
   */
  private handleHistory(frame: HistoryFrame): void {
    const fresh = frame.messages.filter((m) => this.dedup.shouldDeliver(m.seq));
    this.emit("history", { ...frame, messages: fresh });
    if (this.awaitingInitialHistory) {
      this.awaitingInitialHistory = false;
      this.sendSync(this.syncBase);
    } else if (frame.has_more) {
      this.sendSync(this.dedup.last);
    }
  }

  private sendSync(since: number): void {
    if (this.ws === null || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(
      JSON.stringify({
        v: PROTOCOL_VERSION,
        type: "sync",
        since,
        limit: SYNC_LIMIT_DEFAULT,
      }),
    );
  }

  // ---- 内部：事件 ----

  private setStatus(next: PushHubStatus): void {
    if (this.statusValue === next) return;
    this.statusValue = next;
    this.emit("status", next);
  }

  private emit(name: "message", payload: MessageFrame): void;
  private emit(name: "history", payload: HistoryFrame): void;
  private emit(name: "status", payload: PushHubStatus): void;
  private emit(name: "error", payload: PushHubErrorPayload): void;
  private emit(
    name: PushHubEvent,
    payload: MessageFrame | HistoryFrame | PushHubStatus | PushHubErrorPayload,
  ): void {
    if (this.destroyed) return;
    const set = this.listeners[name] as Set<
      (p: unknown) => void
    >;
    for (const cb of set) {
      try {
        cb(payload);
      } catch {
        // 宿主回调异常不毒害 SDK 连接——吞掉继续下一监听器。
      }
    }
  }
}
