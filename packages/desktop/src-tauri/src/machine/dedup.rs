//! SeqDedup —— seq 幂等去重窗口（05-02，D-17；dedup.ts 同构移植）。
//!
//! 职责：连接核心内部维护 last_seq + 已见 seq 集合，实时帧与补拉帧交叠时自动
//! 去重，宿主永不见重复消息——服务端承诺零丢失零重复（SC2），本模块是第二道
//! 防线（防部署断连窗口的边界交叠：服务端每次 accept 无条件重推最近 50 条首拉）。
//!
//! 内存有界：窗口按 DEDUP_WINDOW 裁剪——服务端保留窗口 RETENTION_KEEP=500 +
//! 首拉 INITIAL_FETCH=50 的交叠上界 ~550，取 1000 留冗余（A2 建议值）。
//!
//! answered 帧不经本模块（D-17 硬约束：SDK 按 seq 去重会吞同 seq 重发，
//! answered 独立成帧正是为此——原样透传由 machine 直接 EmitAnswered）。

use std::collections::HashSet;

/// 去重窗口宽度：last_seq - DEDUP_WINDOW 之前的旧 seq 从 Set 裁剪。
pub const DEDUP_WINDOW: i64 = 1000;

pub struct SeqDedup {
    seen: HashSet<i64>,
    last_seq: i64,
}

impl SeqDedup {
    pub fn new() -> Self {
        Self {
            seen: HashSet::new(),
            last_seq: 0,
        }
    }

    /// 该 seq 是否应投递给宿主。
    ///  - 已见 → false（重复，不投递）；
    ///  - 未见 → 记录、last_seq 取 max、裁剪超窗口旧条目 → true。
    pub fn should_deliver(&mut self, seq: i64) -> bool {
        if !self.seen.insert(seq) {
            return false;
        }
        if seq > self.last_seq {
            self.last_seq = seq;
        }
        let floor = self.last_seq - DEDUP_WINDOW;
        if self.seen.len() > DEDUP_WINDOW as usize {
            self.seen.retain(|&s| s >= floor);
        }
        true
    }

    /// 当前游标（已见最大 seq；空窗口为 0）。
    pub fn last(&self) -> i64 {
        self.last_seq
    }

    /// 测试观测口：当前去重窗口内存条目数（有界性断言用，对齐 dedup.ts size）。
    #[allow(dead_code)] // 纯测试观测口（dedup.rs 内嵌测试的有界性断言消费）
    pub fn len(&self) -> usize {
        self.seen.len()
    }
}

impl Default for SeqDedup {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 首次投递 true / 重复 false（dedup.test.ts 场景 1）。
    #[test]
    fn first_delivery_true_duplicate_false() {
        let mut d = SeqDedup::new();
        assert!(d.should_deliver(1));
        assert!(!d.should_deliver(1));
        assert!(d.should_deliver(2));
        assert!(!d.should_deliver(2));
        assert!(!d.should_deliver(1));
    }

    /// 乱序到达 last 取 max（场景 2）。
    #[test]
    fn out_of_order_last_takes_max() {
        let mut d = SeqDedup::new();
        assert!(d.should_deliver(10));
        assert_eq!(d.last(), 10);
        assert!(d.should_deliver(5));
        assert_eq!(d.last(), 10);
        assert!(d.should_deliver(3));
        assert_eq!(d.last(), 10);
        assert!(d.should_deliver(12));
        assert_eq!(d.last(), 12);
    }

    /// 超窗口旧 seq 裁剪后窗口尺寸有界（场景 3）。
    #[test]
    fn window_size_bounded_after_pruning() {
        let mut d = SeqDedup::new();
        for seq in 1..=3000 {
            d.should_deliver(seq);
        }
        assert!(d.len() <= (DEDUP_WINDOW + 1) as usize);
        assert_eq!(d.last(), 3000);
    }

    /// 窗口内重复仍被拦（裁剪不影响近期去重，场景 4/6）。
    #[test]
    fn in_window_duplicates_still_intercepted() {
        let mut d = SeqDedup::new();
        for seq in 1..=2000 {
            d.should_deliver(seq);
        }
        assert!(!d.should_deliver(1500));
        assert!(!d.should_deliver(1000));
        assert!(!d.should_deliver(2000));
        assert!(d.should_deliver(2001));
        assert_eq!(d.last(), 2001);
    }

    /// 窗外语义：超窗旧 seq 视为未见——服务端保留窗口 500 使该重放不可达
    /// （文档化取舍，场景 7）。
    #[test]
    fn beyond_window_old_seq_treated_as_unseen() {
        let mut d = SeqDedup::new();
        for seq in 1..=2000 {
            d.should_deliver(seq);
        }
        // seq 999 已被裁剪出窗口：再见到视为未见（合规服务端不可能重放）。
        assert!(d.should_deliver(999));
    }

    /// 实时帧与补拉帧交叠（重连场景）：已见消息不二次投递（场景 5）。
    #[test]
    fn realtime_and_catchup_overlap_no_double_delivery() {
        let mut d = SeqDedup::new();
        for seq in 1..=30 {
            assert!(d.should_deliver(seq));
        }
        for seq in 51..=100 {
            assert!(d.should_deliver(seq));
        }
        let delivered = (31..=100).filter(|seq| d.should_deliver(*seq)).count();
        assert_eq!(delivered, 20);
        assert_eq!(d.last(), 100);
    }
}
