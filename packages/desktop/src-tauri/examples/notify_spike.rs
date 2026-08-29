//! Spike：winrt-toast-reborn 0.3.8 三 API 运行时实证（05-03 Task 2，T-05-SC）。
//!
//! 实证目标（SUS 包批准后的实证兜底）：
//!  1. show() —— toast 能发出（横幅视觉属人工观察项，不阻塞断言）；
//!  2. on_activated —— 点击回调可达，且 launch 上下文随激活参数返回
//!     （crate 源码 get_activated_action：Arguments 非空才构造 ActivatedAction，
//!      点正文时 Arguments == toast 的 launch 属性——本 spike 实证该链路）；
//!  3. remove_grouped_tag(group, tag) —— 组内精确移除返回 Ok。
//!
//! 结果落盘 %TEMP%/pushhub-spike-result.txt，由 scripts/notify-spike-check.mjs
//! 自动断言（激活上下文标记 + remove Ok 标记）。
//!
//! AUMID 三档策略（RESEARCH Pitfall 4）：优先 register() 注册自有 AUMID
//! （HKCU\SOFTWARE\Classes\AppUserModelId\，仅 DisplayName 无 exe 激活路径——
//! 点击激活依赖进程存活时的 in-process Activated 事件，不拉起新进程）；
//! register 失败回退常量 ToastManager::POWERSHELL_AUM_ID 并落盘日志。

use std::io::Write;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use winrt_toast_reborn::{register, unregister, Toast, ToastManager};

const RESULT_FILE: &str = "pushhub-spike-result.txt";
const OWN_AUMID: &str = "PushHub.Desktop.Spike";
const CHANNEL: &str = "spike-channel";
const WID: &str = "spike-wid";
const LAUNCH: &str = "spike-channel:spike-wid";

fn result_path() -> PathBuf {
    std::env::temp_dir().join(RESULT_FILE)
}

/// 追加一行到结果文件（激活回调线程与主线程都会写）。
fn append_result(line: &str) {
    if let Ok(mut f) =
        std::fs::OpenOptions::new().create(true).append(true).open(result_path())
    {
        let _ = writeln!(f, "{line}");
    }
}

fn main() {
    // 清除上一轮残留，避免陈旧标记污染断言
    let _ = std::fs::remove_file(result_path());
    append_result("SPIKE START");

    // ---- AUMID 三档策略：register 自有 AUMID，失败回退 PowerShell 常量 ----
    let mut registered = false;
    match register(OWN_AUMID, "PushHub Spike", None) {
        Ok(()) => {
            registered = true;
            append_result("AUMID: register OK (own AUMID)");
        }
        Err(e) => {
            append_result(&format!(
                "AUMID: register failed {e:?} — fallback POWERSHELL_AUM_ID"
            ));
        }
    }
    let aumid: &str = if registered {
        OWN_AUMID
    } else {
        ToastManager::POWERSHELL_AUM_ID
    };

    // ---- on_activated：激活上下文落盘（Some 带 arg=launch；None 即空参数激活）----
    let manager = ToastManager::new(aumid).on_activated(None, |action| {
        append_result(&format!("ACTIVATED action={action:?}"));
    });

    // ---- Toast 三件套：tag=wid、group=channel_id、launch=channel:wid ----
    let mut toast = Toast::new();
    toast
        .text1("PushHub Spike")
        .text2("activation probe")
        .tag(WID)
        .group(CHANNEL)
        .launch(LAUNCH);

    match manager.show(&toast) {
        Ok(()) => append_result("SHOW Ok"),
        Err(e) => append_result(&format!("SHOW Err {e:?}")),
    }

    // ---- 主线程轮询等待激活至多 60 秒（每秒查文件）----
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        let content = std::fs::read_to_string(result_path()).unwrap_or_default();
        if content.contains("ACTIVATED") {
            append_result("WAIT activated");
            break;
        }
        if Instant::now() >= deadline {
            append_result("WAIT timeout");
            break;
        }
        std::thread::sleep(Duration::from_secs(1));
    }

    // ---- remove_grouped_tag 实证（组内精确移除）----
    match manager.remove_grouped_tag(CHANNEL, WID) {
        Ok(()) => append_result("REMOVE Ok"),
        Err(e) => append_result(&format!("REMOVE Err {e:?}")),
    }

    // ---- 清理注册（仅本 spike 注册的自有 AUMID）----
    if registered {
        match unregister(OWN_AUMID) {
            Ok(()) => append_result("UNREGISTER Ok"),
            Err(e) => append_result(&format!("UNREGISTER Err {e:?}")),
        }
    }
    append_result("SPIKE END");
}
