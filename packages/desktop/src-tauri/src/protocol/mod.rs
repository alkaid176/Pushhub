//! 协议帧解析（05-01 Task 3 tracer，D-59/D-07）。
//!
//! 与 packages/web-sdk/src/frames.ts 三档语义逐行为对齐：
//!  - Ok(ServerFrame)：合法帧（tracer 实现 pong/message/history 三型，其余 05-02 补全）；
//!  - Drop(&'static str)：非致命丢弃（不可解析/非对象/未知 type/结构违例）——
//!    坏帧不毒害连接；
//!  - Fatal(String)：仅 v !== PROTOCOL_VERSION（D-07 客户端严格方向——
//!    "客户端不识别的 v 即断连报错"，服务端比客户端新，重连无意义）。
//!
//! 守卫纪律：serde_json::Value 手写逐字段守卫（对齐 frames.ts 的深校验，
//! 不信任 derive 默认行为）；未知字段一律忽略（D-07 协议演进规则，
//! fixtures 的 _note 元数据字段是活体测试）；**禁 deny_unknown_fields**。
//!
//! 协议常量与帧结构对齐 packages/shared/src/index.ts（冻结契约唯一事实源）。

use serde::Serialize;
use serde_json::{Map, Value};

pub const PROTOCOL_VERSION: i64 = 1;

/// v:1 message 帧（冻结 13 字段集，D-03；省略语义：可选字段未提供时键不出现）。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct MessageFrame {
    pub v: i64,
    #[serde(rename = "type")]
    pub frame_type: &'static str,
    pub wid: String,
    pub seq: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub options: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub callback_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub click_url: Option<String>,
    pub priority: String,
    pub answered: bool,
    pub answered_by: Option<String>,
    pub answered_at: Option<i64>,
    pub answered_content: Option<String>,
    pub created_at: i64,
}

/// v:1 history 帧（messages 按 seq 升序；oldest_kept_seq/has_more 原样透传，D-10/D-11）。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct HistoryFrame {
    pub v: i64,
    #[serde(rename = "type")]
    pub frame_type: &'static str,
    pub messages: Vec<MessageFrame>,
    pub oldest_kept_seq: i64,
    pub has_more: bool,
}

/// v:1 answered 帧（04-01 冻结字段集）——词汇表完整性保留（tracer 不解析，
/// 05-02 补全；Action::EmitAnswered 的载荷类型）。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AnsweredFrame {
    pub v: i64,
    #[serde(rename = "type")]
    pub frame_type: &'static str,
    pub wid: String,
    pub seq: i64,
    pub answered: bool,
    pub answered_by: Option<String>,
    pub answered_at: i64,
    pub answered_content: Option<String>,
}

/// tracer 已实现的服务端帧型（pong/message/history；answered/ack/error 05-02 补全）。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub enum ServerFrame {
    Pong,
    Message(MessageFrame),
    History(HistoryFrame),
}

/// parse_server_frame 结果三档（对齐 frames.ts FrameResult 判别联合）。
#[derive(Debug, Clone, PartialEq)]
pub enum FrameResult {
    Ok(ServerFrame),
    Drop(&'static str),
    Fatal(String),
}

// ---- 守卫（对齐 frames.ts 逐字段深校验；serde 默认行为不可信）----

/// 可选字符串字段：缺省（键不出现）或 string 均合法（省略语义）。
fn opt_string(m: &Map<String, Value>, key: &str) -> bool {
    match m.get(key) {
        None => true,
        Some(v) => v.is_string(),
    }
}

/// 可选 string[] 字段：缺省或全 string 数组。
fn opt_string_array(m: &Map<String, Value>, key: &str) -> bool {
    match m.get(key) {
        None => true,
        Some(Value::Array(items)) => items.iter().all(|i| i.is_string()),
        Some(_) => false,
    }
}

/// string | null 字段（answered_by/answered_content）。
fn string_or_null(m: &Map<String, Value>, key: &str) -> bool {
    match m.get(key) {
        None | Some(Value::Null) => true,
        Some(v) => v.is_string(),
    }
}

/// integer | null 字段（answered_at）。
fn integer_or_null(m: &Map<String, Value>, key: &str) -> bool {
    match m.get(key) {
        None | Some(Value::Null) => true,
        Some(v) => v.is_i64(),
    }
}

fn is_priority(v: Option<&Value>) -> bool {
    matches!(v.and_then(Value::as_str), Some("low") | Some("normal") | Some("high"))
}

/// MessageFrame 结构深校验（冻结 13 字段集，D-03）。history.messages 的元素
/// 必须各自带 v:1（golden 反例：元素缺 v 即 malformed）。
fn is_message_shape(v: &Value) -> bool {
    let Some(m) = v.as_object() else {
        return false;
    };
    if m.get("v").and_then(Value::as_i64) != Some(PROTOCOL_VERSION) {
        return false;
    }
    match m.get("wid").and_then(Value::as_str) {
        Some(wid) if !wid.is_empty() => {}
        _ => return false,
    }
    match m.get("seq").and_then(Value::as_i64) {
        Some(seq) if seq >= 1 => {}
        _ => return false,
    }
    if !opt_string(m, "title") {
        return false;
    }
    if !m.get("text").map(Value::is_string).unwrap_or(false) {
        return false;
    }
    if !opt_string_array(m, "options") {
        return false;
    }
    if !opt_string(m, "callback_url") || !opt_string(m, "click_url") {
        return false;
    }
    if !is_priority(m.get("priority")) {
        return false;
    }
    if !m.get("answered").map(Value::is_boolean).unwrap_or(false) {
        return false;
    }
    if !string_or_null(m, "answered_by") || !integer_or_null(m, "answered_at") {
        return false;
    }
    if !string_or_null(m, "answered_content") {
        return false;
    }
    if m.get("created_at").and_then(Value::as_i64).is_none() {
        return false;
    }
    m.get("type").and_then(Value::as_str) == Some("message")
}

/// HistoryFrame 结构深校验（messages 数组元素各自过 message 守卫 + 双整数字段）。
fn is_history_shape(v: &Value) -> bool {
    let Some(m) = v.as_object() else {
        return false;
    };
    let Some(messages) = m.get("messages").and_then(Value::as_array) else {
        return false;
    };
    if !messages.iter().all(is_message_shape) {
        return false;
    }
    match m.get("oldest_kept_seq").and_then(Value::as_i64) {
        Some(n) if n >= 0 => {}
        _ => return false,
    }
    m.get("has_more").map(Value::is_boolean).unwrap_or(false)
}

// ---- 提取（守卫已通过后的构造）----

fn take_string(m: &Map<String, Value>, key: &str) -> Option<String> {
    m.get(key).and_then(Value::as_str).map(str::to_string)
}

fn extract_message(m: &Map<String, Value>) -> MessageFrame {
    MessageFrame {
        v: PROTOCOL_VERSION,
        frame_type: "message",
        wid: take_string(m, "wid").unwrap_or_default(),
        seq: m.get("seq").and_then(Value::as_i64).unwrap_or(0),
        title: take_string(m, "title"),
        text: take_string(m, "text").unwrap_or_default(),
        options: m.get("options").and_then(Value::as_array).map(|items| {
            items
                .iter()
                .filter_map(|i| i.as_str().map(str::to_string))
                .collect()
        }),
        callback_url: take_string(m, "callback_url"),
        click_url: take_string(m, "click_url"),
        priority: take_string(m, "priority").unwrap_or_default(),
        answered: m.get("answered").and_then(Value::as_bool).unwrap_or(false),
        answered_by: take_string(m, "answered_by"),
        answered_at: m.get("answered_at").and_then(Value::as_i64),
        answered_content: take_string(m, "answered_content"),
        created_at: m.get("created_at").and_then(Value::as_i64).unwrap_or(0),
    }
}

fn extract_history(m: &Map<String, Value>) -> HistoryFrame {
    let messages = m
        .get("messages")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|i| i.as_object().map(extract_message))
                .collect()
        })
        .unwrap_or_default();
    HistoryFrame {
        v: PROTOCOL_VERSION,
        frame_type: "history",
        messages,
        oldest_kept_seq: m
            .get("oldest_kept_seq")
            .and_then(Value::as_i64)
            .unwrap_or(0),
        has_more: m
            .get("has_more")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    }
}

/// fatal 消息里的版本表示（对齐 TS `String(parsed.v)`：缺省 undefined）。
fn version_repr(v: Option<&Value>) -> String {
    match v {
        None => "undefined".to_string(),
        Some(Value::String(s)) => s.clone(),
        Some(other) => other.to_string(),
    }
}

/// 解析服务端入站帧（三档分流见模块头注释）。
pub fn parse_server_frame(raw: &str) -> FrameResult {
    let parsed: Value = match serde_json::from_str(raw) {
        Ok(v) => v,
        Err(_) => return FrameResult::Drop("unparseable frame"),
    };
    let Some(m) = parsed.as_object() else {
        return FrameResult::Drop("non-object frame");
    };

    // 版本先行（D-07）：v 缺失或不等于当前版本均为版本错误——fatal。
    let v_field = m.get("v");
    if v_field.and_then(Value::as_i64) != Some(PROTOCOL_VERSION) {
        return FrameResult::Fatal(format!(
            "unsupported protocol version: {}",
            version_repr(v_field)
        ));
    }

    match m.get("type").and_then(Value::as_str) {
        Some("pong") => FrameResult::Ok(ServerFrame::Pong),
        Some("message") => {
            if is_message_shape(&parsed) {
                FrameResult::Ok(ServerFrame::Message(extract_message(m)))
            } else {
                FrameResult::Drop("malformed message frame")
            }
        }
        Some("history") => {
            if is_history_shape(&parsed) {
                FrameResult::Ok(ServerFrame::History(extract_history(m)))
            } else {
                FrameResult::Drop("malformed history frame")
            }
        }
        // 未知 type（含 answered/ack/error——05-02 补全前暂按未知丢弃）：
        // D-07 前瞻兼容，非致命丢弃。
        _ => FrameResult::Drop("unknown frame type"),
    }
}

#[cfg(test)]
mod tests;
