//! tokio 接线层（05-01 tracer → 05-04 全行为，D-59/D-60）——pushhub.ts adapter 的 Rust 同构。
//!
//! 职责边界：连接生命周期语义全部在纯状态机（machine/）；本模块只做动作执行——
//! WS 读任务/写任务/定时器任务/控制面 → 翻译为 MachineEvent → machine.input →
//! 逐动作执行副作用（Effects 出口，生产 AppEffects / 测试 Recorder）。
//!  - URL 构造对齐 pushhub.ts:102-105（http→ws 前缀替换 + 尾斜杠去除 +
//!    encodeURIComponent 语义的 percent-encoding + /api/ws/ 前缀）；
//!  - PING 为字节字面量直发（禁运行时 serde 构造——键序反转即失配服务端
//!    setWebSocketAutoResponse，Pitfall 4 传承）；sync 帧允许运行时序列化
//!    （服务端 JSON.parse 键序无关）；
//!  - 定时器：Schedule 即 spawn sleep 任务（代际令牌防陈旧），Cancel 使令牌失效；
//!    ghost 过滤由 machine 武装集承担（双保险，同 TS setTimeout/武装集模式）；
//!  - 陈旧 socket 防护（升级版，对齐 pushhub.ts detach-then-close 语义）：
//!    每连接带代际号（gen）——CreateSocket 自增当前代际（AtomicU64 共享给
//!    writer 任务）：旧 stream 的读事件在主循环入口丢弃（accept_inbound）、
//!    旧 writer 的写请求在写任务入口丢弃；新连接尝试开始即 detach 旧句柄；
//!  - 两流分离（D-61/D-63，Pitfall 8）：通知钩子（notify_hook）只在
//!    EmitMessage（实时帧）动作路径调用；EmitHistory（首拉/补拉批次）与
//!    EmitAnswered 绝不触发——经双计数器测试锁定；
//!  - 缓冲接线（D-62）：EmitMessage/EmitHistory push 进环形缓冲、EmitAnswered
//!    原位更新（三类消息动作统一写缓冲）；
//!  - VISIBILITY 入口（A8/D-27）：控制面（manager/窗口事件）经 Inbound::Control
//!    注入机器事件（Visibility/Destroy/Disconnect/Connect）；
//!  - 踢连容忍：WsClose 不论 close code（含 1008 channel key reset）一律走
//!    状态机退避重连（对齐 web SDK 策略；key 失效属配置错误，UI 引导重配在 05-06）；
//!  - EmitStatus 同步写共享状态单元（manager statuses() 聚合数据源）；
//!  - 错误文案为静态英文短句，不内嵌 URL（密钥在路径段——T-05-04-01）。

use std::collections::HashMap;
use std::hash::{DefaultHasher, Hash, Hasher as _};
use std::sync::atomic::{AtomicU64, Ordering};
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

use crate::buffer::Buffer;
use crate::config::ChannelConfig;
use crate::machine::{Action, CloseReason, Event, Machine, Status, TimerKind};
use crate::protocol::{parse_server_frame, ClientFrame, SyncFrame, PROTOCOL_VERSION};

/// 多频道生命周期管理（Task 3，D-64/D-65）。
pub mod manager;

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

/// 通知钩子载荷：仅实时帧（EmitMessage）触发——两流分离不变量 D-61/D-63。
/// 05-05 将其接线到真实通知线程（winrt-toast 按频道分组）；本 plan 以注入
/// 回调 + 双计数器测试锁定分流语义（文件所有权与 05-03 通知层解耦）。
#[allow(dead_code)] // 字段由 05-05 通知线程消费（当前消费者为注入钩子测试/占位 no-op）
#[derive(Debug, Clone)]
pub struct RealtimeMessage {
    pub channel_id: String,
    pub wid: String,
    pub title: Option<String>,
    pub text: String,
    pub priority: String,
}

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

/// 主循环入站消息。
enum Inbound {
    /// 连接侧事件（带代际号——旧 stream 事件在 accept_inbound 丢弃）。
    Conn { gen: u64, event: Event },
    /// 握手成功（写句柄回传主循环；effects.set_writer 归位后 WsOpen 进机器）。
    Opened { gen: u64, writer: UnboundedSender<Outbound> },
    /// 定时器到点（不经代际过滤——ghost 由 machine 武装集承担）。
    Timer { kind: TimerKind },
    /// 控制面注入（manager 生命周期 + 窗口显隐，Task 3/05-05 接线）：
    /// 机器事件直接进状态机（Visibility/Destroy/Disconnect/Connect）。
    Control(Event),
}

/// 写侧指令（主循环 → writer 任务）。
enum Outbound {
    Text(String),
    Close { code: CloseCode, reason: &'static str },
}

/// accept_inbound 的产物（Opened 需要 writer 归位副作用，与纯事件分流）。
enum Accepted {
    Event(Event),
    Opened { writer: UnboundedSender<Outbound> },
}

/// 主循环入站归约——陈旧代际防护核心（对齐 pushhub.ts detach-then-close：
/// 新连接代际产生后，旧 stream 的一切事件不再进机器）。
/// Timer/Control 不受代际过滤（定时器 ghost 由 machine 武装集第二道过滤）。
fn accept_inbound(msg: Inbound, current_gen: u64) -> Option<Accepted> {
    match msg {
        Inbound::Timer { kind } => Some(Accepted::Event(Event::Timer { kind })),
        Inbound::Control(event) => Some(Accepted::Event(event)),
        Inbound::Opened { gen, writer } => {
            if gen != current_gen {
                return None; // 陈旧握手（已被新连接取代）——丢弃句柄即关连接
            }
            Some(Accepted::Opened { writer })
        }
        Inbound::Conn { gen, event } => {
            if gen != current_gen {
                return None; // 陈旧 socket 防护：旧 stream 事件直接丢弃
            }
            Some(Accepted::Event(event))
        }
    }
}

/// close code 映射（pushhub.ts:355-357 verbatim）：fatal→1002 / deadline→4000 /
/// manual→1000；reason 文案静态英文（不含 URL/密钥——T-05-04-01）。
fn close_code_of(reason: CloseReason) -> (u16, &'static str) {
    match reason {
        CloseReason::Fatal => (1002, "protocol version mismatch"),
        CloseReason::Deadline => (4000, "heartbeat deadline"),
        CloseReason::Manual => (1000, "client disconnect"),
    }
}

/// u16 → tungstenite CloseCode（close_code_of 的运行时桥接）。
fn tungstenite_close(code: u16) -> CloseCode {
    match code {
        1000 => CloseCode::Normal,
        1002 => CloseCode::Protocol,
        other => CloseCode::Library(other),
    }
}

/// 动作副作用出口——生产/测试双实现（测试切面：内存记录，语义断言不变；
/// 计划允许的分派纯函数测试替代方案，trait 抽象成本可控故取 trait）。
trait Effects {
    /// 写句柄归位/弃置（Opened 归位；CreateSocket detach 旧连接置 None）。
    fn set_writer(&mut self, writer: Option<UnboundedSender<Outbound>>);
    /// 出站文本帧（PING 字节常量 / sync 运行时序列化；无活跃连接时静默丢弃）。
    fn send_text(&mut self, text: String);
    /// 主动关闭（code 由 close_code_of 映射；消费写句柄）。
    fn close_socket(&mut self, code: u16, reason: &'static str);
    /// Tauri event emit（ph://status|message|history|answered|error）。
    fn emit<S: Serialize>(&mut self, event: &'static str, payload: &S);
}

/// 生产副作用（真实 WS 写通道 + Tauri event）。
struct AppEffects {
    app: AppHandle,
    writer: Option<UnboundedSender<Outbound>>,
}

impl Effects for AppEffects {
    fn set_writer(&mut self, writer: Option<UnboundedSender<Outbound>>) {
        self.writer = writer;
    }

    fn send_text(&mut self, text: String) {
        if let Some(writer) = &self.writer {
            // 发送失败（连接已死）静默——close/死线路径接管（对齐 TS try/catch）。
            let _ = writer.send(Outbound::Text(text));
        }
    }

    fn close_socket(&mut self, code: u16, reason: &'static str) {
        if let Some(writer) = self.writer.take() {
            let _ = writer.send(Outbound::Close {
                code: tungstenite_close(code),
                reason,
            });
        }
    }

    fn emit<S: Serialize>(&mut self, event: &'static str, payload: &S) {
        let _ = self.app.emit(event, payload);
    }
}

/// adapter 运行态（主循环单任务持有，无锁）。
struct Runtime<E: Effects> {
    effects: E,
    channel_id: String,
    tx: UnboundedSender<Inbound>,
    /// 当前连接代际号（CreateSocket 自增；入站据此过滤陈旧）。
    gen: u64,
    /// 当前代际的共享视图（writer 任务据此丢弃陈旧写请求）。
    gen_shared: Arc<AtomicU64>,
    ws_url: String,
    /// 定时器代际令牌（Schedule 自增发牌；Cancel 自增使旧 sleep 失效）。
    timer_tokens: Arc<Mutex<HashMap<TimerKind, u64>>>,
    /// 每频道环形缓冲（D-62；与 ChannelManager 共享——snapshot 数据源）。
    buffer: Arc<Mutex<Buffer>>,
    /// 状态共享单元（EmitStatus 写；manager statuses() 聚合读）。
    status: Arc<Mutex<Status>>,
    /// 通知钩子（仅 EmitMessage 路径调用——两流分离 D-61/D-63）。
    notify_hook: Box<dyn Fn(RealtimeMessage) + Send>,
}

/// 单频道接线（lib.rs/ChannelManager 对每个频道 spawn 一个，D-64 多频道多任务）。
///
/// ready：前端就绪信号（首帧 status 事件不丢——WebView 加载慢于 Rust 握手时，
/// emit 在 listen 注册前即丢失；前端 listen 挂齐后 emit ph://frontend-ready，
/// 此处方才 Connect。超时 5s 兜底无前端场景）。
///
/// control：控制面事件入口（Event::Destroy 频道停机 / Visibility 窗口显隐
/// / Disconnect/Connect 主动控制——manager 持发送端，Task 3）。
///
/// notify_hook / buffer / status：由 manager 统一构造注入（05-05 接真实通知
/// 线程；本 plan 以测试双计数器锁定两流分离）。
pub async fn run_channel(
    app: AppHandle,
    channel: ChannelConfig,
    server: String,
    mut ready: watch::Receiver<bool>,
    notify_hook: Box<dyn Fn(RealtimeMessage) + Send>,
    buffer: Arc<Mutex<Buffer>>,
    status: Arc<Mutex<Status>>,
    mut control: UnboundedReceiver<Event>,
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
    let mut rt: Runtime<AppEffects> = Runtime {
        effects: AppEffects {
            app,
            writer: None,
        },
        channel_id: channel.id,
        tx: tx.clone(),
        gen: 0,
        gen_shared: Arc::new(AtomicU64::new(0)),
        ws_url,
        timer_tokens: Arc::new(Mutex::new(HashMap::new())),
        buffer,
        status,
        notify_hook,
    };

    // 等前端就绪（窗口纯展示层——D-60；超时兜底）。
    let _ = tokio::time::timeout(Duration::from_secs(5), ready.wait_for(|v| *v)).await;

    // 就绪即连（D-60：连接归 Rust 进程，与窗口生命周期解耦）。
    for action in machine.input(Event::Connect) {
        rt.apply(action);
    }

    // 控制面关闭后退出 select（防忙轮询），仅剩连接侧事件流。
    let mut control_open = true;
    loop {
        let msg = if control_open {
            tokio::select! {
                m = rx.recv() => match m { Some(m) => m, None => break },
                m = control.recv() => match m {
                    Some(event) => Inbound::Control(event),
                    None => { control_open = false; continue; },
                },
            }
        } else {
            match rx.recv().await {
                Some(m) => m,
                None => break,
            }
        };
        let Some(accepted) = accept_inbound(msg, rt.gen) else {
            continue; // 陈旧代际：旧 stream 事件直接丢弃
        };
        let event = match accepted {
            Accepted::Event(event) => event,
            Accepted::Opened { writer } => {
                rt.effects.set_writer(Some(writer));
                Event::WsOpen
            }
        };
        let destroy = matches!(event, Event::Destroy);
        for action in machine.input(event) {
            rt.apply(action);
        }
        if destroy {
            // Destroy 终态（machine 保证此后 Connect 被忽略）：任务收敛退出
            // ——manager 的 remove/destroy 以 JoinHandle 完成为等待点。
            break;
        }
    }
}

impl<E: Effects> Runtime<E> {
    fn apply(&mut self, action: Action) {
        match action {
            Action::CreateSocket => {
                self.gen += 1;
                self.gen_shared.store(self.gen, Ordering::SeqCst);
                // detach 旧连接（对齐 pushhub.ts openSocket 的 stale 防御：
                // 新连接尝试开始即弃旧句柄——旧 writer 任务收端关闭优雅收流；
                // 代际号兜底拦截在途写请求）。
                self.effects.set_writer(None);
                let gen = self.gen;
                let current = Arc::clone(&self.gen_shared);
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
                            tokio::spawn(writer_task(sink, out_rx, gen, current));
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
                let (code, why) = close_code_of(reason);
                self.effects.close_socket(code, why);
            }
            Action::SendPing => {
                // 字节常量直发（禁 serde 序列化构造——Pitfall 4）。
                self.effects.send_text(PING.to_string());
            }
            Action::SendSync { since, limit } => {
                // sync 帧允许运行时 serde 序列化（服务端 JSON.parse 键序无关；
                // 唯一字节常量约束是 PING）。
                let frame = ClientFrame::Sync(SyncFrame {
                    v: PROTOCOL_VERSION,
                    frame_type: "sync".to_string(),
                    since,
                    limit,
                });
                let text = serde_json::to_string(&frame).expect("sync frame serializes");
                self.effects.send_text(text);
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
                // 状态单元先行（manager statuses() 聚合数据源），事件随后。
                *self.status.lock().unwrap() = status;
                self.effects.emit(
                    "ph://status",
                    &json!({ "channel_id": self.channel_id, "status": status.as_str() }),
                );
            }
            Action::EmitMessage { message } => {
                // 实时帧三联：缓冲 push → 前端事件 → 通知钩子（两流分离 D-61/
                // D-63：通知触发只在实时帧路径——Pitfall 8）。
                let realtime = RealtimeMessage {
                    channel_id: self.channel_id.clone(),
                    wid: message.wid.clone(),
                    title: message.title.clone(),
                    text: message.text.clone(),
                    priority: message.priority.clone(),
                };
                self.effects.emit(
                    "ph://message",
                    &FlatFrame {
                        channel_id: &self.channel_id,
                        frame: &message,
                    },
                );
                self.buffer.lock().unwrap().push(message);
                (self.notify_hook)(realtime);
            }
            Action::EmitHistory { frame } => {
                // 补拉/首拉批次：只进缓冲与前端事件，绝不触发通知钩子（D-61）。
                self.effects.emit(
                    "ph://history",
                    &FlatFrame {
                        channel_id: &self.channel_id,
                        frame: &frame,
                    },
                );
                let mut buffer = self.buffer.lock().unwrap();
                for m in frame.messages {
                    buffer.push(m);
                }
            }
            Action::EmitAnswered { frame } => {
                // answered 原位更新（不新增条目，D-17）；通知移除由 05-05 在
                // answered 帧路径接线——本处不触发 notify_hook。
                self.buffer.lock().unwrap().apply_answered(&frame);
                self.effects.emit(
                    "ph://answered",
                    &FlatFrame {
                        channel_id: &self.channel_id,
                        frame: &frame,
                    },
                );
            }
            Action::EmitError { error } => {
                self.effects.emit(
                    "ph://error",
                    &json!({ "channel_id": self.channel_id, "error": error }),
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

async fn writer_task(
    mut sink: WsSink,
    mut rx: UnboundedReceiver<Outbound>,
    gen: u64,
    current_gen: Arc<AtomicU64>,
) {
    while let Some(out) = rx.recv().await {
        // 陈旧代际防护（写侧）：新代际产生后旧 writer 的写请求全部丢弃
        //（对齐 pushhub.ts detach-then-close——旧连接的迟到写入不上 socket）。
        if gen != current_gen.load(Ordering::SeqCst) {
            break;
        }
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
    // 写句柄被弃置（新连接取代/频道停机）→ 优雅关闭。
    let _ = sink.close().await;
}

async fn reader_task(mut source: WsSource, tx: UnboundedSender<Inbound>, gen: u64) {
    while let Some(msg) = source.next().await {
        match msg {
            Ok(Message::Text(text)) => {
                let result = parse_server_frame(text.as_str());
                if tx
                    .send(Inbound::Conn {
                        gen,
                        event: Event::Frame { result },
                    })
                    .is_err()
                {
                    return; // 主循环已结束
                }
            }
            // 协议层控制帧（tungstenite 自动应答 ping/pong；服务端主动 close——
            // 不论 code，含 1008 channel key reset 踢连——流随后结束统一走
            // WsClose 退避重连，踢连容忍）。
            Ok(_) => {}
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

// ---- 测试 ----
//
// 分派层测试切面（计划允许的替代方案中取 trait 抽象）：Recorder 记录
// send_text/close/emit 副作用，语义断言与生产路径完全一致（走同一条
// Runtime::apply 分派）；notify 计数经注入钩子（双计数器）。

/// 测试副作用记录器（内存记录，无 Tauri/WS 依赖）。
#[cfg(test)]
#[derive(Default)]
struct Recorder {
    sent: Vec<String>,
    closes: Vec<(u16, &'static str)>,
    events: Vec<(&'static str, serde_json::Value)>,
    writer: Option<UnboundedSender<Outbound>>,
}

#[cfg(test)]
impl Effects for Recorder {
    fn set_writer(&mut self, writer: Option<UnboundedSender<Outbound>>) {
        self.writer = writer;
    }
    fn send_text(&mut self, text: String) {
        self.sent.push(text);
    }
    fn close_socket(&mut self, code: u16, reason: &'static str) {
        self.closes.push((code, reason));
        self.writer = None;
    }
    fn emit<S: Serialize>(&mut self, event: &'static str, payload: &S) {
        self.events
            .push((event, serde_json::to_value(payload).expect("test payload serializes")));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{AnsweredFrame, FrameResult, HistoryFrame, MessageFrame, ServerFrame};
    use std::sync::atomic::AtomicUsize;

    // ---- 帧构造 helpers（对齐 machine/tests 分工：绕过 parse 直接构造）----

    fn msg_frame(seq: i64) -> MessageFrame {
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

    fn msg(seq: i64) -> FrameResult {
        FrameResult::Ok(ServerFrame::Message(msg_frame(seq)))
    }

    fn history(seqs: &[i64], oldest_kept_seq: i64, has_more: bool) -> FrameResult {
        FrameResult::Ok(ServerFrame::History(HistoryFrame {
            v: 1,
            frame_type: "history",
            messages: seqs.iter().map(|&s| msg_frame(s)).collect(),
            oldest_kept_seq,
            has_more,
        }))
    }

    // ---- URL / PING 契约（05-01 断言不回归）----

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

    // ---- 分派层测试（Runtime<Recorder> + 真状态机驱动）----

    /// 测试运行态：Recorder 副作用 + 注入计数钩子 + 共享缓冲/状态单元。
    fn make_rt() -> (
        Runtime<Recorder>,
        Machine,
        Arc<AtomicUsize>,
        Arc<Mutex<Buffer>>,
        Arc<Mutex<Status>>,
    ) {
        // 定时器事件入废通道（recv 端即弃——send 失败静默，无副作用面）。
        let (tx, _rx) = mpsc::unbounded_channel::<Inbound>();
        let notify_count = Arc::new(AtomicUsize::new(0));
        let buffer = Arc::new(Mutex::new(Buffer::new()));
        let status = Arc::new(Mutex::new(Status::Offline));
        let counter = Arc::clone(&notify_count);
        let rt = Runtime {
            effects: Recorder::default(),
            channel_id: "ch1".to_string(),
            tx,
            gen: 0,
            gen_shared: Arc::new(AtomicU64::new(0)),
            ws_url: "ws://example.invalid/api/ws/redacted".to_string(),
            timer_tokens: Arc::new(Mutex::new(HashMap::new())),
            buffer: Arc::clone(&buffer),
            status: Arc::clone(&status),
            notify_hook: Box::new(move |_m: RealtimeMessage| {
                counter.fetch_add(1, Ordering::SeqCst);
            }),
        };
        (rt, Machine::new(Box::new(|| 0.5)), notify_count, buffer, status)
    }

    /// 驱动机器事件并逐动作分派（滤除 CreateSocket——握手 spawn 真网络任务，
    /// 不属于分派语义断言面；连接建立语义由 E2E 覆盖，05-07）。
    fn drive(machine: &mut Machine, rt: &mut Runtime<Recorder>, event: Event) {
        for action in machine.input(event) {
            if !matches!(action, Action::CreateSocket) {
                rt.apply(action);
            }
        }
    }

    fn online(
        machine: &mut Machine,
        rt: &mut Runtime<Recorder>,
    ) {
        drive(machine, rt, Event::Connect);
        drive(machine, rt, Event::WsOpen);
    }

    /// 两流分离（D-61/D-63，Pitfall 8 双计数器）：首拉 history 批 3 条 +
    /// 实时帧 1 条 → 通知钩子恰 1 次；缓冲 4 条；两类前端事件各 1 次。
    #[tokio::test]
    async fn two_stream_separation_notify_only_realtime() {
        let (mut rt, mut machine, notify_count, buffer, _status) = make_rt();
        online(&mut machine, &mut rt);
        // 首拉批次（3 条）——绝不触发通知。
        drive(&mut machine, &mut rt, Event::Frame { result: history(&[1, 2, 3], 1, false) });
        // 实时帧 1 条——触发通知。
        drive(&mut machine, &mut rt, Event::Frame { result: msg(4) });

        assert_eq!(
            notify_count.load(Ordering::SeqCst),
            1,
            "history 批 3 条 + 实时 1 条 → 通知恰 1 次（D-61）"
        );
        assert_eq!(buffer.lock().unwrap().len(), 4);
        let history_emits = rt
            .effects
            .events
            .iter()
            .filter(|(e, _)| *e == "ph://history")
            .count();
        let message_emits = rt
            .effects
            .events
            .iter()
            .filter(|(e, _)| *e == "ph://message")
            .count();
        assert_eq!((history_emits, message_emits), (1, 1));
    }

    /// 补拉确定序列的出站帧（SC4-d 分派面）：首拉无条件
    /// sync{since=syncBase(0),limit=200}；has_more 以 dedup.last 续翻。
    #[tokio::test]
    async fn sync_frame_sequence_after_first_history() {
        let (mut rt, mut machine, _n, _b, _s) = make_rt();
        online(&mut machine, &mut rt);
        drive(&mut machine, &mut rt, Event::Frame { result: history(&[1, 2, 3], 1, false) });
        drive(&mut machine, &mut rt, Event::Frame { result: history(&[4, 5, 6], 1, true) });

        assert_eq!(
            rt.effects.sent,
            vec![
                r#"{"v":1,"type":"sync","since":0,"limit":200}"#.to_string(),
                r#"{"v":1,"type":"sync","since":6,"limit":200}"#.to_string(),
            ],
            "首拉 since=连接前游标 0；续翻 since=dedup.last=6"
        );
    }

    /// SendPing 直发字节常量（05-01 断言不回归；经分派路径复证）。
    #[tokio::test]
    async fn send_ping_dispatches_byte_constant() {
        let (mut rt, _m, _n, _b, _s) = make_rt();
        rt.apply(Action::SendPing);
        assert_eq!(rt.effects.sent, vec![PING.to_string()]);
    }

    /// VISIBILITY 控制面入口（A8/D-27）：visible → 机器探活序列
    ///（SendPing 直发 + Probe 死线武装）——入口映射经 accept_inbound，
    /// 机器行为经分派路径端到端复证（详细行为已由 machine/tests/visibility 锁定）。
    #[tokio::test]
    async fn visibility_injection_drives_machine_probe() {
        let (mut rt, mut machine, _n, _b, _s) = make_rt();
        online(&mut machine, &mut rt);
        drive(&mut machine, &mut rt, Event::Visibility { visible: true });
        assert!(
            rt.effects.sent.iter().any(|t| t == PING),
            "visible → 立即 ping 探活"
        );
        // hidden：取消心跳/探活（无新增出站副作用）。
        let sent_before = rt.effects.sent.len();
        drive(&mut machine, &mut rt, Event::Visibility { visible: false });
        assert_eq!(rt.effects.sent.len(), sent_before);
    }

    /// answered 路径：缓冲原位更新（D-17）+ ph://answered emit + 不触发通知。
    #[tokio::test]
    async fn answered_updates_buffer_no_notify() {
        let (mut rt, mut machine, notify_count, buffer, _s) = make_rt();
        online(&mut machine, &mut rt);
        drive(&mut machine, &mut rt, Event::Frame { result: msg(1) });
        assert_eq!(notify_count.load(Ordering::SeqCst), 1);

        let frame = AnsweredFrame {
            v: 1,
            frame_type: "answered",
            wid: format!("w{:012}", 1),
            seq: 1,
            answered: true,
            answered_by: Some("alice".to_string()),
            answered_at: 1_700_000_001_000,
            answered_content: Some("done".to_string()),
        };
        drive(
            &mut machine,
            &mut rt,
            Event::Frame {
                result: FrameResult::Ok(ServerFrame::Answered(frame)),
            },
        );

        let snap = buffer.lock().unwrap().snapshot();
        assert_eq!(snap.messages.len(), 1, "answered 原位更新不新增条目");
        let m = &snap.messages[0];
        assert!(m.answered);
        assert_eq!(m.answered_by.as_deref(), Some("alice"));
        assert_eq!(m.answered_at, Some(1_700_000_001_000));
        assert_eq!(m.answered_content.as_deref(), Some("done"));
        assert_eq!(
            notify_count.load(Ordering::SeqCst),
            1,
            "answered 不触发通知钩子（移除通知由 05-05 在 answered 帧路径接线）"
        );
        assert_eq!(
            rt.effects
                .events
                .iter()
                .filter(|(e, _)| *e == "ph://answered")
                .count(),
            1
        );
    }

    /// EmitStatus 分派：共享状态单元更新（manager statuses() 数据源）。
    #[tokio::test]
    async fn emit_status_updates_shared_cell() {
        let (mut rt, mut machine, _n, _b, status) = make_rt();
        drive(&mut machine, &mut rt, Event::Connect);
        assert_eq!(*status.lock().unwrap(), Status::Connecting);
        drive(&mut machine, &mut rt, Event::WsOpen);
        assert_eq!(*status.lock().unwrap(), Status::Online);
    }

    /// 错误路径静态文案（T-05-04-01）：WsFail 的 error 载荷不含 ws_url/密钥。
    #[tokio::test]
    async fn ws_fail_error_static_message_no_url_leak() {
        let (mut rt, mut machine, _n, _b, _s) = make_rt();
        drive(&mut machine, &mut rt, Event::Connect);
        drive(
            &mut machine,
            &mut rt,
            Event::WsFail {
                message: "failed to construct WebSocket for serverUrl".to_string(),
            },
        );
        let (_, payload) = rt
            .effects
            .events
            .iter()
            .find(|(e, _)| *e == "ph://error")
            .expect("WsFail 必须发 ph://error");
        let text = payload.to_string();
        assert!(text.contains("failed to construct WebSocket for serverUrl"));
        assert!(!text.contains("ws://"), "错误载荷不得含连接 URL");
        assert!(!text.contains("example.invalid"));
        assert!(payload["error"]["fatal"] == json!(true));
        assert_eq!(payload["channel_id"], json!("ch1"));
    }

    /// close code 三映射（纯函数面）。
    #[test]
    fn close_code_three_mappings() {
        assert_eq!(
            close_code_of(CloseReason::Fatal),
            (1002, "protocol version mismatch")
        );
        assert_eq!(
            close_code_of(CloseReason::Deadline),
            (4000, "heartbeat deadline")
        );
        assert_eq!(
            close_code_of(CloseReason::Manual),
            (1000, "client disconnect")
        );
    }

    /// close code 映射经分派路径（真事件驱动）：Manual（Disconnect 事件）与
    /// Fatal（v!==1 帧，唯一 Fatal 来源）两条真实路径。
    #[tokio::test]
    async fn close_socket_dispatch_uses_mapped_codes() {
        // Manual：Disconnect 事件路径。
        let (mut rt, mut machine, _n, _b, _s) = make_rt();
        online(&mut machine, &mut rt);
        drive(&mut machine, &mut rt, Event::Disconnect);
        assert_eq!(rt.effects.closes, vec![(1000, "client disconnect")]);

        // Fatal：v!==1 帧（D-07 客户端严格）。
        let (mut rt, mut machine, _n, _b, _s) = make_rt();
        online(&mut machine, &mut rt);
        drive(
            &mut machine,
            &mut rt,
            Event::Frame {
                result: parse_server_frame(r#"{"v":2,"type":"pong"}"#),
            },
        );
        assert_eq!(
            rt.effects.closes,
            vec![(1002, "protocol version mismatch")]
        );

        // Deadline：pong 死线超时路径（forceReconnect）。
        let (mut rt, mut machine, _n, _b, _s) = make_rt();
        online(&mut machine, &mut rt);
        // 武装 pong 死线的正规路径：SendPing 后 Schedule(PongDeadline)——
        // 直接喂 Timer(PongDeadline) 前需机器武装集包含它，否则被 ghost 过滤。
        drive(&mut machine, &mut rt, Event::Visibility { visible: true }); // ping + Probe 死线
        drive(&mut machine, &mut rt, Event::Timer { kind: TimerKind::Probe });
        assert_eq!(rt.effects.closes, vec![(4000, "heartbeat deadline")]);
    }

    /// 陈旧代际防护（读侧入口）：旧 stream 的 Opened/Conn 事件丢弃，
    /// Timer/Control 不受代际过滤。
    #[test]
    fn stale_generation_events_dropped() {
        let (tx, _guard) = mpsc::unbounded_channel::<Outbound>();
        // 旧代际（gen=1）在当前代际（gen=2）下全丢弃。
        assert!(accept_inbound(Inbound::Opened { gen: 1, writer: tx.clone() }, 2).is_none());
        assert!(
            accept_inbound(
                Inbound::Conn {
                    gen: 1,
                    event: Event::WsClose,
                },
                2
            )
            .is_none()
        );
        // 当前代际通过（Opened 携带 writer 归位语义）。
        assert!(matches!(
            accept_inbound(Inbound::Opened { gen: 2, writer: tx }, 2),
            Some(Accepted::Opened { .. })
        ));
        assert!(matches!(
            accept_inbound(
                Inbound::Conn {
                    gen: 2,
                    event: Event::WsClose,
                },
                2
            ),
            Some(Accepted::Event(Event::WsClose))
        ));
        // Timer/Control 与代际无关（ghost 由 machine 武装集承担）。
        assert!(matches!(
            accept_inbound(Inbound::Timer { kind: TimerKind::Heartbeat }, 7),
            Some(Accepted::Event(Event::Timer { .. }))
        ));
        assert!(matches!(
            accept_inbound(Inbound::Control(Event::Visibility { visible: true }), 7),
            Some(Accepted::Event(Event::Visibility { visible: true }))
        ));
    }
}
