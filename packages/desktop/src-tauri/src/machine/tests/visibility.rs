//! VISIBILITY 探活场景（machine-heartbeat.test.ts 的 D-27 describe + hidden
//! describe 全场景镜像）。
//!
//! D-27：窗口/页面回前台 → 立即 ping + 5s 死线（冻结期间连接可能已被中间
//! 设备掐断，visible 瞬间主动探测而非等 30s 周期）；hidden → 取消心跳与
//! 探活（冻结省额度，恢复时探活接管）。桌面端 adapter 在 05-04 接窗口事件。

use super::*;
use crate::machine::{
    Action, CloseReason, Event as Ev, Status, TimerKind, PROBE_DEADLINE_MS,
};

fn has_schedule(acts: &[Action], kind: TimerKind, delay_ms: u64) -> bool {
    acts.iter().any(|a| matches!(
        a,
        Action::Schedule { kind: k, delay_ms: d } if *k == kind && *d == delay_ms
    ))
}

/// 常量锁定：探活死线 5s（字面量断言）。
#[test]
fn probe_deadline_constant_locked_5s() {
    assert_eq!(PROBE_DEADLINE_MS, 5_000);
}

/// VISIBILITY(visible) → 立即 sendPing + schedule(probe, 5_000) + 心跳接管
/// 恢复；不断连、不变状态。
#[test]
fn visible_sends_ping_arms_probe_keeps_connection() {
    let mut m = online_half();
    let acts = m.input(Event::Visibility { visible: true });
    assert!(acts.iter().any(|a| matches!(a, Action::SendPing)), "{acts:?}");
    assert!(has_schedule(&acts, TimerKind::Probe, 5_000), "{acts:?}");
    assert!(has_schedule(&acts, TimerKind::Heartbeat, 30_000), "心跳接管恢复：{acts:?}");
    assert!(!acts.iter().any(|a| matches!(a, Action::CloseSocket { .. })), "{acts:?}");
    assert!(!acts.iter().any(|a| matches!(a, Action::EmitStatus { .. })), "{acts:?}");
    assert_eq!(m.status(), Status::Online);
}

/// 探活 5s 内 pong → cancel(probe)，保持 online 无重连；probe 已解除后
/// 幽灵 TIMER(probe) 零动作。
#[test]
fn probe_pong_within_deadline_cancels_no_reconnect() {
    let mut m = online_half();
    m.input(Event::Visibility { visible: true });
    let acts = m.input(Event::Frame { result: pong() });
    assert!(
        acts.iter().any(|a| matches!(a, Action::Cancel { kind: TimerKind::Probe })),
        "{acts:?}"
    );
    assert!(!acts.iter().any(|a| matches!(a, Action::CloseSocket { .. })), "{acts:?}");
    assert!(!acts.iter().any(|a| matches!(a, Action::EmitStatus { .. })), "{acts:?}");
    // probe 已解除：幽灵 TIMER(probe) 零动作。
    assert!(m
        .input(Event::Timer {
            kind: TimerKind::Probe
        })
        .is_empty());
}

/// 探活超时 → 强制重连（closeSocket(deadline) + reconnecting + 退避 250）。
#[test]
fn probe_timeout_forces_reconnect() {
    let mut m = online_half(); // 0.5 × 500 = 250
    m.input(Event::Visibility { visible: true });
    let acts = m.input(Event::Timer {
        kind: TimerKind::Probe,
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
    assert!(has_schedule(&acts, TimerKind::Reconnect, 250), "{acts:?}");
}

/// 强制重连恢复 online 后探活路径可重复使用。
#[test]
fn probe_path_reusable_after_force_reconnect_recovery() {
    let mut m = online_half();
    m.input(Event::Visibility { visible: true });
    m.input(Event::Timer {
        kind: TimerKind::Probe,
    }); // 判死线
    m.input(Event::Timer {
        kind: TimerKind::Reconnect,
    }); // 退避到点重试
    m.input(Ev::WsOpen); // 恢复 online（attempt 归零）
    let acts = m.input(Event::Visibility { visible: true });
    assert!(acts.iter().any(|a| matches!(a, Action::SendPing)), "{acts:?}");
    assert!(has_schedule(&acts, TimerKind::Probe, 5_000), "{acts:?}");
}

/// 探活 ping 期间收到消息帧照常投递（探活不阻塞业务）。
#[test]
fn probe_ping_does_not_block_message_delivery() {
    let mut m = online_half();
    m.input(Event::Visibility { visible: true });
    let acts = m.input(Event::Frame { result: msg(1) });
    assert!(
        acts.iter().any(|a| matches!(a, Action::EmitMessage { .. })),
        "{acts:?}"
    );
}

/// VISIBILITY(hidden) → cancel(heartbeat) + cancel(probe)；迟到的 heartbeat
/// 幽灵不产 ping；hidden 期间挂起的探活一并取消。
#[test]
fn hidden_cancels_heartbeat_and_pending_probe() {
    let mut m = online_half(); // WS_OPEN 已 arm heartbeat
    m.input(Event::Visibility { visible: true }); // arm probe
    let acts = m.input(Event::Visibility { visible: false });
    assert!(
        acts.iter().any(|a| matches!(a, Action::Cancel { kind: TimerKind::Heartbeat })),
        "{acts:?}"
    );
    assert!(
        acts.iter().any(|a| matches!(a, Action::Cancel { kind: TimerKind::Probe })),
        "{acts:?}"
    );
    assert_eq!(m.status(), Status::Online, "hidden 只取消定时器，连接保持");
    // 迟到的 heartbeat 幽灵不产 ping；probe 幽灵零动作。
    assert!(m
        .input(Event::Timer {
            kind: TimerKind::Heartbeat
        })
        .is_empty());
    assert!(m
        .input(Event::Timer {
            kind: TimerKind::Probe
        })
        .is_empty());
}

/// 非 online 态的 VISIBILITY 零动作（reconnecting 期间探活无意义）。
#[test]
fn non_online_visibility_zero_actions() {
    let mut m = Machine::new(Box::new(|| 0.5));
    m.input(Event::Connect);
    m.input(Ev::WsClose); // → reconnecting
    assert!(m.input(Event::Visibility { visible: true }).is_empty());
    assert!(m.input(Event::Visibility { visible: false }).is_empty());
}
