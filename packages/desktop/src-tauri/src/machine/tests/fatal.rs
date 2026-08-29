//! fatal 停机/WS_FAIL/非致命错误路径场景（machine-fatal.test.ts 全场景 +
//! machine-events.test.ts 的 error 透传/坏帧丢弃 describe 镜像）。
//!
//! v!==1（FrameResult::Fatal）→ emitError(fatal) + closeSocket + offline，
//! 此后任何输入零动作不复活（D-07 客户端严格方向）；CONNECT 显式重连是唯一
//! 恢复口。WS_FAIL 与之同族（WR-04 畸形 serverUrl：确定性配置错误重试无意义）。

use super::*;
use crate::machine::{Action, CloseReason, Status, TimerKind};
use crate::protocol::FrameResult;

fn fatal_v2() -> FrameResult {
    FrameResult::Fatal("unsupported protocol version: 2".to_string())
}

/// fatal 帧 → emitError(fatal) + closeSocket(fatal) + emitStatus offline。
#[test]
fn fatal_frame_emits_error_closes_socket_offline() {
    let mut m = online_half();
    let acts = m.input(Event::Frame { result: fatal_v2() });

    let err = acts.iter().find_map(|a| match a {
        Action::EmitError { error } => Some(error.clone()),
        _ => None,
    });
    let err = err.expect("应有 emitError");
    assert_eq!(err.fatal, Some(true));
    assert!(
        err.message.contains("unsupported protocol version"),
        "{}",
        err.message
    );
    assert!(
        acts.iter().any(|a| matches!(
            a,
            Action::CloseSocket { reason: CloseReason::Fatal }
        )),
        "{acts:?}"
    );
    assert!(
        acts.iter().any(|a| matches!(a, Action::EmitStatus { status: Status::Offline })),
        "{acts:?}"
    );
}

/// fatal 后任何 TIMER 触发都不再 createSocket（心跳/死线/探活/重连全哑火）
/// ——fatal 后机器不再产生任何动作（不会自我复活）。
#[test]
fn fatal_any_timer_never_recreates_socket() {
    let mut m = online_half();
    m.input(Event::Frame { result: fatal_v2() });
    let mut followups = Vec::new();
    for kind in [
        TimerKind::Heartbeat,
        TimerKind::PongDeadline,
        TimerKind::Probe,
        TimerKind::Reconnect,
    ] {
        followups.extend(m.input(Event::Timer { kind }));
    }
    assert!(
        !followups.iter().any(|a| matches!(a, Action::CreateSocket)),
        "{followups:?}"
    );
    assert!(followups.is_empty(), "fatal 后应完全零动作，实际 {followups:?}");
}

/// fatal 后 WS_CLOSE（close 握手完成事件）零动作。
#[test]
fn fatal_late_ws_close_zero_actions() {
    let mut m = online_half();
    m.input(Event::Frame { result: fatal_v2() });
    assert!(m.input(Event::WsClose).is_empty());
}

/// fatal 后的 message 帧不投递（离线态不消费帧）。
#[test]
fn fatal_message_frame_not_delivered() {
    let mut m = online_half();
    m.input(Event::Frame { result: fatal_v2() });
    assert!(m.input(Event::Frame { result: msg(1) }).is_empty());
}

/// CONNECT 手动恢复：用户显式重连清除 fatal 态（02-01 语义保持）。
#[test]
fn connect_manually_recovers_after_fatal() {
    let mut m = online_half();
    m.input(Event::Frame { result: fatal_v2() });
    let acts = m.input(Event::Connect);
    assert!(
        acts.iter().any(|a| matches!(a, Action::CreateSocket)),
        "{acts:?}"
    );
    assert!(
        acts.iter().any(|a| matches!(a, Action::EmitStatus { status: Status::Connecting })),
        "{acts:?}"
    );
}

/// connecting 态 WS_FAIL → emitError(fatal, code=connect_failed) + offline
/// + 不武装任何定时器、不创建 socket（畸形 URL 重试无意义）。
#[test]
fn ws_fail_connecting_fatal_connect_failed_no_timers() {
    let mut m = Machine::new(Box::new(|| 0.5));
    m.input(Event::Connect);
    let acts = m.input(Event::WsFail {
        message: "failed to construct WebSocket for serverUrl".to_string(),
    });

    let err = acts
        .iter()
        .find_map(|a| match a {
            Action::EmitError { error } => Some(error.clone()),
            _ => None,
        })
        .expect("应有 emitError");
    assert_eq!(err.fatal, Some(true));
    assert_eq!(err.code.as_deref(), Some("connect_failed"));
    assert_eq!(err.message, "failed to construct WebSocket for serverUrl");
    assert!(
        acts.iter().any(|a| matches!(a, Action::EmitStatus { status: Status::Offline })),
        "{acts:?}"
    );
    assert!(!acts.iter().any(|a| matches!(a, Action::Schedule { .. })), "{acts:?}");
    assert!(!acts.iter().any(|a| matches!(a, Action::CreateSocket)), "{acts:?}");
    assert_eq!(m.status(), Status::Offline);
}

/// WS_FAIL 后任何 TIMER/WS_CLOSE/FRAME 都零动作（不复活）。
#[test]
fn ws_fail_all_followups_zero_actions() {
    let mut m = Machine::new(Box::new(|| 0.5));
    m.input(Event::Connect);
    m.input(Event::WsFail { message: "boom".to_string() });
    let mut followups = Vec::new();
    for kind in [
        TimerKind::Reconnect,
        TimerKind::Heartbeat,
        TimerKind::PongDeadline,
        TimerKind::Probe,
    ] {
        followups.extend(m.input(Event::Timer { kind }));
    }
    followups.extend(m.input(Event::WsClose));
    followups.extend(m.input(Event::Frame { result: msg(1) }));
    assert!(followups.is_empty(), "WS_FAIL 后应完全零动作，实际 {followups:?}");
}

/// idle 态 WS_FAIL 零动作（防御性忽略）。
#[test]
fn ws_fail_idle_zero_actions() {
    let mut m = Machine::new(Box::new(|| 0.5));
    assert!(m.input(Event::WsFail { message: "boom".to_string() }).is_empty());
    assert_eq!(m.status(), Status::Offline);
}

/// online 态 WS_FAIL 零动作（机器只消费 connecting 期的构造失败）。
#[test]
fn ws_fail_online_zero_actions() {
    let mut m = online_half();
    assert!(m.input(Event::WsFail { message: "boom".to_string() }).is_empty());
    assert_eq!(m.status(), Status::Online);
}

/// offline 态（disconnect 后）WS_FAIL 零动作。
#[test]
fn ws_fail_offline_after_disconnect_zero() {
    let mut m = online_half();
    m.input(Event::Disconnect);
    assert!(m.input(Event::WsFail { message: "boom".to_string() }).is_empty());
}

/// destroyed 态 WS_FAIL 零动作。
#[test]
fn ws_fail_destroyed_zero() {
    let mut m = online_half();
    m.input(Event::Destroy);
    assert!(m.input(Event::WsFail { message: "boom".to_string() }).is_empty());
}

/// DISCONNECT → cancelAll + closeSocket(manual) + offline；手动断开后的
/// WS_CLOSE 回喂零动作（不进退避——manuallyClosed 标志）。
#[test]
fn disconnect_closes_manually_then_ws_close_zero() {
    let mut m = online_half();
    let acts = m.input(Event::Disconnect);
    assert!(
        acts.iter().any(|a| matches!(
            a,
            Action::CloseSocket { reason: CloseReason::Manual }
        )),
        "{acts:?}"
    );
    assert!(
        acts.iter().any(|a| matches!(a, Action::Cancel { kind: TimerKind::Heartbeat })),
        "{acts:?}"
    );
    assert_eq!(m.status(), Status::Offline);
    assert!(m.input(Event::WsClose).is_empty());
}

/// 服务端 WsErrorFrame → emitError 透传（非致命，连接保持）。
#[test]
fn error_frame_passthrough_non_fatal_connection_kept() {
    let mut m = online_half();
    let acts = m.input(Event::Frame {
        result: FrameResult::Ok(crate::protocol::ServerFrame::Error(
            crate::protocol::WsErrorFrame {
                v: 1,
                frame_type: "error",
                code: "invalid_frame".to_string(),
                message: "Ignored malformed frame.".to_string(),
            },
        )),
    });
    let err = acts
        .iter()
        .find_map(|a| match a {
            Action::EmitError { error } => Some(error.clone()),
            _ => None,
        })
        .expect("应有 emitError");
    assert_eq!(err.code.as_deref(), Some("invalid_frame"));
    assert_eq!(err.message, "Ignored malformed frame.");
    assert_eq!(err.fatal, None);
    assert!(
        !acts.iter().any(|a| matches!(a, Action::CloseSocket { .. } | Action::EmitStatus { .. })),
        "非致命错误不得断连/变状态，实际 {acts:?}"
    );
    assert_eq!(m.status(), Status::Online);
}

/// 非致命坏帧（不可解析/结构违例）→ 静默零动作（D-07）。
#[test]
fn drop_frame_silent_zero_actions() {
    let mut m = online_half();
    assert!(
        m.input(Event::Frame {
            result: FrameResult::Drop("unparseable frame")
        })
        .is_empty()
    );
}
