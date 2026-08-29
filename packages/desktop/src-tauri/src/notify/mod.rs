//! WinRT 通知层（05-03 Task 3，SC2/WIN-02/D-65/D-66/D-68/D-69/D-70）。
//!
//! 架构（RESEARCH Pattern 4 + Pitfall 5，Spike 实证 2026-08-29）：
//!  - `ToastManager` 是 `!Send + !Sync`——只存活于 [`spawn_notify_thread`]
//!    函数体内的专用 OS 线程，命令经 `std::sync::mpsc` 传入；
//!  - Toast 三件套：`tag = wid`（每消息唯一）、`group = channel_id`（频道
//!    折叠）、`launch = "channel_id:wid"`（点击定位上下文）；
//!  - 点击回调（Spike 实证）：点正文 → `Some(ActivatedAction)`，其 `arg`
//!    就是 launch 字符串——[`parse_launch`] 还原二元组后经 AppHandle
//!    emit `ph://locate`（载荷 `{channel_id, wid}`，前端由 05-06 消费）；
//!  - AUMID 三档（Pitfall 4）：register() 自有 AUMID（对齐 Tauri identifier
//!    `app.pushhub.desktop`）→ 失败回退 `POWERSHELL_AUM_ID` 常量并打日志。
//!
//! 05-05 起经 lib.rs `mod notify;` 编入 lib 目标（05-03 的 tests/
//! notify_tests.rs #[path] 载体已随接线移除）；通知线程装配（spawn_notify_
//! thread 调用）与 adapter 决策接线见 lib.rs / adapter。
//!
//! 安全（threat model）：make_title/summarize 的输入只有频道名/title/text，
//! Channel Key 不进通知路径（T-05-03-02）；parse_launch 严格单冒号拆分，
//! 畸形返回 None 丢弃（T-05-03-03）；快捷选项（options）不出现在通知中
//! ——结构上 NotifyCmd 就没有该字段（D-68）。

// 公开 API 消费者标注（05-02 同款策略）：spawn_notify_thread 由 lib.rs
// setup 装配；NotifyCmd 族由 commands/adapter 接线；其余纯函数测试直消。
#![allow(dead_code)]

use std::sync::mpsc::Receiver;

use winrt_toast_reborn::content::audio::Sound;
use winrt_toast_reborn::{Audio, Toast, ToastManager};

mod summary;

/// D-68 通知正文摘要上限（约 150 字符，chars 计数近似——A7 裁决：不逐字节
/// 对齐 UTF-16）。
pub const SUMMARY_MAX_CHARS: usize = 150;

/// 应用 AUMID（对齐 tauri.conf.json identifier——NSIS 安装版经 Tauri 模板
/// 登记同源 AUMID，dev/便携版由 register() 补登记，Pitfall 4 三档策略第一档）。
pub const APP_AUMID: &str = "app.pushhub.desktop";

/// D-66 三档优先级（2026-08-29 用户裁决修订版：low 档因 SuppressPopup 不可达
/// 降级为无声横幅，枚举原样传递保留语义）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Priority {
    High,
    Normal,
    Low,
}

impl Priority {
    /// 从协议帧 priority 字符串解析（protocol::is_priority 已守卫三值；
    /// 未知值返回 None，调用侧丢弃或降级处理）。
    pub fn from_param(s: &str) -> Option<Self> {
        match s {
            "high" => Some(Priority::High),
            "normal" => Some(Priority::Normal),
            "low" => Some(Priority::Low),
            _ => None,
        }
    }
}

/// 通知命令（跨线程传入专用 OS 线程；Toast 值可跨线程构造，manager 单线程持有）。
#[derive(Debug, Clone, PartialEq)]
pub enum NotifyCmd {
    Show {
        channel_id: String,
        /// 频道展示名（make_title 组装标题用；来自本地频道配置，非消息内容）。
        channel_name: String,
        wid: String,
        /// 消息 title（协议可选字段；缺失时 make_title 取 text 首行）。
        title: Option<String>,
        /// 消息正文（Markdown 源文本，经 strip_markdown + summarize 后进通知）。
        text: String,
        priority: Priority,
    },
    /// D-69：answered 联动 `remove_grouped_tag` 组内精确移除。
    Remove { channel_id: String, wid: String },
    /// D-70 勿扰（2026-08-29 裁决：true 期间 Show 完全不出通知，不做仅进通知中心）。
    SetDnd(bool),
}

/// [`build_toast_fields`] 的产物（纯数据：测试断言与 Toast 构建两用）。
pub struct ToastFields {
    pub tag: String,
    pub group: String,
    pub launch: String,
    pub sound: Sound,
}

/// Toast 三件套 + 三档声音映射的纯函数构造（D-65×D-69 联合方案 + D-66）。
///
/// - tag = wid（每消息唯一，answered 精确移除的键）
/// - group = channel_id（通知中心按频道折叠）
/// - launch = "channel_id:wid"（单 ASCII 冒号；点击定位上下文）
/// - high → Sound::Default（横幅+系统声）；normal/low → Sound::None（无声横幅）
pub fn build_toast_fields(cmd: &NotifyCmd) -> ToastFields {
    let NotifyCmd::Show { channel_id, wid, priority, .. } = cmd else {
        // 非 Show 命令没有 Toast 语义——调用侧（线程循环）不会走到这里
        unreachable!("build_toast_fields only accepts Show commands")
    };
    // D-66 裁决版三档映射（Sound 无 PartialEq，测试侧用 matches! 断言变体）
    let sound = match priority {
        Priority::High => Sound::Default,
        Priority::Normal | Priority::Low => Sound::None,
    };
    ToastFields {
        tag: wid.clone(),
        group: channel_id.clone(),
        launch: build_launch(channel_id, wid),
        sound,
    }
}

/// launch 字符串构造（与 [`parse_launch`] 互逆）。
pub fn build_launch(channel_id: &str, wid: &str) -> String {
    // 单 ASCII 冒号连接；channel id 与 wid 均为服务端生成 ASCII，无编码歧义
    format!("{channel_id}:{wid}")
}

/// launch 解析：恰一 ASCII 冒号且两侧非空 → `(channel_id, wid)`；
/// 无冒号/多冒号/任一侧为空 → None（T-05-03-03：畸形激活上下文直接丢弃）。
pub fn parse_launch(launch: &str) -> Option<(String, String)> {
    let parts: Vec<&str> = launch.split(':').collect();
    if parts.len() != 2 || parts[0].is_empty() || parts[1].is_empty() {
        return None;
    }
    Some((parts[0].to_string(), parts[1].to_string()))
}

/// D-70 勿扰抑制矩阵：dnd 为真时仅抑制 Show（Remove/SetDnd 照常放行——
/// answered 移除与勿扰开关本身不受勿扰影响）。
pub fn should_suppress(dnd: bool, cmd: &NotifyCmd) -> bool {
    dnd && matches!(cmd, NotifyCmd::Show { .. })
}

/// D-65 通知触发决策矩阵（纯函数，05-05 Task 3）：
///  - 窗口可见且当前频道即消息频道 → false（正在看不打扰）；
///  - 频道静音或全局勿扰 → false（完全不出通知——2026-08-29 裁决，不做
///    仅进通知中心）；
///  - 其余 → true（窗口隐藏 / 可见他频道 / 未选频道均弹）。
pub fn should_notify(
    window_visible: bool,
    current_channel: Option<&str>,
    msg_channel: &str,
    muted: bool,
    dnd: bool,
) -> bool {
    if muted || dnd {
        return false; // D-70：静音/勿扰完全不出
    }
    if window_visible && current_channel == Some(msg_channel) {
        return false; // D-65：正在看不打扰
    }
    true
}

/// 专用通知线程（Pitfall 5：ToastManager !Send——只存在于本函数体内）。
///
/// 线程职责：AUMID 三档初始化 → 注册激活回调（解析 launch → emit
/// `ph://locate`）→ `for cmd in rx` 命令循环（Show/Remove/SetDnd 路由）。
/// 通道关闭（所有 Sender drop）时线程自然退出。
pub fn spawn_notify_thread(
    app: tauri::AppHandle,
    rx: Receiver<NotifyCmd>,
) -> std::thread::JoinHandle<()> {
    use tauri::Emitter;

    std::thread::spawn(move || {
        // ---- AUMID 三档策略（Pitfall 4；Spike 实证第一档 register 在本机可行）----
        let aumid: &str = match winrt_toast_reborn::register(APP_AUMID, "PushHub", None) {
            Ok(()) => APP_AUMID,
            Err(e) => {
                eprintln!("[notify] AUMID register failed {e:?} — fallback POWERSHELL_AUM_ID");
                ToastManager::POWERSHELL_AUM_ID
            }
        };

        // ---- 激活回调（Spike 实证：点正文 → Some(action)，arg == launch 字符串；
        //      空参数激活（None）与畸形 launch 一律丢弃——T-05-03-03）----
        let app_for_click = app.clone();
        let manager = ToastManager::new(aumid).on_activated(None, move |action| {
            if let Some(action) = action {
                if let Some((channel_id, wid)) = parse_launch(&action.arg) {
                    if let Err(e) = app_for_click.emit(
                        "ph://locate",
                        serde_json::json!({ "channel_id": channel_id, "wid": wid }),
                    ) {
                        eprintln!("[notify] ph://locate emit failed: {e:?}");
                    }
                }
            }
        });

        // ---- 命令循环（通道关闭即所有 Sender drop 时线程自然退出）----
        let mut dnd = false;
        for cmd in rx {
            if should_suppress(dnd, &cmd) {
                continue; // D-70：勿扰期间 Show 完全不出通知（裁决：不做仅进通知中心）
            }
            match cmd {
                NotifyCmd::Show { .. } => {
                    let fields = build_toast_fields(&cmd);
                    let NotifyCmd::Show { channel_name, title, text, .. } = &cmd else {
                        unreachable!("arm pattern guarantees Show")
                    };
                    let title_text =
                        summary::make_title(channel_name, title.as_deref(), text);
                    let body = summary::summarize(
                        &summary::strip_markdown(text),
                        SUMMARY_MAX_CHARS,
                    );
                    let mut toast = Toast::new();
                    toast
                        .text1(title_text)
                        .text2(body)
                        .tag(fields.tag)
                        .group(fields.group)
                        .launch(fields.launch)
                        .audio(Audio::new(fields.sound));
                    if let Err(e) = manager.show(&toast) {
                        eprintln!("[notify] show failed: {e:?}");
                    }
                }
                NotifyCmd::Remove { channel_id, wid } => {
                    if let Err(e) = manager.remove_grouped_tag(&channel_id, &wid) {
                        eprintln!("[notify] remove_grouped_tag failed: {e:?}");
                    }
                }
                NotifyCmd::SetDnd(v) => dnd = v,
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn show(priority: Priority) -> NotifyCmd {
        NotifyCmd::Show {
            channel_id: "ch1".into(),
            channel_name: "alerts".into(),
            wid: "w9".into(),
            title: Some("t".into()),
            text: "hello".into(),
            priority,
        }
    }

    #[test]
    fn three_tier_sound_mapping() {
        // D-66 裁决版：high→Default（横幅+声）；normal/low→None（无声横幅）
        assert!(matches!(
            build_toast_fields(&show(Priority::High)).sound,
            Sound::Default
        ));
        assert!(matches!(
            build_toast_fields(&show(Priority::Normal)).sound,
            Sound::None
        ));
        assert!(matches!(
            build_toast_fields(&show(Priority::Low)).sound,
            Sound::None
        ));
    }

    #[test]
    fn toast_fields_triple() {
        // D-65×D-69：tag=wid、group=channel_id、launch=channel:wid
        let f = build_toast_fields(&show(Priority::Normal));
        assert_eq!(f.tag, "w9");
        assert_eq!(f.group, "ch1");
        assert_eq!(f.launch, "ch1:w9");
    }

    #[test]
    fn locate_route() {
        // SC2 三级定位数据通路（VALIDATION 映射）：launch 构造 → 激活参数
        // → 解析还原二元组（Spike 实证 arg == launch 字符串）
        let launch = build_launch("ch1", "w9");
        assert_eq!(parse_launch(&launch), Some(("ch1".into(), "w9".into())));
    }

    #[test]
    fn parse_launch_rejects_malformed() {
        // T-05-03-03：严格单冒号拆分，畸形一律 None
        assert_eq!(parse_launch(""), None);
        assert_eq!(parse_launch("nowid"), None); // 无冒号
        assert_eq!(parse_launch(":wid"), None); // 空 channel
        assert_eq!(parse_launch("ch:"), None); // 空 wid
        assert_eq!(parse_launch("a:b:c"), None); // 多冒号
    }

    #[test]
    fn dnd_suppresses_only_show() {
        // D-70 矩阵：勿扰只拦 Show，Remove/SetDnd 照常
        assert!(should_suppress(true, &show(Priority::High)));
        assert!(!should_suppress(false, &show(Priority::High)));
        assert!(!should_suppress(
            true,
            &NotifyCmd::Remove {
                channel_id: "ch".into(),
                wid: "w".into()
            }
        ));
        assert!(!should_suppress(true, &NotifyCmd::SetDnd(false)));
    }

    #[test]
    fn priority_from_param() {
        assert_eq!(Priority::from_param("high"), Some(Priority::High));
        assert_eq!(Priority::from_param("normal"), Some(Priority::Normal));
        assert_eq!(Priority::from_param("low"), Some(Priority::Low));
        assert_eq!(Priority::from_param("urgent"), None);
    }

    /// D-65 决策矩阵六条路径（05-05 Task 3，断言到布尔值）。
    #[test]
    fn decision_matrix_six_paths() {
        // 1. 窗口可见 + 当前频道即消息频道 → 不弹（正在看不打扰）。
        assert!(!should_notify(true, Some("ch1"), "ch1", false, false));
        // 2. 窗口可见 + 其他频道 → 弹。
        assert!(should_notify(true, Some("ch2"), "ch1", false, false));
        // 3. 窗口隐藏（即使当前即消息频道）→ 弹。
        assert!(should_notify(false, Some("ch1"), "ch1", false, false));
        // 4. 频道静音 → 完全不出（窗口隐藏/可见他频道均不出，D-70）。
        assert!(!should_notify(false, None, "ch1", true, false));
        assert!(!should_notify(true, Some("ch2"), "ch1", true, false));
        // 5. 全局勿扰 → 完全不出（2026-08-29 裁决：不做仅进通知中心）。
        assert!(!should_notify(false, None, "ch1", false, true));
        assert!(!should_notify(true, Some("ch1"), "ch1", false, true));
        // 6. 正常路径：窗口隐藏/未选频道（向导态）/可见但未选 → 弹。
        assert!(should_notify(false, None, "ch1", false, false));
        assert!(should_notify(true, None, "ch1", false, false));
    }
}
