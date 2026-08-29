/**
 * PushHub Desktop 应用装配（05-01 tracer → 05-05 完整装配，D-59/D-60/D-64/
 * D-74/WIN-01）。
 *
 * 架构：WS 连接生命周期归 Rust 进程持有（tokio-tungstenite + 纯状态机），
 * 前端 WebView 是纯展示层——关窗不断线（唯一退出路径是托盘菜单的退出项，
 * CloseRequested 被拦截为隐藏到托盘 + 首次一次性提示 D-71）。
 *
 * setup 装配序：load config → 通知线程（!Send ToastManager 专用 OS 线程，
 * mpsc 命令）→ 共享 AppState（config/focus/notify_tx）→ ChannelManager
 * 就绪即连（D-60：逐频道 spawn，空配置仅起窗口/向导）→ 托盘三项菜单 +
 * tooltip 状态订阅 → 前端就绪门。窗口显隐（托盘左键/关窗拦截/第二实例）
 * 统一经 show/hide_main_window 翻译为各频道 Visibility 事件（A8/D-27：
 * 隐藏取消心跳省额度、显示探活加速——连接保持不断）。
 *
 * 前端就绪信号（ph://frontend-ready 事件，watch 通道跨线程传递）：Rust 握手
 * 快于 WebView 加载时，emit 在前端 listen 注册前即丢失（首帧 status 事件
 * 竞态）——run_channel 等待该信号后才 Connect；超时 5s 兜底无前端场景。
 *
 * 应用退出：RunEvent::Exit 逐频道下发 Destroy（CloseSocket manual + 终态
 * 收敛；close 帧尽力而为——进程退出窗口内不保证送达）。
 */
mod adapter;
mod buffer;
mod commands;
mod config;
mod machine;
mod notify;
mod protocol;
mod tray;

use std::sync::{Arc, Mutex};

use tauri::{Emitter, Listener, Manager};

use adapter::manager::{production_runner, ChannelManager};
use adapter::RealtimeMessage;
use commands::UiFocusState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // 第二实例回调：显示并聚焦已有主窗口（防双开标准行为）+ Visibility 注入。
            show_main_window(app);
        }))
        .invoke_handler(tauri::generate_handler![
            commands::reply,
            commands::channel_snapshot,
            commands::test_connection,
            commands::add_channel,
            commands::update_channel,
            commands::remove_channel,
            commands::set_display_name,
            commands::toggle_dnd,
            commands::set_channel_muted,
            commands::mark_first_close_hint,
            commands::get_config,
            commands::set_current_channel,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // WIN-01/SC1：关窗 ≠ 退出——拦截默认关闭，隐藏到托盘；
                // 唯一退出路径是托盘菜单的退出项（tray quit → app.exit）。
                api.prevent_close();
                let app = window.app_handle();
                hide_main_window(app);
                // D-71 首次关闭一次性提示：未展示过 → 通知前端（提示 UI 归
                // 05-06 渲染；前端确认后调 mark_first_close_hint 置位，此后
                // 不再弹——Rust 侧只保证事件与持久化通道）。
                if let Some(state) = app.try_state::<commands::AppState>() {
                    if !state.config.lock().unwrap().first_close_hint_shown {
                        let _ = app.emit("ph://first-close-hint", ());
                    }
                }
            }
        })
        .setup(|app| {
            let cfg = config::load();

            // ---- 通知线程（05-03 Pattern：!Send ToastManager 专用 OS 线程）----
            let (notify_tx, notify_rx) = std::sync::mpsc::channel::<notify::NotifyCmd>();
            notify::spawn_notify_thread(app.handle().clone(), notify_rx);
            if cfg.dnd {
                // 线程内 should_suppress（D-70）是独立防线——启动时与配置对齐。
                let _ = notify_tx.send(notify::NotifyCmd::SetDnd(true));
            }

            // ---- 共享状态（commands/托盘/通知钩子同一数据源，无快照漂移）----
            let shared_cfg = Arc::new(Mutex::new(cfg.clone()));
            app.manage(commands::AppState {
                config: Arc::clone(&shared_cfg),
                path: config::config_path_or_default(),
                notify_tx,
                focus: Arc::new(Mutex::new(UiFocusState::default())),
            });

            // ---- ChannelManager：就绪即连（D-60/D-64）----
            // 通知钩子占位 no-op：两流分离语义已由 05-04 双计数器测试锁定；
            // Task 3 在此接线真实决策矩阵（WINDOWS.md #10 追踪）。
            let notify_hook: Arc<dyn Fn(RealtimeMessage) + Send + Sync> = Arc::new(|_msg| {});
            let manager = ChannelManager::new(
                cfg.server.clone(),
                notify_hook,
                production_runner(app.handle().clone()),
            );
            // 逐频道 spawn（空 server/无频道 → 仅起窗口）；重复/超限频道跳过
            //（错误面含频道 id——用户标签，不含密钥）。
            if !cfg.server.is_empty() {
                for channel in &cfg.channels {
                    if let Err(reason) = manager.spawn_channel(channel) {
                        eprintln!("pushhub: channel skipped: {reason:?}");
                    }
                }
            }
            let ready_tx = manager.ready_tx();
            app.manage(manager);

            // ---- 托盘（三项菜单 + 左键显隐 + tooltip 状态汇总，D-74）----
            tray::build_tray(app.handle())?;
            // tooltip 事件驱动刷新：每频道 EmitStatus 都 emit ph://status
            //——聚合重算无需额外通知通道。
            let app_for_status = app.handle().clone();
            app.listen("ph://status", move |_| tray::update_tooltip(&app_for_status));

            // ---- 前端就绪门（listen 注册先于 run_channel 的 Connect）----
            app.listen("ph://frontend-ready", move |_event| {
                let _ = ready_tx.send(true);
            });
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

/// 主窗口显示（托盘 show/左键切换/第二实例/通知点击定位共用）：
/// show + set_focus + 逐频道 Visibility{true} 注入（A8/D-27 桌面映射：
/// 探活加速、心跳恢复——连接保持不断）。
fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
    if let Some(manager) = app.try_state::<ChannelManager>() {
        manager.set_visibility(true);
    }
}

/// 主窗口隐藏（关窗拦截/托盘左键切换共用）：hide + Visibility{false} 注入
///（取消心跳省额度——连接保持不断，D-60 关窗零依赖）。
fn hide_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
    if let Some(manager) = app.try_state::<ChannelManager>() {
        manager.set_visibility(false);
    }
}
