//! 通知文案组装（05-03 Task 3，D-68/D-70+A7）。
//!
//! 通知正文 = 剥 Markdown 标记的纯文本摘要（~150 字符按 chars 截断——A7
//! 裁决：chars 计数近似，不逐字节对齐 UTF-16）；标题 = 频道名与消息标题
//! 组合（title 缺失时取 text 剥离后首行）。快捷选项（options）永远不出现在
//! 通知中（D-68——结构性保证：本模块没有 options 入参）。
//!
//! 输入只有频道名/title/text——Channel Key 不进通知路径（T-05-03-02）。

/// 剥离常见 Markdown 标记为纯文本：
/// `**bold**`、`*italic*`、`` `code` ``、围栏代码块（保留内容、去围栏行）、
/// `[text](url)` → text、`![alt](url)` → alt、行首 `#` 标题、列表标记
/// （`-`/`*`/`+`/`数字.`）、`>` 引用标记。
pub fn strip_markdown(text: &str) -> String {
    let _ = text;
    unimplemented!("RED")
}

/// 按 chars 计数截断（不超过 `max_chars` 个字符；不追加省略号——
/// 长度语义由调用侧常量 SUMMARY_MAX_CHARS 控制）。
pub fn summarize(text: &str, max_chars: usize) -> String {
    let _ = (text, max_chars);
    unimplemented!("RED")
}

/// 通知标题组装：`"{频道名}: {标题}"`；title 缺失（None 或空白）时取
/// text 剥 Markdown 后的首行；频道名为空时不加前缀。
pub fn make_title(channel_name: &str, title: Option<&str>, text: &str) -> String {
    let _ = (channel_name, title, text);
    unimplemented!("RED")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_inline_markers() {
        assert_eq!(
            strip_markdown("**bold** and *italic* and `code`"),
            "bold and italic and code"
        );
        assert_eq!(strip_markdown("~~gone~~"), "gone");
    }

    #[test]
    fn strip_links_keep_text() {
        assert_eq!(strip_markdown("[text](https://x.example)"), "text");
        assert_eq!(strip_markdown("![alt](https://x.example/i.png)"), "alt");
        // 非链接方括号原样保留
        assert_eq!(strip_markdown("[not a link"), "[not a link");
    }

    #[test]
    fn strip_line_prefixes() {
        assert_eq!(strip_markdown("## Heading"), "Heading");
        assert_eq!(strip_markdown("- item one"), "item one");
        assert_eq!(strip_markdown("* star item"), "star item");
        assert_eq!(strip_markdown("1. first step"), "first step");
        assert_eq!(strip_markdown("> quoted line"), "quoted line");
        // 井号后无空格不是标题（CommonMark 语义）
        assert_eq!(strip_markdown("#hashtag"), "#hashtag");
    }

    #[test]
    fn strip_fenced_code_keeps_content() {
        let src = "before\n```\ncode line\n```\nafter";
        assert_eq!(strip_markdown(src), "before\ncode line\nafter");
    }

    #[test]
    fn summarize_truncates_by_chars() {
        // 恰好不超限：原样
        assert_eq!(summarize("abcd", 4), "abcd");
        // 超限截断
        assert_eq!(summarize("abcde", 4), "abcd");
        // CJK 按 chars 计数（每字 1）：300 字截到 150
        let long = "推".repeat(300);
        let cut = summarize(&long, 150);
        assert_eq!(cut.chars().count(), 150);
        assert_eq!(cut, "推".repeat(150));
    }

    #[test]
    fn make_title_with_explicit_title() {
        assert_eq!(make_title("alerts", Some("Deploy done"), "body"), "alerts: Deploy done");
        // 空白 title 视为缺失
        assert_eq!(make_title("alerts", Some("  "), "first\nsecond"), "alerts: first");
    }

    #[test]
    fn make_title_falls_back_to_first_line() {
        assert_eq!(make_title("alerts", None, "first line\nsecond"), "alerts: first line");
        // 首行的 Markdown 标记也剥掉
        assert_eq!(make_title("alerts", None, "**urgent** notice"), "alerts: urgent notice");
    }

    #[test]
    fn make_title_without_channel_name() {
        assert_eq!(make_title("", Some("T"), "x"), "T");
    }
}
