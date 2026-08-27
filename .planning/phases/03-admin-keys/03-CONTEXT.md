# Phase 3: 管理页与密钥生命周期 - Context

**Gathered:** 2026-08-27
**Status:** Ready for planning

<domain>
## Phase Boundary

交付 Admin Key 登录的 Web 管理页（vanilla 单文件静态资产）+ 配套 Admin API 扩展：频道创建/列表/**删除**、每频道**多 Send Key**（可选标签、逐个吊销、上限 10）、Channel Key **重置即踢全部连接**、admin HTTP 消息历史查询（排障入口）、创建即展示可复制接入片段。交付后管理员**零命令行**完成频道与三级密钥全生命周期管理——核心用户旅程：管理员登录 → 建频道 → 给机器人创建带标签 Send Key → 机器人 webhook 发消息 → 客户端实时收提示。

**不在本期**：回复能力与 callback（Phase 4）、可视化构造消息的测试页（ADM-04，Phase 4）、npm 包形态（v2）、任何 Tauri/Android 代码（Phase 5/6）、频道改名/编辑（未讨论，若需要属后续增量）。

</domain>

<decisions>
## Implementation Decisions

### 登录与密钥持有

- **D-28:** Admin Key 存 localStorage 长期持有（同 viewer D-24 模式），登出按钮手动清除；不引入服务端会话（零 KV 写成本）。Admin Key 本身就是最高凭据，localStorage 持有不扩大泄露面；管理页 CSP 沿用 viewer 纵深防御模式（`script-src 'self'`） — **Reversibility:** reversible
- **D-29:** 频道密钥（Channel Key / Send Key）管理页默认**掩码显示**（前缀+后缀，如 `phc_Ab3…xYz`），点眼睛按钮单条揭示，复制按钮一键拷贝——防肩窥/防截屏/防共享屏幕误泄（GitHub/CF dashboard 同模式）。列表 API 响应即含完整密钥（掩码是纯前端渲染行为，API 不做掩码裁剪——保持 API 与 UI 职责分离） — **Reversibility:** reversible

### 多 Send Key 体系

- **D-30:** 创建 Send Key 时**可选填标签**（如 `deploy-bot`/`monitor-script`），列表按标签展示——KEY-03 "不同脚本各用各的 Key" 场景的直接辨识支撑。标签进 KV `sk:` 值结构（`{channelId, label?}`），同频道标签不强制唯一（个人工具，重名无害） — **Reversibility:** costly — KV 值结构变更需迁移既有 `sk:` 键
- **D-31:** 每频道 Send Key **上限 10 个**，超出返回 400——防公网 API 被脚本 bug 循环建 Key 静默烧 KV 写额度（免费层 1000 写/天），同时给多脚本场景留足余量 — **Reversibility:** reversible
- **D-32:** 吊销 Send Key = **删键即可**：KV 删 `sk:` 键 + DO `rate_sends` 表对应清理；正在使用的脚本下次 POST 即 401（≤60s 边缘缓存窗口，已文档化行为）。不踢 WS（Send Key 不用于 WS 连接），不做 DO 审计日志行（v1 无消费方） — **Reversibility:** reversible

### Channel Key 重置与踢连接

- **D-33:** 重置 Channel Key = KV 删旧 `ch:` 键写新键 + **同步调 DO 新增 kickAll 内部路由踢出全部现有 WS 连接**（SC2 "DO 内强一致、立即踢出" 的实现）+ `id:` 反向索引同步更新。≤60s KV 边缘缓存双活窗口在管理页 UI 上文案提示（重置确认框注明"最长约 1 分钟后旧密钥全局失效"） — **Reversibility:** costly — kickAll 路由进 DO fetch 契约
- **D-34:** 频道删除复用同一 kickAll 路由：删除 = 踢全部连接 + KV 三前缀键清理 + DO 存储删除（messages/rate_sends 表全清）。**硬删不可恢复**；确认交互为**输入频道名前缀匹配才允许删**（GitHub 删仓库模式）——防误删的交互强度与"个人工具重建成本低"的安全网取舍 — **Reversibility:** one-way — 删除即数据不可恢复，这是产品语义本身

### Admin API 设计

- **D-35:** 新增管理 API 沿用 **REST 资源化风格**（与 D-12 既有 `POST/GET /api/admin/channels` 一致）：`DELETE /api/admin/channels/:channelId`、`POST /api/admin/channels/:channelId/send-keys`（创建，body 含可选 label）、`DELETE /api/admin/channels/:channelId/send-keys/:key`、`POST /api/admin/channels/:channelId/reset-channel-key`、`GET /api/admin/channels/:channelId/messages`（seq 游标翻页）。全部 Bearer Admin Key 鉴权（D-13 两段式常时比较复用）；错误响应沿用 D-06 信封。**注**：`id:` 记录需从单 sendKey 演进为 sendKeys 列表——`GET /api/admin/channels` 响应结构同步演进（向后不兼容变更可接受：唯一消费方是本期新建的管理页与 smoke 脚本，同版本内联动更新） — **Reversibility:** costly — API 路径与响应结构是对外契约
- **D-36:** 消息历史查询走 **DO 新增内部 `/history` 路由**（Worker 层 admin 鉴权后经 X-PH-Verified 内部头转发，同 `/publish`/`/ws` 模式）：seq 游标 keyset 翻页直查 messages 表，复用既有查询逻辑与行映射（含 answered 字段集——排障即看回复状态）。**不属 D-11 "补拉全走 WS" 约束**——那是客户端协议域；admin 是排障工具，需任意深度翻页，WS 补拉做不到。数据留 DO（单群单库天然隔离），不导出 KV — **Reversibility:** costly — 内部路由与翻页语义进 Worker↔DO 契约

### 管理页 UI

- **D-37:** 管理页**vanilla 单文件**（手写 HTML+CSS+JS，放 `packages/server/public/`，零构建零依赖静态资产托管，SC4 asset-first 命中不触发 Worker）——同 viewer 已验证模式，管理页复杂度与 viewer 同量级（表单+列表+状态指示） — **Reversibility:** reversible
- **D-38:** 信息架构**单页列表+详情**：频道列表+创建表单在上方/左侧，选中频道展开详情面板（Channel Key 管理、Send Key 列表、历史入口、删除入口）。频道数少（个人工具 < 20）导航最短 — **Reversibility:** reversible
- **D-39:** 创建频道/创建 Send Key 成功后展示**可直接复制的接入片段**：webhook URL + curl 示例（发给机器人接入方，含 Bearer Send Key 头）、服务端地址 + Channel Key（给客户端配置）+ viewer 页直达链接。机器人接入方零文档上手——本阶段"零命令行"目标的临门一脚 — **Reversibility:** reversible
- **D-40:** 历史排障视图：管理页内嵌渲染历史列表（Markdown 经 web-sdk 同款消毒渲染管线——直接 `<script src="/pushhub.js">` 用 `PushHub.renderMarkdown`，不重复实现），按 seq 倒序翻页，显示 answered 状态徽标 — **Reversibility:** reversible

### 验收方式

- **D-41:** 管理页验收用 **Playwright 真浏览器 E2E**（本地 wrangler dev 起真服务，沿用 D-26 模式）：登录→建频道→建 Send Key→展示接入片段→发消息→查历史→重置 Channel Key（踢连）→吊销 Send Key→删除频道全链路自动化；SC4（静态资产不触发 Worker）生产 dashboard 请求计数验证（沿用 D-14/D-15 生产冒烟节奏） — **Reversibility:** reversible

### Claude's Discretion

- 管理页视觉风格（与 viewer 一致的 system-ui 极简风即可，不必新设计语言）
- 历史翻页的每页条数与"加载更多"交互细节
- 掩码显示的具体格式（前几个字符+省略号+后几个字符）
- Send Key 标签输入的长度上限与字符集校验细节（对齐 CHANNEL_NAME_MAX_LENGTH 模式即可）
- kickAll 后客户端收到的 WS close code/reason 具体值（复用协议已有约定或选标准码，涉及客户端展示则记入决策）
- 接入片段的具体文案与格式（curl 示例的字段取舍）
- admin history API 的查询参数命名与响应信封细节（对齐 D-06/D-12 既有风格）
- E2E 测试文件组织（沿用 Phase 2 e2e/ 目录模式）

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### 冻结协议与既有 API 契约
- `packages/shared/src/index.ts` — 线协议唯一事实源：帧类型、LIMITS、错误码枚举——admin API 错误响应须对齐 D-06 信封与 ErrorCode 枚举
- `packages/shared/src/validators.ts` — 纯函数校验器模式；admin 请求体校验可参照
- `packages/server/src/admin.ts` — 既有 Admin API 实现全貌：D-12/D-13 路由、Bearer 鉴权两段式常时比较、404 未知路径策略——本期全部新路由在此扩展
- `packages/server/src/keys.ts` — KV 三前缀键表（`ch:`/`sk:`/`id:`）与写路径唯一入口 createChannel——D-30/D-35 的 schema 演进主战场；注意 `id:` 值结构要从单 sendKey 演进为 sendKeys 列表
- `packages/server/src/index.ts` — Worker 路由分发（/api/admin/ 前缀、/api/send、/api/ws/:key）与 DO 转发模式（INTERNAL_ORIGIN + X-PH-Verified 头）
- `packages/server/src/chat-room.ts` — DO 内部路由（/publish、/ws）、messages 表结构与行映射、rate_sends 表——D-33 kickAll 与 D-36 /history 路由的挂载点

### 前端资产模式
- `packages/server/public/index.html` — viewer 页 CSP 纵深防御（T-02-09）与 vanilla 单文件模式——管理页直接照此模式
- `packages/server/public/viewer.js` — localStorage 免填模式（D-24）、连接状态渲染——管理页 Admin Key 持有参照
- `packages/web-sdk/src/render/`（经 `packages/server/public/pushhub.js` 暴露）— `PushHub.renderMarkdown` 消毒渲染——管理页历史视图复用（D-40）

### 项目规划
- `.planning/ROADMAP.md` §Phase 3 — 阶段目标、4 条成功标准（SC1 频道 CRUD、SC2 多 Key+重置踢连+历史保留、SC3 排障历史、SC4 静态资产零 Worker 请求）
- `.planning/REQUIREMENTS.md` — KEY-02/03/04、ADM-01/02/03/05 七条本期需求
- `.planning/phases/01-server-core/01-CONTEXT.md` — D-01~D-15（特别是 D-06 错误信封、D-12/D-13 Admin API 最小集、D-11 补拉域边界）
- `.planning/phases/02-web-sdk/02-CONTEXT.md` — D-16~D-27（特别是 D-19 renderMarkdown 公开 API、D-24 localStorage 模式、D-26 Playwright E2E 模式）

### 部署与验收
- `DEPLOY.md` — 版本 +1 规约、D-15 生产冒烟 checklist（SC4 的 dashboard 请求计数验证法在此）
- `scripts/smoke.mjs` — 既有生产冒烟脚本——`GET /api/admin/channels` 响应结构演进后需联动更新（D-35 注记）
- `packages/web-sdk/e2e/` + `packages/web-sdk/playwright.config.ts` — Playwright E2E 组织模式（D-41 沿用）

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `admin.ts` 的 `checkAdminAuth`（两段式常时比较）——全部新路由免费复用，鉴权逻辑零新写
- `keys.ts` 的 `generateRandomString`/`generateSendKey` 拒绝采样生成器——多 Send Key 创建直接复用
- `chat-room.ts` 的 messages 表查询与行映射（`toMessage` 形态转换，含 answered 字段集）——`/history` 路由的查询内核已存在
- `packages/server/public/pushhub.js`（`PushHub.renderMarkdown`）——管理页历史视图消毒渲染直接 `<script>` 引入，零重复实现
- viewer 页 CSP meta 与 system-ui 样式基调——管理页模板起点

### Established Patterns
- Worker→DO 转发：`INTERNAL_ORIGIN` + `X-PH-Verified: 1` 内部可信头——kickAll 与 /history 沿用
- KV 读 `cacheTtl: 60` 显式标注 + 负查询同样进缓存——新读路径（多 Send Key 解析）同模式
- 错误响应 D-06 信封（`{"error":{code,message}}`）+ 401/404 不暴露路径存在性——新路由全部沿用
- 测试：一场景一测试文件；vitest-pool-workers（服务端）+ Playwright 真浏览器（E2E）
- 部署：每计划 `pnpm run deploy` + 版本 +1 + 冒烟 checklist + WINDOWS.md 登记

### Integration Points
- Worker fetch 路由表（`index.ts`）：`/api/admin/` 前缀已分发进 `admin.ts`——新 REST 资源路径在此扩
- DO fetch 内部路由表（`chat-room.ts`）：现有 `/publish`、`/ws`——kickAll、`/history` 新增两个 pathname 分支
- `id:<channelId>` KV 反向索引——`GET /api/admin/channels` 列表数据源，schema 演进影响 `listChannels`
- 静态资产挂载点 `packages/server/public/`——管理页 HTML/JS 落位点（wrangler.jsonc assets 配置无需改动）
- `scripts/smoke.mjs` 消费 `POST/GET /api/admin/channels`——响应结构变更需同步改

</code_context>

<specifics>
## Specific Ideas

- **核心用户旅程（用户原话）**："用户登录管理平台，给机器人创建一个 webhook 密钥，客户端登录管理平台后，机器人通过携带密钥的 webhook 接口发送，客户端接收并进行提示"——管理页是这个旅程的起点，创建密钥后的接入片段（D-39）是旅程各环节的粘合剂
- 掩码+点击揭示对齐 GitHub/Cloudflare dashboard 的密钥展示惯例
- 频道删除输入名确认对齐 GitHub 删仓库交互模式
- 管理页历史视图的 answered 状态展示是 Phase 4 回复闭环的排障前置——本期只读展示（恒为初始值），Phase 4 复用同一视图看真实回复状态

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 3-管理页与密钥生命周期*
*Context gathered: 2026-08-27*
