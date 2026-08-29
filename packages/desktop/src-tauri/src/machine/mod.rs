//! 连接生命周期纯状态机（05-01 tracer → 05-02 全行为，D-59）。
//!
//! packages/web-sdk/src/connection-machine.ts 的同构移植（事件进/动作出，
//! 零 tokio/tungstenite 依赖——随机数经构造注入、定时器经 TIMER 事件回喂）。
//! 常量与词汇表（Event 九变体/Action 十一动作/TimerKind/CloseReason/Status）
//! 与 TS 版逐条 verbatim 对齐；七条序列语义全部落地（连接/退避/心跳/fatal
//! 停机/重连确定补拉/D-27 探活/手动断开与销毁）。
//!
//! 行为臂位（与 connection-machine.ts 行号一一对应）：
//!  - Connect → 复位 manuallyClosed/fatalStopped + EmitStatus(Connecting) + CreateSocket
//!  - Disconnect → cancelAll + closeSocket(manual) + Offline（可再 Connect）
//!  - Destroy → cancelAll + closeSocket(manual) + Destroyed 终态（Connect 被忽略）
//!  - WsOpen → attempt 归零 + syncBase=dedup.last 快照 + awaitingInitialHistory
//!    + 武装心跳(30s) + EmitStatus(Online)
//!  - WsClose → 意外断开走 full jitter 退避；manuallyClosed/fatalStopped → Offline
//!  - Timer(Reconnect) → CreateSocket + EmitStatus(Connecting)
//!  - Timer(Heartbeat) → SendPing + 武装 PongDeadline(10s) + 重武装心跳
//!  - Timer(PongDeadline|Probe) → forceReconnect（closeSocket(deadline) + 退避，
//!    不等 WS_CLOSE——假活连接不会自己产生事件）
//!  - Frame(Pong) → 取消两类死线
//!  - Frame(Message) → should_deliver 过滤后 EmitMessage
//!  - Frame(History) → should_deliver 过滤 EmitHistory + 补拉确定序列
//!    （首拉无条件 SendSync{since=syncBase}；has_more 以 dedup.last 续翻；
//!    连续 SYNC_PAGE_MAX=100 页放弃并 emitError）
//!  - Frame(Answered) → dedup 之外原样透传 EmitAnswered（D-17）
//!  - Frame(Ack) → 静默零动作
//!  - Frame(Error) → 非致命透传，连接保持
//!  - Frame(Fatal) → EmitError(fatal) + CloseSocket(Fatal) + Offline 停机（此后零动作）
//!  - Visibility(true) → SendPing + 武装 Probe(5s) + 心跳接管；Visibility(false)
//!    → 取消心跳与探活（连接保持）

pub mod dedup;

use std::collections::HashSet;

use serde::Serialize;

use self::dedup::SeqDedup;
use crate::protocol::{
    AnsweredFrame, FrameResult, HistoryFrame, MessageFrame, ServerFrame, SYNC_LIMIT_DEFAULT,
};

// ---- 常量（connection-machine.ts:58-73 逐条 verbatim；数值变更即协议事件）----

/// full jitter 退避 base。
pub const BACKOFF_BASE_MS: u64 = 500;

/// full jitter 退避 cap（SC2 锁定 60s——部署断连后的最长静默重连间隔）。
pub const BACKOFF_CAP_MS: u64 = 60_000;

/// 心跳周期：每 30s 一 ping（经服务端 auto-response 零计费保活）。
pub const HEARTBEAT_INTERVAL_MS: u64 = 30_000;

/// pong 死线：ping 后 10s 无 pong 判连接假死（死线超时强制重连，不等 WS_CLOSE）。
pub const PONG_DEADLINE_MS: u64 = 10_000;

/// 探活死线（D-27 探活语义：visible → ping 后 5s 无 pong 判死线强制重连）。
pub const PROBE_DEADLINE_MS: u64 = 5_000;

/// has_more 连续翻页硬上限（T-02-06）。
pub const SYNC_PAGE_MAX: u32 = 100;

// ---- 词汇表 ----

/// 定时器种类（schedule/cancel/TIMER 三处共用；语义上互不重叠）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum TimerKind {
    Reconnect,
    Heartbeat,
    PongDeadline,
    Probe,
}

/// closeSocket 的发起方（adapter 据此选择 WS close code）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseReason {
    Manual,
    Fatal,
    Deadline,
}

/// 状态标签（adapter 原样转发前端；idle/offline/destroyed 内部态均为 Offline）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Connecting,
    Online,
    Reconnecting,
    Offline,
}

impl Status {
    pub fn as_str(self) -> &'static str {
        match self {
            Status::Connecting => "connecting",
            Status::Online => "online",
            Status::Reconnecting => "reconnecting",
            Status::Offline => "offline",
        }
    }
}

/// 输入事件：adapter 把 WS 回调 / 窗口事件 / 定时器到点翻译成这些。
/// Disconnect/Destroy/Visibility 由 05-04 adapter 接窗口/托盘事件时构造。
#[allow(dead_code)] // 05-04 adapter：窗口显隐/托盘退出/主动断开接线
#[derive(Debug)]
pub enum Event {
    Connect,
    Disconnect,
    Destroy,
    WsOpen,
    WsClose,
    WsFail { message: String },
    Frame { result: FrameResult },
    Visibility { visible: bool },
    Timer { kind: TimerKind },
}

/// 错误载荷（对齐 TS PushHubErrorPayload：message + 可选 code/fatal）。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ErrorPayload {
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fatal: Option<bool>,
}

/// 输出动作：adapter 把这些映射到真实 WS / tokio 定时器 / Tauri event。
/// SendSync 由 adapter 翻译为 sync 帧发送（05-04 接线后的读取面）。
#[allow(dead_code)] // 05-04 adapter：动作分发循环（含 SendSync → sync 帧发送）
#[derive(Debug)]
pub enum Action {
    CreateSocket,
    CloseSocket { reason: CloseReason },
    SendPing,
    SendSync { since: i64, limit: u32 },
    Schedule { kind: TimerKind, delay_ms: u64 },
    Cancel { kind: TimerKind },
    EmitStatus { status: Status },
    EmitMessage { message: MessageFrame },
    EmitHistory { frame: HistoryFrame },
    EmitAnswered { frame: AnsweredFrame },
    EmitError { error: ErrorPayload },
}

/// 内部全量状态（idle/offline/destroyed 的 status 标签均为 Offline）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MachineState {
    Idle,
    Connecting,
    Online,
    Reconnecting,
    Offline,
    Destroyed,
}

fn status_of(state: MachineState) -> Status {
    match state {
        MachineState::Connecting => Status::Connecting,
        MachineState::Online => Status::Online,
        MachineState::Reconnecting => Status::Reconnecting,
        MachineState::Idle | MachineState::Offline | MachineState::Destroyed => Status::Offline,
    }
}

/// 纯状态机。用法与 TS createMachine 同构：adapter 逐事件喂 input，
/// 按返回动作序列执行副作用；机器自身无并发。
pub struct Machine {
    random: Box<dyn FnMut() -> f64 + Send>,
    state: MachineState,
    last_status: Option<Status>,
    attempt: u32,
    /// WS_OPEN 瞬间的游标快照——首拉后无条件 sync 的基准（02-01 决策 #5）。
    sync_base: i64,
    awaiting_initial_history: bool,
    sync_count: u32,
    manually_closed: bool,
    fatal_stopped: bool,
    /// 实时帧与补拉帧交叠去重（dedup.rs；answered 帧不经此）。
    dedup: SeqDedup,
    /// 已武装（未取消/未到点）的定时器集合——TIMER 事件据此过滤迟到幽灵。
    timers: HashSet<TimerKind>,
}

impl Machine {
    /// random：随机源注入（full jitter）——测试确定性（对齐 TS options.random）。
    pub fn new(random: Box<dyn FnMut() -> f64 + Send>) -> Self {
        Self {
            random,
            state: MachineState::Idle,
            last_status: None,
            attempt: 0,
            sync_base: 0,
            awaiting_initial_history: false,
            sync_count: 0,
            manually_closed: false,
            fatal_stopped: false,
            dedup: SeqDedup::new(),
            timers: HashSet::new(),
        }
    }

    /// 当前状态标签（只读观测口，非宿主 API；05-04 adapter 状态上报消费）。
    #[allow(dead_code)] // 05-04 adapter：ph://status 事件发射
    pub fn status(&self) -> Status {
        status_of(self.state)
    }

    pub fn input(&mut self, event: Event) -> Vec<Action> {
        let mut out = Vec::new();
        self.handle(event, &mut out);
        out
    }

    fn handle(&mut self, event: Event, out: &mut Vec<Action>) {
        match event {
            Event::Connect => {
                if self.state == MachineState::Destroyed {
                    return;
                }
                self.manually_closed = false;
                self.fatal_stopped = false;
                self.cancel_timer(TimerKind::Reconnect, out);
                if self.state == MachineState::Connecting || self.state == MachineState::Online {
                    return; // 已在连
                }
                self.enter(MachineState::Connecting, out);
                out.push(Action::CreateSocket);
            }
            Event::Disconnect => {
                // 连接生命周期终点（宿主主动调用）：手动关停 + offline。
                if self.state == MachineState::Destroyed {
                    return;
                }
                self.manually_closed = true;
                self.cancel_all_timers(out);
                if self.state == MachineState::Connecting || self.state == MachineState::Online {
                    out.push(Action::CloseSocket {
                        reason: CloseReason::Manual,
                    });
                }
                self.enter(MachineState::Offline, out);
            }
            Event::Destroy => {
                // 终局销毁：cancelAll + manual close + destroyed（此后 Connect 被忽略）。
                if self.state == MachineState::Destroyed {
                    return;
                }
                self.cancel_all_timers(out);
                if self.state == MachineState::Connecting || self.state == MachineState::Online {
                    out.push(Action::CloseSocket {
                        reason: CloseReason::Manual,
                    });
                }
                self.enter(MachineState::Destroyed, out);
            }
            Event::WsOpen => {
                if self.state != MachineState::Connecting {
                    return;
                }
                self.attempt = 0;
                // 连接前游标快照（Pitfall 5 中段缺口零丢失的关键）。
                self.sync_base = self.dedup.last();
                self.awaiting_initial_history = true;
                self.sync_count = 0;
                self.arm_timer(TimerKind::Heartbeat, HEARTBEAT_INTERVAL_MS, out);
                self.enter(MachineState::Online, out);
            }
            Event::WsClose => {
                if self.state == MachineState::Online || self.state == MachineState::Connecting {
                    self.cancel_all_timers(out);
                    if self.manually_closed || self.fatal_stopped {
                        self.enter(MachineState::Offline, out);
                        return;
                    }
                    // 意外断开（部署断连/网络闪断/握手失败）→ full jitter 退避重连。
                    self.enter(MachineState::Reconnecting, out);
                    let delay = self.backoff_delay();
                    self.arm_timer(TimerKind::Reconnect, delay, out);
                    self.attempt += 1;
                }
                // reconnecting（deadline 路径已自行调度）/offline/destroyed：零动作。
            }
            Event::WsFail { message } => {
                // WR-04（02-04）TS 语义：确定性配置错误（畸形 serverUrl 使构造器
                // 同步抛）——fatal 语义与 v!==1 同族（报错 + 停止 + 不复活）。
                // tracer 的 adapter 在 URL 非法时产出本事件，不实现即卡死在
                // connecting（Rule 2 补齐）。仅 connecting 态消费；其余态零动作。
                if self.state != MachineState::Connecting {
                    return;
                }
                self.cancel_all_timers(out);
                out.push(Action::EmitError {
                    error: ErrorPayload {
                        message,
                        code: Some("connect_failed".to_string()),
                        fatal: Some(true),
                    },
                });
                self.enter(MachineState::Offline, out);
            }
            Event::Timer { kind } => {
                if !self.timers.remove(&kind) {
                    return; // 未武装的迟到幽灵定时器
                }
                match kind {
                    TimerKind::Reconnect => {
                        if self.state == MachineState::Reconnecting {
                            self.enter(MachineState::Connecting, out);
                            out.push(Action::CreateSocket);
                        }
                    }
                    TimerKind::Heartbeat => {
                        if self.state == MachineState::Online {
                            out.push(Action::SendPing);
                            self.arm_timer(TimerKind::PongDeadline, PONG_DEADLINE_MS, out);
                            self.arm_timer(TimerKind::Heartbeat, HEARTBEAT_INTERVAL_MS, out);
                        }
                    }
                    TimerKind::PongDeadline | TimerKind::Probe => {
                        // 死线超时（周期心跳 pong 死线 / D-27 探活死线）：连接判
                        // 假死，立即强制重连（不等 WS_CLOSE——假活连接不会自己
                        // 产生事件）——恢复后按重连确定序列补拉。
                        if self.state == MachineState::Online {
                            self.force_reconnect(out);
                        }
                    }
                }
            }
            Event::Visibility { visible } => {
                // D-27 探活：窗口回前台 → 立即 ping + 5s 死线（冻结期间连接可能
                // 已被中间设备掐断，visible 瞬间主动探测而非等 30s 周期）。
                if self.state != MachineState::Online {
                    return;
                }
                if visible {
                    out.push(Action::SendPing);
                    self.arm_timer(TimerKind::Probe, PROBE_DEADLINE_MS, out);
                    // 周期心跳接管恢复（hidden 期间被取消；未取消时仅复位周期，无害）。
                    self.arm_timer(TimerKind::Heartbeat, HEARTBEAT_INTERVAL_MS, out);
                } else {
                    // hidden：取消心跳周期与探活（冻结时省额度，恢复时探活接管）。
                    self.cancel_timer(TimerKind::Heartbeat, out);
                    self.cancel_timer(TimerKind::Probe, out);
                }
            }
            Event::Frame { result } => {
                self.handle_frame(result, out);
            }
        }
    }

    fn handle_frame(&mut self, result: FrameResult, out: &mut Vec<Action>) {
        if self.state != MachineState::Online {
            return; // 帧只在已建连状态消费（含断开后迟到帧）
        }
        match result {
            FrameResult::Ok(ServerFrame::Pong) => {
                // auto-response 回帧：两类死线一并解除（pong 即"连接活着"的唯一证据）。
                self.cancel_timer(TimerKind::PongDeadline, out);
                self.cancel_timer(TimerKind::Probe, out);
            }
            FrameResult::Ok(ServerFrame::Message(message)) => {
                // D-16×D-17：shouldDeliver 是唯一投递闸门（重复 seq 静默吞）。
                if self.dedup.should_deliver(message.seq) {
                    out.push(Action::EmitMessage { message });
                }
            }
            FrameResult::Ok(ServerFrame::History(frame)) => {
                self.handle_history(frame, out);
            }
            FrameResult::Ok(ServerFrame::Answered(frame)) => {
                // 04-03：answered 在 SeqDedup 之外原样透传（D-17 硬约束——
                // SDK 按 seq 去重会吞同 seq 重发，answered 独立成帧正是为此；
                // 同 wid 重复扇出照发，幂等消化归宿主按 wid 判定）。
                out.push(Action::EmitAnswered { frame });
            }
            FrameResult::Ok(ServerFrame::Ack(_)) => {
                // 04-01 Q4 定稿：ack 静默消费零输出——answered 扇出即公共确认
                // 信号（回复者本人由随后的 answered 自证）。
            }
            FrameResult::Ok(ServerFrame::Error(e)) => {
                // 服务端 WS 错误帧（invalid_frame 等）——非致命透传，连接保持。
                out.push(Action::EmitError {
                    error: ErrorPayload {
                        message: e.message,
                        code: Some(e.code),
                        fatal: None,
                    },
                });
            }
            FrameResult::Drop(_) => {
                // 非致命（不可解析/结构违例/未知 type）：静默丢弃（D-07）。
            }
            FrameResult::Fatal(message) => {
                // D-07 客户端侧职责：断连 + 报错 + 不再重连（此后零动作）。
                self.fatal_stopped = true;
                self.cancel_all_timers(out);
                out.push(Action::EmitError {
                    error: ErrorPayload {
                        message,
                        code: None,
                        fatal: Some(true),
                    },
                });
                out.push(Action::CloseSocket {
                    reason: CloseReason::Fatal,
                });
                self.enter(MachineState::Offline, out);
            }
        }
    }

    /// 补拉确定序列（SC4-d，connection-machine.ts handleHistory 逐行为对齐）：
    ///  - 帧结构原样（oldest_kept_seq/has_more 透传），messages 只含宿主未见
    ///    消息（should_deliver 唯一过滤闸门）；
    ///  - 首拉 → 无条件 sendSync since=连接前游标（缺口可深于首拉 50 条，Pitfall 5）；
    ///  - has_more → 以 dedup.last（本批最大已见 seq）续翻；
    ///  - 连续翻页达 SYNC_PAGE_MAX=100 → emitError 放弃补拉（连接保持，T-02-06）。
    fn handle_history(&mut self, mut frame: HistoryFrame, out: &mut Vec<Action>) {
        frame
            .messages
            .retain(|m| self.dedup.should_deliver(m.seq));
        let has_more = frame.has_more;
        out.push(Action::EmitHistory { frame });
        if self.awaiting_initial_history {
            self.awaiting_initial_history = false;
            self.sync_count = 1;
            out.push(Action::SendSync {
                since: self.sync_base,
                limit: SYNC_LIMIT_DEFAULT,
            });
            return;
        }
        if has_more {
            if self.sync_count >= SYNC_PAGE_MAX {
                // T-02-06：异常翻页死循环防线——放弃补拉并报错，连接保持。
                out.push(Action::EmitError {
                    error: ErrorPayload {
                        message: format!(
                            "sync pagination exceeded {SYNC_PAGE_MAX} pages; giving up catch-up"
                        ),
                        code: Some("sync_page_limit".to_string()),
                        fatal: None,
                    },
                });
                return;
            }
            self.sync_count += 1;
            out.push(Action::SendSync {
                since: self.dedup.last(),
                limit: SYNC_LIMIT_DEFAULT,
            });
        }
    }

    /// 意外失活（pong/探活死线）：立即走退避重连路径（不等 WS_CLOSE 事件）。
    fn force_reconnect(&mut self, out: &mut Vec<Action>) {
        self.cancel_all_timers(out);
        out.push(Action::CloseSocket {
            reason: CloseReason::Deadline,
        });
        self.enter(MachineState::Reconnecting, out);
        let delay = self.backoff_delay();
        self.arm_timer(TimerKind::Reconnect, delay, out);
        self.attempt += 1;
    }

    /// 武装定时器（替换语义：同种已武装则先 cancel 再 schedule）。
    fn arm_timer(&mut self, kind: TimerKind, delay_ms: u64, out: &mut Vec<Action>) {
        self.cancel_timer(kind, out);
        self.timers.insert(kind);
        out.push(Action::Schedule { kind, delay_ms });
    }

    fn cancel_timer(&mut self, kind: TimerKind, out: &mut Vec<Action>) {
        if self.timers.remove(&kind) {
            out.push(Action::Cancel { kind });
        }
    }

    fn cancel_all_timers(&mut self, out: &mut Vec<Action>) {
        let kinds: Vec<TimerKind> = self.timers.iter().copied().collect();
        for kind in kinds {
            self.cancel_timer(kind, out);
        }
    }

    fn enter(&mut self, next: MachineState, out: &mut Vec<Action>) {
        self.state = next;
        let label = status_of(next);
        if self.last_status != Some(label) {
            self.last_status = Some(label);
            out.push(Action::EmitStatus { status: label });
        }
    }

    /// full jitter：delay = random() * min(60_000, 500 * 2^attempt)。
    fn backoff_delay(&mut self) -> u64 {
        let r = (self.random)();
        let window = BACKOFF_CAP_MS
            .min(BACKOFF_BASE_MS.saturating_mul(1u64 << self.attempt.min(32)));
        (r * window as f64) as u64
    }
}

#[cfg(test)]
mod tests;
