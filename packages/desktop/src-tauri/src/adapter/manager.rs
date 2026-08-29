//! ChannelManager —— 多频道生命周期管理（05-04 Task 3，D-64/D-65）。
//!
//! 结构决策（D-64 costly）：每频道独立 tokio 任务 + 独立状态机 + 独立缓冲 +
//! 独立通知分组——单频道断连/重启不影响其他频道。本类型只做生命周期控制面：
//! spawn/remove/restart/状态聚合/snapshot；连接语义全部在 run_channel 内。
//!
//! 测试切面：频道任务经 ChannelRunner 工厂注入（生产 production_runner 包装
//! run_channel；测试以假任务验证生命周期/上限/聚合语义——不建真连接）。
//!
//! 并发模型：所有方法 &self + 内部 Mutex（Tauri State 要求 Send+Sync）；
//! remove/destroy 的任务收敛等待为 detach 有界等待（不阻塞调用方——逻辑删除
//! 随句柄出表即时完成，close 帧由频道任务自行送达）。

// 公开 API 消费者标注（05-02 同款策略，取模块级——本模块的生产消费面即
// 模块边界）：spawn_channel/ready_tx/destroy_all 已由 lib.rs 消费；remove/
// restart/set_visibility/statuses/snapshot/len 的生产消费者是 05-05 commands
// 与 05-06 UI（生命周期与聚合语义已由本模块测试锁定）。
#![allow(dead_code)]

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::mpsc::{self, UnboundedReceiver, UnboundedSender};
use tokio::sync::watch;

use crate::buffer::{Buffer, BufferSnapshot};
use crate::config::ChannelConfig;
use crate::machine::{Event, Status};

use super::RealtimeMessage;

/// 频道数上限（D-65——对齐管理页 Send Key 上限 10 的量级；第 9 个 add 返回
/// ChannelLimitReached，05-05 config 命令与 05-06 UI 均以本常量为准）。
pub const MAX_CHANNELS: usize = 8;

/// manager 错误面（05-05 命令层透传前端）。
#[derive(Debug, Clone, PartialEq)]
pub enum ManagerError {
    /// 频道 id 已存在（spawn 拒绝）。
    DuplicateChannel(String),
    /// 超出 MAX_CHANNELS 上限（D-65）。
    ChannelLimitReached,
    /// 频道不存在（remove/restart/snapshot 未命中）。
    ChannelNotFound(String),
}

/// 频道任务装配参数（ChannelRunner 的注入契约——app 句柄由生产 runner
/// 闭包持有，manager 与测试均不触碰 Tauri 类型）。
pub struct SpawnInputs {
    pub config: ChannelConfig,
    pub server: String,
    pub ready: watch::Receiver<bool>,
    pub notify_hook: Box<dyn Fn(RealtimeMessage) + Send>,
    pub buffer: Arc<Mutex<Buffer>>,
    pub status: Arc<Mutex<Status>>,
    pub control: UnboundedReceiver<Event>,
    /// 出站直发帧入口（reply 等非机器帧，05-05 commands::reply 经
    /// manager.send_raw 写入——run_channel 转发进主循环直发 writer）。
    pub outbox: UnboundedReceiver<String>,
}

/// 频道任务工厂（测试切面：注入假任务验证生命周期/聚合语义）。
pub type ChannelRunner =
    Arc<dyn Fn(SpawnInputs) -> tauri::async_runtime::JoinHandle<()> + Send + Sync>;

/// 生产 runner：run_channel 包装（app 句柄闭包捕获；tauri 异步运行时 spawn）。
pub fn production_runner(app: tauri::AppHandle) -> ChannelRunner {
    Arc::new(move |p: SpawnInputs| {
        tauri::async_runtime::spawn(super::run_channel(
            app.clone(),
            p.config,
            p.server,
            p.ready,
            p.notify_hook,
            p.buffer,
            p.status,
            p.control,
            p.outbox,
        ))
    })
}

/// 单频道句柄（manager 表项）。
struct ChannelHandle {
    /// 频道配置（restart_channel 重 spawn 数据源）。
    config: ChannelConfig,
    /// 生命周期/显隐控制端（Destroy/Visibility 等机器事件下发）。
    control: UnboundedSender<Event>,
    /// 出站直发帧通道（reply 等非机器帧——send_raw 写入端）。
    outbox: UnboundedSender<String>,
    /// 每频道环形缓冲（D-62；snapshot 数据源——remove 后随句柄丢弃）。
    buffer: Arc<Mutex<Buffer>>,
    /// 状态共享单元（run_channel EmitStatus 写 / statuses() 读）。
    status: Arc<Mutex<Status>>,
    /// 频道任务句柄（remove/destroy 的收敛等待点）。
    join: tauri::async_runtime::JoinHandle<()>,
}

/// 多频道管理器（Tauri State 注册；05-05 commands / 05-06 UI 消费面）。
pub struct ChannelManager {
    /// 服务端地址（向导首配经 set_server 更新——spawn 时读取；Mutex 因
    /// set_server 与 spawn_channel 并发调用）。
    server: Mutex<String>,
    /// 通知钩子（统一构造注入各频道——两流分离不变量在 run_channel 分派层）。
    notify_hook: Arc<dyn Fn(RealtimeMessage) + Send + Sync>,
    /// 频道任务工厂（测试注入假任务）。
    runner: ChannelRunner,
    /// 前端就绪信号（05-01 就绪门：所有频道共享同一信号源）。
    ready_tx: watch::Sender<bool>,
    channels: Mutex<HashMap<String, ChannelHandle>>,
}

impl ChannelManager {
    pub fn new(
        server: String,
        notify_hook: Arc<dyn Fn(RealtimeMessage) + Send + Sync>,
        runner: ChannelRunner,
    ) -> Self {
        let (ready_tx, _) = watch::channel(false);
        Self {
            server: Mutex::new(server),
            notify_hook,
            runner,
            ready_tx,
            channels: Mutex::new(HashMap::new()),
        }
    }

    /// 更新服务端地址（向导首配场景：server + 第一个频道一起落；后续
    /// spawn 以此为连接基址——05-05 commands::add_channel 调用）。
    pub fn set_server(&self, server: String) {
        *self.server.lock().unwrap() = server;
    }

    /// 前端就绪信号发送端（lib.rs listen ph://frontend-ready 接线用）。
    pub fn ready_tx(&self) -> watch::Sender<bool> {
        self.ready_tx.clone()
    }

    /// 当前频道数（UI 上限提示数据源）。
    pub fn len(&self) -> usize {
        self.channels.lock().unwrap().len()
    }

    /// 空态判断（05-06 UI 消费；与 len() 成对）。
    #[allow(dead_code)]
    pub fn is_empty(&self) -> bool {
        self.channels.lock().unwrap().is_empty()
    }

    /// 新增频道并启动任务（重复 id 拒绝；超 MAX_CHANNELS 拒绝，D-65）。
    pub fn spawn_channel(&self, config: &ChannelConfig) -> Result<(), ManagerError> {
        let mut channels = self.channels.lock().unwrap();
        if channels.contains_key(&config.id) {
            return Err(ManagerError::DuplicateChannel(config.id.clone()));
        }
        if channels.len() >= MAX_CHANNELS {
            return Err(ManagerError::ChannelLimitReached);
        }
        let (control_tx, control_rx) = mpsc::unbounded_channel::<Event>();
        let (outbox_tx, outbox_rx) = mpsc::unbounded_channel::<String>();
        let buffer = Arc::new(Mutex::new(Buffer::new()));
        let status = Arc::new(Mutex::new(Status::Offline));
        let shared_hook = Arc::clone(&self.notify_hook);
        let notify_hook = Box::new(move |m: RealtimeMessage| shared_hook(m));
        let join = (self.runner)(SpawnInputs {
            config: config.clone(),
            server: self.server.lock().unwrap().clone(),
            ready: self.ready_tx.subscribe(),
            notify_hook,
            buffer: Arc::clone(&buffer),
            status: Arc::clone(&status),
            control: control_rx,
            outbox: outbox_rx,
        });
        channels.insert(
            config.id.clone(),
            ChannelHandle {
                config: config.clone(),
                control: control_tx,
                outbox: outbox_tx,
                buffer,
                status,
                join,
            },
        );
        Ok(())
    }

    /// 移除频道：发 Destroy（频道任务 closeSocket(manual) + 终态收敛）+ 句柄
    /// 出表（snapshot/statuses 即时不可见；缓冲随之丢弃）。任务收敛为 detach
    /// 有界等待（2s）——不阻塞调用方（Tauri 命令层任意上下文安全）。
    pub fn remove_channel(&self, id: &str) -> Result<(), ManagerError> {
        let handle = self.take_handle(id)?;
        let _ = handle.control.send(Event::Destroy);
        tauri::async_runtime::spawn(async move {
            let _ = tokio::time::timeout(Duration::from_secs(2), handle.join).await;
        });
        Ok(())
    }

    /// 重启频道（配置修改用）：remove + 以原配置重新 spawn。
    pub fn restart_channel(&self, id: &str) -> Result<(), ManagerError> {
        let config = {
            let channels = self.channels.lock().unwrap();
            channels
                .get(id)
                .map(|h| h.config.clone())
                .ok_or_else(|| ManagerError::ChannelNotFound(id.to_string()))?
        };
        self.remove_channel(id)?;
        self.spawn_channel(&config)
    }

    /// 窗口显隐广播（A8/D-27）：逐频道注入 Visibility 事件（连接保持，仅
    /// 心跳/探活策略切换）。05-05 的 lib.rs 接 window 事件后调用本方法。
    pub fn set_visibility(&self, visible: bool) {
        let channels = self.channels.lock().unwrap();
        for handle in channels.values() {
            let _ = handle.control.send(Event::Visibility { visible });
        }
    }

    /// 单频道状态查询（05-05 commands::reply 的在线 fail-fast 数据源；
    /// 频道不存在返回 None）。
    pub fn channel_status(&self, id: &str) -> Option<Status> {
        let channels = self.channels.lock().unwrap();
        channels.get(id).map(|h| *h.status.lock().unwrap())
    }

    /// 出站直发帧（reply 等非机器帧，WEB-03 Pattern 7）：写入频道的 outbox
    /// 通道，由频道任务直发 writer（不经状态机词汇表）。频道不存在返回
    /// ChannelNotFound；频道任务已停机的窄窗竞态由发送端静默容忍（上层
    /// 已按 status==Online fail-fast）。
    pub fn send_raw(&self, id: &str, text: String) -> Result<(), ManagerError> {
        let channels = self.channels.lock().unwrap();
        match channels.get(id) {
            Some(handle) => {
                let _ = handle.outbox.send(text);
                Ok(())
            }
            None => Err(ManagerError::ChannelNotFound(id.to_string())),
        }
    }

    /// 状态聚合（托盘 tooltip 数据源；按 channel_id 排序稳定输出）。
    pub fn statuses(&self) -> Vec<(String, Status)> {
        let channels = self.channels.lock().unwrap();
        let mut out: Vec<(String, Status)> = channels
            .iter()
            .map(|(id, h)| (id.clone(), *h.status.lock().unwrap()))
            .collect();
        out.sort_by(|a, b| a.0.cmp(&b.0));
        out
    }

    /// 频道缓冲快照（窗口重开全量重建数据源，D-60；频道不存在返回 None）。
    pub fn snapshot(&self, id: &str) -> Option<BufferSnapshot> {
        let channels = self.channels.lock().unwrap();
        channels
            .get(id)
            .map(|h| h.buffer.lock().unwrap().snapshot())
    }

    /// 全部频道停机（应用退出路径：逐频道 Destroy；close 帧尽力而为——
    /// 进程退出窗口内不保证送达）。
    pub fn destroy_all(&self) {
        let drained: Vec<ChannelHandle> = {
            let mut channels = self.channels.lock().unwrap();
            channels.drain().map(|(_, h)| h).collect()
        };
        for handle in drained {
            let _ = handle.control.send(Event::Destroy);
            tauri::async_runtime::spawn(async move {
                let _ = tokio::time::timeout(Duration::from_secs(2), handle.join).await;
            });
        }
    }

    /// 句柄出表（remove/destroy 共用——出表即逻辑删除完成）。
    fn take_handle(&self, id: &str) -> Result<ChannelHandle, ManagerError> {
        let mut channels = self.channels.lock().unwrap();
        channels
            .remove(id)
            .ok_or_else(|| ManagerError::ChannelNotFound(id.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(id: &str) -> ChannelConfig {
        ChannelConfig {
            id: id.to_string(),
            name: format!("n-{id}"),
            key: format!("phc_{id}"),
            muted: false,
        }
    }

    /// 假 runner：模拟上线（状态单元写 Online）+ 控制面事件记录 + Destroy
    /// 收敛退出（exited 标志供任务真实退出的有界轮询断言）。
    fn fake_runner(
        seen: Arc<Mutex<Vec<(String, Event)>>>,
        exited: Arc<Mutex<Vec<String>>>,
    ) -> ChannelRunner {
        Arc::new(move |p: SpawnInputs| {
            let seen = Arc::clone(&seen);
            let exited = Arc::clone(&exited);
            let SpawnInputs {
                config, status, mut control, ..
            } = p;
            let id = config.id.clone();
            tauri::async_runtime::spawn(async move {
                // 模拟 EmitStatus(Online) 的共享单元写入（真实路径在
                // run_channel 分派层，adapter 测试已锁定）。
                *status.lock().unwrap() = Status::Online;
                while let Some(event) = control.recv().await {
                    let destroy = matches!(event, Event::Destroy);
                    seen.lock().unwrap().push((id.clone(), event));
                    if destroy {
                        break;
                    }
                }
                exited.lock().unwrap().push(id);
            })
        })
    }

    fn manager_with(runner: ChannelRunner) -> ChannelManager {
        ChannelManager::new(
            "http://127.0.0.1:4911".to_string(),
            Arc::new(|_m: RealtimeMessage| {}),
            runner,
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

    /// MAX_CHANNELS 常量（D-65）。
    #[test]
    fn max_channels_constant_is_8() {
        assert_eq!(MAX_CHANNELS, 8);
    }

    /// 上限边界：第 8 个允许、第 9 个拒绝（ChannelLimitReached）。
    #[tokio::test]
    async fn max_channels_boundary_8_ok_9_rejected() {
        let mgr = manager_with(fake_runner(
            Arc::new(Mutex::new(vec![])),
            Arc::new(Mutex::new(vec![])),
        ));
        for i in 1..=8 {
            assert!(
                mgr.spawn_channel(&cfg(&format!("ch{i}"))).is_ok(),
                "第 {i} 个频道应允许（上限 8）"
            );
        }
        assert_eq!(
            mgr.spawn_channel(&cfg("ch9")).unwrap_err(),
            ManagerError::ChannelLimitReached,
            "第 9 个频道必须拒绝（D-65）"
        );
    }

    /// 重复 id 拒绝。
    #[tokio::test]
    async fn duplicate_channel_id_rejected() {
        let mgr = manager_with(fake_runner(
            Arc::new(Mutex::new(vec![])),
            Arc::new(Mutex::new(vec![])),
        ));
        assert!(mgr.spawn_channel(&cfg("ch1")).is_ok());
        assert_eq!(
            mgr.spawn_channel(&cfg("ch1")).unwrap_err(),
            ManagerError::DuplicateChannel("ch1".to_string())
        );
        assert_eq!(mgr.len(), 1);
    }

    /// remove：句柄出表（snapshot None / statuses 空）+ 任务真实退出（有界
    /// 轮询 exited 标志）。
    #[tokio::test]
    async fn remove_channel_snapshot_none_and_task_exits() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let exited = Arc::new(Mutex::new(Vec::new()));
        let mgr = manager_with(fake_runner(Arc::clone(&seen), Arc::clone(&exited)));
        mgr.spawn_channel(&cfg("ch1")).unwrap();
        assert!(mgr.snapshot("ch1").is_some());

        mgr.remove_channel("ch1").unwrap();
        assert!(
            mgr.snapshot("ch1").is_none(),
            "remove 后缓冲随句柄丢弃"
        );
        assert!(mgr.statuses().is_empty());
        // Destroy 已下发且任务收敛退出。
        soon(|| !exited.lock().unwrap().is_empty()).await;
        let events = seen.lock().unwrap();
        assert!(events
            .iter()
            .any(|(id, e)| id == "ch1" && matches!(e, Event::Destroy)));
    }

    /// remove 未知频道：ChannelNotFound。
    #[tokio::test]
    async fn remove_unknown_channel_not_found() {
        let mgr = manager_with(fake_runner(
            Arc::new(Mutex::new(vec![])),
            Arc::new(Mutex::new(vec![])),
        ));
        assert_eq!(
            mgr.remove_channel("ghost").unwrap_err(),
            ManagerError::ChannelNotFound("ghost".to_string())
        );
    }

    /// statuses 聚合：假任务上线后按 id 排序聚合（托盘数据源语义）。
    #[tokio::test]
    async fn statuses_aggregate_from_cells() {
        let mgr = manager_with(fake_runner(
            Arc::new(Mutex::new(vec![])),
            Arc::new(Mutex::new(vec![])),
        ));
        mgr.spawn_channel(&cfg("ch2")).unwrap();
        mgr.spawn_channel(&cfg("ch1")).unwrap();
        // 轮询真实断言条件（两频道均 Online）——句柄入表是同步的、假任务
        // 写状态单元是异步的，len 条件会过早通过。
        soon(|| {
            let s = mgr.statuses();
            s.len() == 2 && s.iter().all(|(_, st)| *st == Status::Online)
        })
        .await;
        assert_eq!(
            mgr.statuses(),
            vec![
                ("ch1".to_string(), Status::Online),
                ("ch2".to_string(), Status::Online),
            ],
            "聚合自共享状态单元且按 id 排序"
        );
    }

    /// 显隐广播：两频道都收到 Visibility 事件。
    #[tokio::test]
    async fn visibility_broadcasts_to_all_channels() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let mgr = manager_with(fake_runner(Arc::clone(&seen), Arc::new(Mutex::new(Vec::new()))));
        mgr.spawn_channel(&cfg("ch1")).unwrap();
        mgr.spawn_channel(&cfg("ch2")).unwrap();
        mgr.set_visibility(true);
        soon(|| seen.lock().unwrap().len() == 2).await;
        let events = seen.lock().unwrap();
        assert!(events.iter().all(|(_, e)| matches!(
            e,
            Event::Visibility { visible: true }
        )));
    }

    /// restart：以原配置重新 spawn（句柄回表、snapshot 恢复可见）。
    #[tokio::test]
    async fn restart_channel_respawns_with_same_config() {
        let mgr = manager_with(fake_runner(
            Arc::new(Mutex::new(vec![])),
            Arc::new(Mutex::new(vec![])),
        ));
        mgr.spawn_channel(&cfg("ch1")).unwrap();
        soon(|| mgr.statuses().len() == 1).await;
        mgr.restart_channel("ch1").unwrap();
        assert!(mgr.snapshot("ch1").is_some(), "restart 后句柄回表");
        soon(|| mgr.statuses().len() == 1).await;
        assert_eq!(mgr.len(), 1);
    }

    /// set_server：更新后新 spawn 的频道以新地址连接（SpawnInputs.server 记录）。
    #[tokio::test]
    async fn set_server_updates_spawn_base_url() {
        let servers = Arc::new(Mutex::new(Vec::new()));
        let seen = Arc::clone(&servers);
        let runner: ChannelRunner = Arc::new(move |p: SpawnInputs| {
            let server = p.server.clone();
            let seen = Arc::clone(&seen);
            let mut control = p.control;
            tauri::async_runtime::spawn(async move {
                seen.lock().unwrap().push(server);
                while let Some(event) = control.recv().await {
                    if matches!(event, Event::Destroy) {
                        break;
                    }
                }
            })
        });
        let mgr = ChannelManager::new(
            "http://old".to_string(),
            Arc::new(|_m: RealtimeMessage| {}),
            runner,
        );
        mgr.spawn_channel(&cfg("ch1")).unwrap();
        mgr.set_server("https://pushhub.dyun.org".to_string());
        mgr.spawn_channel(&cfg("ch2")).unwrap();
        mgr.remove_channel("ch1").unwrap();
        mgr.remove_channel("ch2").unwrap();
        // 假任务异步记录 SpawnInputs.server——有界轮询到两条再断言顺序。
        soon(|| servers.lock().unwrap().len() == 2).await;
        assert_eq!(
            *servers.lock().unwrap(),
            vec!["http://old".to_string(), "https://pushhub.dyun.org".to_string()],
            "set_server 后续 spawn 以新地址为基址"
        );
    }

    /// send_raw：出站直发帧送达频道任务（outbox 接收端捕获）；未知频道
    /// ChannelNotFound。
    #[tokio::test]
    async fn send_raw_delivers_and_unknown_not_found() {
        let sent = Arc::new(Mutex::new(Vec::new()));
        let captured = Arc::clone(&sent);
        let runner: ChannelRunner = Arc::new(move |p: SpawnInputs| {
            let captured = Arc::clone(&captured);
            let mut control = p.control;
            let mut outbox = p.outbox;
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::select! {
                        ev = control.recv() => match ev {
                            Some(e) if matches!(e, Event::Destroy) => break,
                            Some(_) => {}
                            None => break,
                        },
                        t = outbox.recv() => {
                            if let Some(t) = t { captured.lock().unwrap().push(t); }
                        }
                    }
                }
            })
        });
        let mgr = ChannelManager::new(
            "http://s".to_string(),
            Arc::new(|_m: RealtimeMessage| {}),
            runner,
        );
        mgr.spawn_channel(&cfg("ch1")).unwrap();
        mgr.send_raw("ch1", r#"{"v":1,"type":"reply"}"#.to_string()).unwrap();
        soon(|| sent.lock().unwrap().len() == 1).await;
        assert_eq!(sent.lock().unwrap()[0], r#"{"v":1,"type":"reply"}"#);
        assert_eq!(
            mgr.send_raw("ghost", "x".to_string()).unwrap_err(),
            ManagerError::ChannelNotFound("ghost".to_string())
        );
        mgr.remove_channel("ch1").unwrap();
    }

    /// channel_status：假任务写 Online 后可查（reply fail-fast 数据源）。
    #[tokio::test]
    async fn channel_status_reads_shared_cell() {
        let mgr = manager_with(fake_runner(
            Arc::new(Mutex::new(vec![])),
            Arc::new(Mutex::new(vec![])),
        ));
        mgr.spawn_channel(&cfg("ch1")).unwrap();
        soon(|| mgr.channel_status("ch1") == Some(Status::Online)).await;
        assert_eq!(mgr.channel_status("ghost"), None);
    }
}
