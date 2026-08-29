//! 连接生命周期纯状态机（05-01 Task 3 tracer，D-59）。
//!
//! packages/web-sdk/src/connection-machine.ts 的同构移植（事件进/动作出，
//! 零 tokio/tungstenite 依赖——随机数经构造注入、定时器经 TIMER 事件回喂）。
//! 常量与词汇表（Event 九变体/Action 十一动作/TimerKind/CloseReason/Status）
//! 与 TS 版逐条 verbatim 对齐；行为臂位本 task 实现 tracer 子集（连接/退避/
//! 心跳/pong/三型帧/fatal 停机），其余臂位返回空动作——05-02 填充
//!（功能性缺口，非架构缺口：补拉序列/探活/主动断开/deadline 强制重连）。
//!
//! tracer 实现的臂位（与 05-01-PLAN Task 3 一一对应）：
//!  - Connect → EmitStatus(Connecting) + CreateSocket
//!  - WsOpen → attempt 归零 + 武装心跳(30s) + EmitStatus(Online)
//!  - WsClose → EmitStatus(Reconnecting) + Schedule(Reconnect, full jitter 退避)
//!  - Timer(Reconnect) → CreateSocket + EmitStatus(Connecting)
//!  - Timer(Heartbeat) → SendPing + 武装 PongDeadline(10s) + 重武装心跳
//!  - Frame(Pong) → 取消两类死线
//!  - Frame(Message) → EmitMessage
//!  - Frame(History) → EmitHistory（tracer 直通——dedup 过滤与 sendSync 05-02）
//!  - Frame(Fatal) → EmitError(fatal) + CloseSocket(Fatal) + Offline 停机（此后零动作）

pub mod dedup;

use std::collections::HashSet;

use serde::Serialize;

use crate::protocol::{AnsweredFrame, FrameResult, HistoryFrame, MessageFrame, ServerFrame};

// ---- 常量（connection-machine.ts:58-73 逐条 verbatim；数值变更即协议事件）----

/// full jitter 退避 base。
pub const BACKOFF_BASE_MS: u64 = 500;

/// full jitter 退避 cap（SC2 锁定 60s——部署断连后的最长静默重连间隔）。
pub const BACKOFF_CAP_MS: u64 = 60_000;

/// 心跳周期：每 30s 一 ping（经服务端 auto-response 零计费保活）。
pub const HEARTBEAT_INTERVAL_MS: u64 = 30_000;

/// pong 死线：ping 后 10s 无 pong 判连接假死（死线强制重连 05-02 填充）。
pub const PONG_DEADLINE_MS: u64 = 10_000;

/// 探活死线（D-27 探活语义 05-02 填充）。
#[allow(dead_code)] // 词汇表完整性：05-02 探活臂位消费
pub const PROBE_DEADLINE_MS: u64 = 5_000;

/// has_more 连续翻页硬上限（T-02-06）。
#[allow(dead_code)] // 词汇表完整性：05-02 补拉序列消费
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
#[allow(dead_code)] // Manual/Deadline 臂位 05-02 填充（词汇表完整性）
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
#[allow(dead_code)] // Disconnect/Destroy/Visibility 臂位 05-02 填充（词汇表完整性）
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
#[allow(dead_code)] // SendSync/EmitAnswered 臂位 05-02 填充（词汇表完整性）
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
    fatal_stopped: bool,
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
            fatal_stopped: false,
            timers: HashSet::new(),
        }
    }

    /// 当前状态标签（只读观测口，非宿主 API）。
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
                self.fatal_stopped = false;
                self.cancel_timer(TimerKind::Reconnect, out);
                if self.state == MachineState::Connecting || self.state == MachineState::Online {
                    return; // 已在连
                }
                self.enter(MachineState::Connecting, out);
                out.push(Action::CreateSocket);
            }
            Event::Disconnect => {
                // 05-02 填充（TS 语义：manual close + offline 停机）。
            }
            Event::Destroy => {
                // 05-02 填充（TS 语义：cancelAll + manual close + destroyed）。
            }
            Event::WsOpen => {
                if self.state != MachineState::Connecting {
                    return;
                }
                self.attempt = 0;
                self.arm_timer(TimerKind::Heartbeat, HEARTBEAT_INTERVAL_MS, out);
                self.enter(MachineState::Online, out);
            }
            Event::WsClose => {
                if self.state == MachineState::Online || self.state == MachineState::Connecting {
                    self.cancel_all_timers(out);
                    if self.fatal_stopped {
                        self.enter(MachineState::Offline, out);
                        return;
                    }
                    // 意外断开（部署断连/网络闪断/握手失败）→ full jitter 退避重连。
                    self.enter(MachineState::Reconnecting, out);
                    let delay = self.backoff_delay();
                    self.arm_timer(TimerKind::Reconnect, delay, out);
                    self.attempt += 1;
                }
                // reconnecting/offline/destroyed：零动作。
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
                        // 死线超时强制重连（forceReconnect）——05-02 填充。
                    }
                }
            }
            Event::Visibility { .. } => {
                // D-27 探活（visible → ping + probe；hidden → 取消心跳/探活）——05-02 填充。
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
                // tracer：直发 EmitMessage（SeqDedup 过滤 05-02 接入）。
                out.push(Action::EmitMessage { message });
            }
            FrameResult::Ok(ServerFrame::History(frame)) => {
                // tracer：帧直通（dedup 过滤 + sendSync 补拉序列 05-02 填充）。
                out.push(Action::EmitHistory { frame });
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
mod tests {
    use super::*;

    /// tracer 退避确定性测试（05-01-PLAN Task 3 验收项）：
    /// 注入随机源恒 0.5，WsOpen 后 WsClose，首拍 Schedule{Reconnect, 250}
    /// ——min(60000, 500*2^0)=500 的窗口中点恰为 250ms。
    #[test]
    fn backoff_first_tick_deterministic_with_random_half() {
        let mut m = Machine::new(Box::new(|| 0.5));

        let acts = m.input(Event::Connect);
        assert!(
            matches!(
                acts.as_slice(),
                [Action::EmitStatus { status: Status::Connecting }, Action::CreateSocket]
            ),
            "Connect → EmitStatus(Connecting) + CreateSocket，实际 {acts:?}"
        );

        let acts = m.input(Event::WsOpen);
        assert!(
            acts.iter().any(|a| matches!(
                a,
                Action::Schedule { kind: TimerKind::Heartbeat, delay_ms: 30_000 }
            )),
            "WsOpen 武装心跳 30s，实际 {acts:?}"
        );
        assert!(
            acts.iter().any(|a| matches!(
                a,
                Action::EmitStatus { status: Status::Online }
            )),
            "WsOpen → EmitStatus(Online)，实际 {acts:?}"
        );

        let acts = m.input(Event::WsClose);
        assert!(
            acts.iter().any(|a| matches!(
                a,
                Action::EmitStatus { status: Status::Reconnecting }
            )),
            "WsClose → EmitStatus(Reconnecting)，实际 {acts:?}"
        );
        assert!(
            acts.iter().any(|a| matches!(
                a,
                Action::Schedule { kind: TimerKind::Reconnect, delay_ms: 250 }
            )),
            "首拍退避恰 250ms（0.5 × min(60000, 500×2^0)），实际 {acts:?}"
        );
    }

    /// v!==1 fatal → EmitError(fatal) + CloseSocket(Fatal) + Offline，此后零动作。
    #[test]
    fn fatal_frame_stops_machine_permanently() {
        let mut m = Machine::new(Box::new(|| 0.5));
        m.input(Event::Connect);
        m.input(Event::WsOpen);

        let acts = m.input(Event::Frame {
            result: FrameResult::Fatal("unsupported protocol version: 2".into()),
        });
        assert!(
            acts.iter().any(|a| matches!(
                a,
                Action::EmitError { error: ErrorPayload { fatal: Some(true), .. } }
            )),
            "fatal 帧 → EmitError(fatal)，实际 {acts:?}"
        );
        assert!(
            acts.iter().any(|a| matches!(
                a,
                Action::CloseSocket { reason: CloseReason::Fatal }
            )),
            "fatal 帧 → CloseSocket(Fatal)，实际 {acts:?}"
        );
        assert_eq!(m.status(), Status::Offline);

        // 停机后零动作：后续任何事件不再产出动作（不再重连）。
        assert!(m.input(Event::WsClose).is_empty());
        assert!(m.input(Event::Timer { kind: TimerKind::Reconnect }).is_empty());
        assert!(m
            .input(Event::Frame {
                result: FrameResult::Ok(ServerFrame::Pong)
            })
            .is_empty());
    }

    /// ghost timer 过滤：未武装的 TIMER 事件直接丢弃零动作。
    #[test]
    fn ghost_timer_filtered() {
        let mut m = Machine::new(Box::new(|| 0.5));
        m.input(Event::Connect);
        // heartbeat 从未武装即到点 → 幽灵，零动作。
        assert!(m.input(Event::Timer { kind: TimerKind::Heartbeat }).is_empty());
        assert_eq!(m.status(), Status::Connecting);
    }

    /// 畸形 serverUrl（WS_FAIL）→ fatal 停机语义（WR-04）。
    #[test]
    fn ws_fail_is_fatal_connect_failed() {
        let mut m = Machine::new(Box::new(|| 0.5));
        m.input(Event::Connect);
        let acts = m.input(Event::WsFail {
            message: "failed to construct WebSocket for serverUrl".into(),
        });
        assert!(
            acts.iter().any(|a| matches!(
                a,
                Action::EmitError { error: ErrorPayload { code: Some(ref c), fatal: Some(true), .. } } if c == "connect_failed"
            )),
            "WS_FAIL → EmitError(fatal, connect_failed)，实际 {acts:?}"
        );
        assert_eq!(m.status(), Status::Offline);
    }

    /// 心跳臂位：TIMER(heartbeat) → SendPing + 武装 pongDeadline + 重武装心跳。
    #[test]
    fn heartbeat_timer_sends_ping_and_arms_deadline() {
        let mut m = Machine::new(Box::new(|| 0.5));
        m.input(Event::Connect);
        m.input(Event::WsOpen);
        // 消化武装集里的 heartbeat（WsOpen 武装的那只）。
        let acts = m.input(Event::Timer { kind: TimerKind::Heartbeat });
        assert!(acts.iter().any(|a| matches!(a, Action::SendPing)));
        assert!(acts.iter().any(|a| matches!(
            a,
            Action::Schedule { kind: TimerKind::PongDeadline, delay_ms: 10_000 }
        )));
        assert!(acts.iter().any(|a| matches!(
            a,
            Action::Schedule { kind: TimerKind::Heartbeat, delay_ms: 30_000 }
        )));

        // FRAME(pong) → 取消两类死线（pongDeadline 已武装 → Cancel；probe 未武装 → 无）。
        let acts = m.input(Event::Frame {
            result: FrameResult::Ok(ServerFrame::Pong),
        });
        assert!(matches!(
            acts.as_slice(),
            [Action::Cancel { kind: TimerKind::PongDeadline }]
        ));
    }
}
