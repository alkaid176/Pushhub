//! 心跳/pong 死线/ghost timer/DESTROY 场景（machine-heartbeat.test.ts 非探活
//! 部分 + machine-events.test.ts 的 pong 死线重置 describe 全场景镜像）。

use super::*;
use crate::machine::{
    Action, CloseReason, Event as Ev, Status, TimerKind, HEARTBEAT_INTERVAL_MS, PONG_DEADLINE_MS,
};

fn has_schedule(acts: &[Action], kind: TimerKind, delay_ms: Option<u64>) -> bool {
    acts.iter().any(|a| match a {
        Action::Schedule { kind: k, delay_ms: d } => {
            *k == kind && delay_ms.map(|w| *d == w).unwrap_or(true)
        }
        _ => false,
    })
}

/// 常量锁定：30s 心跳 / 10s pong 死线（5s 探活死线见 visibility.rs）。
#[test]
fn constants_locked_30s_10s() {
    assert_eq!(HEARTBEAT_INTERVAL_MS, 30_000);
    assert_eq!(PONG_DEADLINE_MS, 10_000);
}

/// TIMER(heartbeat) → sendPing + arm(pongDeadline, 10s) + re-arm(heartbeat, 30s)。
#[test]
fn heartbeat_timer_full_action_set() {
    let mut m = online_half();
    let acts = m.input(Event::Timer {
        kind: TimerKind::Heartbeat,
    });
    assert!(acts.iter().any(|a| matches!(a, Action::SendPing)), "{acts:?}");
    assert!(has_schedule(&acts, TimerKind::PongDeadline, Some(10_000)), "{acts:?}");
    assert!(has_schedule(&acts, TimerKind::Heartbeat, Some(30_000)), "{acts:?}");
}

/// FRAME(pong) → cancel(pongDeadline)，且不误伤心跳周期。
#[test]
fn pong_cancels_deadline_not_heartbeat() {
    let mut m = online_half();
    m.input(Event::Timer {
        kind: TimerKind::Heartbeat,
    }); // 武装 pongDeadline
    let acts = m.input(Event::Frame { result: pong() });
    assert!(
        acts.iter().any(|a| matches!(a, Action::Cancel { kind: TimerKind::PongDeadline })),
        "{acts:?}"
    );
    assert!(
        !acts.iter().any(|a| matches!(a, Action::Cancel { kind: TimerKind::Heartbeat })),
        "pong 不得误伤心跳周期，实际 {acts:?}"
    );
}

/// pong 死线超时 → closeSocket(deadline) + reconnecting + 退避 schedule，
/// 心跳停摆；close 握手完成后迟到的 WS_CLOSE 不二次调度（deadline 路径已接管）。
#[test]
fn pong_deadline_timeout_forces_reconnect_heartbeat_stops() {
    let mut m = online_half(); // attempt=0 → 退避 delay = 0.5*500 = 250
    m.input(Event::Timer {
        kind: TimerKind::Heartbeat,
    }); // sendPing + 武装 pongDeadline
    let acts = m.input(Event::Timer {
        kind: TimerKind::PongDeadline,
    });

    assert!(
        acts.iter().any(|a| matches!(
            a,
            Action::CloseSocket { reason: CloseReason::Deadline }
        )),
        "{acts:?}"
    );
    assert!(
        acts.iter().any(|a| matches!(a, Action::EmitStatus { status: Status::Reconnecting })),
        "{acts:?}"
    );
    assert!(has_schedule(&acts, TimerKind::Reconnect, Some(250)), "{acts:?}");
    assert!(
        acts.iter().any(|a| matches!(a, Action::Cancel { kind: TimerKind::Heartbeat })),
        "死线路径应停摆心跳，实际 {acts:?}"
    );
    // close 握手完成后迟到的 WS_CLOSE：reconnecting 态零动作（deadline 已接管）。
    assert!(m.input(Ev::WsClose).is_empty());
}

/// pong 到达解除死线后，TIMER(pongDeadline) 为幽灵事件零动作。
#[test]
fn pong_arrives_deadline_cleared_ghost_timer_zero() {
    let mut m = online_half();
    m.input(Event::Timer {
        kind: TimerKind::Heartbeat,
    }); // 武装 pongDeadline
    m.input(Event::Frame { result: pong() }); // 取消
    assert!(m
        .input(Event::Timer {
            kind: TimerKind::PongDeadline
        })
        .is_empty());
}

/// 未武装的 TIMER 事件直接丢弃零动作（ghost timer 过滤——connecting 态变体）。
#[test]
fn ghost_timer_unarmed_zero_actions() {
    let mut m = Machine::new(Box::new(|| 0.5));
    m.input(Event::Connect);
    // heartbeat 从未武装即到点 → 幽灵，零动作。
    assert!(m
        .input(Event::Timer {
            kind: TimerKind::Heartbeat
        })
        .is_empty());
    assert_eq!(m.status(), Status::Connecting);
}

/// DESTROY 清除全部在武定时器（D-18 资源释放，机器层）：heartbeat +
/// pongDeadline 在武时 DESTROY → 全部 cancel + offline，此后零动作。
#[test]
fn destroy_clears_all_armed_timers() {
    let mut m = online_half();
    m.input(Event::Timer {
        kind: TimerKind::Heartbeat,
    }); // arm pongDeadline
    let acts = m.input(Event::Destroy);
    assert!(
        acts.iter().any(|a| matches!(a, Action::Cancel { kind: TimerKind::Heartbeat })),
        "{acts:?}"
    );
    assert!(
        acts.iter().any(|a| matches!(a, Action::Cancel { kind: TimerKind::PongDeadline })),
        "{acts:?}"
    );
    assert!(
        acts.iter().any(|a| matches!(a, Action::EmitStatus { status: Status::Offline })),
        "{acts:?}"
    );
    for kind in [
        TimerKind::Reconnect,
        TimerKind::Heartbeat,
        TimerKind::PongDeadline,
        TimerKind::Probe,
    ] {
        assert!(m.input(Event::Timer { kind }).is_empty(), "{kind:?} 应零动作");
    }
    assert!(m.input(Event::Connect).is_empty()); // destroyed 不可复活
}
