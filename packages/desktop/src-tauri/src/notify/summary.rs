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
    let mut out: Vec<String> = Vec::new();
    let mut in_fence = false;
    for line in text.lines() {
        let leading = line.trim_start();
        // 围栏代码块：围栏行本身丢弃（开/闭切换），内容行原样保留
        if leading.starts_with("```") || leading.starts_with("~~~") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            out.push(line.to_string());
            continue;
        }
        out.push(strip_line(leading));
    }
    out.join("\n")
}

/// 行级标记剥离：引用 `>`、标题 `#`、列表标记（`-`/`*`/`+`/`数字.`）。
fn strip_line(line: &str) -> String {
    let mut s = line;
    // 引用标记（连续 `>` 一并剥掉，嵌套引用也归一）
    s = s.trim_start_matches('>').trim_start();
    // 标题井号：`#`+ 后跟空格或行尾才是标题（CommonMark 语义，#hashtag 保留）
    if s.starts_with('#') {
        let after = s.trim_start_matches('#');
        if after.is_empty() || after.starts_with(' ') {
            s = after.trim_start();
        }
    }
    // 列表标记：`- ` / `* ` / `+ ` / `数字. `
    let bytes = s.as_bytes();
    if bytes.len() >= 2
        && (bytes[0] == b'-' || bytes[0] == b'*' || bytes[0] == b'+')
        && bytes[1] == b' '
    {
        s = &s[2..];
    } else if let Some((digits, rest)) = split_leading_digits(s) {
        if digits > 0 && rest.starts_with(". ") {
            s = &rest[2..];
        }
    }
    strip_inline(s).trim().to_string()
}

/// 行首连续数字长度拆分（无数字返回 (0, 原串)）。
fn split_leading_digits(s: &str) -> Option<(usize, &str)> {
    let end = s.find(|c: char| !c.is_ascii_digit()).unwrap_or(s.len());
    Some((end, &s[end..]))
}

/// 行内标记剥离：图片/链接保留文本、删除线/粗体/斜体/行内代码去标记。
fn strip_inline(s: &str) -> String {
    let s = replace_links(s);
    let s = s.replace("~~", "").replace("**", "").replace("__", "");
    let s = remove_paired(&s, '*');
    let s = remove_paired(&s, '_');
    s.replace('`', "")
}

/// `![alt](url)` → alt、`[text](url)` → text；非链接形态的方括号原样保留。
/// （不支持嵌套方括号——Markdown 链接文本不含裸 `]`。）
fn replace_links(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        let is_img = chars[i] == '!' && i + 1 < chars.len() && chars[i + 1] == '[';
        if chars[i] == '[' || is_img {
            let start = if is_img { i + 1 } else { i };
            if let Some(rel_close) = chars[start + 1..].iter().position(|&c| c == ']') {
                let close = start + 1 + rel_close;
                if close + 1 < chars.len() && chars[close + 1] == '(' {
                    if let Some(rel_paren) = chars[close + 2..].iter().position(|&c| c == ')') {
                        for &c in &chars[start + 1..close] {
                            out.push(c);
                        }
                        i = close + 2 + rel_paren + 1;
                        continue;
                    }
                }
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

/// 成对标记移除（`*italic*` → italic）：保留标记间内容，去两侧标记；
/// 落单的标记字符按字面保留。
fn remove_paired(s: &str, marker: char) -> String {
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == marker {
            if let Some(rel) = chars[i + 1..].iter().position(|&c| c == marker) {
                for &c in &chars[i + 1..i + 1 + rel] {
                    out.push(c);
                }
                i = i + 1 + rel + 1;
                continue;
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

/// 按 chars 计数截断（不超过 `max_chars` 个字符；不追加省略号——
/// 长度语义由调用侧常量 SUMMARY_MAX_CHARS 控制）。
pub fn summarize(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        text.to_string()
    } else {
        text.chars().take(max_chars).collect()
    }
}

/// 通知标题组装：`"{频道名}: {标题}"`；title 缺失（None 或空白）时取
/// text 剥 Markdown 后的首行；频道名为空时不加前缀。
pub fn make_title(channel_name: &str, title: Option<&str>, text: &str) -> String {
    let provided = title.map(str::trim).filter(|t| !t.is_empty());
    let head_src = match provided {
        Some(t) => t.to_string(),
        None => {
            let stripped = strip_markdown(text);
            stripped.lines().next().unwrap_or_default().to_string()
        }
    };
    // 提供的 title 也过一遍行内剥离（**加粗标题** → 加粗标题），并压到单行
    let head = strip_inline(&head_src);
    let head = head.lines().next().unwrap_or_default().trim();
    let name = channel_name.trim();
    if name.is_empty() || head.is_empty() {
        return if name.is_empty() { head.to_string() } else { name.to_string() };
    }
    format!("{name}: {head}")
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
