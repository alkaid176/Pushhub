---
phase: 02-web-sdk
reviewed: 2026-08-26T17:25:24Z
depth: standard
files_reviewed: 12
files_reviewed_list:
  - packages/web-sdk/package.json
  - packages/web-sdk/build.mjs
  - packages/web-sdk/src/pushhub.ts
  - packages/web-sdk/src/frames.ts
  - packages/web-sdk/src/dedup.ts
  - packages/web-sdk/src/render/render-markdown.ts
  - packages/web-sdk/src/entry-iife.cts
  - packages/web-sdk/src/connection-machine.ts
  - packages/server/public/viewer.js
  - packages/server/public/index.html
  - packages/server/src/index.ts
  - packages/web-sdk/README.md
findings:
  critical: 1
  warning: 4
  info: 5
  total: 10
status: issues_found
---

# Phase 02: Code Review Report

**Reviewed:** 2026-08-26T17:25:24Z
**Depth:** standard
**Files Reviewed:** 12（另按 required_reading 通读 19 个测试/E2E/配置文件作上下文）
**Status:** issues_found

## Summary

对 Web SDK 参考客户端（pushhub.js 单文件 IIFE、纯状态机、消毒渲染管道）、
demo 查看器（viewer.js + index.html）以及 server 入口的 x-ph-worker 标记头变更
做了标准深度评审，并交叉核对了 `@pushhub/shared` 冻结协议与
`packages/server/src/chat-room.ts` 的服务端事实。

核心链路验证为正确的高置信项：

- **消毒管道主防线成立**：marked(18.0.11) → DOMPurify(3.4.14) 管道对
  fixtures 全部 8 个攻击样本输出正确（script/iframes 清除、on* 移除、
  javascript:/data: href 移除、A 元素强制 target/rel），jsdom 单测 + 真浏览器
  E2E 双层锁定，与 CLAUDE.md 的 DOMPurify 必选约束一致；
- **心跳字节契约**：SDK `PING = '{"v":1,"type":"ping"}'`（pushhub.ts:60）与
  服务端 `PING_FRAME`（chat-room.ts:44）逐字节相同，注释中的键序反转坑
  （Pitfall 4）已规避；
- **状态机事件/动作映射完整**：CONNECT/DISCONNECT/DESTROY/WS_OPEN/WS_CLOSE/
  FRAME/VISIBILITY/TIMER 八事件全分支跟踪，幽灵定时器过滤（timers Set）、
  重连确定序列（syncBase 快照 → 首拉 → 无条件 sync → has_more 续翻 →
  SYNC_PAGE_MAX 死循环防线）、fatal 不复活、DESTROY 资源释放语义自洽，
  machine-*.test.ts 断言与实现一致；
- **密钥纪律**：错误载荷不含 Channel Key 子串、onerror 静默（URL 含密钥）、
  viewer 仅 localStorage 明文（自担取舍已文档化）；
- **server 变更安全**：`stampMarker`（index.ts:133-144）跳过 101、复制构造
  Response 的模式正确；全服务端无 204/205/304 响应（grep 证实），null-body
  TypeError 边界不可达；仅新增响应头，不改冻结的错误信封 body/WS 协议/资产字节。

关键问题：一个 Critical 级发布一致性缺陷（index.html 的 SDK 缓存参数仍钉在
0.1.7，而包版本已是 0.1.8，违反本阶段自己写下的 README 维护约定——正是
README 警告的"部署后改了没生效"经典来源）；两个消毒管道的次级缺口
（SVG 命名空间锚点绕过强制新窗口策略、DOMPurify 默认 profile 放行
style/form/input 等页面级干扰元素）；两个查看器健壮性缺陷（localStorage
读取路径未防护、构造函数对畸形 URL 同步抛异常导致 UI 卡死）。

## Narrative Findings (AI reviewer)

### Critical Issues

#### CR-01: SDK 缓存参数与包版本脱节——index.html 钉在 `?v=0.1.7`，包版本已是 0.1.8

**File:** `packages/server/public/index.html:130`（关联：`package.json:3`、`packages/web-sdk/scripts/chaos-sc2.mjs:114`、`packages/web-sdk/README.md:123-127`）
**Issue:** 本阶段 README 明确约定："每次重建产物并部署后，同步更新引用处的 `?v=` 值（取当次部署版本号）；查看器页 index.html 中的引用同样遵守"，并自述 stale SDK 缓存是"部署后改了没生效的经典来源"。当前 HEAD 状态：根 package.json `version: "0.1.8"`（本阶段从 0.1.4 连续 bump），而 index.html 引用 `/pushhub.js?v=0.1.7`。chaos-sc2.mjs 的用法示例要求 `--expect-version 0.1.8`（即 0.1.8 部署已在计划/执行内），但其内部日志仍硬编码 "0.1.7 查看器接入"——三处版本互相矛盾，证明约定已被打破。后果：任何在 0.1.7 部署期访问过查看器的浏览器将以同 URL 命中缓存，在 0.1.8+ 部署后无限期运行旧 SDK 字节；deploy 脚本（`pnpm run deploy`）只重建产物不更新该引用，缺陷会在后续每次部署中自动延续。
**Fix:**
```html
<!-- packages/server/public/index.html:130 -->
- <script src="/pushhub.js?v=0.1.7"></script>
+ <script src="/pushhub.js?v=0.1.8"></script>
```
建议同时把该引用改为构建期注入（build.mjs 读根 package.json version 并替换 index.html 模板占位符），或在 CI 加一条断言（从 index.html 提取 `?v=` 与根 version 比对），从机制上杜绝人为漏更。chaos-sc2.mjs:114 的硬编码版本日志一并改为输出实际 EXPECT_VERSION。

### Warnings

#### WR-01: afterSanitizeAttributes 钩子大小写敏感——SVG 命名空间锚点绕过"强制新窗口 + noopener"不变量（D-21）

**File:** `packages/web-sdk/src/render/render-markdown.ts:53-58`
**Issue:** 钩子判定 `node.tagName === "A"`。HTML 命名空间元素 tagName 为大写 `"A"`，但 SVG 命名空间元素 tagName 为小写 `"a"`。DOMPurify 默认 profile 放行 `<svg><a xlink:href="…">`（svg 标签白名单含 `a`，xlink:href 属 URI 属性走安全正则）。marked 原样透传原始 HTML，因此消息体 `[<svg><a xlink:href="https://evil.example">领取奖励</a></svg>]`（任意 Webhook 发送方可控）渲染出的 SVG 锚点不会获得 `target="_blank"` 与 `rel="noopener noreferrer"`——点击后在**当前标签页**导航离开宿主页面，破坏 D-21"消毒后链接统一新窗口打开并切断 opener 引用"的安全不变量。攻击面有限（无脚本执行、href 经 DOMPurify URI 过滤），但这是本阶段以 fixtures + 双层断言锁定的核心安全承诺的一个可绕过分支，且现有 8 个攻击样本未覆盖 SVG 锚点。
**Fix:**
```ts
purify.addHook("afterSanitizeAttributes", (node) => {
  // SVG 命名空间 tagName 为小写 "a"——大小写双检或按局部名判定。
  if (node.tagName === "A" || node.tagName === "a") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});
```
并在 `test/fixtures/attack-samples.json` 增补一条 `<svg><a xlink:href="https://x">t</a></svg>` 样本固化回归。

#### WR-02: DOMPurify 使用全默认 profile——`style` 元素/属性、`form`、`input`、`button`、`img` 均从未可信消息放行，可整页重排版与钓鱼

**File:** `packages/web-sdk/src/render/render-markdown.ts:60`
**Issue:** `purify.sanitize(...)` 未传任何 profile 配置。DOMPurify 默认白名单包含 `style` 元素与 `style` 属性、`form`、`input`、`button`、`img` 等。消息 text 来自任意外部 Webhook 发送方：`<style>` 元素无论出现在文档何处都**全文档生效**，发送方可重排版整个宿主页面——例如在查看器上叠 `position:fixed` 全屏透明层覆盖"服务端地址/Channel Key"表单做点击钓鱼，或把页面文字改造成误导内容；`<form>`+`<input>`+`<button>` 可渲染伪造 UI（查看器的 CSP `form-action 'self'` 挡住了跨域提交，但第三方宿主页面通常无 CSP）；`<img src="https://tracker/pixel">` 构成阅读回执/IP 探针（`img-src * data:` 放行）。这些不构成脚本执行（主防线成立），但都是"外部发送方控制宿主页面呈现"的面，对一个把不可信 Markdown 渲染进宿主页面的 SDK 属于应显式收敛的攻击面。
**Fix:**
```ts
return purify.sanitize(marked.parse(text, { async: false }), {
  // 消息 Markdown 不需要页面级元素与表单控件；style 走属性级禁用。
  FORBID_TAGS: ["style", "form", "input", "button", "select", "textarea", "iframe"],
  FORBID_ATTR: ["style"],
});
```
若要保留消息内 `<img>`（GFM 图片是合法用例），至少在 README 记录追踪像素取舍；若要保留内联代码高亮类样式再单独评估 `class` 白名单。

#### WR-03: viewer.js localStorage 读取路径无异常防护——写入有 try/catch、读取没有，存储被禁时脚本中途夭折

**File:** `packages/server/public/viewer.js:198-199`（对照写入侧 170-175）
**Issue:** 写入侧已有 `try { localStorage.setItem(...) } catch { /* 隐私模式降级 */ }`，但初始化侧 `serverInput.value = urlServer || window.localStorage.getItem(LS_SERVER) || ...` 未包 try/catch。当浏览器完全禁用站点存储（Chrome"阻止所有 Cookie"）时，**访问 `window.localStorage` getter 本身**抛 SecurityError——脚本在 198 行中断：URL 参数自动连接（200-202）、攻击样本按钮区（204-230）、`window.__pushhubViewer` 调试句柄（233）全部不执行，页面半残且只有控制台报错。这正是写入侧注释自认过的环境，防护却不对称。
**Fix:**
```js
function lsGet(key) {
  try { return window.localStorage.getItem(key); } catch (e) { return null; }
}
// 198-199 行改为：
serverInput.value = urlServer || lsGet(LS_SERVER) || window.location.origin;
keyInput.value = urlKey || lsGet(LS_KEY) || "";
```

#### WR-04: 畸形 serverUrl 使 PushHub 构造函数同步抛出未捕获异常——查看器 UI 卡死在"连接中"且无错误提示

**File:** `packages/web-sdk/src/pushhub.ts:91-94, 216-232`；`packages/server/public/viewer.js:161-183`
**Issue:** URL 构造为 `serverUrl.replace(/^http/, "ws")`（无 `/i` 标志）+ 拼接。三类常见输入产生非法 WS URL：大写 scheme（`HTTP://…`——正则不匹配，前缀保持 `HTTP:`）、非 http(s) scheme（如 `javascript:alert(1)`）、相对地址或空串。此时 `new WebSocket(...)` 同步抛 SyntaxError，经 `dispatch → apply(createSocket) → openSocket` 一路上抛出构造函数。查看器 `connect()` 对 `new window.PushHub(...)` 无 try/catch：表单提交处理器中断，状态行已先设为"连接中"（176 行）但永不迁移，error bar 永不显示——用户面对一个静默卡死的页面。SDK 侧的 URL 规范化缺失与查看器侧的异常处理缺失叠加成完整故障。
**Fix:** 两层都修。SDK 侧（根治）——构造器内规范化并路由到 error 事件而非抛出：
```ts
constructor(serverUrl: string, channelKey: string) {
  const normalized = serverUrl.trim().replace(/^http(s?):/i, "ws$1:").replace(/\/+$/, "");
  let u: URL;
  try {
    u = new URL(normalized);
  } catch {
    // 不抛出：进入 offline 态并发 error 载荷（不含密钥），宿主可感知。
    this.dispatch({ kind: "CONNECT" /* 无效 URL：由首个 emitError 表达 */ });
    // 或最小改动：throw new TypeError("PushHub: serverUrl must be an absolute http(s) URL");
  }
  if (u.protocol !== "ws:" && u.protocol !== "wss:") { /* 同上 */ }
  ...
}
```
查看器侧（兜底）——`connect()` 内 `new window.PushHub(...)` 包 try/catch，catch 中 `setStatus("offline")` + `showError({ message: "服务端地址无效" })`。

### Info

#### IN-01: sendPing 有 try/catch、sendSync 没有——防御模式不对称

**File:** `packages/web-sdk/src/pushhub.ts:158-165`（对照 167-178）
**Issue:** `sendPing` 捕获发送异常并注释"close/死线路径接管"；`sendSync` 直接 `this.ws.send(...)`。单线程下 readyState 检查后同步 send 实际难以抛出，但若某日抛出，dispatch 会中断动作序列且机器状态已推进（awaitingInitialHistory 已清、syncCount=1），本次连接的补拉静默丢失。统一防御模式可消除该潜在分叉。
**Fix:** `sendSync` 的 `this.ws.send(...)` 包与 sendPing 相同的 try/catch（注释指向重连路径接管），或抽一个 `safeSend(data)` 私有方法两处共用。

#### IN-02: 强制重连后机器丢失"页面 hidden"事实——WS_OPEN 无条件重 arm 心跳

**File:** `packages/web-sdk/src/connection-machine.ts:287-296`（对照 339-354）
**Issue:** VISIBILITY(hidden) 取消心跳与探活的意图是"页面冻结省额度"；但 pongDeadline/probe 死线触发的 forceReconnect → 新 WS_OPEN 会重新 `armTimer("heartbeat")`，此后后台标签页恢复 30s 周期 ping，直到下一次 visibilitychange 才再取消。当前影响近零（ping 经 setWebSocketAutoResponse 零计费），但 Phase 5/6 按同构语义移植时会原样带走这个状态缺口。
**Fix:** 机器内增加 `let visible = true` 状态位：VISIBILITY 事件更新之；WS_OPEN 时仅在 `visible` 为真时 arm 心跳（hidden 时依赖服务端数据到达或下次 visible 探活唤醒）。至少在文件头行为契约注释中显式记录该取舍。

#### IN-03: playwright `reuseExistingServer: true` 可能静默测试陈旧构建

**File:** `packages/web-sdk/playwright.config.ts:18`
**Issue:** 端口 4911 上若有上次运行遗留的 wrangler dev（serve 的是当时的 pushhub.js 产物），E2E 会静默复用，测到旧 SDK——与"Pitfall 9：E2E 测的是构建产物"的立意相悖。本地迭代提速的合理选择，但残留服务时会产出误导性绿灯。
**Fix:** 保持现状可接受，但建议在 CI 入口用 `reuseExistingServer: !process.env.CI`（Playwright 官方惯例），或在 README 测试一节注明"复测前手动确认 4911 无残留进程"。

#### IN-04: `canvasinfoBg` 非 CSS 标准系统色关键字——不受支持时静默降级为透明

**File:** `packages/server/public/index.html:80`
**Issue:** `.msg-body pre { background: canvasinfoBg; }`——CSS Color 4 标准系统色集为 Canvas/CanvasText/GrayText/Highlight 等，`canvasinfoBg` 不在标准列表（个别引擎可能有私有映射）。不识别时整条 background 声明被丢弃，代码块背景回退为透明，仅视觉降级无功能影响。
**Fix:** 换用确定可用的值：`background: Canvas;`（配 `color-scheme: light dark` 自动适配）或显式色值 + `@media (prefers-color-scheme: dark)` 覆盖。

#### IN-05: CSP `img-src * data:` 放行消息内远程图片——追踪像素/阅读回执面

**File:** `packages/server/public/index.html:10`
**Issue:** GFM 图片是消息合法用例（`![](https://chart.example/x.png)`），但任意发送方因此可借图片加载拿到查看者 IP 与阅读时间（追踪像素）。与 WR-02 的 img 放行是同一取舍的两面，属有意识的权衡范围，建议至少在 index.html 的 CSP 注释或 README 中记录该隐私取舍，供后续需要时收紧（`img-src 'self' data:`）。

---

_Reviewed: 2026-08-26T17:25:24Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
