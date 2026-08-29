//! 补拉确定序列/去重过滤/answered-ack 映射场景（machine-events.test.ts 的
//! history+sendSync、message 去重、answered/ack describe + history-filter.test.ts
//! 全场景镜像）。
//!
//! D-16×D-17 交集语义："emitHistory 载荷的 messages 永远只含宿主未见消息"；
//! 帧结构（oldest_kept_seq/has_more）原样透传（无 SDK 私有加工）。

use super::*;
use crate::machine::{Action, Event as Ev, TimerKind, SYNC_PAGE_MAX};
use crate::protocol::{AnsweredFrame, ServerFrame};

fn answered_frame() -> AnsweredFrame {
    AnsweredFrame {
        v: 1,
        frame_type: "answered",
        wid: "m_ansFrame000001".to_string(),
        seq: 7,
        answered: true,
        answered_by: Some("运维笔记本".to_string()),
        answered_at: 1_756_185_660_000,
        answered_content: Some("确认".to_string()),
    }
}

/// 重连首拉：emitHistory 只含未见消息，oldest_kept_seq/has_more 原样，
/// sendSync(since=连接前游标 syncBase, limit=SYNC_LIMIT_DEFAULT=200)。
#[test]
fn reconnect_first_pull_filtered_and_unconditional_sync() {
    let mut m = Machine::new(Box::new(|| 0.5));
    m.input(Event::Connect);
    // 第一段连接：实时见过 seq 1..10。
    m.input(Ev::WsOpen);
    for seq in 1..=10 {
        m.input(Event::Frame { result: msg(seq) });
    }
    // 意外断连 → 退避 → 重连成功。
    m.input(Ev::WsClose);
    m.input(Event::Timer {
        kind: TimerKind::Reconnect,
    });
    let open_acts = m.input(Ev::WsOpen);
    assert!(
        matches!(
            open_acts.as_slice(),
            [
                Action::Schedule { kind: TimerKind::Heartbeat, delay_ms: 30_000 },
                Action::EmitStatus { status: crate::machine::Status::Online }
            ]
        ),
        "WS_OPEN 动作恰 [arm heartbeat, emitStatus online]，实际 {open_acts:?}"
    );

    // 服务端 accept 即重推最近若干条（此处 8..15，交叠 8..10 已见）。
    let seqs: Vec<i64> = (8..=15).collect();
    let acts = m.input(Event::Frame {
        result: history(&seqs, 8, false),
    });

    let hist_seqs: Vec<i64> = acts
        .iter()
        .find_map(|a| match a {
            Action::EmitHistory { frame } => Some(frame.messages.iter().map(|m| m.seq).collect()),
            _ => None,
        })
        .expect("应有 emitHistory");
    assert_eq!(hist_seqs, vec![11, 12, 13, 14, 15], "只投递未见消息");
    // 帧结构原样透传（D-16）。
    let frame = acts.iter().find_map(|a| match a {
        Action::EmitHistory { frame } => Some(frame),
        _ => None,
    });
    let frame = frame.expect("emitHistory 存在");
    assert_eq!(frame.oldest_kept_seq, 8);
    assert!(!frame.has_more);
    // 无条件补拉：since=syncBase（WS_OPEN 瞬间的游标快照，02-01 决策 #5）。
    assert!(
        acts.iter().any(|a| matches!(
            a,
            Action::SendSync { since: 10, limit: 200 }
        )),
        "sendSync(since=syncBase=10, limit=200)，实际 {acts:?}"
    );
}

/// 翻页：has_more=true 的后续 history → sendSync(since=dedup.last) 续翻；
/// 追平（has_more=false）→ 不再 sync。
#[test]
fn paging_has_more_continues_with_dedup_last() {
    let mut m = online_half();
    // 首拉（has_more=true）→ 无条件 sync since=syncBase=0。
    let acts = m.input(Event::Frame {
        result: history(&[1, 2], 1, true),
    });
    let syncs: Vec<(i64, u32)> = acts
        .iter()
        .filter_map(|a| match a {
            Action::SendSync { since, limit } => Some((*since, *limit)),
            _ => None,
        })
        .collect();
    assert_eq!(syncs, vec![(0, 200)], "{acts:?}");

    // 翻页响应（3..5，has_more=true）→ 以本批最大 seq 为新 since。
    let acts = m.input(Event::Frame {
        result: history(&[3, 4, 5], 1, true),
    });
    let syncs: Vec<(i64, u32)> = acts
        .iter()
        .filter_map(|a| match a {
            Action::SendSync { since, limit } => Some((*since, *limit)),
            _ => None,
        })
        .collect();
    assert_eq!(syncs, vec![(5, 200)], "{acts:?}");

    // 追平（has_more=false）→ 不再 sync，仍投递。
    let acts = m.input(Event::Frame {
        result: history(&[6], 1, false),
    });
    assert!(!acts.iter().any(|a| matches!(a, Action::SendSync { .. })), "{acts:?}");
    assert!(acts.iter().any(|a| matches!(a, Action::EmitHistory { .. })), "{acts:?}");
}

/// SYNC_PAGE_MAX=100：连续 has_more 翻页达上限后放弃并 emitError
/// （code=sync_page_limit，非致命——连接保持，只放弃翻页）；放弃后正常
/// 收尾（has_more=false）仍照常投递。
#[test]
fn sync_page_max_100_gives_up_with_error() {
    assert_eq!(SYNC_PAGE_MAX, 100);
    let mut m = online_half();
    // 首拉 has_more=true → syncCount=1。
    let mut acts = m.input(Event::Frame {
        result: history(&[1], 1, true),
    });
    assert_eq!(
        acts.iter().filter(|a| matches!(a, Action::SendSync { .. })).count(),
        1
    );
    // 再翻 99 页（syncCount 2..100）——每批恰一个 sendSync。
    for i in 2..=100 {
        acts = m.input(Event::Frame {
            result: history(&[i], 1, true),
        });
        assert_eq!(
            acts.iter().filter(|a| matches!(a, Action::SendSync { .. })).count(),
            1,
            "第 {i} 批应恰一个 sendSync"
        );
    }
    // 第 101 批仍 has_more=true → 放弃：emitError、零 sendSync。
    acts = m.input(Event::Frame {
        result: history(&[101], 1, true),
    });
    assert!(
        !acts.iter().any(|a| matches!(a, Action::SendSync { .. })),
        "达上限后不再续翻，实际 {acts:?}"
    );
    let err = acts
        .iter()
        .find_map(|a| match a {
            Action::EmitError { error } => Some(error.clone()),
            _ => None,
        })
        .expect("应有 emitError");
    assert_eq!(err.code.as_deref(), Some("sync_page_limit"));
    assert_eq!(err.fatal, None, "非致命：连接保持");
    assert_eq!(m.status(), crate::machine::Status::Online);
    // 放弃后正常收尾（has_more=false）仍照常投递。
    let acts = m.input(Event::Frame {
        result: history(&[], 1, false),
    });
    assert!(acts.iter().any(|a| matches!(a, Action::EmitHistory { .. })), "{acts:?}");
    assert!(!acts.iter().any(|a| matches!(a, Action::SendSync { .. })), "{acts:?}");
}

/// message 去重（D-17 宿主永不见重复）：未见 seq → 恰一 emitMessage；
/// 重复 seq → 零输出。
#[test]
fn message_dedup_unseen_emits_duplicate_zero() {
    let mut m = online_half();
    // 吃掉首拉（空频道）避免 sendSync 干扰断言。
    m.input(Event::Frame {
        result: history(&[], 0, false),
    });

    let a1 = m.input(Event::Frame { result: msg(1) });
    assert_eq!(
        a1.iter().filter(|a| matches!(a, Action::EmitMessage { .. })).count(),
        1
    );

    let a2 = m.input(Event::Frame { result: msg(1) });
    assert!(a2.is_empty(), "重复 seq 零输出，实际 {a2:?}");
}

/// 预置已见 {1..30}，喂 history {20..50} → messages 恰为 {31..50}，
/// oldest_kept_seq/has_more 原样（D-16×D-17 交叠批次过滤）。
#[test]
fn overlap_batch_filtering_keeps_frame_fields_verbatim() {
    let seqs: Vec<i64> = (1..=30).collect();
    let mut m = online_with_seen(&seqs);
    let batch: Vec<i64> = (20..=50).collect();

    let acts = m.input(Event::Frame {
        result: history(&batch, 20, true),
    });
    let frame = acts
        .iter()
        .find_map(|a| match a {
            Action::EmitHistory { frame } => Some(frame),
            _ => None,
        })
        .expect("应有 emitHistory");
    let got: Vec<i64> = frame.messages.iter().map(|m| m.seq).collect();
    let expected: Vec<i64> = (31..=50).collect();
    assert_eq!(got, expected);
    // 帧结构原样透传（D-16：无 SDK 私有加工）。
    assert_eq!(frame.oldest_kept_seq, 20);
    assert!(frame.has_more);
    assert_eq!(frame.v, 1);
    assert_eq!(frame.frame_type, "history");
}

/// 全批已见的 history → messages 为空数组但帧仍发出（D-10 分隔线语义保留）。
#[test]
fn all_seen_batch_empty_messages_frame_still_emitted() {
    let mut m = online_with_seen(&[5, 6, 7]);
    let acts = m.input(Event::Frame {
        result: history(&[5, 6, 7], 5, false),
    });
    let frame = acts
        .iter()
        .find_map(|a| match a {
            Action::EmitHistory { frame } => Some(frame),
            _ => None,
        })
        .expect("全重复批仍应发帧");
    assert!(frame.messages.is_empty());
    assert_eq!(frame.oldest_kept_seq, 5);
    assert!(!frame.has_more);
}

/// 完整重连序列宿主零重复（T-02-07 / D-17）：实时 1..30 → 断连 → 重连首拉
/// 1..35 交叠 → 首拉后 sync 响应 31..35 再交叠 → 宿主恰见 1..35 各一次。
#[test]
fn full_reconnect_sequence_host_sees_no_duplicates() {
    let mut m = Machine::new(Box::new(|| 0.5));
    m.input(Event::Connect);
    let mut host_seqs: Vec<i64> = Vec::new();

    // 第一段连接：实时收 1..30。
    m.input(Ev::WsOpen);
    for seq in 1..=30 {
        for a in m.input(Event::Frame { result: msg(seq) }) {
            if let Action::EmitMessage { message } = a {
                host_seqs.push(message.seq);
            }
        }
    }

    // 意外断连 → 退避 → 重连（服务端部署断连场景）。
    m.input(Ev::WsClose);
    m.input(Event::Timer {
        kind: TimerKind::Reconnect,
    });
    m.input(Ev::WsOpen);

    // 重连首拉：服务端重推最近 50（此处 1..35，前 30 已见）。
    let batch: Vec<i64> = (1..=35).collect();
    let open_acts = m.input(Event::Frame {
        result: history(&batch, 1, false),
    });
    // 首拉后无条件 sync（since=连接前游标 30）。
    assert!(
        open_acts.iter().any(|a| matches!(a, Action::SendSync { since: 30, .. })),
        "{open_acts:?}"
    );
    for a in &open_acts {
        if let Action::EmitHistory { frame } = a {
            host_seqs.extend(frame.messages.iter().map(|m| m.seq));
        }
    }
    // sync 响应 31..35 再交叠一次。
    let tail: Vec<i64> = (31..=35).collect();
    let acts = m.input(Event::Frame {
        result: history(&tail, 1, false),
    });
    for a in &acts {
        if let Action::EmitHistory { frame } = a {
            host_seqs.extend(frame.messages.iter().map(|m| m.seq));
        }
    }

    // 宿主视角：恰 1..35 各一次，零重复。
    let expected: Vec<i64> = (1..=35).collect();
    assert_eq!(host_seqs, expected);
    let unique: std::collections::HashSet<i64> = host_seqs.iter().copied().collect();
    assert_eq!(unique.len(), host_seqs.len(), "宿主不得见重复");
}

/// answered 帧 → 恰一个 emitAnswered 动作且携带原帧（D-16 帧不加工）。
#[test]
fn answered_frame_emits_once_with_original_fields() {
    let mut m = online_half();
    m.input(Event::Frame {
        result: history(&[], 0, false),
    }); // 吃掉首拉
    let f = answered_frame();
    let acts = m.input(Event::Frame {
        result: answered_event(f.clone()),
    });
    let emitted: Vec<&AnsweredFrame> = acts
        .iter()
        .filter_map(|a| match a {
            Action::EmitAnswered { frame } => Some(frame),
            _ => None,
        })
        .collect();
    assert_eq!(emitted.len(), 1);
    assert_eq!(*emitted[0], f, "原帧逐字段透传");
}

/// ack 帧 → 零动作输出（04-01 Q4 定稿：ack 静默消费，无公共事件）。
#[test]
fn ack_frame_zero_actions() {
    let mut m = online_half();
    m.input(Event::Frame {
        result: history(&[], 0, false),
    });
    let acts = m.input(Event::Frame {
        result: FrameResult::Ok(ServerFrame::Ack(crate::protocol::AckFrame {
            v: 1,
            frame_type: "ack",
            wid: "m_ansFrame000001".to_string(),
        })),
    });
    assert!(acts.is_empty(), "ack 静默零动作，实际 {acts:?}");
}

/// 同 wid 两次 answered 帧 → 两次 emitAnswered（answered 路径与 SeqDedup
/// 完全隔离——D-17：answered 独立成帧正为避免同 seq 去重吞掉重发）。
#[test]
fn same_wid_answered_twice_emits_twice_dedup_isolated() {
    let mut m = online_half();
    m.input(Event::Frame {
        result: history(&[], 0, false),
    });
    let f = answered_frame();
    let a1 = m.input(Event::Frame {
        result: answered_event(f.clone()),
    });
    let a2 = m.input(Event::Frame {
        result: answered_event(f),
    });
    assert_eq!(
        a1.iter().filter(|a| matches!(a, Action::EmitAnswered { .. })).count(),
        1
    );
    assert_eq!(
        a2.iter().filter(|a| matches!(a, Action::EmitAnswered { .. })).count(),
        1,
        "同 wid 重复 answered 照发（幂等消化归宿主按 wid 判定），实际 {a2:?}"
    );
}

/// answered 帧的 FrameResult 包装便捷构造（本文件内多处使用）。
fn answered_event(frame: AnsweredFrame) -> FrameResult {
    FrameResult::Ok(ServerFrame::Answered(frame))
}
