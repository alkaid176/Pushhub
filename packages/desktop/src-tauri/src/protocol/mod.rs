//! 协议帧解析（05-01 Task 3 tracer + 05-02 Task 1 全帧型补全，D-59/D-07）。
//!
//! 与 packages/web-sdk/src/frames.ts 三档语义逐行为对齐：
//!  - Ok(ServerFrame)：合法帧（pong/message/history/answered/ack/error 全集）；
//!  - Drop(&'static str)：非致命丢弃（不可解析/非对象/未知 type/结构违例）——
//!    坏帧不毒害连接；
//!  - Fatal(String)：仅 v !== PROTOCOL_VERSION（D-07 客户端严格方向——
//!    "客户端不识别的 v 即断连报错"，服务端比客户端新，重连无意义）。
//!
//! 守卫纪律：serde_json::Value 手写逐字段守卫（对齐 frames.ts 的深校验，
//! 不信任 derive 默认行为）；未知字段一律忽略（D-07 协议演进规则，
//! fixtures 的 _note 元数据字段是活体测试）；不启用严格未知字段拒绝属性。
//!
//! 协议常量与帧结构对齐 packages/shared/src/index.ts（冻结契约唯一事实源）。

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub const PROTOCOL_VERSION: i64 = 1;

// ---- 协议常量（shared/src/index.ts:18-60 verbatim；数值变更即协议事件）----

/// D-08 每频道保留窗口：最近 500 条——桌面端环形缓冲上限（BUFFER_CAP，D-62；
/// buffer 模块在 05-04+ 接线消费）。
#[allow(dead_code)]
pub const RETENTION_KEEP: usize = 500;

/// D-09 新客户端首次连接（since: null）默认拉取的最近消息条数（D-63 行为锚点；
/// 服务端行为常量，客户端侧对齐断言消费）。
#[allow(dead_code)]
pub const INITIAL_FETCH: usize = 50;

/// D-11 sync 补拉 limit 缺省值（machine SendSync 动作消费）。
pub const SYNC_LIMIT_DEFAULT: u32 = 200;

/// D-11 sync 补拉 limit 上限（一次拉不完以 has_more 翻页；服务端侧权威校验，
/// 客户端侧常量对齐断言消费）。
#[allow(dead_code)]
pub const SYNC_LIMIT_MAX: u32 = 500;

/// D-53 回复展示名（reply 帧 by 字段）最大长度：64 UTF-16 码元（reply 命令层
/// 宽松预检消费，05-05；权威校验在服务端）。
#[allow(dead_code)]
pub const BY_MAX: usize = 64;

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

/// v:1 answered 帧（04-01 冻结字段集）——Action::EmitAnswered 的载荷类型；
/// 不经 SeqDedup 原样透传（D-17：独立帧而非 message 重发）。
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

/// v:1 ack 帧（服务端 → 回复者本人，04-01 Q4）——恰 v/type/wid 三键的
/// 最小确认；机器侧静默消费零动作（answered 扇出即公共确认信号）。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AckFrame {
    pub v: i64,
    #[serde(rename = "type")]
    pub frame_type: &'static str,
    pub wid: String,
}

/// v:1 error 帧（WS 侧错误，非致命透传——连接保持）。code 守卫只查 string
/// 不枚举（04-01 决策：未知 code 天然兼容，D-07 只加不改）。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct WsErrorFrame {
    pub v: i64,
    #[serde(rename = "type")]
    pub frame_type: &'static str,
    pub code: String,
    pub message: String,
}

/// v:1 reply 帧（客户端 → 服务端，04-01 D-45/D-46）。selected_option 与 text
/// 恰提供其一（载荷恰一校验在发送侧命令层，域级校验在服务端 DO）；by 为
/// 自报展示名，缺省不序列化（省略语义——键不出现即匿名回复，D-53）。
#[allow(dead_code)] // 05-04 adapter reply() 公开方法 / 05-05 UI 回复面构造
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReplyFrame {
    pub v: i64,
    #[serde(rename = "type")]
    pub frame_type: String,
    pub wid: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selected_option: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub by: Option<String>,
}

/// v:1 sync 帧（客户端 → 服务端，D-11 补拉）。运行时 serde 序列化合法——
/// 服务端 JSON.parse 键序无关；唯一字节常量约束是 PING（Pitfall 4）。
/// 05-04 adapter 的 SendSync 动作分派消费。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SyncFrame {
    pub v: i64,
    #[serde(rename = "type")]
    pub frame_type: String,
    pub since: i64,
    pub limit: u32,
}

/// 客户端 → 服务端帧（v:1：ping/sync/reply）。ping 经字节常量直发（Pitfall 4：
/// 键序反转即失配服务端 auto-response）、sync 经 SendSync 动作参数构造——
/// serde 序列化面当前 sync + reply（untagged：序列化即内层帧形态）。
#[allow(dead_code)] // Reply 由 05-05 UI 回复面构造；Sync 已由 05-04 adapter 消费
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ClientFrame {
    Reply(ReplyFrame),
    Sync(SyncFrame),
}

/// 服务端 → 客户端帧全集（pong/message/history/answered/ack/error）。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub enum ServerFrame {
    Pong,
    Message(MessageFrame),
    History(HistoryFrame),
    Answered(AnsweredFrame),
    Ack(AckFrame),
    Error(WsErrorFrame),
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

/// string | null 字段（answered_by/answered_content 等）。键必须存在（TS
/// isStringOrNull(undefined) === false——必填可空字段缺键即违例）；值可 null。
fn string_or_null(m: &Map<String, Value>, key: &str) -> bool {
    match m.get(key) {
        None => false,
        Some(Value::Null) => true,
        Some(v) => v.is_string(),
    }
}

/// integer | null 字段（answered_at）。键必须存在（同 string_or_null 语义）。
fn integer_or_null(m: &Map<String, Value>, key: &str) -> bool {
    match m.get(key) {
        None => false,
        Some(Value::Null) => true,
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

/// AnsweredFrame 结构深校验（04-01 冻结字段集，照 isMessageShape 逐字段）。
/// seq 允许 0（与 message 守卫的 >=1 不同——answered 只作展示定位不作排序键）；
/// answered_at 为非空整数（帧只在成功回复后发射，approve-freeze 裁量点 3）；
/// answered 按冻结形态查 boolean（恒 true 语义由服务端保证，D-45）。
fn is_answered_shape(v: &Value) -> bool {
    let Some(m) = v.as_object() else {
        return false;
    };
    if m.get("v").and_then(Value::as_i64) != Some(PROTOCOL_VERSION) {
        return false;
    }
    if m.get("type").and_then(Value::as_str) != Some("answered") {
        return false;
    }
    if !m.get("wid").map(Value::is_string).unwrap_or(false) {
        return false;
    }
    match m.get("seq").and_then(Value::as_i64) {
        Some(seq) if seq >= 0 => {}
        _ => return false,
    }
    if !m.get("answered").map(Value::is_boolean).unwrap_or(false) {
        return false;
    }
    if !string_or_null(m, "answered_by") {
        return false;
    }
    if m.get("answered_at").and_then(Value::as_i64).is_none() {
        return false;
    }
    string_or_null(m, "answered_content")
}

/// WsErrorFrame 结构校验（code/message 双 string；code 不枚举——04-01 决策，
/// 未知错误码天然兼容 D-07 演进规则）。
fn is_error_shape(m: &Map<String, Value>) -> bool {
    m.get("code").map(Value::is_string).unwrap_or(false)
        && m.get("message").map(Value::is_string).unwrap_or(false)
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

fn extract_answered(m: &Map<String, Value>) -> AnsweredFrame {
    AnsweredFrame {
        v: PROTOCOL_VERSION,
        frame_type: "answered",
        wid: take_string(m, "wid").unwrap_or_default(),
        seq: m.get("seq").and_then(Value::as_i64).unwrap_or(0),
        answered: m.get("answered").and_then(Value::as_bool).unwrap_or(false),
        answered_by: take_string(m, "answered_by"),
        answered_at: m.get("answered_at").and_then(Value::as_i64).unwrap_or(0),
        answered_content: take_string(m, "answered_content"),
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
        Some("answered") => {
            if is_answered_shape(&parsed) {
                FrameResult::Ok(ServerFrame::Answered(extract_answered(m)))
            } else {
                FrameResult::Drop("malformed answered frame")
            }
        }
        Some("ack") => {
            // 宽松直通照 pong 模式（04-01 Q4）：恰查 v/type/wid 三键——v 已由
            // 版本门检查、type 已由 match 匹配，此处只查 wid 为 string。
            match m.get("wid").map(Value::is_string) {
                Some(true) => FrameResult::Ok(ServerFrame::Ack(AckFrame {
                    v: PROTOCOL_VERSION,
                    frame_type: "ack",
                    wid: take_string(m, "wid").unwrap_or_default(),
                })),
                _ => FrameResult::Drop("malformed ack frame"),
            }
        }
        Some("error") => {
            if is_error_shape(m) {
                FrameResult::Ok(ServerFrame::Error(WsErrorFrame {
                    v: PROTOCOL_VERSION,
                    frame_type: "error",
                    code: take_string(m, "code").unwrap_or_default(),
                    message: take_string(m, "message").unwrap_or_default(),
                }))
            } else {
                FrameResult::Drop("malformed error frame")
            }
        }
        // 未知 type（含客户端方向的 sync/reply 帧）：D-07 前瞻兼容，非致命丢弃。
        _ => FrameResult::Drop("unknown frame type"),
    }
}

#[cfg(test)]
mod tests;
