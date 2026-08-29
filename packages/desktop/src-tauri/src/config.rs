//! 启动配置（05-01 Task 3 → 05-05 Task 1 完整化）：PH_CONFIG_PATH 环境变量
//! 覆盖 + %APPDATA%/PushHub/config.json 缺省路径。
//!
//! 05-05 扩展（WIN-06/D-70/D-71/D-72）：
//!  - 完整字段集：server / channels（含每频道 muted）/ display_name / dnd /
//!    first_close_hint_shown；
//!  - 原子保存 [`save_to`]：同目录临时文件写入后 rename 覆盖（Windows 上
//!    std::fs::rename 对应 MoveFileExW + MOVEFILE_REPLACE_EXISTING，可直接
//!    覆盖已存在目标）；任何一步失败错误上抛不静默（T-05-05-03 mitigate）；
//!  - 损坏文件降级默认配置并打日志不 panic（T-05-05-03 mitigate；serde
//!    解析错误只含行列位置不含文件内容——密钥不进日志）。
//!
//! serde 容错：字段缺失用 default（#[serde(default)]）——旧版配置文件
//! （无 muted/dnd/display_name 等字段）平滑升级解析。

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    pub server: String,
    pub channels: Vec<ChannelConfig>,
    /// 全局展示名（reply 帧 by 字段来源，D-72）：设置一次每次 reply 自动携带；
    /// None = 匿名回复（by 键不序列化）。
    pub display_name: Option<String>,
    /// 全局勿扰（D-70 托盘 CheckItem / commands::toggle_dnd 双写入口）：
    /// true 期间通知决策矩阵完全不出 Show（不做"仅进通知中心"）。
    pub dnd: bool,
    /// 首次关闭提示已展示标记（D-71）：首次关窗 emit ph://first-close-hint，
    /// 前端确认后经 commands::mark_first_close_hint 置位，此后不再弹。
    pub first_close_hint_shown: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ChannelConfig {
    pub id: String,
    pub name: String,
    pub key: String,
    /// 每频道静音（D-70）：true 时该频道实时消息完全不出通知——只影响通知
    /// 决策不影响连接（连接照常、缓冲照常、窗口内照常可见）。
    pub muted: bool,
}

/// 配置文件路径解析：PH_CONFIG_PATH 优先（E2E 配置隔离锚点）；缺省
/// %APPDATA%/PushHub/config.json。两者均不可解析（无 APPDATA 的非 Windows
/// 环境）返回 None——调用侧降级内存默认配置。
pub fn config_path() -> Option<PathBuf> {
    std::env::var("PH_CONFIG_PATH")
        .ok()
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var("APPDATA")
                .ok()
                .map(|a| PathBuf::from(a).join("PushHub").join("config.json"))
        })
}

/// 配置文件路径的完整解析（无环境变量时回退相对路径 config.json——
/// AppState 持有具体路径，保存永远定点写入）。
#[allow(dead_code)] // 05-05 Task 2 lib.rs setup 构造 AppState.path 消费
pub fn config_path_or_default() -> PathBuf {
    config_path().unwrap_or_else(|| PathBuf::from("config.json"))
}

/// 启动加载（lib.rs setup 消费）：文件缺失/不可解析 → 空配置（首启无配置
/// 场景，仅起前端窗口/向导）。
pub fn load() -> Config {
    match config_path() {
        Some(path) => load_from(&path),
        None => Config::default(),
    }
}

/// 定点加载（测试/E2E 消费）：损坏文件返回默认配置并打日志（不 panic）。
pub fn load_from(path: &Path) -> Config {
    match std::fs::read_to_string(path) {
        Ok(raw) => match serde_json::from_str::<Config>(&raw) {
            Ok(cfg) => cfg,
            Err(e) => {
                // serde_json 解析错误只含行列位置，不回显文件内容（密钥纪律）。
                eprintln!("pushhub: config file corrupted, using defaults: {e}");
                Config::default()
            }
        },
        Err(_) => Config::default(), // 文件缺失：首启无配置场景
    }
}

/// 原子保存（T-05-05-03）：同目录临时文件写入 + rename 覆盖。
///
/// rename 在 Windows 上带 MOVEFILE_REPLACE_EXISTING 语义（可直接覆盖已存在
/// 目标）；父目录缺失时先创建。失败返回错误描述（不静默、不留半写文件
/// ——目标文件要么旧内容要么新内容）。
pub fn save_to(path: &Path, cfg: &Config) -> Result<(), String> {
    let body = serde_json::to_string_pretty(cfg)
        .map_err(|e| format!("config serialize failed: {e}"))?;
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("config dir create failed: {e}"))?;
        }
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, body).map_err(|e| format!("config temp write failed: {e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("config replace failed: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 测试用临时配置路径（进程级唯一目录，避免测试间与真实配置互踩；
    /// PH_CONFIG_PATH 环境变量方案在并行测试下有进程级竞态，不采用）。
    fn temp_config_path(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "pushhub-cfg-{tag}-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("config.json")
    }

    #[test]
    fn parse_full_config() {
        let raw = r#"{"server":"http://127.0.0.1:4911","channels":[{"id":"ch1","name":"测试","key":"phc_abc","muted":true}],"display_name":"笔电","dnd":true,"first_close_hint_shown":true}"#;
        let cfg: Config = serde_json::from_str(raw).unwrap();
        assert_eq!(cfg.server, "http://127.0.0.1:4911");
        assert_eq!(cfg.channels.len(), 1);
        assert_eq!(cfg.channels[0].name, "测试");
        assert_eq!(cfg.channels[0].key, "phc_abc");
        assert!(cfg.channels[0].muted);
        assert_eq!(cfg.display_name.as_deref(), Some("笔电"));
        assert!(cfg.dnd);
        assert!(cfg.first_close_hint_shown);
    }

    #[test]
    fn parse_missing_fields_defaults_empty() {
        // 字段缺失用 default（serde 容错）：空对象 → 空配置。
        let cfg: Config = serde_json::from_str("{}").unwrap();
        assert_eq!(cfg.server, "");
        assert!(cfg.channels.is_empty());
        assert_eq!(cfg.display_name, None);
        assert!(!cfg.dnd);
        assert!(!cfg.first_close_hint_shown);
        // channels 元素字段缺失同容错。
        let cfg: Config = serde_json::from_str(r#"{"channels":[{}]}"#).unwrap();
        assert_eq!(cfg.channels[0].id, "");
        assert!(!cfg.channels[0].muted);
    }

    /// 旧版配置文件（05-01/05-04 时代只有 server+channels，无 muted 等新字段）
    /// 平滑升级解析（serde default）。
    #[test]
    fn legacy_config_without_new_fields_parses() {
        let raw = r#"{"server":"http://127.0.0.1:4911","channels":[{"id":"ch1","name":"alerts","key":"phc_abc"}]}"#;
        let cfg: Config = serde_json::from_str(raw).unwrap();
        assert_eq!(cfg.channels.len(), 1);
        assert!(!cfg.channels[0].muted);
        assert_eq!(cfg.display_name, None);
        assert!(!cfg.dnd);
    }

    /// 原子写往返：save_to → load_from 内容一致；目录自动创建。
    #[test]
    fn save_load_roundtrip() {
        let path = temp_config_path("roundtrip");
        let cfg = Config {
            server: "https://pushhub.dyun.org".to_string(),
            channels: vec![ChannelConfig {
                id: "ch1".to_string(),
                name: "告警群".to_string(),
                key: "phc_k".to_string(),
                muted: true,
            }],
            display_name: Some("Windows 笔电".to_string()),
            dnd: false,
            first_close_hint_shown: false,
        };
        save_to(&path, &cfg).unwrap();
        assert_eq!(load_from(&path), cfg, "往返内容一致");
    }

    /// 原子覆盖：二次保存覆盖既有文件；临时文件不残留（目录内恰一个文件）。
    #[test]
    fn save_overwrites_existing_atomically() {
        let path = temp_config_path("overwrite");
        let v1 = Config {
            server: "http://a".to_string(),
            ..Default::default()
        };
        let v2 = Config {
            server: "http://b".to_string(),
            dnd: true,
            ..Default::default()
        };
        save_to(&path, &v1).unwrap();
        save_to(&path, &v2).unwrap();
        assert_eq!(load_from(&path), v2, "二次保存后目标为新内容");
        let dir_files: Vec<_> = std::fs::read_dir(path.parent().unwrap())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains("config"))
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(dir_files, vec!["config.json".to_string()], "无 .tmp 残留");
    }

    /// 损坏文件降级默认配置不 panic（T-05-05-03）。
    #[test]
    fn corrupted_file_falls_back_to_default() {
        let path = temp_config_path("corrupted");
        std::fs::write(&path, "{ not valid json !!!").unwrap();
        assert_eq!(load_from(&path), Config::default());
    }

    /// 文件缺失 → 默认配置（首启场景）。
    #[test]
    fn missing_file_is_default() {
        let path = temp_config_path("missing").with_file_name("absent.json");
        assert_eq!(load_from(&path), Config::default());
    }
}
