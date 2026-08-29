//! tokio 接线层（05-01 Task 3 tracer，D-59/D-60）——pushhub.ts adapter 的 Rust 同构。
//!
//! 职责边界：连接生命周期语义全部在纯状态机（machine/）；本模块只做动作执行——
//!   WS 读任务/定时器任务 → 翻译为 MachineEvent → machine.input → 逐动作执行副作用。
//!  - URL 构造对齐 pushhub.ts:102-105（http→ws 前缀替换 + 尾斜杠去除 +
//!    encodeURIComponent 语义的 percent-encoding + /api/ws/ 前缀）；
//!  - PING 为字节字面量直发（禁运行时 serde 构造——键序反转即失配服务端
//!    setWebSocketAutoResponse，Pitfall 4 传承）；
//!  - 定时器：Schedule 即 spawn sleep 任务（代际令牌防陈旧），Cancel 使令牌失效；
//!    ghost 过滤由 machine 武装集承担（双保险，同 TS setTimeout/武装集模式）；
//!  - 陈旧 socket 防护：每连接带代际号（gen），旧 stream 的事件直接丢弃；
//!  - EmitStatus/EmitMessage/EmitHistory → app.emit 到 ph://status、ph://message、
//!    ph://history，载荷 {channel_id, ...帧数据}；
//!  - 错误文案为静态英文短句，不内嵌 URL（密钥在路径段——T-05-01-03）。

use std::collections::HashMap;
use std::hash::{DefaultHasher, Hash, Hasher as _};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use percent_encoding::{utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};
use serde::Serialize;
use serde_json::json;
use tokio::net::TcpStream;
use tokio::sync::mpsc::{self, UnboundedReceiver, UnboundedSender};
use tokio::sync::watch;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::frame::CloseFrame;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};
use tauri::{AppHandle, Emitter};

use crate::config::ChannelConfig;
use crate::machine::{Action, CloseReason, Event, Machine, TimerKind};
use crate::protocol::parse_server_frame;

type WsStream = WebSocketStream<MaybeTlsStream<TcpStream>>;
type WsSink = SplitSink<WsStream, Message>;
type WsSource = SplitStream<WsStream>;

/// encodeURIComponent 语义的非保留集：A-Za-z0-9 - _ . ! ~ * ' ( )。
const ENCODE_SET: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'!')
    .remove(b'~')
    .remove(b'*')
    .remove(b'\'')
    .remove(b'(')
    .remove(b')');

/// 心跳出站帧（Pitfall 4）：逐字节等于服务端 setWebSocketAutoResponse 匹配串
/// （chat-room.ts:52）——字符串常量直发，禁运行时对象序列化构造。
const PING: &str = r#"{"v":1,"type":"ping"}"#;

/// 连接 URL 构造（pushhub.ts:102-105 同构）。
pub fn build_ws_url(server: &str, channel_key: &str) -> String {
    // http→ws 前缀替换：http:// → ws://、https:// → wss://（"http"→"ws" 后 s 保留）。
    let ws = match server.strip_prefix("http") {
        Some(rest) => format!("ws{rest}"),
        None => server.to_string(),
    };
    let trimmed = ws.trim_end_matches('/');
    format!(
        "{}/api/ws/{}",
        trimmed,
        utf8_percent_encode(channel_key, ENCODE_SET)
    )
}

/// 主循环入站消息（代际过滤见 run_loop）。
enum Inbound {
    /// 连接侧事件（带代际号——旧 stream 事件直接丢弃）。
    Conn { gen: u64, event: Event },
    /// 握手成功（写句柄回传主循环；state.writer 归位后 WsOpen 进机器）。
    Opened { gen: u64, writer: UnboundedSender<Outbound> },
    /// 定时器到点（不经代际过滤——ghost 由 machine 武装集承担）。
    Timer { kind: TimerKind },
}

/// 写侧指令（主循环 → writer 任务）。
enum Outbound {
    Text(String),
    Close { code: CloseCode, reason: &'static str },
}

/// adapter 运行态（主循环单任务持有，无锁）。
struct Runtime {
    app: AppHandle,
    channel_id: String,
    tx: UnboundedSender<Inbound>,
    /// 当前连接代际号（CreateSocket 时自增；入站 Conn/Opened 据此过滤陈旧）。
    gen: u64,
    /// 当前连接的写句柄（None = 无活跃连接）。
    writer: Option<UnboundedSender<Outbound>>,
    ws_url: String,
    /// 定时器代际令牌（Schedule 自增发牌；Cancel 自增使旧 sleep 失效）。
    timer_tokens: Arc<Mutex<HashMap<TimerKind, u64>>>,
}

/// 单频道接线（lib.rs setup 对每个频道 spawn 一个，D-64 多频道即多任务）。
///
/// ready：前端就绪信号（首帧 status 事件不丢——WebView 加载慢于 Rust 握手时，
/// emit 在 listen 注册前即丢失；前端 listen 挂齐后 emit ph://frontend-ready，
/// 此处方才 Connect。超时 5s 兜底无前端场景）。
pub async fn run_channel(
    app: AppHandle,
    channel: ChannelConfig,
    server: String,
    mut ready: watch::Receiver<bool>,
) {
    let ws_url = build_ws_url(&server, &channel.key);
    let (tx, mut rx) = mpsc::unbounded_channel::<Inbound>();

    // 随机种子：时间 × 频道 ID（两频道抖动序列不同步）。
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0x9E3779B97F4A7C15);
    let mut h = DefaultHasher::new();
    nanos.hash(&mut h);
    channel.id.hash(&mut h);
    let seed = h.finish();

    let mut machine = Machine::new(default_random(seed));
    let mut rt = Runtime {
        app,
        channel_id: channel.id,
        tx: tx.clone(),
        gen: 0,
        writer: None,
        ws_url,
        timer_tokens: Arc::new(Mutex::new(HashMap::new())),
    };

    // 等前端就绪（窗口纯展示层——D-60；超时兜底）。
    let _ = tokio::time::timeout(Duration::from_secs(5), ready.wait_for(|v| *v)).await;

    // 就绪即连（D-60：连接归 Rust 进程，与窗口生命周期解耦）。
    for action in machine.input(Event::Connect) {
        rt.apply(action);
    }

    while let Some(msg) = rx.recv().await {
        let event = match msg {
            Inbound::Timer { kind } => Event::Timer { kind },
            Inbound::Opened { gen, writer } => {
                if gen != rt.gen {
                    continue; // 陈旧握手（已被新连接取代）——丢弃句柄即关连接
                }
                rt.writer = Some(writer);
                Event::WsOpen
            }
            Inbound::Conn { gen, event } => {
                if gen != rt.gen {
                    continue; // 陈旧 socket 防护：旧 stream 事件直接丢弃
                }
                event
            }
        };
        for action in machine.input(event) {
            rt.apply(action);
        }
    }
}

impl Runtime {
    fn apply(&mut self, action: Action) {
        match action {
            Action::CreateSocket => {
                self.gen += 1;
                let gen = self.gen;
                let url = self.ws_url.clone();
                let tx = self.tx.clone();
                // 握手指派给子任务（避免阻塞主循环；成功/失败均回发事件）。
                tokio::spawn(async move {
                    let request = match url.as_str().into_client_request() {
                        Ok(r) => r,
                        Err(_) => {
                            // 畸形 serverUrl（确定性配置错误）→ WS_FAIL fatal 语义。
                            // 错误文案静态英文，不内嵌 URL（密钥在路径段）。
                            let _ = tx.send(Inbound::Conn {
                                gen,
                                event: Event::WsFail {
                                    message: "failed to construct WebSocket for serverUrl"
                                        .to_string(),
                                },
                            });
                            return;
                        }
                    };
                    match connect_async(request).await {
                        Ok((stream, _resp)) => {
                            let (sink, source) = stream.split();
                            let (out_tx, out_rx) = mpsc::unbounded_channel::<Outbound>();
                            tokio::spawn(writer_task(sink, out_rx));
                            // Opened 先于任何帧事件入队（mpsc FIFO + 先 send 后
                            // spawn reader——服务端 accept 即推首拉 history，
                            // attach-before-trigger 同款纪律）。
                            if tx.send(Inbound::Opened { gen, writer: out_tx }).is_err() {
                                return;
                            }
                            tokio::spawn(reader_task(source, tx.clone(), gen));
                        }
                        Err(_) => {
                            // 握手失败（网络闪断/服务端不可达）→ TS onclose 同语义：
                            // 退避重连（WS_CLOSE 分支的"握手失败"路径）。
                            let _ = tx.send(Inbound::Conn {
                                gen,
                                event: Event::WsClose,
                            });
                        }
                    }
                });
            }
            Action::CloseSocket { reason } => {
                if let Some(writer) = self.writer.take() {
                    // close code 映射（pushhub.ts:355-361）：fatal→1002 / deadline→4000 / manual→1000。
                    let (code, why) = match reason {
                        CloseReason::Fatal => (CloseCode::Protocol, "protocol version mismatch"),
                        CloseReason::Deadline => (CloseCode::Library(4000), "heartbeat deadline"),
                        CloseReason::Manual => (CloseCode::Normal, "client disconnect"),
                    };
                    let _ = writer.send(Outbound::Close { code, reason: why });
                }
            }
            Action::SendPing => {
                if let Some(writer) = &self.writer {
                    // 字节常量直发（禁 serde 序列化构造——Pitfall 4）。
                    let _ = writer.send(Outbound::Text(PING.to_string()));
                }
            }
            Action::SendSync { .. } => {
                // 05-02：重连补拉序列（sync 帧构造与发送）。
            }
            Action::Schedule { kind, delay_ms } => {
                let token = {
                    let mut tokens = self.timer_tokens.lock().unwrap();
                    let t = tokens.entry(kind).or_insert(0);
                    *t += 1;
                    *t
                };
                let tokens = Arc::clone(&self.timer_tokens);
                let tx = self.tx.clone();
                tokio::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(delay_ms)).await;
                    let stale = {
                        let tokens = tokens.lock().unwrap();
                        tokens.get(&kind).copied() != Some(token)
                    };
                    if !stale {
                        let _ = tx.send(Inbound::Timer { kind });
                    }
                });
            }
            Action::Cancel { kind } => {
                // 自增令牌使未到点的旧 sleep 失效（machine 武装集是第二道过滤）。
                let mut tokens = self.timer_tokens.lock().unwrap();
                let t = tokens.entry(kind).or_insert(0);
                *t += 1;
            }
            Action::EmitStatus { status } => {
                let _ = self.app.emit(
                    "ph://status",
                    json!({ "channel_id": self.channel_id, "status": status.as_str() }),
                );
            }
            Action::EmitMessage { message } => {
                let payload = FlatFrame {
                    channel_id: &self.channel_id,
                    frame: &message,
                };
                let _ = self.app.emit("ph://message", payload);
            }
            Action::EmitHistory { frame } => {
                let payload = FlatFrame {
                    channel_id: &self.channel_id,
                    frame: &frame,
                };
                let _ = self.app.emit("ph://history", payload);
            }
            Action::EmitAnswered { frame } => {
                let payload = FlatFrame {
                    channel_id: &self.channel_id,
                    frame: &frame,
                };
                let _ = self.app.emit("ph://answered", payload);
            }
            Action::EmitError { error } => {
                let _ = self.app.emit(
                    "ph://error",
                    json!({ "channel_id": self.channel_id, "error": error }),
                );
            }
        }
    }
}

/// Tauri event 载荷：{channel_id, ...帧数据}（serde flatten）。
#[derive(Serialize, Clone)]
struct FlatFrame<'a, T: Serialize> {
    channel_id: &'a str,
    #[serde(flatten)]
    frame: &'a T,
}

async fn writer_task(mut sink: WsSink, mut rx: UnboundedReceiver<Outbound>) {
    while let Some(out) = rx.recv().await {
        match out {
            Outbound::Text(text) => {
                if sink.send(Message::Text(text.into())).await.is_err() {
                    return; // 连接已死——close 路径接管
                }
            }
            Outbound::Close { code, reason } => {
                let _ = sink
                    .send(Message::Close(Some(CloseFrame {
                        code,
                        reason: reason.into(),
                    })))
                    .await;
                let _ = sink.close().await;
                return;
            }
        }
    }
    // 主循环丢弃句柄（新连接取代/频道停机）→ 优雅关闭。
    let _ = sink.close().await;
}

async fn reader_task(mut source: WsSource, tx: UnboundedSender<Inbound>, gen: u64) {
    while let Some(msg) = source.next().await {
        match msg {
            Ok(Message::Text(text)) => {
                let result = parse_server_frame(text.as_str());
                if tx.send(Inbound::Conn {
                    gen,
                    event: Event::Frame { result },
                })
                .is_err()
                {
                    return; // 主循环已结束
                }
            }
            Ok(_) => {} // 协议层控制帧（tungstenite 自动应答 ping/pong）
            Err(_) => break,
        }
    }
    // 流结束（服务端断开/close 握手完成）→ WsClose。
    let _ = tx.send(Inbound::Conn {
        gen,
        event: Event::WsClose,
    });
}

/// 生产随机源（xorshift64* → [0,1)）：退避抖动用，无需密码学强度；
/// 测试确定性经 Machine::new 注入替代（本函数不进测试路径）。
fn default_random(seed: u64) -> Box<dyn FnMut() -> f64 + Send> {
    let mut state = seed.wrapping_mul(0x9E3779B97F4A7C15) | 1;
    Box::new(move || {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        let x = state.wrapping_mul(0x2545F4914F6CDD1D);
        (x >> 11) as f64 / (1u64 << 53) as f64
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// URL 构造对齐 pushhub.ts:102-105（含 https→wss 与尾斜杠）。
    #[test]
    fn ws_url_construction() {
        assert_eq!(
            build_ws_url("http://127.0.0.1:4911", "phc_abc"),
            "ws://127.0.0.1:4911/api/ws/phc_abc"
        );
        assert_eq!(
            build_ws_url("https://pushhub.dyun.org/", "phc_abc"),
            "wss://pushhub.dyun.org/api/ws/phc_abc"
        );
        // 尾部多斜杠全去除。
        assert_eq!(
            build_ws_url("http://example.com//", "k"),
            "ws://example.com/api/ws/k"
        );
    }

    /// encodeURIComponent 语义：保留字符集不转义、保留字转义（Pitfall 7：
    /// 服务端逐段 decodeURIComponent，键含保留字符必须先编码）。
    #[test]
    fn percent_encoding_matches_encode_uri_component() {
        let url = build_ws_url("http://s", "a/b?c=d&e f");
        assert!(url.ends_with("/api/ws/a%2Fb%3Fc%3Dd%26e%20f"), "got {url}");
        // 非保留集原样保留。
        let url = build_ws_url("http://s", "az09-_.!~*'()");
        assert!(url.ends_with("/api/ws/az09-_.!~*'()"), "got {url}");
    }

    /// PING 字节常量逐字节等于服务端匹配串（Pitfall 4）。
    #[test]
    fn ping_constant_byte_exact() {
        assert_eq!(PING, r#"{"v":1,"type":"ping"}"#);
        assert_eq!(PING.len(), 21);
    }
}
