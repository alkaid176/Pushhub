/**
 * PushHub Desktop 应用装配（05-01 Task 2 脚手架；Task 3 填充 setup 连接装配）。
 *
 * 架构（D-59/D-60/D-75）：WS 连接生命周期归 Rust 进程持有（tokio-tungstenite +
 * 纯状态机），前端 WebView 是纯展示层——关窗不断线。Task 3 的 setup 钩子将启动
 * 时读配置（config::load），对每个频道 spawn 独立 adapter::run_channel 任务
 * （就绪即连，窗口后开——D-60）。
 */
use tauri::Manager;

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
        .setup(|_app| Ok(()))
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
