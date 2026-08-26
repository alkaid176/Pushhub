# Phase 1: 服务端核心与协议冻结 - Context

**Gathered:** 2026-08-26
**Status:** Ready for planning

<domain>
## Phase Boundary

交付 Cloudflare Workers 服务端核心：`POST /api/send`（Send Key 鉴权 + 每分钟 30 条限流）→ ChatRoom DO（Hibernation WS + 扇出 + SQLite 历史）→ 客户端 WS 实时收消息 + since 游标补拉。同时冻结线协议（`shared/` 包：TS 类型 + golden JSON fixtures，含 seq 游标、answered 状态字段、版本字段）。Admin API 最小集（创建频道 + 列表）供测试期自助建频道，Phase 3 管理页复用。

**不在本期**：管理页 UI、回复链/回调送达（Phase 4）、任何客户端（Phase 2/5/6）、消息渲染（服务端是哑管道）。

</domain>

<decisions>
## Implementation Decisions

### 消息 schema 冻结范围

- **D-01:** `click_url` 进 v1 协议（可选 string，≤2048 字符）——三端客户端点击消息标题/卡片即跳转。竞品 table stakes（ntfy Click / Bark url / Server酱 short），成本近零，避免上线后立刻加字段 — **Reversibility:** one-way — 协议冻结后字段删除或语义变更属破坏性变更，golden fixtures 与四端实现都要联动
- **D-02:** 消息体大小上限取宽松档：`text` ≤ 32KB（32,768 字符）、`title` ≤ 256 字符、`options` ≤ 4 项 × 每项 64 字符、`callback_url` ≤ 2048 字符、`click_url` ≤ 2048 字符。超限返回 413 + 明确错误码 — **Reversibility:** costly — 上限进 golden fixtures 与三端输入框限制，收紧/放宽要四端联动
- **D-03:** answered 状态字段集 Phase 1 一次定全（`answered`/`answered_by`/`answered_at`/`answered_content`，初始 null）——Phase 4 只加 reply 处理逻辑和回调，不改 schema 不改表。这是协议冻结的本意 — **Reversibility:** one-way — 表结构与 WS 帧 schema 一旦冻结并出 golden fixtures，后续加字段集需协议版本升级
- **D-04:** `priority` 三档枚举 `low`/`normal`/`high`，默认 `normal`。服务端校验枚举（非自由字符串），映射到后续 Android 通知通道 / Windows toast 场景 — **Reversibility:** costly — 枚举值是对外契约，三端 switch 逻辑依赖
- **D-05:** 消息对外 ID（wid）用 nanoid 形如 `m_xxx`（16 字符，前缀 m_ 表消息，URL 安全不可猜测），与 seq（频道内单调游标，SQLite rowid）职责分离：seq 是补拉游标，wid 是回调去重与三端引用身份 — **Reversibility:** one-way — wid 是对外公开 API 的身份字段，发布后不可更改
- **D-06:** API 错误响应统一 `{"error":{"code":"...","message":"..."}}`——HTTP 状态码（401/413/429/400）+ 机器可读 code 枚举（如 `rate_limited`/`payload_too_large`/`invalid_key`）。golden fixtures 同时冻结正反例 — **Reversibility:** costly — 错误码是对外契约，发送方脚本会程序化处理
- **D-07:** 协议版本字段：所有 WS 帧顶层带 `v:1`（整数递增）。演进规则写进 shared/ 包 README：只加字段不改语义、未知字段必须忽略（Rust serde 禁用 `deny_unknown_fields`）。客户端不识别的 v 即断连报错 — **Reversibility:** one-way — 版本语义发布后即为公开契约

### 保留窗口与补拉语义

- **D-08:** 每频道保留最近 500 条消息，alarm 每日批量清理一次（`DELETE WHERE seq <= max(seq)-500`，注意删除也计 SQLite 行写额度，一天一次足够） — **Reversibility:** reversible — 数值可调，清理逻辑不变
- **D-09:** 新客户端首次连接（`since: null`）默认拉最近 50 条——首屏轻快；更早历史通过 WS 内翻页按需拉取 — **Reversibility:** reversible
- **D-10:** 保留窗口缺口语义：补拉响应带 `oldest_kept_seq`（频道现存最老 seq）；客户端发现请求的 `since` < `oldest_kept_seq` 时呈现"更早消息已清理"分隔线，不报错不断连——补拉承诺边界诚实可见 — **Reversibility:** costly — 帧字段进 golden fixtures；语义（非报错）是三端统一行为
- **D-11:** 大窗口补拉走 WS 内翻页：`sync` 请求带 `limit`（默认 200，上限 500），一次拉不完响应标 `has_more: true` + 客户端续翻。不另开 HTTP 历史接口——补拉全部走 WS，协议面最小 — **Reversibility:** costly — sync 帧语义冻结后改动即协议变更

### 频道初始化方式

- **D-12:** Phase 1 实现Admin API 最小集：`POST /api/admin/channels`（Admin Key 鉴权，创建频道 → 返回 Channel Key + Send Key）+ `GET /api/admin/channels`（列表）。curl/脚本可自助建频道测试；Phase 3 管理页直接复用同一 API，零重复建设 — **Reversibility:** costly — API 路径与响应结构是对外契约
- **D-13:** Admin Key 本期走 Worker secret（`wrangler secret put ADMIN_KEY`）+ 常时比较鉴权；删除/重置/吊销等全套管理 API 不预建，Phase 3 随管理页一起做 — **Reversibility:** reversible

### 部署验证节奏

- **D-14:** 每计划（PLAN）完成后即 `wrangler deploy` 到 workers.dev 做生产冒烟，通过才算计划完成。理由：wrangler dev 本地掩盖三大生产差异（限额不强制/KV 即时一致/DO 不驱逐），验收标准 3（空闲群 DO duration 不增长）只能在生产 dashboard 验证 — **Reversibility:** reversible — 流程性决策
- **D-15:** 生产冒烟用固定 5 分钟 checklist，固化进部署脚本/文档，每次版本 +1 都跑：① curl 建频道 + 发消息 ② WS 连接收消息 ③ 断连重连 + since 补拉 ④ dashboard 看 DO duration（空闲不增）与请求曲线 — **Reversibility:** reversible

### Claude's Discretion

- monorepo 目录结构细节（pnpm workspace 布局、shared/ 包内部组织）——研究已推荐 pnpm workspace，具体布局由规划阶段定
- 限流桶实现细节（令牌桶表结构、清理策略）——目标行为已定（每 Send Key 每分钟 30 条、429），实现方式自由
- KV 键前缀具体命名（`ch:`/`sk:`/`id:` 为研究推荐值，可微调）
- golden fixtures 的组织方式（按帧类型分文件 vs 单文件多例）
- 测试文件划分粒度（遵循一场景一文件的既定规范即可）

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### 项目规划
- `.planning/PROJECT.md` — 项目核心价值、约束、关键决策表（Durable Objects 做实时分发等）
- `.planning/REQUIREMENTS.md` — 40 条 v1 需求（本期：SRV-01~07、KEY-01、KEY-05）与 Out of Scope
- `.planning/ROADMAP.md` §Phase 1 — 阶段目标、验收标准 5 条、Research note（DO 类名首版定终身）

### 项目研究（2026-08-26，决策的主要依据）
- `.planning/research/SUMMARY.md` — 研究综合：核心发现与 Phase 1 验收建议（空闲不计时长）
- `.planning/research/STACK.md` — 技术栈版本实查 + 免费额度硬数据表（规划容量的依据）+ Do NOT use 清单（禁 `ws.accept()` 等）
- `.planning/research/ARCHITECTURE.md` — 系统架构图、KV 键表设计（ch:/sk:/id:）、消息协议草案（WS 帧 + HTTP API）、workers-chat-demo 官方锚点
- `.planning/research/PITFALLS.md` — 十大坑及防线：1.1 非休眠烧时长、1.4 KV 60s 双活、2.2 DO 内存态丢失、6.1 seq 是协议脊柱、7.2 vitest-pool-workers 已知怪癖、7.3 DO 类名一次性决策
- `.planning/research/FEATURES.md` — 竞品矩阵与 table stakes（click_url/title 分离的依据）、D1-D8 差异化定位

### 工程环境
- `D:\AIworkspaces\PushHub\.claude\CLAUDE.md` — 技术约束全文（免费额度硬数据、推荐技术栈、Do NOT use 清单）

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- 无——项目为全新代码库（仓库内仅有 `.planning/` 与 `.claude/`，零源码）。Phase 1 是从零搭建

### Established Patterns
- 无既有代码模式。遵循研究推荐的官方模式：workers-chat-demo 的 ChatRoom DO 结构（WebSocketPair + acceptWebSocket + tags + quitters 清理模式）

### Integration Points
- 无既有系统。本阶段建立所有后续阶段的集成点：shared/ 协议包（四端契约）、`/api/send`、WS 升级路由、Admin API、静态资产目录结构（Phase 2 pushhub.js、Phase 3 管理页将挂入）

</code_context>

<specifics>
## Specific Ideas

- 服务端定位为**哑管道**：存储原文 + 原文扇出，渲染与清洗全在客户端（10ms CPU 预算）
- KV 只存密钥元数据（`ch:`/`sk:`/`id:` 三类键），高频状态全进 DO SQLite——KV 1,000 写/天额度约束
- 每次调用子请求个位数：Worker 入口 1 次 KV 读 + 1 次 DO stub fetch（50 子请求/调用限制）
- DO 内存字段一律视为缓存，任意时刻可从 getWebSockets/attachment/SQLite 重建
- 测试规范：一场景一测试文件（vitest-pool-workers 文件级隔离怪癖的对策）；compatibility_date 从 wrangler 配置程序化读取

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 1-服务端核心与协议冻结*
*Context gathered: 2026-08-26*
