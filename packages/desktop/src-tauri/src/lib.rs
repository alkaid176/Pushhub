/**
 * PushHub Desktop 应用装配（05-01 tracer → 05-04 就绪即连装配，D-59/D-60/D-64）。
 *
 * 架构：WS 连接生命周期归 Rust 进程持有（tokio-tungstenite + 纯状态机），
 * 前端 WebView 是纯展示层——关窗不断线。setup 启动时读配置（config::load），
 * 构造 ChannelManager 并逐频道 spawn（就绪即连，D-60；每频道独立任务/状态机/
 * 缓冲，D-64）；无配置时仅起前端窗口。manager 注册为 Tauri State（05-05
 * commands / 05-06 UI 消费面）。
 *
 * 前端就绪信号（ph://frontend-ready 事件，watch 通道跨线程传递）：Rust 握手
 * 快于 WebView 加载时，emit 在前端 listen 注册前即丢失（首帧 status 事件竞态）
 * ——run_channel 等待该信号后才 Connect；超时 5s 兜底无前端场景。
 *
 * 应用退出：RunEvent::Exit 逐频道下发 Destroy（CloseSocket manual + 终态
 * 收敛；close 帧尽力而为——进程退出窗口内不保证送达）。
 */
mod adapter;
mod buffer;
mod config;
mod machine;
mod protocol;

use std::sync::Arc;

use tauri::{Listener, Manager};

use adapter::manager::{production_runner, ChannelManager};
use adapter::RealtimeMessage;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // 第二实例回调：显示并聚焦已有主窗口（防双开标准行为）。
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .setup(|app| {
            let cfg = config::load();
            // 通知钩子占位：两流分离语义已由 05-04 双计数器测试锁定；
            // 05-05 在此接线真实通知线程（winrt-toast 按频道分组）。
            let notify_hook: Arc<dyn Fn(RealtimeMessage) + Send + Sync> = Arc::new(|_msg| {});
            let manager = ChannelManager::new(
                cfg.server.clone(),
                notify_hook,
                production_runner(app.handle().clone()),
            );
            // 就绪即连（D-60）：逐频道 spawn（空 server/无频道 → 仅起窗口）。
            // 重复/超限频道跳过（错误面含频道 id——用户标签，不含密钥）。
            if !cfg.server.is_empty() {
                for channel in &cfg.channels {
                    if let Err(reason) = manager.spawn_channel(channel) {
                        eprintln!("pushhub: channel skipped: {reason:?}");
                    }
                }
            }
            // 前端就绪门：listen 注册先于 run_channel 的 Connect（其内部等待
            // 信号，watch retain 值无竞态——05-01 决策 #3）。
            let ready_tx = manager.ready_tx();
            app.listen("ph://frontend-ready", move |_event| {
                let _ = ready_tx.send(true);
            });
            // manager 入 Tauri State（05-05 commands / 05-06 UI 消费面）。
            app.manage(manager);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");
    app.run(|app, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            if let Some(manager) = app.try_state::<ChannelManager>() {
                manager.destroy_all();
            }
        }
    });
}
