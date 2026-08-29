//! 每频道本地消息环形缓冲（05-04 Task 1，D-60/D-62）。
//!
//! 职责：Rust 侧持有频道消息历史（服务端 DO 只保留 500 条——客户端存更多
//! 无意义，D-62 对齐 RETENTION_KEEP=500/D-08），作为窗口重开时全量重建列表
//! 的数据源（D-60：前端无常驻状态，snapshot 即重建载荷）。
//!
//! 语义锁定：
//!  - 容量 500 环形：push 满时淘汰最旧一条（严格插入序，最旧先出）并返回
//!    被淘汰项；
//!  - snapshot() 返回当前全部消息（按 seq 升序）与元信息（累计淘汰数、
//!    最旧保留 seq）——Pitfall 7：v1 直接全量导出（接受 ~16MB 理论峰值
//!    边界，个人/小团队现实消息远小于上限，不预优化）；
//!  - apply_answered：answered 状态原位更新（不新增条目——D-17 answered
//!    独立成帧正是为此）；找不到对应 wid 返回 false（迟到 answered 容忍，
//!    消息可能已被环形淘汰或属于其他会话前窗口）。
//!
//! 零 tokio 依赖（纯逻辑，std VecDeque + std sync 原语）。

use std::collections::VecDeque;

use serde::Serialize;

use crate::protocol::{AnsweredFrame, MessageFrame};

/// 每频道缓冲上限（D-62；与服务端 DO 保留窗口 RETENTION_KEEP=500/D-08 对齐
/// ——测试硬断言两常量互等，数值漂移即协议事件）。
pub const BUFFER_CAP: usize = 500;

/// snapshot 全量导出（窗口重开重建的数据源，D-60）。
#[allow(dead_code)] // 生产消费者：manager.snapshot → 05-05 窗口重建命令（测试已锁定语义）
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct BufferSnapshot {
    /// 当前保留消息（按 seq 升序——插入序在补拉/实时交叠时可能乱序，
    /// 展示语义要求 seq 升序，导出时排序）。
    pub messages: Vec<MessageFrame>,
    /// 自缓冲创建以来累计淘汰条数（观测元数据）。
    pub evicted: u64,
    /// 当前保留的最旧 seq（空缓冲为 None）。
    pub oldest_kept_seq: Option<i64>,
}

/// 环形消息缓冲（泛型默认 MessageFrame——answered 原位更新与 seq 元信息
/// 为 MessageFrame 特化能力，见 `impl Buffer<MessageFrame>`）。
pub struct Buffer<T = MessageFrame> {
    deque: VecDeque<T>,
    evicted: u64,
}

impl<T> Buffer<T> {
    pub fn new() -> Self {
        Self {
            deque: VecDeque::with_capacity(BUFFER_CAP),
            evicted: 0,
        }
    }

    /// 入缓冲；容量满时淘汰最旧一条（插入序）并返回被淘汰项（未满返回 None）。
    pub fn push(&mut self, msg: T) -> Option<T> {
        let evicted = if self.deque.len() >= BUFFER_CAP {
            self.deque.pop_front()
        } else {
            None
        };
        if evicted.is_some() {
            self.evicted += 1;
        }
        self.deque.push_back(msg);
        evicted
    }

    /// 当前保留条数。
    #[allow(dead_code)] // 测试断言 + 05-05 窗口重建命令消费
    pub fn len(&self) -> usize {
        self.deque.len()
    }

    /// 是否为空。
    #[allow(dead_code)] // 05-06 UI 空态判断
    pub fn is_empty(&self) -> bool {
        self.deque.is_empty()
    }
}

impl Buffer<MessageFrame> {
    /// 全量快照：消息按 seq 升序 + 淘汰计数 + 最旧保留 seq。
    #[allow(dead_code)] // 生产消费者：manager.snapshot → 05-05 窗口重建命令（测试已锁定语义）
    pub fn snapshot(&self) -> BufferSnapshot {
        let mut messages: Vec<MessageFrame> = self.deque.iter().cloned().collect();
        messages.sort_by_key(|m| m.seq);
        BufferSnapshot {
            oldest_kept_seq: messages.first().map(|m| m.seq),
            messages,
            evicted: self.evicted,
        }
    }

    /// answered 原位更新（D-17）：按 wid 定位缓冲内消息，answered 系列字段
    /// 以帧为准覆写；找不到返回 false（迟到 answered 容忍——消息可能已被
    /// 环形淘汰）。幂等：同 wid 重复扇出重复覆写无害。
    pub fn apply_answered(&mut self, frame: &AnsweredFrame) -> bool {
        for m in &mut self.deque {
            if m.wid == frame.wid {
                m.answered = frame.answered;
                m.answered_by = frame.answered_by.clone();
                m.answered_at = Some(frame.answered_at);
                m.answered_content = frame.answered_content.clone();
                return true;
            }
        }
        false
    }
}

impl<T> Default for Buffer<T> {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::RETENTION_KEEP;

    /// 最小合法 message 帧（对齐 machine/tests/mod.rs 构造分工）。
    fn msg(seq: i64) -> MessageFrame {
        MessageFrame {
            v: 1,
            frame_type: "message",
            wid: format!("w{seq:012}"),
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

    /// answered 帧（by/content 可指定——apply_answered 覆写断言用）。
    fn answered_frame(wid: &str, seq: i64) -> AnsweredFrame {
        AnsweredFrame {
            v: 1,
            frame_type: "answered",
            wid: wid.to_string(),
            seq,
            answered: true,
            answered_by: Some("alice".to_string()),
            answered_at: 1_700_000_001_000,
            answered_content: Some("done".to_string()),
        }
    }

    /// BUFFER_CAP 对齐服务端保留窗口（D-62×D-08——两常量互等硬断言）。
    #[test]
    fn buffer_cap_matches_server_retention() {
        assert_eq!(BUFFER_CAP, 500);
        assert_eq!(BUFFER_CAP, RETENTION_KEEP);
    }

    /// 容量边界：恰 500 条零淘汰（push 全返回 None）。
    #[test]
    fn push_within_cap_no_eviction() {
        let mut buf = Buffer::new();
        for seq in 1..=500 {
            assert!(buf.push(msg(seq)).is_none(), "seq {seq} 不应淘汰");
        }
        assert_eq!(buf.len(), 500);
        assert!(!buf.is_empty());
    }

    /// 第 501/502 条分别淘汰最旧两条（严格插入序，最旧先出），容量恒 500。
    #[test]
    fn push_beyond_cap_evicts_oldest_in_insertion_order() {
        let mut buf = Buffer::new();
        for seq in 1..=500 {
            buf.push(msg(seq));
        }
        let evicted = buf.push(msg(501)).expect("第 501 条必须淘汰最旧一条");
        assert_eq!(evicted.seq, 1);
        let evicted = buf.push(msg(502)).expect("第 502 条淘汰次旧一条");
        assert_eq!(evicted.seq, 2);
        assert_eq!(buf.len(), 500);
    }

    /// snapshot：全量导出按 seq 升序 + 淘汰计数 + 最旧保留 seq 元信息；
    /// 空缓冲 messages 空 / evicted 0 / oldest_kept_seq None。
    #[test]
    fn snapshot_order_and_metadata() {
        let mut buf = Buffer::new();
        // 空缓冲。
        let empty = buf.snapshot();
        assert!(empty.messages.is_empty());
        assert_eq!(empty.evicted, 0);
        assert_eq!(empty.oldest_kept_seq, None);

        for seq in 1..=502 {
            buf.push(msg(seq));
        }
        let snap = buf.snapshot();
        assert_eq!(snap.messages.len(), 500);
        // 升序：最旧保留 seq=3，最新 seq=502。
        assert_eq!(snap.evicted, 2);
        assert_eq!(snap.oldest_kept_seq, Some(3));
        assert_eq!(snap.messages.first().unwrap().seq, 3);
        assert_eq!(snap.messages.last().unwrap().seq, 502);
        // 严格升序断言。
        let seqs: Vec<i64> = snap.messages.iter().map(|m| m.seq).collect();
        let mut sorted = seqs.clone();
        sorted.sort_unstable();
        assert_eq!(seqs, sorted);
    }

    /// 补拉/实时交叠时插入序可乱（先到 seq 100，补拉批 60..99 后到）——
    /// snapshot 导出仍按 seq 升序（展示语义），oldest_kept_seq 取最小 seq。
    #[test]
    fn snapshot_sorts_out_of_order_arrivals() {
        let mut buf = Buffer::new();
        buf.push(msg(100));
        for seq in 60..100 {
            buf.push(msg(seq));
        }
        let snap = buf.snapshot();
        let seqs: Vec<i64> = snap.messages.iter().map(|m| m.seq).collect();
        assert_eq!(seqs.first(), Some(&60));
        assert_eq!(seqs.last(), Some(&100));
        assert_eq!(snap.oldest_kept_seq, Some(60));
        let mut sorted = seqs.clone();
        sorted.sort_unstable();
        assert_eq!(seqs, sorted);
    }

    /// apply_answered 命中：answered 系列字段原位更新，条目数不变。
    #[test]
    fn apply_answered_hit_updates_in_place() {
        let mut buf = Buffer::new();
        buf.push(msg(1));
        buf.push(msg(2));
        let before = buf.len();

        assert!(buf.apply_answered(&answered_frame("w000000000001", 1)));
        let snap = buf.snapshot();
        let m = &snap.messages[0];
        assert_eq!(m.seq, 1);
        assert!(m.answered);
        assert_eq!(m.answered_by.as_deref(), Some("alice"));
        assert_eq!(m.answered_at, Some(1_700_000_001_000));
        assert_eq!(m.answered_content.as_deref(), Some("done"));
        // 原位更新不新增条目。
        assert_eq!(buf.len(), before);
        // 幂等：同 wid 重复扇出重复覆写无害（D-17）。
        assert!(buf.apply_answered(&answered_frame("w000000000001", 1)));
        assert_eq!(buf.len(), before);
    }

    /// apply_answered 未命中：迟到 answered（消息已淘汰/不在此窗口）返回
    /// false，缓冲不变。
    #[test]
    fn apply_answered_miss_returns_false() {
        let mut buf = Buffer::new();
        buf.push(msg(1));
        assert!(!buf.apply_answered(&answered_frame("unknown_wid", 1)));
        let snap = buf.snapshot();
        assert!(!snap.messages[0].answered);
        assert_eq!(buf.len(), 1);
    }
}
