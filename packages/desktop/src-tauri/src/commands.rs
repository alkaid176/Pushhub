//! Tauri 命令面（05-05 Task 1，WIN-06）——前端 invoke 的全部 Rust 侧入口。
//!
//! 命令全集：reply（fail-fast 三步）/ channel_snapshot（窗口重建）/
//! test_connection（向导连通验证，D-73）/ config CRUD（add/update/remove
//! channel、set_display_name、toggle_dnd、set_channel_muted、
//! mark_first_close_hint、get_config）/ set_current_channel（UI 焦点上报，
//! 通知决策矩阵的 current_channel 输入——05-06 前端接线）。
//!
//! 设计纪律：
//!  - reply fail-fast 三步逐条对齐 pushhub.ts:148-196（WEB-03 Pattern 7）：
//!    (1) 载荷恰一（selected_option XOR text，truthiness 语义与 JS
//!    Boolean() 同源——空串视为未提供）本地拒绝 invalid_frame；
//!    (2) 频道状态非 online → not_connected（不排队不重试）；
//!    (3) 经频道 outbox 直发 writer（reply 不进连接状态机词汇表）。
//!  - 宽松预检（Pitfall 6 + prohibitions）：text 按 chars() 超 TEXT_MAX、
//!    by/selected_option 超 BY_MAX → limit_exceeded 显式拒绝，绝不静默截断
//!    为语义不同的内容；权威校验在服务端（D-06）。
//!  - 错误面 CmdError{code, message}：code 可编程消费；message 为静态英文
//!    短句，绝不内嵌 Channel Key/连接 URL（T-05-05-04）。
//!  - 内部 do_* 函数与 #[tauri::command] 薄壳分离：核心逻辑不依赖 Tauri
//!    State，cargo test 直接消费（与 ChannelManager 注入工厂同款测试切面）。

// 公开 API 消费者标注（05-02 同款策略）：命令经 lib.rs invoke_handler 注册
// （Task 2 完整装配）；do_*/纯函数由测试直消。
#![allow(dead_code)]

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::State;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::frame::CloseFrame;

use crate::adapter::manager::{ChannelManager, ManagerError};
use crate::adapter::build_ws_url;
use crate::buffer::BufferSnapshot;
use crate::config::{self, ChannelConfig, Config};
use crate::machine::Status;
use crate::notify::NotifyCmd;
use crate::protocol::{ClientFrame, ReplyFrame, BY_MAX, PROTOCOL_VERSION, TEXT_MAX};

/// UI 焦点状态（通知决策矩阵 D-65 的 current_channel 输入）：前端切换频道
/// 时经 set_current_channel 上报（05-06 接线；本 plan 预留通道）。
#[derive(Debug, Default)]
pub struct UiFocusState {
    /// 当前展示频道（None = 无频道选中/向导态——决策矩阵按"非当前"处理）。
    pub current_channel: Option<String>,
}

/// 跨命令共享的应用状态（lib.rs setup 构造并 manage；通知决策闭包共享
/// 同一份 Arc——muted/dnd/焦点读取与命令写入同一数据源，无快照漂移）。
pub struct AppState {
    pub config: Arc<Mutex<Config>>,
    /// 配置文件路径（setup 时解析一次；所有保存定点写入，不重复解析环境变量）。
    pub path: PathBuf,
    /// 通知线程命令发送端（Show/Remove/SetDnd 经 mpsc 进专用 OS 线程）。
    pub notify_tx: std::sync::mpsc::Sender<NotifyCmd>,
    /// UI 焦点状态（决策矩阵输入）。
    pub focus: Arc<Mutex<UiFocusState>>,
}

/// 命令层结构化错误（前端可编程消费 code）。
///
/// message 为静态英文短句——不含 Channel Key/URL/用户输入回显
/// （T-05-05-04 prohibitions）。
#[derive(Debug, Clone, Serialize)]
pub struct CmdError {
    pub code: &'static str,
    pub message: &'static str,
}

impl CmdError {
    fn new(code: &'static str, message: &'static str) -> Self {
        Self { code, message }
    }
}

/// 向导连通性验证超时上限（约 5 秒量级——常量断言锁定验收口径）。
pub const TEST_CONNECTION_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

// ---- reply（fail-fast 三步，WEB-03 Pattern 7）----

/// reply 载荷（前端 invoke 参数）：恰一校验在 validate_reply（两字段都收，
/// truthiness 判定与 pushhub.ts Boolean() 同源——空串视为未提供）。
#[derive(Debug, Clone, Deserialize)]
pub struct ReplyPayload {
    pub selected_option: Option<String>,
    pub text: Option<String>,
}

/// JS truthiness 语义的"已提供"判定（Boolean(payload.x)：空串为 false）。
fn is_present(s: &Option<String>) -> bool {
    s.as_deref().map(|s| !s.is_empty()).unwrap_or(false)
}

/// reply 三步核心：恰一校验 + 长度宽松预检 + 帧构造（纯函数，测试直消）。
///
/// by 为 None 时 serde skip——序列化输出不含 by 键（D-72 缺省匿名语义，
/// pushhub.ts "by !== undefined 才展开" 同构）。
fn validate_reply(payload: &ReplyPayload, by: Option<&str>, wid: &str) -> Result<ReplyFrame, CmdError> {
    // (1) 载荷恰一：同真/同假均 invalid_frame。
    let has_option = is_present(&payload.selected_option);
    let has_text = is_present(&payload.text);
    if has_option == has_text {
        return Err(CmdError::new(
            "invalid_frame",
            "reply payload must provide exactly one of selected_option or text",
        ));
    }
    // 宽松预检（chars() 近似，Pitfall 6）：超限显式拒绝，不截断（prohibitions）。
    if let Some(t) = payload.text.as_deref() {
        if t.chars().count() > TEXT_MAX {
            return Err(CmdError::new(
                "limit_exceeded",
                "reply text exceeds client limit (rejected, not truncated)",
            ));
        }
    }
    if let Some(o) = payload.selected_option.as_deref() {
        if o.chars().count() > BY_MAX {
            return Err(CmdError::new(
                "limit_exceeded",
                "selected_option exceeds client limit (rejected, not truncated)",
            ));
        }
    }
    if let Some(name) = by {
        if name.chars().count() > BY_MAX {
            return Err(CmdError::new(
                "limit_exceeded",
                "display name exceeds client limit (rejected, not truncated)",
            ));
        }
    }
    Ok(ReplyFrame {
        v: PROTOCOL_VERSION,
        frame_type: "reply".to_string(),
        wid: wid.to_string(),
        selected_option: if has_option {
            payload.selected_option.clone()
        } else {
            None
        },
        text: if has_text { payload.text.clone() } else { None },
        by: by.map(str::to_string),
    })
}

/// reply 内部实现（命令壳直转；测试直消）。
fn do_reply(
    state: &AppState,
    manager: &ChannelManager,
    channel_id: &str,
    wid: &str,
    payload: &ReplyPayload,
) -> Result<(), CmdError> {
    let display_name = state.config.lock().unwrap().display_name.clone();
    let frame = validate_reply(payload, display_name.as_deref(), wid)?;
    // (2) 连接检查：fail-fast——非 online 不排队不重试（WEB-03 边界语义；
    // 用户重试策略归宿主/前端业务层）。
    if manager.channel_status(channel_id) != Some(Status::Online) {
        return Err(CmdError::new("not_connected", "reply failed: not connected"));
    }
    // (3) 发帧：经频道 outbox 直发 writer（不进状态机词汇表）。
    let text = serde_json::to_string(&ClientFrame::Reply(frame)).expect("reply frame serializes");
    manager
        .send_raw(channel_id, text)
        .map_err(|_| CmdError::new("not_connected", "reply failed: not connected"))?;
    Ok(())
}

/// 回复消息（前端回复面调用；by 取全局展示名配置 D-72）。
#[tauri::command]
pub fn reply(
    state: State<'_, AppState>,
    manager: State<'_, ChannelManager>,
    channel_id: String,
    wid: String,
    payload: ReplyPayload,
) -> Result<(), CmdError> {
    do_reply(&state, &manager, &channel_id, &wid, &payload)
}

// ---- channel_snapshot（窗口重开全量重建，D-60）----

/// 频道缓冲快照（窗口开/重开时全量重建列表；频道不存在返回 None）。
#[tauri::command]
pub fn channel_snapshot(
    manager: State<'_, ChannelManager>,
    channel_id: String,
) -> Option<BufferSnapshot> {
    manager.snapshot(&channel_id)
}

// ---- test_connection（向导连通验证，D-73/WIN-06）----

/// 连接探测错误分类（不回显底层错误——tungstenite Display 可能含 URL/密钥，
/// T-05-05-04：只按错误类别映射静态文案）。
fn classify_connect_error(e: &tokio_tungstenite::tungstenite::Error) -> CmdError {
    use tokio_tungstenite::tungstenite::Error as WsError;
    match e {
        WsError::Io(_) => CmdError::new("unreachable", "server unreachable (network error)"),
        WsError::Http(_) => CmdError::new("handshake_rejected", "server rejected the WebSocket handshake"),
        _ => CmdError::new("handshake_rejected", "WebSocket handshake failed"),
    }
}

/// 连通性探测核心（命令壳直转；测试直消）：真实 WS 握手，成功即以
/// Manual 1000（close_code_of 同语义）优雅关闭。URL 构造复用 adapter 的
/// build_ws_url（与正式连接同一函数——探测口径与运行口径一致）。
async fn probe_connection(server: &str, channel_key: &str) -> Result<(), CmdError> {
    let url = build_ws_url(server, channel_key);
    let request = url
        .as_str()
        .into_client_request()
        .map_err(|_| CmdError::new("invalid_url", "server address is not a valid URL"))?;
    match tokio::time::timeout(
        TEST_CONNECTION_TIMEOUT,
        tokio_tungstenite::connect_async(request),
    )
    .await
    {
        Err(_) => Err(CmdError::new("timeout", "connection attempt timed out")),
        Ok(Err(e)) => Err(classify_connect_error(&e)),
        Ok(Ok((mut stream, _resp))) => {
            // 成功即关（Manual 1000 / "client disconnect"——与正式连接的
            // close_code_of(Manual) 完全同语义）。
            let _ = stream
                .close(Some(CloseFrame {
                    code: CloseCode::Normal,
                    reason: "client disconnect".into(),
                }))
                .await;
            Ok(())
        }
    }
}

/// 向导「验证连通」数据源：以真实 WS 握手探测 server+channel_key 组合。
#[tauri::command]
pub async fn test_connection(server: String, channel_key: String) -> Result<(), CmdError> {
    probe_connection(&server, &channel_key).await
}

// ---- config CRUD（WIN-06/D-65/D-70/D-71/D-72）----

fn map_manager_err(e: ManagerError) -> CmdError {
    match e {
        ManagerError::DuplicateChannel(_) => {
            CmdError::new("duplicate_channel", "channel id already exists")
        }
        // "(max 8)" 与 manager::MAX_CHANNELS 联动（常量单一事实源在其模块，
        // 测试硬断言上限行为）。
        ManagerError::ChannelLimitReached => CmdError::new(
            "channel_limit_reached",
            "channel limit reached (max 8)",
        ),
        ManagerError::ChannelNotFound(_) => CmdError::new("channel_not_found", "channel not found"),
    }
}

fn persist(state: &AppState, cfg: &Config) -> Result<(), CmdError> {
    config::save_to(&state.path, cfg)
        .map_err(|_| CmdError::new("io", "failed to persist config file"))
}

/// 新频道 id 生成（纳秒时间戳十六进制——8 频道上限下碰撞概率可忽略，
/// 命中重复时 manager 以 DuplicateChannel 显式拒绝）。
fn new_channel_id() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("ch_{nanos:x}")
}

/// add_channel 内部实现：落盘 + spawn（验证连通由前端先调 test_connection，
/// 本命令不重复探测——失败成本高的网络操作不隐式串联）。向导首配场景
/// server 与第一个频道一起落（manager.set_server 更新后续 spawn 基址）。
fn do_add_channel(
    state: &AppState,
    manager: &ChannelManager,
    server: Option<String>,
    name: &str,
    key: &str,
) -> Result<String, CmdError> {
    let mut cfg = state.config.lock().unwrap();
    if let Some(s) = server {
        let s = s.trim();
        if !s.is_empty() {
            cfg.server = s.to_string();
        }
    }
    if cfg.server.trim().is_empty() {
        return Err(CmdError::new(
            "invalid_url",
            "server address required before adding a channel",
        ));
    }
    if name.trim().is_empty() {
        return Err(CmdError::new("invalid_frame", "channel name required"));
    }
    if key.trim().is_empty() {
        return Err(CmdError::new("invalid_frame", "channel key required"));
    }
    let channel = ChannelConfig {
        id: new_channel_id(),
        name: name.trim().to_string(),
        key: key.trim().to_string(),
        muted: false,
    };
    // 上限检查由 manager 承担（MAX_CHANNELS 单一事实源，第 9 个拒绝）。
    manager.set_server(cfg.server.trim().to_string());
    manager.spawn_channel(&channel).map_err(map_manager_err)?;
    let id = channel.id.clone();
    cfg.channels.push(channel);
    persist(state, &cfg)?;
    Ok(id)
}

/// 新增频道（spawn + 落盘）；返回新频道 id。
#[tauri::command]
pub fn add_channel(
    state: State<'_, AppState>,
    manager: State<'_, ChannelManager>,
    server: Option<String>,
    name: String,
    key: String,
) -> Result<String, CmdError> {
    do_add_channel(&state, &manager, server, &name, &key)
}

/// update_channel 内部实现：落盘 + 以新配置 remove→spawn（key 变更需重连；
/// manager.restart_channel 复用句柄内旧配置，不适用于 key 变更场景）。
fn do_update_channel(
    state: &AppState,
    manager: &ChannelManager,
    id: &str,
    name: Option<String>,
    key: Option<String>,
) -> Result<(), CmdError> {
    let mut cfg = state.config.lock().unwrap();
    let Some(stored) = cfg.channels.iter().find(|c| c.id == id).cloned() else {
        return Err(CmdError::new("channel_not_found", "channel not found"));
    };
    let mut updated = stored.clone();
    if let Some(n) = name {
        if n.trim().is_empty() {
            return Err(CmdError::new("invalid_frame", "channel name required"));
        }
        updated.name = n.trim().to_string();
    }
    if let Some(k) = key {
        if k.trim().is_empty() {
            return Err(CmdError::new("invalid_frame", "channel key required"));
        }
        updated.key = k.trim().to_string();
    }
    // 先落盘后重启（重启失败时配置仍一致——下次启动按新配置连接）。
    if let Some(pos) = cfg.channels.iter().position(|c| c.id == id) {
        cfg.channels[pos] = updated.clone();
    }
    persist(state, &cfg)?;
    if updated.key != stored.key || updated.name != stored.name {
        manager.remove_channel(id).ok(); // 不在表内（未 spawn）时忽略
        manager.spawn_channel(&updated).map_err(map_manager_err)?;
    }
    Ok(())
}

/// 修改频道（name/key 变更即 remove→spawn 重连）。
#[tauri::command]
pub fn update_channel(
    state: State<'_, AppState>,
    manager: State<'_, ChannelManager>,
    id: String,
    name: Option<String>,
    key: Option<String>,
) -> Result<(), CmdError> {
    do_update_channel(&state, &manager, &id, name, key)
}

/// remove_channel 内部实现：Destroy 停机 + 落盘移除。
fn do_remove_channel(state: &AppState, manager: &ChannelManager, id: &str) -> Result<(), CmdError> {
    manager.remove_channel(id).map_err(map_manager_err)?;
    let mut cfg = state.config.lock().unwrap();
    cfg.channels.retain(|c| c.id != id);
    persist(state, &cfg)
}

/// 删除频道（Destroy + 出表 + 落盘移除）。
#[tauri::command]
pub fn remove_channel(
    state: State<'_, AppState>,
    manager: State<'_, ChannelManager>,
    id: String,
) -> Result<(), CmdError> {
    do_remove_channel(&state, &manager, &id)
}

/// set_display_name 内部实现（BY_MAX 预检——超限拒绝不截断；空串视为清除）。
fn do_set_display_name(state: &AppState, name: Option<String>) -> Result<(), CmdError> {
    let normalized = name.and_then(|n| {
        let trimmed = n.trim().to_string();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    });
    if let Some(n) = &normalized {
        if n.chars().count() > BY_MAX {
            return Err(CmdError::new(
                "limit_exceeded",
                "display name exceeds client limit (rejected, not truncated)",
            ));
        }
    }
    let mut cfg = state.config.lock().unwrap();
    cfg.display_name = normalized;
    persist(state, &cfg)
}

/// 设置全局展示名（reply 帧 by 字段来源，D-72；None/空串清除 → 匿名回复）。
#[tauri::command]
pub fn set_display_name(
    state: State<'_, AppState>,
    name: Option<String>,
) -> Result<(), CmdError> {
    do_set_display_name(&state, name)
}

/// toggle_dnd 内部实现：落盘 + 通知线程 SetDnd（双写保持一致——线程内
/// should_suppress 与决策矩阵读配置是两道独立防线，同一数据源驱动）。
fn do_toggle_dnd(state: &AppState, dnd: bool) -> Result<(), CmdError> {
    let mut cfg = state.config.lock().unwrap();
    cfg.dnd = dnd;
    persist(state, &cfg)?;
    if state.notify_tx.send(NotifyCmd::SetDnd(dnd)).is_err() {
        // 通知线程已停（异常态）：配置已落盘，不阻断命令——下次启动按配置恢复。
        eprintln!("pushhub: notify thread unreachable, dnd persisted to config only");
    }
    Ok(())
}

/// 全局勿扰开关（D-70：托盘 CheckItem 与设置面板双入口）。
#[tauri::command]
pub fn toggle_dnd(state: State<'_, AppState>, dnd: bool) -> Result<(), CmdError> {
    do_toggle_dnd(&state, dnd)
}

/// set_channel_muted 内部实现：只落盘（静音只影响通知决策不影响连接——
/// 连接/缓冲/窗口可见性照常）。
fn do_set_channel_muted(state: &AppState, id: &str, muted: bool) -> Result<(), CmdError> {
    let mut cfg = state.config.lock().unwrap();
    let Some(ch) = cfg.channels.iter_mut().find(|c| c.id == id) else {
        return Err(CmdError::new("channel_not_found", "channel not found"));
    };
    ch.muted = muted;
    persist(state, &cfg)
}

/// 每频道静音开关（D-70——通知决策矩阵的 muted 输入）。
#[tauri::command]
pub fn set_channel_muted(
    state: State<'_, AppState>,
    id: String,
    muted: bool,
) -> Result<(), CmdError> {
    do_set_channel_muted(&state, &id, muted)
}

/// mark_first_close_hint 内部实现（D-71：一次性提示，此后不再弹）。
fn do_mark_first_close_hint(state: &AppState) -> Result<(), CmdError> {
    let mut cfg = state.config.lock().unwrap();
    if !cfg.first_close_hint_shown {
        cfg.first_close_hint_shown = true;
        persist(state, &cfg)?;
    }
    Ok(())
}

/// 标记首次关闭提示已展示（前端一次性提示确认后调用，D-71）。
#[tauri::command]
pub fn mark_first_close_hint(state: State<'_, AppState>) -> Result<(), CmdError> {
    do_mark_first_close_hint(&state)
}

/// 读取配置（本地单用户配置面：channels 的 key 原样返回——前端编辑需要；
/// 配置文件本身在用户目录，无额外秘密可脱敏）。
#[tauri::command]
pub fn get_config(state: State<'_, AppState>) -> Config {
    state.config.lock().unwrap().clone()
}

/// UI 焦点上报：当前展示频道（通知决策矩阵 D-65 的 current_channel 输入；
/// 05-06 前端切换频道时调用——本 plan 预留通道）。
#[tauri::command]
pub fn set_current_channel(state: State<'_, AppState>, channel_id: Option<String>) {
    do_set_current_channel(&state, channel_id);
}

fn do_set_current_channel(state: &AppState, channel_id: Option<String>) {
    state.focus.lock().unwrap().current_channel = channel_id;
}

// 公开 API 消费者标注（05-02 同款策略）：命令经 lib.rs invoke_handler 注册
// （Task 2）；do_*/纯函数由测试直消。

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapter::manager::{ChannelRunner, SpawnInputs};
    use crate::adapter::RealtimeMessage;
    use crate::machine::Event;
    use std::collections::HashMap;
    use std::path::Path;
    use std::time::Duration;

    // ---- 测试基建（State-free：AppState 直接构造 + 注入 runner）----

    fn temp_path(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pushhub-cmd-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("config.json")
    }

    fn test_state(path: &Path, cfg: Config) -> (AppState, std::sync::mpsc::Receiver<NotifyCmd>) {
        let (tx, rx) = std::sync::mpsc::channel();
        (
            AppState {
                config: Arc::new(Mutex::new(cfg)),
                path: path.to_path_buf(),
                notify_tx: tx,
                focus: Arc::new(Mutex::new(UiFocusState::default())),
            },
            rx,
        )
    }

    /// 有界轮询断言（假任务在 tauri 全局运行时异步启动——跨运行时收敛）。
    async fn soon(mut probe: impl FnMut() -> bool) {
        for _ in 0..200 {
            if probe() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("condition not met within 2s");
    }

    /// 假 runner：写入注入的频道状态后驻留（Destroy 收敛退出）；记录
    /// SpawnInputs.server 与 outbox 直发帧（命令层全流程的无网络切面）。
    fn stub_runner(
        statuses: HashMap<String, Status>,
        servers: Arc<Mutex<Vec<String>>>,
        sent: Arc<Mutex<Vec<String>>>,
    ) -> ChannelRunner {
        Arc::new(move |p: SpawnInputs| {
            let id = p.config.id.clone();
            let server = p.server;
            let status = p.status;
            let mut control = p.control;
            let mut outbox = p.outbox;
            let statuses = statuses.clone();
            let servers = Arc::clone(&servers);
            let sent = Arc::clone(&sent);
            tauri::async_runtime::spawn(async move {
                servers.lock().unwrap().push(server);
                if let Some(s) = statuses.get(&id) {
                    *status.lock().unwrap() = *s;
                }
                loop {
                    tokio::select! {
                        ev = control.recv() => match ev {
                            Some(e) if matches!(e, Event::Destroy) => break,
                            Some(_) => {}
                            None => break,
                        },
                        t = outbox.recv() => {
                            if let Some(t) = t { sent.lock().unwrap().push(t); }
                        }
                    }
                }
            })
        })
    }

    fn online_runner() -> (ChannelManager, Arc<Mutex<Vec<String>>>) {
        let sent = Arc::new(Mutex::new(Vec::new()));
        let mgr = ChannelManager::new(
            "http://127.0.0.1:4911".to_string(),
            Arc::new(|_m: RealtimeMessage| {}),
            stub_runner(
                HashMap::from([("ch1".to_string(), Status::Online)]),
                Arc::new(Mutex::new(Vec::new())),
                Arc::clone(&sent),
            ),
        );
        (mgr, sent)
    }

    fn payload_text(text: &str) -> ReplyPayload {
        ReplyPayload {
            selected_option: None,
            text: Some(text.to_string()),
        }
    }

    // ---- reply fail-fast 三步 ----

    /// (1) 载荷恰一：同真/同假（含空串 truthiness 视为未提供）均 invalid_frame，
    /// 且帧不发出（sent 为空）。
    #[tokio::test]
    async fn reply_exactly_one_violation_rejected_no_frame_sent() {
        let path = temp_path("reply-invalid");
        let (state, _rx) = test_state(&path, Config::default());
        let (mgr, sent) = online_runner();
        mgr.spawn_channel(&crate::config::ChannelConfig {
            id: "ch1".to_string(),
            name: "n".to_string(),
            key: "phc_k".to_string(),
            muted: false,
        })
        .unwrap();

        let both = ReplyPayload {
            selected_option: Some("a".to_string()),
            text: Some("b".to_string()),
        };
        let err = do_reply(&state, &mgr, "ch1", "m_1", &both).unwrap_err();
        assert_eq!(err.code, "invalid_frame");

        let neither = ReplyPayload {
            selected_option: None,
            text: None,
        };
        assert_eq!(
            do_reply(&state, &mgr, "ch1", "m_1", &neither).unwrap_err().code,
            "invalid_frame"
        );

        // 空串 truthiness 视为未提供（JS Boolean() 同源——双空/空+实同判）。
        let empty_opt = ReplyPayload {
            selected_option: Some(String::new()),
            text: None,
        };
        assert_eq!(
            do_reply(&state, &mgr, "ch1", "m_1", &empty_opt).unwrap_err().code,
            "invalid_frame"
        );

        // 校验拒绝先于在线检查——等假任务完全启动后仍零帧（拒绝路径无出站）。
        soon(|| mgr.channel_status("ch1") == Some(Status::Online)).await;
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(sent.lock().unwrap().is_empty(), "invalid_frame 路径零出站帧");
    }

    /// (2) 离线/未知频道 → not_connected（不排队不重试）。
    #[tokio::test]
    async fn reply_offline_and_unknown_channel_not_connected() {
        let path = temp_path("reply-offline");
        let (state, _rx) = test_state(&path, Config::default());
        let (mgr, sent) = online_runner();
        // ch1 在 runner 中注入 Online，但尚未 spawn——状态单元 Offline。
        assert_eq!(
            do_reply(&state, &mgr, "ghost", "m_1", &payload_text("hi"))
                .unwrap_err()
                .code,
            "not_connected"
        );
        // spawn 后状态异步写 Online 前的 Offline 窗口同样 fail-fast。
        mgr.spawn_channel(&crate::config::ChannelConfig {
            id: "other".to_string(),
            name: "n".to_string(),
            key: "phc_k".to_string(),
            muted: false,
        })
        .unwrap();
        assert_eq!(
            do_reply(&state, &mgr, "other", "m_1", &payload_text("hi"))
                .unwrap_err()
                .code,
            "not_connected",
            "非 online 频道（Offline）拒绝"
        );
        assert!(sent.lock().unwrap().is_empty());
    }

    /// (3) 成功路径：display_name 为 None 时序列化输出不含 by 键（D-72 缺省
    /// 匿名——serde skip 验证，逐字节断言）。
    #[tokio::test]
    async fn reply_success_frame_omits_by_when_display_name_none() {
        let path = temp_path("reply-ok");
        let (state, _rx) = test_state(&path, Config::default());
        let (mgr, sent) = online_runner();
        mgr.spawn_channel(&crate::config::ChannelConfig {
            id: "ch1".to_string(),
            name: "n".to_string(),
            key: "phc_k".to_string(),
            muted: false,
        })
        .unwrap();
        soon(|| mgr.channel_status("ch1") == Some(Status::Online)).await;

        do_reply(&state, &mgr, "ch1", "m_1", &payload_text("hello")).unwrap();
        soon(|| !sent.lock().unwrap().is_empty()).await;
        assert_eq!(
            sent.lock().unwrap()[0],
            r#"{"v":1,"type":"reply","wid":"m_1","text":"hello"}"#,
            "by None → 键不出现（pushhub.ts by!==undefined 展开语义同构）"
        );
    }

    /// 成功路径（by 携带）：display_name 配置进 by 字段。
    #[tokio::test]
    async fn reply_success_serializes_display_name_as_by() {
        let path = temp_path("reply-by");
        let (state, _rx) = test_state(
            &path,
            Config {
                display_name: Some("Windows 笔电".to_string()),
                ..Default::default()
            },
        );
        let (mgr, sent) = online_runner();
        mgr.spawn_channel(&crate::config::ChannelConfig {
            id: "ch1".to_string(),
            name: "n".to_string(),
            key: "phc_k".to_string(),
            muted: false,
        })
        .unwrap();
        soon(|| mgr.channel_status("ch1") == Some(Status::Online)).await;

        do_reply(&state, &mgr, "ch1", "m_2", &payload_text("hi")).unwrap();
        soon(|| !sent.lock().unwrap().is_empty()).await;
        assert_eq!(
            sent.lock().unwrap()[0],
            r#"{"v":1,"type":"reply","wid":"m_2","text":"hi","by":"Windows 笔电"}"#
        );
    }

    /// 宽松预检（Pitfall 6 + prohibitions）：text 超 TEXT_MAX、by/selected_option
    /// 超 BY_MAX → limit_exceeded 显式拒绝，帧未发出（不截断）；恰在上限内通过。
    #[tokio::test]
    async fn reply_limit_precheck_rejects_without_truncation() {
        let path = temp_path("reply-limit");
        let (state, _rx) = test_state(
            &path,
            Config {
                display_name: Some("名".repeat(BY_MAX)),
                ..Default::default()
            },
        );
        let (mgr, sent) = online_runner();
        mgr.spawn_channel(&crate::config::ChannelConfig {
            id: "ch1".to_string(),
            name: "n".to_string(),
            key: "phc_k".to_string(),
            muted: false,
        })
        .unwrap();
        soon(|| mgr.channel_status("ch1") == Some(Status::Online)).await;

        // text 超 TEXT_MAX（恰 32769 chars）——拒绝不截断。
        let over_text = "a".repeat(TEXT_MAX + 1);
        let err = do_reply(&state, &mgr, "ch1", "m_1", &payload_text(&over_text)).unwrap_err();
        assert_eq!(err.code, "limit_exceeded");
        // selected_option 超 BY_MAX。
        let over_opt = ReplyPayload {
            selected_option: Some("o".repeat(BY_MAX + 1)),
            text: None,
        };
        assert_eq!(
            do_reply(&state, &mgr, "ch1", "m_1", &over_opt).unwrap_err().code,
            "limit_exceeded"
        );
        // by 超 BY_MAX（配置展示名 65 字）。
        let state_over_by = AppState {
            config: Arc::new(Mutex::new(Config {
                display_name: Some("名".repeat(BY_MAX + 1)),
                ..Default::default()
            })),
            path: path.clone(),
            notify_tx: state.notify_tx.clone(),
            focus: Arc::new(Mutex::new(UiFocusState::default())),
        };
        assert_eq!(
            do_reply(&state_over_by, &mgr, "ch1", "m_1", &payload_text("hi"))
                .unwrap_err()
                .code,
            "limit_exceeded"
        );
        // 恰在上限内（text == TEXT_MAX、by == BY_MAX）通过并发帧。
        let at_limit = "a".repeat(TEXT_MAX);
        do_reply(&state, &mgr, "ch1", "m_1", &payload_text(&at_limit)).unwrap();
        soon(|| !sent.lock().unwrap().is_empty()).await;
        let frame = &sent.lock().unwrap()[0];
        assert!(frame.contains(&format!(r#""text":"{}""#, at_limit)));
        assert!(!frame.contains("limit"), "未发生截断——原文完整直发");
    }

    // ---- config CRUD ----

    fn channel_cfg(id: &str) -> ChannelConfig {
        ChannelConfig {
            id: id.to_string(),
            name: format!("n-{id}"),
            key: format!("phc_{id}"),
            muted: false,
        }
    }

    fn empty_runner() -> ChannelManager {
        ChannelManager::new(
            "http://127.0.0.1:4911".to_string(),
            Arc::new(|_m: RealtimeMessage| {}),
            stub_runner(
                HashMap::new(),
                Arc::new(Mutex::new(Vec::new())),
                Arc::new(Mutex::new(Vec::new())),
            ),
        )
    }

    /// add_channel：落盘 + spawn；向导首配 server 一起落并更新 spawn 基址。
    #[tokio::test]
    async fn add_channel_persists_spawns_and_sets_server() {
        let path = temp_path("add");
        let (state, _rx) = test_state(&path, Config::default());
        let servers = Arc::new(Mutex::new(Vec::new()));
        let mgr = ChannelManager::new(
            "http://old".to_string(),
            Arc::new(|_m: RealtimeMessage| {}),
            stub_runner(HashMap::new(), Arc::clone(&servers), Arc::new(Mutex::new(Vec::new()))),
        );

        let id = do_add_channel(
            &state,
            &mgr,
            Some("http://127.0.0.1:4911".to_string()),
            "告警群",
            "phc_k",
        )
        .unwrap();
        assert!(id.starts_with("ch_"), "生成的频道 id 形态");
        assert_eq!(mgr.len(), 1, "spawn 入表");
        {
            let cfg = state.config.lock().unwrap();
            assert_eq!(cfg.server, "http://127.0.0.1:4911");
            assert_eq!(cfg.channels.len(), 1);
            assert_eq!(cfg.channels[0].name, "告警群");
            assert!(!cfg.channels[0].muted);
        }
        assert_eq!(
            config::load_from(&path).channels.len(),
            1,
            "落盘往返一致"
        );
        soon(|| servers.lock().unwrap().last().cloned() == Some("http://127.0.0.1:4911".to_string()))
            .await;
        mgr.remove_channel(&id).unwrap();
    }

    /// add_channel 第 9 个返回 channel_limit_reached（ChannelLimitReached
    /// 派生错误）且不落盘。
    #[tokio::test]
    async fn add_channel_9th_returns_limit_error() {
        let path = temp_path("limit9");
        let (state, _rx) = test_state(&path, Config::default());
        let mgr = empty_runner();
        for i in 1..=8 {
            do_add_channel(&state, &mgr, Some("http://s".to_string()), &format!("频道{i}"), "phc_k")
                .unwrap_or_else(|e| panic!("第 {i} 个应允许: {e:?}"));
            std::thread::sleep(Duration::from_millis(1)); // id 时间戳防碰撞
        }
        let err = do_add_channel(&state, &mgr, Some("http://s".to_string()), "第9个", "phc_k")
            .unwrap_err();
        assert_eq!(err.code, "channel_limit_reached", "ChannelLimitReached 派生错误码");
        assert_eq!(state.config.lock().unwrap().channels.len(), 8, "第 9 个不落盘");
        for i in 1..=8 {
            let id = &state.config.lock().unwrap().channels[i - 1].id;
            mgr.remove_channel(id).unwrap();
        }
    }

    /// add_channel 缺 server（空配置且未传）→ invalid_url。
    #[tokio::test]
    async fn add_channel_requires_server() {
        let path = temp_path("noserver");
        let (state, _rx) = test_state(&path, Config::default());
        let mgr = empty_runner();
        let err = do_add_channel(&state, &mgr, None, "告警", "phc_k").unwrap_err();
        assert_eq!(err.code, "invalid_url");
    }

    /// update_channel：name/key 落盘 + 以新配置重 spawn（remove→spawn）。
    #[tokio::test]
    async fn update_channel_persists_and_respawns() {
        let path = temp_path("update");
        let (state, _rx) = test_state(
            &path,
            Config {
                server: "http://s".to_string(),
                channels: vec![channel_cfg("ch1")],
                ..Default::default()
            },
        );
        let mgr = empty_runner();
        mgr.spawn_channel(&channel_cfg("ch1")).unwrap();

        do_update_channel(
            &state,
            &mgr,
            "ch1",
            Some("新名字".to_string()),
            Some("phc_new".to_string()),
        )
        .unwrap();
        {
            let cfg = state.config.lock().unwrap();
            assert_eq!(cfg.channels[0].name, "新名字");
            assert_eq!(cfg.channels[0].key, "phc_new");
        }
        assert_eq!(mgr.len(), 1, "remove→spawn 后句柄回表");
        assert_eq!(config::load_from(&path).channels[0].key, "phc_new");
        mgr.remove_channel("ch1").unwrap();
        // 未知频道。
        assert_eq!(
            do_update_channel(&state, &mgr, "ghost", None, None)
                .unwrap_err()
                .code,
            "channel_not_found"
        );
    }

    /// remove_channel：Destroy + 落盘移除。
    #[tokio::test]
    async fn remove_channel_persists() {
        let path = temp_path("remove");
        let (state, _rx) = test_state(
            &path,
            Config {
                server: "http://s".to_string(),
                channels: vec![channel_cfg("ch1")],
                ..Default::default()
            },
        );
        let mgr = empty_runner();
        mgr.spawn_channel(&channel_cfg("ch1")).unwrap();
        do_remove_channel(&state, &mgr, "ch1").unwrap();
        assert_eq!(mgr.len(), 0);
        assert!(state.config.lock().unwrap().channels.is_empty());
        assert!(config::load_from(&path).channels.is_empty(), "落盘移除");
    }

    /// set_display_name：设置/清除/超限（BY_MAX 预检不截断）。
    #[tokio::test]
    async fn set_display_name_set_clear_limit() {
        let path = temp_path("name");
        let (state, _rx) = test_state(&path, Config::default());
        do_set_display_name(&state, Some("Windows 笔电".to_string())).unwrap();
        assert_eq!(
            state.config.lock().unwrap().display_name.as_deref(),
            Some("Windows 笔电")
        );
        // 空串视为清除。
        do_set_display_name(&state, Some("   ".to_string())).unwrap();
        assert_eq!(state.config.lock().unwrap().display_name, None);
        // 超限拒绝（65 字）。
        let err = do_set_display_name(&state, Some("名".repeat(BY_MAX + 1))).unwrap_err();
        assert_eq!(err.code, "limit_exceeded");
        // 落盘往返。
        do_set_display_name(&state, Some("笔电".to_string())).unwrap();
        assert_eq!(
            config::load_from(&path).display_name.as_deref(),
            Some("笔电")
        );
    }

    /// toggle_dnd：落盘 + 通知线程收到 SetDnd（双写一致性）。
    #[tokio::test]
    async fn toggle_dnd_persists_and_notifies_thread() {
        let path = temp_path("dnd");
        let (state, rx) = test_state(&path, Config::default());
        do_toggle_dnd(&state, true).unwrap();
        assert!(state.config.lock().unwrap().dnd);
        assert_eq!(rx.try_recv(), Ok(NotifyCmd::SetDnd(true)));
        assert!(config::load_from(&path).dnd, "落盘");
        do_toggle_dnd(&state, false).unwrap();
        assert!(!state.config.lock().unwrap().dnd);
        assert_eq!(rx.try_recv(), Ok(NotifyCmd::SetDnd(false)));
    }

    /// set_channel_muted：落盘；静音只影响通知不影响连接（频道保持 spawn）。
    #[tokio::test]
    async fn set_channel_muted_persists() {
        let path = temp_path("mute");
        let (state, _rx) = test_state(
            &path,
            Config {
                server: "http://s".to_string(),
                channels: vec![channel_cfg("ch1")],
                ..Default::default()
            },
        );
        let mgr = empty_runner();
        mgr.spawn_channel(&channel_cfg("ch1")).unwrap();
        do_set_channel_muted(&state, "ch1", true).unwrap();
        assert!(state.config.lock().unwrap().channels[0].muted);
        assert_eq!(mgr.len(), 1, "静音不断连——频道照常");
        assert!(config::load_from(&path).channels[0].muted);
        assert_eq!(
            do_set_channel_muted(&state, "ghost", true).unwrap_err().code,
            "channel_not_found"
        );
        mgr.remove_channel("ch1").unwrap();
    }

    /// mark_first_close_hint：置位 + 落盘（幂等）。
    #[tokio::test]
    async fn mark_first_close_hint_persists() {
        let path = temp_path("hint");
        let (state, _rx) = test_state(&path, Config::default());
        do_mark_first_close_hint(&state).unwrap();
        assert!(state.config.lock().unwrap().first_close_hint_shown);
        assert!(config::load_from(&path).first_close_hint_shown);
        do_mark_first_close_hint(&state).unwrap(); // 幂等
    }

    /// set_current_channel：焦点状态更新（决策矩阵输入预留通道）。
    #[test]
    fn set_current_channel_updates_focus() {
        let path = temp_path("focus");
        let (state, _rx) = test_state(&path, Config::default());
        do_set_current_channel(&state, Some("ch1".to_string()));
        assert_eq!(
            state.focus.lock().unwrap().current_channel.as_deref(),
            Some("ch1")
        );
        do_set_current_channel(&state, None);
        assert_eq!(state.focus.lock().unwrap().current_channel, None);
    }

    // ---- test_connection ----

    /// 超时常量断言（约 5 秒量级——验收口径）。
    #[test]
    fn test_connection_timeout_is_5s() {
        assert_eq!(TEST_CONNECTION_TIMEOUT, Duration::from_secs(5));
    }

    /// 畸形 server 地址 → invalid_url（与 adapter WsFail 同一分类语义）。
    #[tokio::test]
    async fn test_connection_invalid_url_rejected() {
        let err = probe_connection("not a url", "k").await.unwrap_err();
        assert_eq!(err.code, "invalid_url");
        // 错误文案不回显输入（含密钥的 URL 绝不进错误载荷）。
        assert!(!err.message.contains('k'));
    }

    /// 网络不可达分类：回环死端口（连接拒绝即 Io 错误）→ unreachable。
    #[tokio::test]
    async fn test_connection_unreachable_classified() {
        let err = probe_connection("http://127.0.0.1:1", "k")
            .await
            .unwrap_err();
        assert_eq!(err.code, "unreachable");
    }
}

