//! full jitter 退避场景（machine-backoff.test.ts 全场景镜像）。
//!
//! delay = random() * min(60_000, 500 * 2^attempt)；随机源闭包注入制造确定性
//! （0 → 下界闭区间、0.5 → 恰中点、1 → 恰上界/cap）。cap 60_000 是 SC2 锁定值。

use super::*;
use crate::machine::{Action, TimerKind, BACKOFF_BASE_MS, BACKOFF_CAP_MS};

/// 连接失败循环：CONNECT → (WS_CLOSE → TIMER(reconnect)) × 30，attempt 0..29。
fn collect_backoff(random: Box<dyn FnMut() -> f64 + Send>) -> Vec<u64> {
    let mut m = Machine::new(random);
    m.input(Event::Connect);
    let mut delays = Vec::new();
    for _ in 0..30 {
        for a in m.input(Event::WsClose) {
            if let Action::Schedule {
                kind: TimerKind::Reconnect,
                delay_ms,
            } = a
            {
                delays.push(delay_ms);
            }
        }
        m.input(Event::Timer {
            kind: TimerKind::Reconnect,
        });
    }
    delays
}

/// 常量锁定：base 500ms / cap 60_000ms（字面量断言——数值漂移即测试红）。
#[test]
fn constants_locked_base_500_cap_60000() {
    assert_eq!(BACKOFF_BASE_MS, 500);
    assert_eq!(BACKOFF_CAP_MS, 60_000);
}

/// 连续 30 次重连尝试：每个 delay ∈ [0, min(60_000, 500*2^attempt)]
/// （多组随机样本：0 / 0.5 / 0.25 / 0.75 / 0.999999999999 / 0.000001）。
#[test]
fn thirty_attempts_within_bounds_multiple_random_samples() {
    let samples: Vec<Box<dyn FnMut() -> f64 + Send>> = vec![
        Box::new(|| 0.0),
        Box::new(|| 0.5),
        Box::new(|| 0.25),
        Box::new(|| 0.75),
        Box::new(|| 0.999_999_999_999),
        Box::new(|| 0.000_001),
    ];
    for random in samples {
        let delays = collect_backoff(random);
        assert_eq!(delays.len(), 30, "恰 30 个退避拍");
        for (attempt, &delay) in delays.iter().enumerate() {
            let attempt = attempt as u32;
            let bound = (BACKOFF_CAP_MS as u64).min(BACKOFF_BASE_MS * (1u64 << attempt));
            assert!(
                delay <= bound,
                "attempt={attempt} delay={delay} 越界 bound={bound}"
            );
        }
    }
}

/// full jitter 确定值：random=0.5 → delay = min(cap, base*2^attempt) / 2（恰中点）。
#[test]
fn full_jitter_deterministic_midpoint_random_half() {
    let delays = collect_backoff(Box::new(|| 0.5));
    for (attempt, &delay) in delays.iter().enumerate() {
        let attempt = attempt as u32;
        let expected = (BACKOFF_CAP_MS.min(BACKOFF_BASE_MS * (1u64 << attempt))) / 2;
        assert_eq!(delay, expected, "attempt={attempt} 应恰为窗口中点");
    }
}

/// cap 恰为 60_000：random=1 时 attempt>=7 的 delay 精确等于 60_000
/// （500*2^7=64_000 > 60_000 → min 生效）；attempt<7 时恰为 500*2^attempt。
#[test]
fn cap_exactly_60000_random_one() {
    let delays = collect_backoff(Box::new(|| 1.0));
    for (attempt, &delay) in delays.iter().enumerate() {
        if attempt >= 7 {
            assert_eq!(delay, 60_000, "attempt={attempt} cap 生效应精确 60000");
        } else {
            assert_eq!(
                delay,
                BACKOFF_BASE_MS * (1u64 << attempt),
                "attempt={attempt} 未及 cap 应恰为窗口全宽"
            );
        }
    }
}

/// random=0 时 delay=0（full jitter 下界闭区间）。
#[test]
fn random_zero_delay_zero() {
    for delay in collect_backoff(Box::new(|| 0.0)) {
        assert_eq!(delay, 0);
    }
}

/// 成功连接（WS_OPEN）后 attempt 归零——再断连退避回到 base 档
/// （0.5 × 500 = 250ms）。
#[test]
fn wsopen_resets_attempt_backoff_returns_to_base() {
    let mut m = Machine::new(Box::new(|| 0.5));
    m.input(Event::Connect);
    for _ in 0..3 {
        m.input(Event::WsClose);
        m.input(Event::Timer {
            kind: TimerKind::Reconnect,
        });
    }
    m.input(Event::WsOpen); // 第四次尝试成功 → attempt 归零
    let acts = m.input(Event::WsClose);
    let first = acts.iter().find_map(|a| match a {
        Action::Schedule {
            kind: TimerKind::Reconnect,
            delay_ms,
        } => Some(*delay_ms),
        _ => None,
    });
    assert_eq!(first, Some(250), "0.5 × min(60000, 500×2^0) = 250，实际 {acts:?}");
}

/// 完整连接动作序列 + 首拍退避确定性（05-01 tracer 验收项，从 mod.rs 迁移）：
/// Connect → [EmitStatus(Connecting), CreateSocket]；WsOpen → 武装心跳 +
/// EmitStatus(Online)；WsClose → EmitStatus(Reconnecting) + 首拍恰 250ms。
#[test]
fn backoff_first_tick_deterministic_with_random_half() {
    let mut m = Machine::new(Box::new(|| 0.5));

    let acts = m.input(Event::Connect);
    assert!(
        matches!(
            acts.as_slice(),
            [
                Action::EmitStatus {
                    status: crate::machine::Status::Connecting
                },
                Action::CreateSocket
            ]
        ),
        "Connect → EmitStatus(Connecting) + CreateSocket，实际 {acts:?}"
    );

    let acts = m.input(Event::WsOpen);
    assert!(
        acts.iter().any(|a| matches!(
            a,
            Action::Schedule {
                kind: TimerKind::Heartbeat,
                delay_ms: 30_000
            }
        )),
        "WsOpen 武装心跳 30s，实际 {acts:?}"
    );
    assert!(
        acts.iter().any(|a| matches!(
            a,
            Action::EmitStatus {
                status: crate::machine::Status::Online
            }
        )),
        "WsOpen → EmitStatus(Online)，实际 {acts:?}"
    );

    let acts = m.input(Event::WsClose);
    assert!(
        acts.iter().any(|a| matches!(
            a,
            Action::EmitStatus {
                status: crate::machine::Status::Reconnecting
            }
        )),
        "WsClose → EmitStatus(Reconnecting)，实际 {acts:?}"
    );
    assert!(
        acts.iter().any(|a| matches!(
            a,
            Action::Schedule {
                kind: TimerKind::Reconnect,
                delay_ms: 250
            }
        )),
        "首拍退避恰 250ms（0.5 × min(60000, 500×2^0)），实际 {acts:?}"
    );
}
