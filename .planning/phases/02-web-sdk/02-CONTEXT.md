# Phase 2: Web SDK 参考客户端 - Context

**Gathered:** 2026-08-26
**Status:** Ready for planning

<domain>
## Phase Boundary

交付单文件 `pushhub.js`（esbuild IIFE，global `PushHub`）：零依赖零构建 `<script>` 引入即用（WEB-01/02），内置指数退避 + full jitter 重连（上限 60s）与 since 游标补拉、宿主无感（WEB-04），marked + DOMPurify 消毒渲染辅助（WEB-05），SDK 同时是 Tauri/Android 移植的参考实现与最廉价的端到端协议验证器。另交付轻量查看器 demo 页（worker 静态资产）。SDK 事件 API 表面即三端移植的参考接口契约。

**不在本期**：回复能力（WEB-03，Phase 4——服务端 reply API 未就绪）、可视化构造消息的测试页（ADM-04，Phase 4）、npm 包形态（PLT-03，v2）、任何 Tauri/Android 代码（Phase 5/6）。

</domain>

<decisions>
## Implementation Decisions

### SDK 事件 API 表面（三端移植参考契约）

- **D-16:** 事件枚举四事件：`on("message")`（实时帧逐条）、`on("history")`（补拉批次——首拉与增量统一，含 `oldest_kept_seq`/`has_more`，宿主可感知"更早消息已清理"分隔线时机）、`on("status")`（连接状态变化）、`on("error")`（错误）。SDK 不展开 history 批次进 message 事件——语义与冻结协议帧一一对应，无 SDK 私有加工 — **Reversibility:** one-way — 事件枚举是 SDK 对外公开 API，Phase 5/6 按此契约移植，发布后变更即破坏宿主页面
- **D-17:** seq 幂等去重归 SDK：内部维护 last_seq + 已见 seq 窗口，实时帧与补拉帧交叠时自动去重，宿主回调永不见重复消息——服务端承诺零丢失零重复（SC2），SDK 是第二道防线（防部署断连窗口的边界交叠） — **Reversibility:** costly — 去重语义进 SDK 行为契约，三端移植各需一致实现
- **D-18:** 连接生命周期三方法：`new PushHub(serverUrl, channelKey)` 构造即自动连接（SC1 两行接入体验）；`disconnect()` 主动断开并停止重连（可再 connect 恢复）；`destroy()` = disconnect + 移除全部监听 + 释放资源（SPA 卸载内存安全） — **Reversibility:** one-way — 构造即连与生命周期方法是公开 API 形态，宿主与后续端按此编程

### 渲染辅助形态

- **D-19:** 渲染辅助为纯函数：`PushHub.renderMarkdown(text) → string`（安全 HTML），宿主自己拼 DOM；SDK 不含消息列表 UI、不拥有 DOM 结构 — **Reversibility:** costly — renderMarkdown 是公开 API；不含 UI 是 SDK 定位边界（宿主 DOM 自由度承诺）
- **D-20:** 渲染核心（marked 配置 + DOMPurify 消毒管道）写成可移植纯 TS 模块：pushhub.js 打包它，Phase 5 Tauri 前端直接 import 同一模块——模块禁止 window/document 之外的环境假设（DOMPurify 原生支持多环境）。这是"四端消毒逻辑不漂移、XSS 防线一致"的组织保障 — **Reversibility:** costly — 模块环境假设约束写进代码结构，Tauri 依赖此路径复用
- **D-21:** 消毒后链接统一强制 `target=_blank + rel=noopener noreferrer`（DOMPurify hook 实现）——Webhook 消息链接不可信，防反向 tabnabbing；click_url 跳转同理 — **Reversibility:** reversible — hook 行为可调，但三端应保持一致

### Demo 页（轻量查看器）

- **D-22:** demo 页为轻量消息查看器：接入表单（服务端地址 + Channel Key）+ 消息流列表（Markdown 渲染 + 时间戳）+ 连接状态指示 + 攻击样本按钮（验 SC3 消毒，含 `<script>`/`<img onerror>` 样本）。不构造消息、不回复（发消息用 curl/smoke.mjs，回复是 Phase 4 域） — **Reversibility:** reversible
- **D-23:** 查看器即 SC1 验证：它本身用 `<script src="/pushhub.js">` + `new PushHub()` 零构建接入——其存在即 SC1 证明，不另建 blank.html — **Reversibility:** reversible
- **D-24:** 查看器含排障细节：接入配置存 localStorage（下次免填）；部署断连后自动重连续补拉是 SC2 观察点；"更早消息已清理"分隔线渲染（D-10 oldest_kept_seq 语义可视化） — **Reversibility:** reversible

### 测试矩阵与 iOS 策略

- **D-25:** SDK 测试两层：happy-dom 单测（重连状态机、seq 去重、渲染消毒纯逻辑，mock WebSocket）+ Playwright 真浏览器 E2E（真服务端连真频道收真消息、断线重连补拉、攻击样本渲染验证）。不加 SDK 级 vitest-pool-workers 集成层——SDK 是浏览器产物，Node 池跑 DOM 依赖代码有环境裂缝，服务端兼容性已由 Phase 1 服务端测试 + Playwright E2E 覆盖 — **Reversibility:** reversible — 测试栈组织可调
- **D-26:** Playwright E2E 服务端用本地 `wrangler dev`（真 DO/真 KV/真 WS，localhost）——快、可重复、无网络依赖、不耗生产额度；生产域名（pushhub.dyun.org）验证沿用 Phase 1 D-14/D-15 部署后冒烟节奏，不在自动化测试里连生产 — **Reversibility:** reversible
- **D-27:** iOS Safari 不做专项测试，但 `visibilitychange` 探活逻辑写进 SDK（页面回前台主动探活，死线即重连续补拉）——标准 API、逻辑完备不依赖真机验证；iOS 真机验证不追踪不记 WINDOWS.md，风险后置到有真实 iOS 使用反馈时 — **Reversibility:** reversible

### Claude's Discretion

- status 事件的枚举具体值（connecting/online/offline/reconnecting 之类）与 error 事件载荷结构——规划阶段随 API 细化定
- marked 配置细节（语法子集、sanitize 钩子顺序）与渲染模块文件组织
- 重连退避参数（base/cap/jitter 具体数值——上限 60s 已锁）、心跳周期与死线判定阈值
- packages/web-sdk 包的内部目录结构与 npm scripts 组织
- 攻击样本 fixture 的具体内容集（覆盖 `<script>`/`<img onerror>`/`javascript:` 等，够回归即可）
- 查看器页面布局风格

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### 冻结协议契约（本期的最高权威文件）
- `packages/shared/src/index.ts` — v1 线协议唯一事实源：全帧类型（MessageFrame/HistoryFrame/PongFrame/WsErrorFrame/SyncFrame/PingFrame）+ 常量（INITIAL_FETCH=50/SYNC_LIMIT_*=200|500/PROTOCOL_VERSION=1）——SDK 帧解析与常量必须与此对齐
- `packages/shared/src/validators.ts` — 纯函数校验器；SDK 侧帧校验可复用
- `packages/shared/fixtures/` — 12 个 golden fixtures 正反例——SDK 解析器的契约测试输入基线
- `packages/shared/README.md` — 协议演进三条规则（只加字段/未知字段忽略/未知 v 断连）——SDK 必须按"未知字段忽略"实现前瞻兼容

### 服务端集成点
- `packages/server/src/chat-room.ts` — ChatRoom DO：WS 升级流程（accept 后立即推首拉 history）、sync 补拉（keyset/limit/oldest_kept_seq）、PING_FRAME 自动应答字面量（`{"v":1,"type":"ping"}`）——SDK 心跳与补拉行为的服务端对应实现
- `packages/server/src/index.ts` — `GET /api/ws/:channelKey` 路由（Channel Key 走路径段——浏览器 WS 无法带鉴权头）；无效密钥 401 拒绝
- `packages/server/wrangler.jsonc` — assets asset-first 配置（public/ 目录、不设 run_worker_first）；`packages/server/public/` 是 pushhub.js 与 demo 页的挂载点

### 项目规划
- `.planning/ROADMAP.md` §Phase 2 — 阶段目标、4 条成功标准、Research note（iOS visibilitychange 已裁决为 D-27）
- `.planning/REQUIREMENTS.md` — WEB-01/02/04/05 四条本期需求与 Out of Scope
- `.planning/phases/01-server-core/01-CONTEXT.md` — Phase 1 全部决策（D-01~D-15），特别是 D-09（首拉 50 条）、D-10（oldest_kept_seq 缺口语义）、D-11（补拉全走 WS）

### 研究与环境
- `.planning/research/STACK.md` §Web SDK — esbuild 命令行、marked 18 + DOMPurify 3.4 版本、体积预算表（~70KB min/~23KB gzip）
- `D:\AIworkspaces\PushHub\.claude\CLAUDE.md` §Web SDK / §Testing — 技术栈约束全文（IIFE 单文件、手写重连、vitest + happy-dom、Playwright 冒烟）
- `DEPLOY.md` — 部署节奏与版本 +1 规则（deploy 必须 `pnpm run deploy`）

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `packages/shared/`（冻结协议包）：SDK 源码直接 import 其 TS 类型与常量（workspace 内部包，零构建步）——帧类型、INITIAL_FETCH、PROTOCOL_VERSION 全部复用，不重复定义
- `packages/server/public/`：静态资产目录已就位（现仅 index.html 占位页，Phase 2 将替换/挂载 pushhub.js 与 demo 页）；wrangler.jsonc assets 配置无需改动
- pnpm workspace `packages/*` 布局：新建 `packages/web-sdk` 即自动纳入 workspace
- esbuild 0.28.1 已在 lockfile（vitest 传递依赖），onlyBuiltDependencies 白名单已含 esbuild

### Established Patterns
- 测试规范（Phase 1 固化）：一场景一测试文件；vitest 池隔离注意项——SDK 单测沿用 vitest 但换 happy-dom 环境
- TypeScript 7.0.2 + tsconfig.base.json（strict/ESNext/resolveJsonModule）——SDK 包继承 base 配置；golden fixtures 静态 import 的能力已在 base 配置就绪
- 部署后生产冒烟节奏（D-14/D-15）：每计划部署 +1 版本、固定 checklist、经 https://pushhub.dyun.org（workers.dev SNI 阻断）

### Integration Points
- WS 入口：`wss://<server>/api/ws/<channelKey>`——SDK 连接 URL 的构造规则
- 服务端行为锚点：accept 成功即推首拉 history（since:null → 最近 50 条）；每次部署全量断连（SC2 混沌测试的触发方式）；无效 Channel Key → HTTP 401 握手失败
- 静态资产分发：pushhub.js 放 `packages/server/public/pushhub.js`，`/pushhub.js` 直接命中资产不触发 Worker（SC4 验收：dashboard 请求计数不增）

</code_context>

<specifics>
## Specific Ideas

- SDK 是"参考实现"定位：事件 API 表面（四事件 + 三生命周期方法）即 Phase 5/6 移植时照抄的接口契约——命名与语义要经得起四端对齐
- 渲染核心模块的"可移植纯 TS"约束（D-20）是为 Phase 5 Tauri 前端直接 import 准备的——写代码时把它当被两个消费者共享的库对待
- "每次部署即一次免费混沌测试"（SC2）：部署后打开查看器页面观察自动重连 + 补拉，是 D-15 冒烟 checklist 的自然扩展
- 攻击样本回归（SC3）：`<script>`、`<img onerror>` 等样本经 renderMarkdown 输出必须无害——fixture 化进测试

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 2-Web SDK 参考客户端*
*Context gathered: 2026-08-26*
