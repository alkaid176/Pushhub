//! machine 测试家族（05-02 Task 3）——TS 测试家族场景全集的 Rust 镜像。
//!
//! 场景清单来源（TS 测试即场景清单，不自行发明用例）：
//!  - backoff.rs   ← machine-backoff.test.ts
//!  - heartbeat.rs ← machine-heartbeat.test.ts（心跳/死线/DESTROY 部分）
//!  - fatal.rs     ← machine-fatal.test.ts + machine-events.test.ts（error/坏帧）
//!  - resync.rs    ← machine-events.test.ts（history/去重/answered/ack）
//!                  + history-filter.test.ts
//!  - visibility.rs← machine-heartbeat.test.ts（D-27 探活 describe）
//!  - dedup 场景   ← dedup.test.ts（在 machine/dedup.rs 内嵌 #[cfg(test)]）
//!
//! 帧构造分工（对齐 TS test/helpers.ts）：机器测试直接构造 ServerFrame
//! 结构体（绕过 parse_server_frame——后者的契约由 protocol/tests.rs 吃
//! golden fixtures 独立锁定）。常量在断言中以字面量出现（250/60000/30000/
//! 10000/5000/100——数值漂移即测试红）。

mod backoff;
mod fatal;
mod heartbeat;
mod resync;
mod visibility;

use crate::machine::{Event, Machine};
use crate::protocol::{FrameResult, HistoryFrame, MessageFrame, ServerFrame};

/// 最小合法 message 帧（D-03 冻结 13 字段；可选字段走省略语义 None）。
pub(crate) fn msg_frame(seq: i64) -> MessageFrame {
    MessageFrame {
        v: 1,
        frame_type: "message",
        wid: format!("m_test{seq:012}"),
        seq,
        title: None,
        text: format!("message #{seq}"),
        options: None,
        callback_url: None,
        click_url: None,
        priority: "normal".to_string(),
        answered: false,
        answered_by: None,
        answered_at: None,
        answered_content: None,
        created_at: 1_700_000_000_000 + seq,
    }
}

/// message 帧事件（FrameResult::Ok 包装）。
pub(crate) fn msg(seq: i64) -> FrameResult {
    FrameResult::Ok(ServerFrame::Message(msg_frame(seq)))
}

/// history 帧事件（oldest_kept_seq / has_more 由调用方指定——原样透传断言用）。
pub(crate) fn history(seqs: &[i64], oldest_kept_seq: i64, has_more: bool) -> FrameResult {
    FrameResult::Ok(ServerFrame::History(HistoryFrame {
        v: 1,
        frame_type: "history",
        messages: seqs.iter().map(|&s| msg_frame(s)).collect(),
        oldest_kept_seq,
        has_more,
    }))
}

/// pong 帧事件。
pub(crate) fn pong() -> FrameResult {
    FrameResult::Ok(ServerFrame::Pong)
}

/// 在线机器（随机源恒 0.5——退避相关断言的确定性基准）。
pub(crate) fn online_half() -> Machine {
    let mut m = Machine::new(Box::new(|| 0.5));
    m.input(Event::Connect);
    m.input(Event::WsOpen);
    m
}

/// 在线机器 + 预置已见 seq（实时 message 帧逐条喂入）。
pub(crate) fn online_with_seen(seqs: &[i64]) -> Machine {
    let mut m = online_half();
    for seq in seqs {
        m.input(Event::Frame { result: msg(*seq) });
    }
    m
}
