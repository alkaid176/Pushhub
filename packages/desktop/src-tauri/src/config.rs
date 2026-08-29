//! 启动配置（05-01 Task 3）：PH_CONFIG_PATH 环境变量覆盖 + %APPDATA%/PushHub/
//! config.json 缺省路径。文件缺失/解析失败返回空配置（无频道 → 仅起前端窗口）。
//! serde 容错：字段缺失用 default（#[serde(default)]）。

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    pub server: String,
    pub channels: Vec<ChannelConfig>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ChannelConfig {
    pub id: String,
    pub name: String,
    pub key: String,
}

pub fn load() -> Config {
    // PH_CONFIG_PATH 优先（E2E 配置隔离锚点）；缺省 %APPDATA%/PushHub/config.json。
    let path = std::env::var("PH_CONFIG_PATH")
        .ok()
        .or_else(|| std::env::var("APPDATA").ok().map(|a| format!("{a}/PushHub/config.json")));
    let Some(path) = path else {
        return Config::default();
    };
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_full_config() {
        let raw = r#"{"server":"http://127.0.0.1:4911","channels":[{"id":"ch1","name":"测试","key":"phc_abc"}]}"#;
        let cfg: Config = serde_json::from_str(raw).unwrap();
        assert_eq!(cfg.server, "http://127.0.0.1:4911");
        assert_eq!(cfg.channels.len(), 1);
        assert_eq!(cfg.channels[0].name, "测试");
        assert_eq!(cfg.channels[0].key, "phc_abc");
    }

    #[test]
    fn parse_missing_fields_defaults_empty() {
        // 字段缺失用 default（serde 容错）：空对象 → 空配置。
        let cfg: Config = serde_json::from_str("{}").unwrap();
        assert_eq!(cfg.server, "");
        assert!(cfg.channels.is_empty());
        // channels 元素字段缺失同容错。
        let cfg: Config = serde_json::from_str(r#"{"channels":[{}]}"#).unwrap();
        assert_eq!(cfg.channels[0].id, "");
    }
}
