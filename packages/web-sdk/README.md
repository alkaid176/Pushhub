# @pushhub/web-sdk — pushhub.js SDK API 参考

单文件 IIFE 产物 `pushhub.js`：`<script>` 引入即用（零依赖零构建，WEB-01），
全局暴露 `PushHub` 类。本文档是 SDK 对外契约的完整记载，也是 **Phase 5（Tauri
桌面）/ Phase 6（Android）移植时照抄的接口契约**——事件 API 表面的命名与语义
以本文为准（one-way，02-01 Task 2 用户裁决定稿）。

- 产物路径：`https://pushhub.dyun.org/pushhub.js`（Cloudflare 静态资产分发，
  命中不计 Worker 请求额度，SC4）
- 源码：`packages/web-sdk/src/`（`pushhub.ts` 公开类；`connection-machine.ts`
  纯状态机；`render/render-markdown.ts` 可移植渲染模块）
- 行为基线：单测 100 例 + Playwright E2E（tracer / reconnect / viewer 三 spec）

## 两行接入（WEB-01 形态）

```html
<script src="https://pushhub.dyun.org/pushhub.js"></script>
<script>
  const hub = new PushHub("https://pushhub.dyun.org", "<channelKey>");
</script>
```

构造即自动连接（D-18）。`serverUrl` 填服务端任意 http(s) 地址，SDK 内部转换为
WS URL（`http→ws` / `https→wss` + `/api/ws/<encodeURIComponent(channelKey)>`）。
demo 查看器（`https://pushhub.dyun.org/`）就是这两行接入的活样本（D-23）。

## 五事件（D-16 + 04-03 answered）

```ts
hub.on("message", (m: MessageFrame) => {});
hub.on("history", (h: HistoryFrame) => {});
hub.on("status", (s: PushHubStatus) => {});
hub.on("error", (e: PushHubErrorPayload) => {});
hub.on("answered", (a: AnsweredFrame) => {}); // 04-03 第五事件（纯加法）
```

`on()` 返回实例本身（可链式）。同一事件可注册多个回调；宿主回调抛异常不会
毒害 SDK 连接（内部捕获）。

| 事件 | 载荷 | 语义 |
|------|------|------|
| `message` | `MessageFrame`（v:1 线协议帧原样：`wid`、`seq`、`title?`、`text`、`options?`、`click_url?`、`priority`、`answered*`、`created_at`） | 实时帧逐条。text 是 Markdown 原文（哑管道，逐字透传） |
| `history` | `HistoryFrame`（`messages[]`、`oldest_kept_seq`、`has_more`） | 补拉批次（首拉 + 重连 sync + 翻页统一走此事件，SDK 不展开批次进 message）。**on("history") 载荷的 messages 永远只含宿主未见消息；oldest_kept_seq 与 has_more 原样透传**（D-16×D-17 交集契约：SDK 去重窗口消化实时与补拉的交叠，宿主两侧合流永不见重复；`oldest_kept_seq` 大于 1 且宿主已翻到保留窗口底部时可呈现"更早消息已清理"分隔线，D-10 诚实缺口语义） |
| `status` | `"connecting" \| "online" \| "reconnecting" \| "offline"` | 连接状态变化（仅变化时发射）。首连 `connecting→online`；意外断连 `reconnecting→connecting→online`；主动 `disconnect()` 后为 `offline` |
| `error` | `{ message: string; code?: string; fatal?: boolean }` | 错误载荷。`fatal: true`（如服务端线协议版本不识别，v!==1）后 SDK 断开且不再自动重连，需宿主调 `connect()` 手动恢复。载荷绝不包含 Channel Key 子串 |
| `answered` | `AnsweredFrame`（`wid`、`seq`、`answered: true`、`answered_by: string \| null`、`answered_at: number`、`answered_content: string \| null`） | 群内**任何人**对消息的处置结果实时扇出（04-03 第五事件，回复闭环）。含自己回复后的回声——同一 wid 可能多次到达（多端竞态），宿主按 `wid` 幂等消化。**安全**：`answered_content` 是回复 Markdown 原文（透传不转义，进 DOM 前必经 `PushHub.renderMarkdown`）；`answered_by` 是自报展示名，渲染必须用 `textContent` 直插、不可拼进 innerHTML（D-53） |

`ack` 帧（回复者本人的最小确认 `{v,type,wid}`）被 SDK **静默消费——无公共事件**
（04-01 Q4 定稿：answered 扇出即公共确认信号；回复者由随后的 answered 自证
回复成功，单独 ack 公共事件徒增 API 面）。

消息帧字段全集见 `@pushhub/shared`（`packages/shared/src/index.ts`）——SDK 与
服务端共用同一协议事实源，本 SDK 不私自加工帧结构。

## 生命周期三方法（D-18）

| 方法 | 行为 |
|------|------|
| `new PushHub(serverUrl, channelKey)` | 构造即连（两行接入体验） |
| `disconnect()` | 主动断开并停止重连；之后可再 `connect()` 恢复 |
| `connect()` | 手动（重）连接——`disconnect()` 后恢复，或 fatal 后手动重启 |
| `destroy()` | disconnect + 移除全部监听 + 释放资源（SPA 卸载内存安全） |

SDK 内部同时注册 `visibilitychange`（D-27 探活）：页面回前台主动 ping + 5 秒
死线，超时强制重连续补拉（iOS Safari 冻结恢复路径）；`destroy()` 会移除监听。

## 回复消息：hub.reply()（WEB-03，04-03）

```ts
hub.reply(wid, { selected_option: "确认" }, "运维笔记本"); // 快捷选项 + 自报展示名
hub.reply(wid, { text: "**自定义** Markdown 回复" });      // 自定义输入（匿名）
```

| 参数 | 约束 |
|------|------|
| `wid` | 目标消息 ID（`message` / `answered` 帧的 `wid` 字段） |
| `payload` | **恰一载荷**：`selected_option`（须在原消息 `options` 白名单内——域级校验在服务端）或 `text`（Markdown 原文 ≤ 32KB，SDK 零转义直发，RPL-02 哑管道） |
| `by?` | 自报展示名，≤ 64 UTF-16 码元（`BY_MAX`，D-53）。SDK **不持久化**（持久化由宿主承担）；缺省即匿名回复（`answered_by` 存 null） |

**fail-fast 语义（不排队、不重试、不抛异常）**——两种本地拒绝均经 `error` 事件
返回，方法本身立即返回 void：

| code | 触发 | 宿主应对 |
|------|------|---------|
| `invalid_frame` | `selected_option` 与 `text` 同真或同假 | 修正载荷（服务端权威校验的本地前置，省一次往返） |
| `not_connected` | 状态非 `online`（connecting / reconnecting / offline 或 ws 未就绪） | 重试时机由宿主决定（如等 `on("status")` 回 `online` 后重发）——重试策略属业务层，SDK 刻意不代劳 |

服务端域级拒绝（`not_found` / `already_replied` / 白名单外 `invalid_frame`）经
同一 `error` 事件透传且**连接保持不断开**。回复闭环最小示例：

```ts
const hub = new PushHub("https://pushhub.dyun.org", "<channelKey>");
hub.on("message", (m) => {
  // 渲染消息后，用户点击快捷选项即回复：
  // hub.reply(m.wid, { selected_option: m.options?.[0] ?? "" }, "我的笔记本");
});
hub.on("answered", (a) => {
  // 群内任何人处置了消息 a.wid —— 按 wid 幂等更新本地消息状态；
  // a.answered_content 进 DOM 前必经 PushHub.renderMarkdown（同 message.text）
});
```

## 静态 PushHub.renderMarkdown(text)（D-19 / WEB-05 双形态）

```ts
const safeHtml: string = PushHub.renderMarkdown("**bold** 与 [链接](https://example.com)");
el.innerHTML = safeHtml; // 已消毒，可直接入 DOM
```

Markdown（GFM：表格/任务列表/删除线；单换行成 `<br>`）→ DOMPurify 消毒 →
安全 HTML 字符串。**消息来自任意外部 Webhook 发送方，消息内容进 DOM 前必经
本管道**（marked 不消毒原始 HTML，不经消毒直通 = 存储型 XSS 直通所有客户端）。

- 消毒后链接一律强制 `target="_blank"` + `rel="noopener noreferrer"`（D-21，
  防反向 tabnabbing）；`javascript:` / `data:` 等危险 href 被移除
- 无 `window` 的环境（SSR 导入等）返回纯转义文本（无富文本、无执行面）
- **宿主也可以完全不用它**：只消费 `on("message")` 的原始数据自行渲染（自行
  渲染时消毒责任在宿主）——SDK 无 UI、不拥有宿主 DOM 结构

### 消息内 click_url（D-21"跳转同理"条款）

`MessageFrame.click_url` 是消息内不可信跳转指令。宿主实现跳转时必须：
scheme 白名单（仅 `http` / `https` 放行，其余丢弃）+ `window.open(url, "_blank",
"noopener")`。查看器 `viewer.js` 的 `safeOpenClickUrl` 是参考实现。

## 心跳、退避与去重参数

全部行为固化于 `connection-machine.ts`（纯状态机，02-02）：

| 参数 | 值 | 行为 |
|------|----|------|
| `HEARTBEAT_INTERVAL_MS` | 30,000 | 每 30s 发一次应用层 ping（服务端 auto-response 零唤醒自动回 pong） |
| `PONG_DEADLINE_MS` | 10,000 | ping 后 10s 未见 pong 判死线，强制断开重连（防静默假活） |
| `PROBE_DEADLINE_MS` | 5,000 | visibilitychange 回前台立即探活，5s 无响应强制重连续补拉 |
| `BACKOFF_BASE_MS` | 500 | 意外断连重连退避基准 |
| `BACKOFF_CAP_MS` | 60,000 | full jitter 退避上限：`delay = random() * min(cap, base * 2^attempt)` |
| `DEDUP_WINDOW` | 1000 | seq 去重窗口宽度（实时与补拉交叠去重，内存有界） |
| `SYNC_PAGE_MAX` | 100 | has_more 翻页硬上限，超限发 `error`（code `sync_page_limit`）不再翻 |

重连确定序列：WS open → 以"连接前游标"为 sync 基准 → 首拉 history（服务端
accept 即推最近 50 条）→ 无条件 sync 补拉 → `has_more` 以最新游标续翻——
断连期间消息零丢失、宿主零重复（SC2）。

## Channel Key 存储取舍（查看器场景）

demo 查看器把 Channel Key 明文存本机浏览器 `localStorage`（键 `pushhub.key`、
`pushhub.server`，下次打开免填，D-24）。这是用户自担的便利取舍：本机浏览器
存储的读取门槛高于密钥经 URL 传输的面。接入方自行权衡；清除方式为删除站点
本地数据。SDK 本身**不**持久化任何密钥。

## 三端移植注意（Phase 5 Tauri / Phase 6 Android）

- **事件 API 表面即接口契约**：五事件语义（04-03 answered 纯加法）、status
  枚举、error 载荷结构、生命周期三方法与 `reply()` 的 fail-fast 语义按本文
  移植；上表七组参数建议同值（去重窗口与翻页上限直接影响零重复语义）
- `reply()` 在三端同构 fail-fast：非在线即本地 `not_connected` 拒绝，载荷
  恰一性本地前置校验——不排队不重试（用户重试语义属宿主业务层，Pattern 7）
- `connection-machine.ts` 是零平台依赖纯状态机（输入事件流 → 输出动作流，
  随机源/定时器全部注入）——Tauri 侧按同构方式对接 Rust 状态机
- 渲染消毒模块可直接复用：`import { renderMarkdown } from
  "@pushhub/web-sdk/src/render/render-markdown"`（D-20 可移植纯 TS 模块，
  Tauri WebView 前端直接 import 同一模块，四端消毒逻辑不漂移）
- 心跳 ping 帧必须是逐字节字符串 `{"v":1,"type":"ping"}`（服务端
  setWebSocketAutoResponse 按字面量匹配；运行时对象序列化会键序反转失配）

## ?v= 缓存参数维护约定

引用 `/pushhub.js` 时带版本查询参数（如 `/pushhub.js?v=0.1.7`）规避浏览器
缓存——stale SDK 缓存是部署后"改了没生效"的经典来源。**每次重建产物
（`pnpm --filter @pushhub/web-sdk run build`）并部署后，同步更新引用处的
`?v=` 值**（取当次部署版本号）；查看器页 `index.html` 中的引用同样遵守。
