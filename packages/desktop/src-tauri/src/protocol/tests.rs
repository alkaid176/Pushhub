//! golden fixtures 契约测试 + 常量对齐（05-02 Task 1，T-05-02-01/T-05-02-02）。
//!
//! 全部 15 个 fixtures 经 include_str! 跨包直读（相对 tests.rs 所在目录，
//! 目标根 packages/shared/fixtures/）——断言模式与 TS frames.test.ts 一一对照。
//! fixtures 的 `_note` 元数据字段是"未知字段忽略"（D-07）语义的活体测试：
//! 守卫必须放行（禁 deny_unknown_fields）。
//!
//! 方向说明：reply/sync 是客户端 → 服务端帧——parse_server_frame（服务端 →
//! 客户端方向）视角下均为未知 type → Drop；reply 正例经 ClientFrame::Reply
//! 反序列化消费（客户端发送侧 serde 结构的契约面）。

use serde_json::Value;

use super::{
    parse_server_frame, AckFrame, ClientFrame, FrameResult, ReplyFrame, ServerFrame,
};
use crate::machine;
use crate::machine::dedup;

// ---- 15 个 golden fixtures（include_str! 跨包直读）----

const ANSWERED_POSITIVE: &str =
    include_str!("../../../../shared/fixtures/answered-frame.positive.json");
const ENVELOPE_INVALID_BODY: &str =
    include_str!("../../../../shared/fixtures/error-envelope.invalid-body.json");
const ENVELOPE_INVALID_KEY: &str =
    include_str!("../../../../shared/fixtures/error-envelope.invalid-key.json");
const ENVELOPE_TOO_LARGE: &str =
    include_str!("../../../../shared/fixtures/error-envelope.payload-too-large.json");
const ENVELOPE_RATE_LIMITED: &str =
    include_str!("../../../../shared/fixtures/error-envelope.rate-limited.json");
const HISTORY_NEGATIVE: &str =
    include_str!("../../../../shared/fixtures/history-frame.negative.json");
const HISTORY_POSITIVE: &str =
    include_str!("../../../../shared/fixtures/history-frame.positive.json");
const MESSAGE_NEGATIVE: &str =
    include_str!("../../../../shared/fixtures/message-frame.negative.json");
const MESSAGE_POSITIVE: &str =
    include_str!("../../../../shared/fixtures/message-frame.positive.json");
const PONG_POSITIVE: &str = include_str!("../../../../shared/fixtures/pong-frame.positive.json");
const REPLY_NEGATIVE: &str =
    include_str!("../../../../shared/fixtures/reply-frame.negative.json");
const REPLY_POSITIVE: &str =
    include_str!("../../../../shared/fixtures/reply-frame.positive.json");
const SYNC_NEGATIVE: &str =
    include_str!("../../../../shared/fixtures/sync-frame.negative.json");
const SYNC_POSITIVE: &str = include_str!("../../../../shared/fixtures/sync-frame.positive.json");
const WS_ERROR: &str = include_str!("../../../../shared/fixtures/ws-error-frame.json");

fn as_array(raw: &str) -> Vec<Value> {
    serde_json::from_str(raw).expect("fixture is a JSON array")
}

fn stringify(entry: &Value) -> String {
    serde_json::to_string(entry).unwrap()
}

// ---- 正例：合法服务端帧 Ok，未知字段（_note）放行 ----

#[test]
fn pong_fixture_parses_with_unknown_note_field_ignored() {
    match parse_server_frame(PONG_POSITIVE) {
        FrameResult::Ok(ServerFrame::Pong) => {}
        other => panic!("expected Ok(Pong), got {:?}", other),
    }
}

#[test]
fn message_fixture_positive_fields() {
    match parse_server_frame(MESSAGE_POSITIVE) {
        FrameResult::Ok(ServerFrame::Message(m)) => {
            assert_eq!(m.wid, "m_2E9fKm3PqR7vXyZa");
            assert_eq!(m.seq, 42);
            assert_eq!(m.title.as_deref(), Some("Deploy finished"));
            assert_eq!(m.priority, "high");
            assert_eq!(
                m.options.as_ref().map(|o| o.len()),
                Some(3),
                "options 三项（Acknowledge/Retry deploy/Escalate）"
            );
            assert_eq!(m.answered, false);
            assert_eq!(m.answered_by, None);
            assert_eq!(m.answered_at, None);
            assert_eq!(m.answered_content, None);
            assert_eq!(m.created_at, 1756185600000);
            assert_eq!(
                m.callback_url.as_deref(),
                Some("https://ci.example.com/hooks/pushhub-callback")
            );
        }
        other => panic!("expected Ok(Message), got {:?}", other),
    }
}

#[test]
fn history_fixture_positive_each_entry_with_frozen_values() {
    let arr = as_array(HISTORY_POSITIVE);
    assert_eq!(arr.len(), 2, "翻页例 + 首拉例");
    for entry in &arr {
        let raw = stringify(entry);
        match parse_server_frame(&raw) {
            FrameResult::Ok(ServerFrame::History(h)) => {
                // 解析条数与 fixture 原文一致；每条元素 seq 升序（服务端契约）。
                let orig_len = entry["messages"].as_array().unwrap().len();
                assert_eq!(h.messages.len(), orig_len);
                let seqs: Vec<i64> = h.messages.iter().map(|m| m.seq).collect();
                assert!(seqs.windows(2).all(|w| w[0] < w[1]));
            }
            other => panic!("expected Ok(History), got {:?}", other),
        }
    }
    // fixtures 冻结值（TS frames.test.ts 同款双例断言）。
    match parse_server_frame(&stringify(&arr[0])) {
        FrameResult::Ok(ServerFrame::History(h)) => {
            assert_eq!(h.messages.len(), 2);
            assert_eq!(h.oldest_kept_seq, 41);
            assert!(h.has_more, "翻页例 has_more=true");
        }
        other => panic!("paging example: expected Ok(History), got {:?}", other),
    }
    match parse_server_frame(&stringify(&arr[1])) {
        FrameResult::Ok(ServerFrame::History(h)) => {
            assert_eq!(h.messages.len(), 50);
            assert_eq!(h.oldest_kept_seq, 1);
            assert!(!h.has_more, "首拉例 has_more=false");
        }
        other => panic!("first-fetch example: expected Ok(History), got {:?}", other),
    }
}

#[test]
fn answered_fixture_positive_each_entry_fields_verbatim() {
    let arr = as_array(ANSWERED_POSITIVE);
    assert_eq!(arr.len(), 2, "自报展示名 + 匿名两形态");
    let mut answered_by_values: Vec<Option<String>> = Vec::new();
    for entry in &arr {
        let raw = stringify(entry);
        match parse_server_frame(&raw) {
            FrameResult::Ok(ServerFrame::Answered(a)) => {
                assert_eq!(a.wid, entry["wid"].as_str().unwrap());
                assert_eq!(a.seq, entry["seq"].as_i64().unwrap());
                assert!(a.answered, "冻结形态恒 true（D-45）");
                assert_eq!(a.answered_at, entry["answered_at"].as_i64().unwrap());
                match entry["answered_content"].as_str() {
                    Some(s) => assert_eq!(a.answered_content.as_deref(), Some(s)),
                    None => assert_eq!(a.answered_content, None),
                }
                answered_by_values.push(a.answered_by.clone());
                // _note 字段存在且被忽略（D-07 活体测试）。
                assert!(entry.get("_note").is_some());
            }
            other => panic!("expected Ok(Answered), got {:?}", other),
        }
    }
    assert_eq!(
        answered_by_values,
        vec![Some("运维笔记本".to_string()), None],
        "两形态在位：自报展示名 + 匿名（answered_by null）"
    );
}

#[test]
fn ws_error_fixture_all_four_codes() {
    let arr = as_array(WS_ERROR);
    assert_eq!(arr.len(), 4);
    let mut codes = Vec::new();
    for entry in &arr {
        match parse_server_frame(&stringify(entry)) {
            FrameResult::Ok(ServerFrame::Error(e)) => {
                assert_eq!(e.code, entry["code"].as_str().unwrap());
                assert_eq!(e.message, entry["message"].as_str().unwrap());
                codes.push(e.code.clone());
            }
            other => panic!("expected Ok(Error), got {:?}", other),
        }
    }
    // 04-01 追加 already_replied / not_found 两例的冻结顺序。
    assert_eq!(
        codes,
        vec![
            "invalid_version",
            "invalid_frame",
            "already_replied",
            "not_found"
        ]
    );
}

#[test]
fn ack_three_key_frame_ok() {
    match parse_server_frame(r#"{"v":1,"type":"ack","wid":"m_2E9fKm3PqR7vXyZa"}"#) {
        FrameResult::Ok(ServerFrame::Ack(AckFrame { wid, .. })) => {
            assert_eq!(wid, "m_2E9fKm3PqR7vXyZa");
        }
        other => panic!("expected Ok(Ack), got {:?}", other),
    }
}

#[test]
fn ack_malformed_wid_drops() {
    // wid 缺失 / wid 非字符串 → 非致命丢弃（恰查三键：v/type/wid）。
    assert!(matches!(
        parse_server_frame(r#"{"v":1,"type":"ack"}"#),
        FrameResult::Drop(_)
    ));
    assert!(matches!(
        parse_server_frame(r#"{"v":1,"type":"ack","wid":42}"#),
        FrameResult::Drop(_)
    ));
}

// ---- 反例分流：Fatal（v 不匹配/缺失）与 Drop（结构违例/未知 type）----

#[test]
fn history_fixture_negative_each_violation_drops() {
    let arr = as_array(HISTORY_NEGATIVE);
    assert_eq!(arr.len(), 3);
    for entry in &arr {
        let raw = stringify(&entry["frame"]);
        match parse_server_frame(&raw) {
            FrameResult::Drop(_) => {}
            other => panic!(
                "expected Drop for violation {:?}, got {:?}",
                entry["_violation"], other
            ),
        }
    }
}

#[test]
fn sync_negative_fixture_v2_fatal_others_drop() {
    let arr = as_array(SYNC_NEGATIVE);
    assert_eq!(arr.len(), 5);
    for entry in &arr {
        let raw = stringify(&entry["frame"]);
        let v2 = entry["frame"]["v"].as_i64() == Some(2);
        match parse_server_frame(&raw) {
            FrameResult::Fatal(msg) => {
                assert!(v2, "仅 v:2 例为 fatal，violation={:?}", entry["_violation"]);
                assert!(
                    msg.contains("unsupported protocol version"),
                    "fatal 消息: {msg}"
                );
            }
            FrameResult::Drop(_) => {
                assert!(!v2, "v:2 例必须 fatal，violation={:?}", entry["_violation"]);
            }
            FrameResult::Ok(f) => panic!(
                "sync 是客户端帧——服务端方向未知 type，got Ok({:?}), violation={:?}",
                f, entry["_violation"]
            ),
        }
    }
}

#[test]
fn sync_positive_fixture_drops_as_client_direction_frame() {
    for entry in as_array(SYNC_POSITIVE) {
        assert!(
            matches!(parse_server_frame(&stringify(&entry)), FrameResult::Drop(_)),
            "sync 是客户端帧：服务端方向未知 type，entry={entry}"
        );
    }
}

#[test]
fn reply_negative_fixture_drops_in_server_direction() {
    let arr = as_array(REPLY_NEGATIVE);
    assert_eq!(arr.len(), 9);
    for entry in &arr {
        let raw = stringify(&entry["frame"]);
        match parse_server_frame(&raw) {
            FrameResult::Drop(reason) => {
                // v:1 的 reply 帧落在未知 type 分支（客户端方向帧）。
                assert_eq!(reason, "unknown frame type");
            }
            other => panic!(
                "expected Drop for violation {:?}, got {:?}",
                entry["_violation"], other
            ),
        }
    }
}

#[test]
fn reply_positive_fixture_deserializes_as_client_frame() {
    let arr = as_array(REPLY_POSITIVE);
    assert_eq!(arr.len(), 4);
    let mut saw_by = false;
    for entry in &arr {
        let frame: ReplyFrame = match serde_json::from_value(entry.clone()) {
            Ok(f) => f,
            Err(e) => panic!("reply 正例应可反序列化: {e}, entry={entry}"),
        };
        assert_eq!(frame.v, 1);
        assert_eq!(frame.frame_type, "reply");
        assert_eq!(frame.wid, "m_2E9fKm3PqR7vXyZa");
        if frame.by.is_some() {
            saw_by = true;
        }
        // 恰一形态逐例对齐（selected_option XOR text——fixture 冻结）。
        let has_opt = entry.get("selected_option").is_some();
        let has_text = entry.get("text").is_some();
        assert_ne!(has_opt, has_text, "恰一形态: {entry}");
        assert_eq!(frame.selected_option.is_some(), has_opt);
        assert_eq!(frame.text.is_some(), has_text);
    }
    assert!(saw_by, "4 例中恰一带 by（自报展示名形态）");
}

#[test]
fn reply_serialization_omits_absent_fields() {
    let frame = ReplyFrame {
        v: 1,
        frame_type: "reply".to_string(),
        wid: "m_2E9fKm3PqR7vXyZa".to_string(),
        selected_option: None,
        text: Some("done".to_string()),
        by: None,
    };
    let json = serde_json::to_string(&ClientFrame::Reply(frame.clone())).unwrap();
    assert!(!json.contains("by"), "by 缺省不序列化（省略语义）: {json}");
    assert!(!json.contains("selected_option"), "缺省可选字段同省略: {json}");
    assert!(json.contains(r#""text":"done""#), "{json}");

    let with_by = ReplyFrame {
        by: Some("运维笔记本".to_string()),
        ..frame
    };
    let json = serde_json::to_string(&ClientFrame::Reply(with_by)).unwrap();
    assert!(json.contains("by"), "by 提供时序列化: {json}");
}

#[test]
fn error_envelope_fixtures_fatal_version_gate_first() {
    // HTTP 信封非帧形态（无 v 字段）→ Fatal（D-07 版本门先行，TS 同款）。
    for raw in [
        ENVELOPE_INVALID_BODY,
        ENVELOPE_INVALID_KEY,
        ENVELOPE_TOO_LARGE,
        ENVELOPE_RATE_LIMITED,
    ] {
        assert!(
            matches!(parse_server_frame(raw), FrameResult::Fatal(_)),
            "error-envelope 无 v 字段 → fatal: {raw}"
        );
    }
}

#[test]
fn message_negative_fixture_bodies_fatal_no_v_field() {
    let arr = as_array(MESSAGE_NEGATIVE);
    assert_eq!(arr.len(), 8);
    for entry in &arr {
        let raw = stringify(&entry["body"]);
        assert!(
            matches!(parse_server_frame(&raw), FrameResult::Fatal(_)),
            "请求体反例无 v 字段 → fatal, violation={:?}",
            entry["_violation"]
        );
    }
}

#[test]
fn version_mismatch_is_fatal() {
    let raw = r#"{"v":2,"type":"pong"}"#;
    match parse_server_frame(raw) {
        FrameResult::Fatal(msg) => {
            assert!(msg.contains("2"), "fatal 消息含版本值: {msg}");
        }
        other => panic!("expected Fatal, got {:?}", other),
    }
    // v 缺失同为 fatal（D-07）。
    assert!(matches!(
        parse_server_frame(r#"{"type":"pong"}"#),
        FrameResult::Fatal(_)
    ));
    // v 类型混淆（字符串 "1"）同为 fatal——对齐 TS `parsed.v !== 1`。
    assert!(matches!(
        parse_server_frame(r#"{"v":"1","type":"pong"}"#),
        FrameResult::Fatal(_)
    ));
}

#[test]
fn unknown_type_and_unparseable_drop() {
    assert!(matches!(
        parse_server_frame(r#"{"v":1,"type":"future-thing","x":1}"#),
        FrameResult::Drop(_)
    ));
    assert!(matches!(
        parse_server_frame("not json at all"),
        FrameResult::Drop(_)
    ));
    assert!(matches!(
        parse_server_frame("[1,2,3]"),
        FrameResult::Drop(_)
    ));
    assert!(matches!(parse_server_frame("42"), FrameResult::Drop(_)));
    assert!(matches!(parse_server_frame("null"), FrameResult::Drop(_)));
}

#[test]
fn malformed_message_guards() {
    // seq 非正整数。
    assert!(matches!(
        parse_server_frame(
            r#"{"v":1,"type":"message","wid":"m_a","seq":0,"text":"x","priority":"normal","answered":false,"answered_by":null,"answered_at":null,"answered_content":null,"created_at":1}"#
        ),
        FrameResult::Drop(_)
    ));
    // text 非 string。
    assert!(matches!(
        parse_server_frame(
            r#"{"v":1,"type":"message","wid":"m_a","seq":1,"text":42,"priority":"normal","answered":false,"answered_by":null,"answered_at":null,"answered_content":null,"created_at":1}"#
        ),
        FrameResult::Drop(_)
    ));
    // priority 越界枚举。
    assert!(matches!(
        parse_server_frame(
            r#"{"v":1,"type":"message","wid":"m_a","seq":1,"text":"x","priority":"urgent","answered":false,"answered_by":null,"answered_at":null,"answered_content":null,"created_at":1}"#
        ),
        FrameResult::Drop(_)
    ));
    // wid 空串。
    assert!(matches!(
        parse_server_frame(
            r#"{"v":1,"type":"message","wid":"","seq":1,"text":"x","priority":"normal","answered":false,"answered_by":null,"answered_at":null,"answered_content":null,"created_at":1}"#
        ),
        FrameResult::Drop(_)
    ));
    // seq 为字符串（类型混淆——serde as_i64 拒绝非数字）。
    assert!(matches!(
        parse_server_frame(
            r#"{"v":1,"type":"message","wid":"m_a","seq":"5","text":"x","priority":"normal","answered":false,"answered_by":null,"answered_at":null,"answered_content":null,"created_at":1}"#
        ),
        FrameResult::Drop(_)
    ));
    // 必填可空字段 answered_by 键缺失（TS isStringOrNull(undefined) === false）。
    assert!(matches!(
        parse_server_frame(
            r#"{"v":1,"type":"message","wid":"m_a","seq":1,"text":"x","priority":"normal","answered":false,"answered_at":null,"answered_content":null,"created_at":1}"#
        ),
        FrameResult::Drop(_)
    ));
}

#[test]
fn answered_malformed_guards() {
    // answered_by 数字。
    assert!(matches!(
        parse_server_frame(
            r#"{"v":1,"type":"answered","wid":"m_x","seq":1,"answered":true,"answered_by":42,"answered_at":1756185660000,"answered_content":"x"}"#
        ),
        FrameResult::Drop(_)
    ));
    // answered_content 缺失（键必须存在，值可 null）。
    assert!(matches!(
        parse_server_frame(
            r#"{"v":1,"type":"answered","wid":"m_x","seq":1,"answered":true,"answered_by":null,"answered_at":1756185660000}"#
        ),
        FrameResult::Drop(_)
    ));
    // seq 负数（answered 守卫允许 0，拒绝负）。
    assert!(matches!(
        parse_server_frame(
            r#"{"v":1,"type":"answered","wid":"m_x","seq":-1,"answered":true,"answered_by":null,"answered_at":1756185660000,"answered_content":"x"}"#
        ),
        FrameResult::Drop(_)
    ));
    // type 拼错 → 未知 type 丢弃（非 fatal 路径）。
    match parse_server_frame(r#"{"v":1,"type":"answeered","wid":"m_x","seq":1}"#) {
        FrameResult::Drop(reason) => assert_eq!(reason, "unknown frame type"),
        other => panic!("expected Drop, got {:?}", other),
    }
}

// ---- 常量对齐（十项 must_haves + 超集；数值变更即协议事件）----

#[test]
fn constants_align_with_ts_source() {
    // 协议常量（packages/shared/src/index.ts:18-60 verbatim）。
    assert_eq!(super::PROTOCOL_VERSION, 1);
    assert_eq!(super::RETENTION_KEEP, 500);
    assert_eq!(super::INITIAL_FETCH, 50);
    assert_eq!(super::SYNC_LIMIT_DEFAULT, 200);
    assert_eq!(super::SYNC_LIMIT_MAX, 500);
    assert_eq!(super::BY_MAX, 64);
    // 机器常量（packages/web-sdk/src/connection-machine.ts:58-73 verbatim）。
    assert_eq!(machine::BACKOFF_BASE_MS, 500);
    assert_eq!(machine::BACKOFF_CAP_MS, 60_000);
    assert_eq!(machine::HEARTBEAT_INTERVAL_MS, 30_000);
    assert_eq!(machine::PONG_DEADLINE_MS, 10_000);
    assert_eq!(machine::PROBE_DEADLINE_MS, 5_000);
    assert_eq!(machine::SYNC_PAGE_MAX, 100);
    // 去重窗口（packages/web-sdk/src/dedup.ts:13 verbatim）。
    assert_eq!(dedup::DEDUP_WINDOW, 1000);
}
