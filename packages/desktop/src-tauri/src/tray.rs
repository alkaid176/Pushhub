//! 系统托盘（05-05 Task 2，D-74/WIN-01/SC1）。
//!
//! 菜单恰三项（D-74 精简裁决）：显示主窗口 / 全局勿扰（CheckItem，初始
//! 勾选态读 config.dnd）/ 退出——设置入口在主窗口内，不进托盘菜单。
//! 左键单击 = 主窗口显隐切换（show_menu_on_left_click(false)——左键留给
//! 显隐，菜单归右键；勿用已废弃的 menu_on_left_click）。
//!
//! tooltip 显示连接状态汇总（「PushHub — N 在线 / M 重连中」，两档口径：
//! Online 计在线、Connecting+Reconnecting 计重连中、Offline 不列），随
//! ph://status 事件驱动刷新（每频道 EmitStatus 都 emit 该事件——聚合重算
//! 无需额外通知通道）。
//!
//! 勿扰勾选与 commands::toggle_dnd 走同一内部实现（配置落盘 + 通知线程
//! SetDnd 双写）：config.dnd 是唯一事实源，勾选态显式 set_checked 对齐
//! （不依赖平台自动翻转行为的差异）。

use tauri::menu::{CheckMenuItem, Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};

use crate::commands::{self, AppState};
use crate::machine::Status;

/// 托盘句柄的 State 包装（set_tooltip 运行时更新用——A4：TrayIcon 句柄
/// 存 State，ph://status 事件驱动刷新）。
pub struct TrayHandle(pub tauri::tray::TrayIcon);

/// tooltip 汇总文案（D-74，纯函数）：「PushHub — N 在线 / M 重连中」。
pub fn tooltip_summary(statuses: &[(String, Status)]) -> String {
    let online = statuses
        .iter()
        .filter(|(_, s)| *s == Status::Online)
        .count();
    let reconnecting = statuses
        .iter()
        .filter(|(_, s)| matches!(s, Status::Connecting | Status::Reconnecting))
        .count();
    format!("PushHub — {online} 在线 / {reconnecting} 重连中")
}

/// tooltip 聚合刷新（lib.rs 的 ph://status 监听调用；也供显式刷新点复用）。
pub fn update_tooltip(app: &AppHandle) {
    let Some(tray) = app.try_state::<TrayHandle>() else {
        return;
    };
    let Some(manager) = app.try_state::<crate::adapter::manager::ChannelManager>() else {
        return;
    };
    let _ = tray.0.set_tooltip(Some(tooltip_summary(&manager.statuses())));
}

/// 构建托盘（lib.rs setup 调用；三件套：三项菜单 + 左键显隐 + tooltip）。
pub fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    // 初始勾选态读配置（D-70：托盘与设置面板双入口，同一数据源）。
    let dnd = app
        .try_state::<AppState>()
        .map(|s| s.config.lock().unwrap().dnd)
        .unwrap_or(false);
    let show = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
    let dnd_item = CheckMenuItem::with_id(app, "dnd", "全局勿扰", true, dnd, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &dnd_item, &quit])?;
    // 初始 tooltip：构建时刻的聚合快照（首帧 status 事件到达后即事件驱动刷新）。
    let initial_tooltip = app
        .try_state::<crate::adapter::manager::ChannelManager>()
        .map(|m| tooltip_summary(&m.statuses()))
        .unwrap_or_else(|| "PushHub".to_string());
    let dnd_for_event = dnd_item.clone();
    let tray = TrayIconBuilder::with_id("main")
        .icon(app.default_window_icon().expect("bundled icon").clone())
        .tooltip(initial_tooltip)
        .menu(&menu)
        // D-74：左键留给显隐切换（菜单归右键；menu_on_left_click 已废弃）。
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| match event.id.as_ref() {
            "show" => crate::show_main_window(app),
            "dnd" => {
                // config.dnd 为唯一事实源：翻转→落盘+SetDnd→勾选态显式对齐
                //（不依赖平台 CheckItem 自动翻转行为的差异）。
                let state = app.state::<AppState>();
                let new_dnd = !state.config.lock().unwrap().dnd;
                if commands::do_toggle_dnd(&state, new_dnd).is_ok() {
                    let _ = dnd_for_event.set_checked(new_dnd);
                }
            }
            "quit" => app.exit(0), // 唯一退出入口（关窗只隐藏，WIN-01/SC1）
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // 左键单击（抬起）切换主窗口显隐（D-74）。
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle().clone();
                let visible = app
                    .get_webview_window("main")
                    .map(|w| w.is_visible().unwrap_or(false))
                    .unwrap_or(false);
                if visible {
                    crate::hide_main_window(&app);
                } else {
                    crate::show_main_window(&app);
                }
            }
        })
        .build(app)?;
    app.manage(TrayHandle(tray));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn statuses(pairs: &[( &str, Status)]) -> Vec<(String, Status)> {
        pairs
            .iter()
            .map(|(id, s)| (id.to_string(), *s))
            .collect()
    }

    /// 空频道态：0 在线 / 0 重连中。
    #[test]
    fn tooltip_empty_channels() {
        assert_eq!(tooltip_summary(&[]), "PushHub — 0 在线 / 0 重连中");
    }

    /// 两档口径：Online 计在线；Connecting+Reconnecting 计重连中；
    /// Offline 不列（D-74「以在线/重连中两档为准」）。
    #[test]
    fn tooltip_two_tier_aggregation() {
        let s = statuses(&[
            ("a", Status::Online),
            ("b", Status::Online),
            ("c", Status::Connecting),
            ("d", Status::Reconnecting),
            ("e", Status::Offline),
        ]);
        assert_eq!(tooltip_summary(&s), "PushHub — 2 在线 / 2 重连中");
    }

    /// Offline 全员：在线/重连中均 0（offline 不列）。
    #[test]
    fn tooltip_all_offline() {
        let s = statuses(&[("a", Status::Offline), ("b", Status::Offline)]);
        assert_eq!(tooltip_summary(&s), "PushHub — 0 在线 / 0 重连中");
    }
}
