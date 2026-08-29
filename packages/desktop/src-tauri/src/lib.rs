/**
 * PushHub Desktop 应用装配（05-01 Task 3 tracer，D-59/D-60/D-75）。
 *
 * 架构：WS 连接生命周期归 Rust 进程持有（tokio-tungstenite + 纯状态机），
 * 前端 WebView 是纯展示层——关窗不断线。setup 启动时读配置（config::load），
 * 对每个频道 spawn 独立 adapter::run_channel（就绪即连，D-64 多频道多任务）；
 * 无配置时仅起前端窗口。
 *
 * 前端就绪信号（ph://frontend-ready 事件，watch 通道跨线程传递）：Rust 握手
 * 快于 WebView 加载时，emit 在前端 listen 注册前即丢失（首帧 status 事件竞态）
 * ——run_channel 等待该信号后才 Connect；超时 5s 兜底无前端场景。
 */
mod adapter;
mod buffer;
mod config;
mod machine;
mod protocol;

use tauri::{Listener, Manager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // 第二实例回调：显示并聚焦已有主窗口（防双开标准行为）。
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .setup(|app| {
            let cfg = config::load();
            if !cfg.server.is_empty() {
                let (ready_tx, ready_rx) = tokio::sync::watch::channel(false);
                let tx = ready_tx.clone();
                app.listen("ph://frontend-ready", move |_event| {
                    let _ = tx.send(true);
                });
                for channel in cfg.channels {
                    let handle = app.handle().clone();
                    let server = cfg.server.clone();
                    let ready = ready_rx.clone();
                    tauri::async_runtime::spawn(adapter::run_channel(
                        handle, channel, server, ready,
                    ));
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
