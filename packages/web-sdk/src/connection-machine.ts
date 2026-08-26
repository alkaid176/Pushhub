/**
 * connection-machine —— 连接生命周期纯状态机（02-02 Task 1，WEB-04/SC2）。
 *
 * 形态（RESEARCH Pattern 3，CLAUDE.md §Testing Desktop 同构思路）：
 *   输入事件流 → createMachine() → 输出动作流
 * 模块纯逻辑：零 WebSocket/window/document/Node 依赖——随机数与时间不经由
 * 本模块发起（定时器由 adapter 按 schedule 动作创建、到点回喂 TIMER 事件；
 * 随机数经 options.random 注入，默认 Math.random）——Phase 5 Tauri/Rust
 * 移植的同构参考（D-17 语义载体）。
 *
 * 状态迁移：idle → connecting → online ⇄ reconnecting（退避中）→ offline
 * （主动断开 / fatal / destroyed）。emitStatus 仅在状态标签变化时输出。
 *
 * 行为契约（02-01 冻结 + 02-02 固化）：
 *  - full jitter 退避：delay = random() * min(60_000, 500 * 2^attempt)，
 *    WS_OPEN 成功后 attempt 归零（SC2 cap 锁定 60s）；
 *  - 重连确定序列：WS_OPEN → syncBase=dedup.last 快照 → 首拉 history
 *    （messages 经 shouldDeliver 过滤进 emitHistory，oldest_kept_seq/
 *    has_more 原样透传——D-16×D-17 交集唯一实现点）→ 无条件 sendSync
 *    (since=syncBase, limit=SYNC_LIMIT_DEFAULT)（首拉只覆盖 50 条，缺口
 *    更深必须主动 sync，Pitfall 5）→ has_more 以本批最大 seq 续翻，连续
 *    翻页达 SYNC_PAGE_MAX=100 放弃并 emitError（T-02-06 防服务端异常死循环）；
 *  - v!==1 fatal 帧 → emitError(fatal) + closeSocket + offline，此后零动作
 *    不再重连（D-07 客户端严格；服务端宽容忽略坏帧——方向相反）；
 *  - 心跳：WS_OPEN arm(heartbeat, 30s)；TIMER(heartbeat) → sendPing +
 *    arm(pongDeadline, 10s) + re-arm(heartbeat)；FRAME(pong) → cancel 两类死线；
 *    pong/探活死线超时 → closeSocket(deadline) + 退避重连（T-02-08 假活防线）；
 *  - VISIBILITY 探活（D-27）：visible → sendPing + arm(probe, 5s) + 心跳
 *    周期接管恢复；hidden → 取消心跳与探活（页面冻结省额度，恢复时探活接管）。
 *
 * import 说明（prohibition 核对）：仅引用 @pushhub/shared（冻结协议包，
 * 纯常量/类型）与本包 ./frames（类型）、./dedup（纯逻辑）——零平台 API。
 */
import { SYNC_LIMIT_DEFAULT, type HistoryFrame, type MessageFrame } from "@pushhub/shared";
import type { FrameResult } from "./frames";
import { SeqDedup } from "./dedup";

/** Task 2 checkpoint 定稿：status 枚举（one-way 公开契约，adapter 原样转发）。 */
export type PushHubStatus = "connecting" | "online" | "reconnecting" | "offline";

/** Task 2 checkpoint 定稿：error 事件载荷（one-way 公开契约）。 */
export interface PushHubErrorPayload {
  message: string;
  code?: string;
  fatal?: boolean;
}

// ---- 常量（A2 Discretion 建议值；cap 为 SC2 锁定值）----

/** full jitter 退避 base（首失败重连延迟上限 500ms 量级）。 */
export const BACKOFF_BASE_MS = 500;

/** full jitter 退避 cap（SC2 锁定 60s——服务端部署断连后的最长静默重连间隔）。 */
export const BACKOFF_CAP_MS = 60_000;

/** 心跳周期：每 30s 一 ping（经服务端 auto-response 零计费保活）。 */
export const HEARTBEAT_INTERVAL_MS = 30_000;

/** pong 死线：ping 后 10s 无 pong 判连接假死，强制重连。 */
export const PONG_DEADLINE_MS = 10_000;

/** 探活死线（D-27）：页面回前台 ping 后 5s 无 pong 判死线，强制重连续补拉。 */
export const PROBE_DEADLINE_MS = 5_000;

/** has_more 连续翻页硬上限（T-02-06：服务端异常循环 has_more 时不无限翻页）。 */
export const SYNC_PAGE_MAX = 100;

// ---- 事件与动作词汇表 ----

/** 定时器种类（schedule/cancel/TIMER 三处共用；语义上互不重叠）。 */
export type TimerKind = "reconnect" | "heartbeat" | "pongDeadline" | "probe";

/** closeSocket 的发起方（adapter 据此选择 WS close code）。 */
export type CloseReason = "manual" | "fatal" | "deadline";

/** 输入事件：adapter 把 WS 回调 / DOM 事件 / 定时器到点翻译成这些。 */
export type MachineEvent =
  | { kind: "CONNECT" }
  | { kind: "DISCONNECT" }
  | { kind: "DESTROY" }
  | { kind: "WS_OPEN" }
  | { kind: "WS_CLOSE" }
  | { kind: "FRAME"; result: FrameResult }
  | { kind: "VISIBILITY"; visible: boolean }
  | { kind: "TIMER"; timer: TimerKind };

/** 输出动作：adapter 把这些映射到真实 WebSocket / 定时器 / on 回调。 */
export type MachineAction =
  | { kind: "createSocket" }
  | { kind: "closeSocket"; reason: CloseReason }
  | { kind: "sendPing" }
  | { kind: "sendSync"; since: number; limit: number }
  | { kind: "schedule"; timer: TimerKind; delayMs: number }
  | { kind: "cancel"; timer: TimerKind }
  | { kind: "emitStatus"; status: PushHubStatus }
  | { kind: "emitMessage"; message: MessageFrame }
  | { kind: "emitHistory"; frame: HistoryFrame }
  | { kind: "emitError"; error: PushHubErrorPayload };

/** 内部全量状态（idle/offline/destroyed 的 status 标签均为 "offline"）。 */
type MachineState =
  | "idle"
  | "connecting"
  | "online"
  | "reconnecting"
  | "offline"
  | "destroyed";

export interface MachineOptions {
  /** 随机源注入（full jitter）——测试确定性；缺省 Math.random。 */
  random?: () => number;
}

export interface ConnectionMachine {
  input(event: MachineEvent): MachineAction[];
  /** 当前状态标签（只读观测口，非宿主 API）。 */
  readonly status: PushHubStatus;
}

function statusOf(state: MachineState): PushHubStatus {
  if (state === "connecting") return "connecting";
  if (state === "online") return "online";
  if (state === "reconnecting") return "reconnecting";
  return "offline"; // idle / offline / destroyed
}

/**
 * 创建状态机。用法：adapter 逐事件喂 input，按返回动作序列执行副作用；
 * 同一事件的动作按序完整执行（状态先迁移、动作随迁移产生——宿主回调在
 * emit 动作时同步触发，重入（回调内再调 connect/disconnect）由后续事件
 * 排队消化，机器自身无并发。
 */
export function createMachine(options: MachineOptions = {}): ConnectionMachine {
  // 缺省经属性查找取 Math.random（而非构造时捕获函数引用）——宿主页面
  // 可替换 Math.random（如 E2E 注入确定退避窗口）；语义与直接引用等价。
  const random = options.random ?? ((): number => Math.random());
  const dedup = new SeqDedup();

  let state: MachineState = "idle";
  let lastStatus: PushHubStatus | null = null;
  let attempt = 0;
  /** WS_OPEN 瞬间的游标快照——首拉后无条件 sync 的基准（02-01 决策 #5）。 */
  let syncBase = 0;
  let awaitingInitialHistory = false;
  let syncCount = 0;
  let manuallyClosed = false;
  let fatalStopped = false;
  /** 已武装（未取消/未到点）的定时器集合——TIMER 事件据此过滤迟到幽灵。 */
  const timers = new Set<TimerKind>();

  const backoffDelay = (a: number): number =>
    random() * Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** a);

  function cancelTimer(timer: TimerKind, out: MachineAction[]): void {
    if (timers.delete(timer)) {
      out.push({ kind: "cancel", timer });
    }
  }

  function cancelAllTimers(out: MachineAction[]): void {
    for (const timer of [...timers]) cancelTimer(timer, out);
  }

  /** 武装定时器（替换语义：同种已武装则先 cancel 再 schedule）。 */
  function armTimer(timer: TimerKind, delayMs: number, out: MachineAction[]): void {
    cancelTimer(timer, out);
    timers.add(timer);
    out.push({ kind: "schedule", timer, delayMs });
  }

  function enter(next: MachineState, out: MachineAction[]): void {
    state = next;
    const label = statusOf(next);
    if (label !== lastStatus) {
      lastStatus = label;
      out.push({ kind: "emitStatus", status: label });
    }
  }

  /** 意外失活（pong/探活死线）：立即走退避重连路径（不等 WS_CLOSE 事件）。 */
  function forceReconnect(out: MachineAction[]): void {
    cancelAllTimers(out);
    out.push({ kind: "closeSocket", reason: "deadline" });
    enter("reconnecting", out);
    armTimer("reconnect", backoffDelay(attempt), out);
    attempt += 1;
  }

  function handleFrame(result: FrameResult, out: MachineAction[]): void {
    if (state !== "online") return; // 帧只在已建连状态消费（含销毁/断开后迟到帧）
    if (!result.ok) {
      if (result.fatal) {
        // D-07 客户端侧职责：断连 + 报错 + 不再重连。
        fatalStopped = true;
        cancelAllTimers(out);
        out.push({ kind: "emitError", error: { message: result.message, fatal: true } });
        out.push({ kind: "closeSocket", reason: "fatal" });
        enter("offline", out);
      }
      // 非致命（不可解析/结构违例/未知 type）：静默丢弃。
      return;
    }
    const frame = result.frame;
    switch (frame.type) {
      case "message":
        if (dedup.shouldDeliver(frame.seq)) {
          out.push({ kind: "emitMessage", message: frame });
        }
        return;
      case "pong":
        // auto-response 回帧：两类死线一并解除（周期心跳 pongDeadline 与
        // D-27 探活 probe——pong 即"连接活着"的唯一证据）。
        cancelTimer("pongDeadline", out);
        cancelTimer("probe", out);
        return;
      case "error":
        // 服务端 WS 错误帧（invalid_frame 等）——非致命透传，连接保持。
        out.push({ kind: "emitError", error: { message: frame.message, code: frame.code } });
        return;
      case "history":
        handleHistory(frame, out);
        return;
    }
  }

  function handleHistory(frame: HistoryFrame, out: MachineAction[]): void {
    // D-16×D-17 交集：帧结构原样（oldest_kept_seq/has_more 透传），
    // messages 只含宿主未见消息（shouldDeliver 是唯一过滤闸门）。
    const fresh = frame.messages.filter((m) => dedup.shouldDeliver(m.seq));
    out.push({ kind: "emitHistory", frame: { ...frame, messages: fresh } });
    if (awaitingInitialHistory) {
      // 首拉 → 无条件 sync since=连接前游标（缺口可深于首拉 50 条，Pitfall 5）。
      awaitingInitialHistory = false;
      syncCount = 1;
      out.push({ kind: "sendSync", since: syncBase, limit: SYNC_LIMIT_DEFAULT });
      return;
    }
    if (frame.has_more) {
      if (syncCount >= SYNC_PAGE_MAX) {
        // T-02-06：异常翻页死循环防线——放弃补拉并报错，连接保持。
        out.push({
          kind: "emitError",
          error: {
            message: `sync pagination exceeded ${SYNC_PAGE_MAX} pages; giving up catch-up`,
            code: "sync_page_limit",
          },
        });
        return;
      }
      syncCount += 1;
      out.push({ kind: "sendSync", since: dedup.last, limit: SYNC_LIMIT_DEFAULT });
    }
  }

  function input(event: MachineEvent): MachineAction[] {
    const out: MachineAction[] = [];
    switch (event.kind) {
      case "CONNECT": {
        if (state === "destroyed") return out;
        manuallyClosed = false;
        fatalStopped = false;
        cancelTimer("reconnect", out);
        if (state === "connecting" || state === "online") return out; // 已在连
        enter("connecting", out);
        out.push({ kind: "createSocket" });
        return out;
      }
      case "DISCONNECT": {
        if (state === "destroyed") return out;
        manuallyClosed = true;
        cancelAllTimers(out);
        if (state === "connecting" || state === "online") {
          out.push({ kind: "closeSocket", reason: "manual" });
        }
        enter("offline", out);
        return out;
      }
      case "DESTROY": {
        if (state === "destroyed") return out;
        cancelAllTimers(out);
        if (state === "connecting" || state === "online") {
          out.push({ kind: "closeSocket", reason: "manual" });
        }
        enter("destroyed", out);
        return out;
      }
      case "WS_OPEN": {
        if (state !== "connecting") return out;
        attempt = 0;
        syncBase = dedup.last; // 连接前游标快照（Pitfall 5 中段缺口零丢失的关键）
        awaitingInitialHistory = true;
        syncCount = 0;
        armTimer("heartbeat", HEARTBEAT_INTERVAL_MS, out);
        enter("online", out);
        return out;
      }
      case "WS_CLOSE": {
        if (state === "online" || state === "connecting") {
          cancelAllTimers(out);
          if (manuallyClosed || fatalStopped) {
            enter("offline", out);
            return out;
          }
          // 意外断开（部署断连/网络闪断/握手失败）→ full jitter 退避重连。
          enter("reconnecting", out);
          armTimer("reconnect", backoffDelay(attempt), out);
          attempt += 1;
        }
        // reconnecting（deadline 路径已自行调度）/offline/destroyed：零动作。
        return out;
      }
      case "TIMER": {
        if (!timers.delete(event.timer)) return out; // 未武装的迟到幽灵定时器
        switch (event.timer) {
          case "reconnect":
            if (state === "reconnecting") {
              enter("connecting", out);
              out.push({ kind: "createSocket" });
            }
            return out;
          case "heartbeat":
            if (state === "online") {
              out.push({ kind: "sendPing" });
              armTimer("pongDeadline", PONG_DEADLINE_MS, out);
              armTimer("heartbeat", HEARTBEAT_INTERVAL_MS, out);
            }
            return out;
          case "pongDeadline":
          case "probe":
            // 死线超时（周期心跳 pong 死线 / D-27 探活死线）：连接判假死，
            // 立即强制重连（不等 WS_CLOSE）——恢复后按重连确定序列补拉。
            if (state === "online") {
              forceReconnect(out);
            }
            return out;
        }
        return out;
      }
      case "VISIBILITY": {
        // D-27 探活：页面回前台 → 立即 ping + 5s 死线（iOS 冻结恢复路径——
        // 冻结期间连接可能已被中间设备掐断，visible 瞬间主动探测而非等 30s 周期）。
        if (state !== "online") return out;
        if (event.visible) {
          out.push({ kind: "sendPing" });
          armTimer("probe", PROBE_DEADLINE_MS, out);
          // 周期心跳接管恢复（hidden 期间被取消；未取消时仅复位周期，无害）。
          armTimer("heartbeat", HEARTBEAT_INTERVAL_MS, out);
        } else {
          // hidden：取消心跳周期与探活（页面冻结时省额度，恢复时探活接管）。
          cancelTimer("heartbeat", out);
          cancelTimer("probe", out);
        }
        return out;
      }
      case "FRAME": {
        handleFrame(event.result, out);
        return out;
      }
    }
  }

  return {
    input,
    get status(): PushHubStatus {
      return statusOf(state);
    },
  };
}
