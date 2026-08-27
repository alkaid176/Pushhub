/**
 * renderMarkdown —— Markdown 渲染 + HTML 消毒管道（02-01，D-19/D-20/D-21）。
 *
 * D-20 可移植纯 TS 模块：pushhub.js 打包它，Phase 5 Tauri 前端直接 import 同一
 * 模块——四端消毒逻辑不漂移、XSS 防线一致的组织保障。环境假设仅 window/document
 * （DOMPurify 默认导出即工厂，原生支持多环境）；禁止任何 Node 专有 API。
 *
 * D-21：消毒后链接统一强制 target=_blank + rel=noopener noreferrer
 * （afterSanitizeAttributes hook）——Webhook 消息链接不可信，防反向 tabnabbing。
 * tagName 两分支判定覆盖 SVG 命名空间锚点（G-02-2）；FORBID_TAGS 收敛
 * style/form/input/button 等非聊天语义标签的放行面（WR-02）。
 *
 * 消息来自任意外部 Webhook 发送方，未经消毒的原始 HTML 直通 = 存储型 XSS
 * 直通所有客户端（CLAUDE.md 本域最高危项）——消息内容进 DOM 前必经本管道。
 *
 * 断言基线：test/fixtures/attack-samples.json（RESEARCH Pattern 2 实证预期输出
 * 表固化；消毒断言宿主为 jsdom + 真浏览器两层，轻量 DOM 宿主不承载——实证失真）。
 */
import { marked } from "marked";
import createDOMPurify from "dompurify";

// 聊天语义：GFM（表格/任务列表/删除线）+ 单换行成 <br>。
marked.use({ gfm: true, breaks: true });

/** DOMPurify 惰性单例（首次调用时随宿主 window 创建）。 */
let purify: ReturnType<typeof createDOMPurify> | null = null;

/** 无 DOM 环境的转义降级（D-20 可移植性：不渲染富文本只保证无害）。 */
function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Markdown → 安全 HTML 纯函数（D-19）。
 *
 * 宿主无 window 时（如 Node 纯逻辑环境）跳过 DOMPurify 初始化，直接返回
 * 转义降级——原文可见、无任何标签执行面。
 */
/** DOMPurify 工厂入参形态（WindowLike——dompurify 类型对 lib DOM 的 Window 有摩擦）。 */
type PurifyWindow = Parameters<typeof createDOMPurify>[0];

export function renderMarkdown(text: string): string {
  const w = (globalThis as { window?: unknown }).window as PurifyWindow | undefined;
  if (w === undefined) {
    return escapeHtml(text);
  }
  if (purify === null) {
    purify = createDOMPurify(w);
    // D-21：消毒后 A 元素一律新窗口打开并切断 opener 引用。
    // tagName 两分支（G-02-2）：HTML 命名空间 tagName 大写 "A"、SVG 命名空间
    // 小写 "a"——两者同等加固，SVG 锚点不可绕过 D-21 强制新窗口。
    purify.addHook("afterSanitizeAttributes", (node) => {
      if (node.tagName === "A" || node.tagName === "a") {
        node.setAttribute("target", "_blank");
        node.setAttribute("rel", "noopener noreferrer");
      }
    });
  }
  // WR-02：收敛放行面——非聊天语义标签（表单钓鱼/UI 伪装攻击面）一律禁用。
  // 已知取舍：GFM 任务列表复选框字形随 input 消失（文本保留，UAT 裁决明知
  // 取舍，attack-samples.json task-list 样本固化证据）。
  return purify.sanitize(marked.parse(text, { async: false }), {
    FORBID_TAGS: ["style", "form", "input", "button", "select", "textarea", "label", "option"],
  });
}
