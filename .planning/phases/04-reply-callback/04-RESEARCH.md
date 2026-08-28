# Phase 4: 回复链与回调送达 - Research

**Researched:** 2026-08-28
**Domain:** WS 协议演进（reply/ack/answered 帧）+ DO 内回调投递（alarm 驱动指数退避）+ HMAC 签名（Web Crypto / Node / 浏览器三环境）+ KV schema 演进 + vanilla 测试页
**Confidence:** HIGH（代码集成点全部实读源码核实；平台事实全部官方文档直读；落地细节均有既有先例）

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

- **D-42:** 回复**一次锁定**：服务端首答即写入 answered 四字段（D-03 已冻结字段集），后续对同消息的回复请求全部拒绝——错误响应/错误帧须区分"消息不存在"与"已回复"。SC1"快捷按钮冻结防重复处置"的服务端最强保证；个人/小团队告警群一人处置即完成，重复处置无意义 — **Reversibility:** one-way
- **D-43:** 回调**恰首答触发一次**：只有首次成功回复触发一次 callback POST，被拒回复不回调。发送方按 message_id 天然幂等 — **Reversibility:** one-way
- **D-44:** 回复竞态**先到先得**：DO 单线程串行处理天然无锁，首到者成功、次到者收错误帧；败者客户端随后收到 answered 状态帧，UI 自然冻结，无需重试 — **Reversibility:** reversible
- **D-45:** 回复走 **WS 内 v:1 reply 帧**（客户端→服务端 wid + selected_option?/text? + by?），服务端回 ack/error 帧 + 全连接扇出 answered 状态帧。协议新增 3 个帧类型（reply/ack/answered 或等价命名）+ golden fixtures 正反例（D-07 只加帧不改语义，合规演进）。**不另开 HTTP 回复接口** — **Reversibility:** one-way
- **D-46:** 回复载荷验证**恰一 + 白名单**：selected_option 必须在原消息 options 内（白名单校验）；自定义 text ≤ 32KB（同 D-02 text 上限口径）；二者**恰提供其一**；校验失败回错误帧不断连 — **Reversibility:** costly
- **D-47:** **每频道独立 signing secret**：随频道创建生成并下发（沿用 201 唯一完整返回点先例），管理页可查可重置（掩码显示同 D-29）；回调用 HMAC-SHA256 签名。与 Send Key 权限分离。存储进 KV ch: 记录 — **Reversibility:** costly
- **D-48:** 签名覆盖 **timestamp + raw body**：headers `PushHub-Message-Id` / `PushHub-Timestamp` / `PushHub-Signature`（HMAC-SHA256 hex）。防重放（timestamp 超时拒收，容忍窗如 5 分钟）+ 防篡改；发送方验签三步：比时间窗 → 重算 HMAC → 常时比较 — **Reversibility:** one-way
- **D-49:** 回调 body 用**回调域专用结构**：`{message_id(wid), reply(text 或 selected_option), replied_by, replied_at, channel_id}`——不复用 WS MessageFrame — **Reversibility:** one-way
- **D-50:** 回调重试用 **DO alarm 驱动指数退避**（档位如 1s/2m/10m/30m，总次数封顶 ~5 次），最终失败写 SQLite 失败记录行（wid/url/错误/重试次数/时间），测试页可查。**注意与 D-08 保留清理 alarm 的并存设计** — **Reversibility:** reversible
- **D-51:** answered_by 用**自报展示名**：客户端随回复自报，服务端不验证直接存 answered_by 并扇出 — **Reversibility:** reversible
- **D-52:** 展示名**随 reply 帧携带**（`by?` 字段）——名字可进 attachment（跨休眠存活），后续 reply 默认复用。**不设连接时 identity 声明帧** — **Reversibility:** costly
- **D-53:** 展示名 **≤64 字符（UTF-16 码元）可缺省**（缺省 = 匿名回复，answered_by 存 null）；客户端渲染 answered_by 时走 textContent 或同消毒管道 — **Reversibility:** reversible
- **D-54:** 回调 body **携带 replied_by**（可 null，与 answered_by 同源同值） — **Reversibility:** reversible
- **D-55:** 测试页为**独立 test.html + test.js** 静态资产（vanilla 单文件，零构建零依赖）：构造消息表单 + 发送（Send Key Bearer）+ 实时消息流（Channel Key 经 pushhub.js）+ 回复操作 + 回调验签器 + 失败记录查询。**viewer 保持轻量不动** — **Reversibility:** reversible
- **D-56:** 测试页内置**本地验签器 + 回调观察窗**：粘贴回调 headers/body 可本地验签；callback_url 输入框支持任意外部接收器（webhook.site 等） — **Reversibility:** reversible
- **D-57:** SC5 交付 **Node 回调接收器脚本**（`scripts/callback-receiver.mjs` 或同级）：本地监听端口收回调 POST → 完整验签 → 打印结果；双重交付：SC5 验收证据 + 用户可拷贝的验签参考实现 — **Reversibility:** reversible
- **D-58:** 回调最终失败记录查询入口在**测试页**（按频道拉取）；**管理页本期不动**（admin.js 不再膨胀） — **Reversibility:** reversible

### Claude's Discretion

- 新帧类型的具体命名与 ack 帧字段细节——规划阶段随协议细化定
- answered 状态同步帧的形态：独立 answered 帧 vs 更新后的 message 帧重发（倾向独立 answered 帧）
- 回调重试档位具体数值与总次数上限（~5 次量级已定）
- timestamp 容忍窗具体值（~5 分钟量级已定）
- signing secret 的生成方式与长度（对齐既有 generateSendKey 拒绝采样模式）
- 测试页消息流与 viewer 消息渲染的代码复用方式（vanilla 零构建约束下倾向简单复制或共享小模块）
- 验签器的 UI 布局与交互细节
- 回调失败记录的 API 路径设计（对齐 D-35 REST 风格 + D-36 内部路由转发模式）
- attachment 存展示名的具体结构演进
- E2E 测试组织（沿用 Phase 2/3 e2e/ 目录模式）

### Deferred Ideas (OUT OF SCOPE)
None — discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| RPL-01 | 客户端可回复消息：快捷选项或自定义文本输入 | reply 帧（C→S 新帧类型）+ validateInboundFrame 扩展恰一校验 + DO webSocketMessage 挂载点 |
| RPL-02 | 回复内容以 Markdown 格式传输与渲染 | answered_content 走 renderMarkdown 消毒管道（test 页与 SDK 渲染）；服务端哑管道透传 |
| RPL-03 | 有人回复时服务端自动 POST 回 callback_url | DO 内 fetch() + 回调域专用 body（D-49）+ 签名三头（D-48） |
| RPL-04 | 回调送达失败时自动重试（指数退避，有上限），最终失败记录可查 | callbacks SQLite 表 + alarm 单槽 min 调度重构（官方多事件模式）+ 测试页查询 API |
| RPL-05 | answered 状态同步：群内实时看到已回复及内容 | 独立 answered 帧全连接扇出（SeqDedup 硬约束决定不可用 message 重发）+ SDK 第五事件 |
| KEY-06 | 回调请求带 PushHub-Message-Id 与签名头，发送方可验签防伪造 | Web Crypto HMAC-SHA256 + timestamp 容忍窗 + 三环境常时比较方案（Workers/Node/浏览器） |
| WEB-03 | SDK 支持宿主页面发起回复 | pushhub.ts reply() 公开方法（fail-fast 语义）+ answered 事件 |
| ADM-04 | 测试页：可视化构造消息、看实时流、发起回复 | test.html + test.js 静态资产 + build.mjs ?v= 注入扩展 + 验签器 + 失败记录查询 |
</phase_requirements>

## Project Constraints (from CLAUDE.md)

- **全程中文回答**（用户可见输出）；技术术语、代码、路径英文
- **零成本**：全部依赖 Cloudflare 免费额度——回调重试 fetch 与 alarm 次数必须封顶（每消息 ≤5 次外呼 + 每次 alarm 计 1 DO 请求）
- **服务端 TypeScript + Workers Runtime，不用 Node 专有 API**（callback-receiver.mjs 是脚本不是服务端代码，Node 22 可用）
- **Do NOT use**（Server）：`ws.accept()`（一律 `ctx.acceptWebSocket`）；KV-backed DO；D1/R2；Queues 做回调重试；自建轮询/SSE
- **部署规约**（DEPLOY.md）：部署前版本号补丁位 +1；`pnpm run deploy`（链式 build 后 deploy）；生产冒烟走 `https://pushhub.dyun.org`（本机 workers.dev 被 SNI/DNS 污染阻断）
- **网页 UI 测试用 Playwright 技能**（用户全局 CLAUDE.md）
- 部署即断开全部 WS——重连是客户端既有能力，测试页无需特殊处理

## Summary

本期是在**冻结协议上的第一次合规演进**（D-07 只加不改）+ **DO 内首次外呼 fetch** + **alarm 单槽从单一职责（保留清理）重构为多事件调度器**。全部集成点已在 Phase 1-3 预埋好：messages 表 answered 四列 Phase 1 已建全（本期只 UPDATE 不改 schema）、webSocketMessage 的 switch 直接挂 reply 分支、KV normalize 兼容层有 normalizeIdRecord 先例、掩码/常时比较/内部头转发全部有可复制实现。

研究确认了三个**必须在计划里显式处理的结构性事实**：

1. **alarm() 尾部无条件 `setAlarm(+24h)`（chat-room.ts:726）与回调重试天然冲突**——Cloudflare DO 每个 DO 只有一个 alarm 槽位，`setAlarm` 覆盖既有 alarm。官方文档给出标准解法（"Scheduling multiple events with a single alarm"）：事件日程落存储、alarm() 处理到期事件后按"下一个到期时间的最小值"重排。现有 alarm 处理器必须重构为双职责调度器，且保留清理的到期时间必须持久化（建议 meta 表 `retention_due` 行），否则被重试 alarm 反复"顺延"。
2. **answered 同步必须是独立帧类型，这不是偏好而是代码层硬约束**——SDK 的 SeqDedup 按 seq 去重（`dedup.ts:24-27`：已见 seq 的 message 帧被静默丢弃），history 过滤同走 shouldDeliver（connection-machine.ts:233）。同 seq 的 message 帧重发在 SDK 侧等于不可见。discretion 项就此以实证定稿。
3. **常时比较在三个环境是三个不同 API**——Workers 独有 `crypto.subtle.timingSafeEqual`（官方文档明示"non-standard extension"）；Node 用 `node:crypto.timingSafeEqual`；浏览器两者皆无，测试页验签器必须手写 XOR 累加常时比较。服务端已有 D-13 两段式实现（admin.ts:74-96）可整体复用到 secret 管理鉴权，但发送方参考实现与浏览器验签器各需自己的写法。

签名方案对标 Stripe（官方文档已核实细节）：`signed_payload = timestamp + "." + rawBody`，HMAC-SHA256，hex；**重试投递时生成新 timestamp + 新签名**（Stripe 同款，天然适配容忍窗）；**回调 body 在入队时预序列化一次、逐次重试字节不变**（body 重序列化可能键序漂移导致验签失败）。

**Primary recommendation:** 协议层按 reply/ack/answered 三帧 + already_replied/not_found 两个新错误码推进 fixtures；服务端把 alarm 重构为官方多事件调度模式（callbacks 表 + meta.retention_due）；签名密钥经 X-PH 内部头随 /ws 转发落 DO meta 表（ch: 已解析、零额外 KV 读，且 reply 必经 WS 连接保证密钥先于回调就位）；测试页照 viewer/admin 模式做静态资产并扩展 build.mjs 注入清单。

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| reply 帧校验（结构层：恰一/长度） | shared 包纯函数 | — | validators.ts 冻结先例：纯函数零依赖，四端复用 |
| reply 语义校验（白名单/已回复判定） | DO（chat-room.ts） | — | 需读 messages 行（options JSON、answered 位），DO 单线程串行保证 D-44 先到先得 |
| answered 状态落库与扇出 | DO | — | UPDATE answered 四列 + 全连接 ws.send（publish 扇出同款遍历） |
| 回调签名（HMAC-SHA256） | DO（Web Crypto） | — | 回调在 DO 内发起，签名就近；secret 从 DO meta 表读 |
| signing secret 生成/存储/重置 | Worker（keys.ts + admin.ts） | KV ch: | KV 低频写额度匹配；normalize 兼容层先例 |
| 回调重试调度 | DO alarm | — | 休眠零成本 + at-least-once；官方多事件单 alarm 模式 |
| 回调最终投递 | DO fetch() 外呼 | — | 无状态 POST；2xx 即成功；封顶 5 次 |
| 失败记录查询 API | Worker 路由 + DO 内部路由 | — | D-36 /history 转发模式（鉴权头换成 Channel Key 域，见 Open Questions Q4） |
| reply 客户端 API（reply()/answered 事件） | Web SDK | — | pushhub.ts 公开方法 + frames.ts 帧守卫扩展 |
| 测试页（构造/流/回复/验签/失败查询） | 静态资产（asset-first） | pushhub.js | 零 Worker 请求额度消耗；渲染复用 renderMarkdown |
| 验签参考实现 | scripts/callback-receiver.mjs | — | Node 22；SC5 证据 + 用户可拷贝 |

## Standard Stack

### Core

**本期零新增依赖。** 全部能力来自 Workers 运行时内置 API、既有 workspace 包与 Node 内置模块。

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Web Crypto（Workers 运行时内置） | 内置 | HMAC-SHA256 签名（crypto.subtle.importKey/sign）+ 常时比较（crypto.subtle.timingSafeEqual） | 官方文档确认 HMAC sign/verify/importKey 全支持；timingSafeEqual 为 Workers 专有非标准扩展 [VERIFIED: developers.cloudflare.com/workers/runtime-apis/web-crypto/] |
| DO Alarms API | 运行时内置 | 回调重试调度 | 单 DO 单 alarm 槽、at-least-once、失败重试 2s 起 6 次封顶；官方多事件单 alarm 模式 [VERIFIED: developers.cloudflare.com/durable-objects/api/alarms/] |
| DO SQLite（ctx.storage.sql） | 运行时内置 | callbacks 队列表 + 失败记录 | messages/rate_sends/meta 三表先例；幂等 DDL 构造器重跑 [VERIFIED: packages/server/src/chat-room.ts:65-103,231-244] |
| @pushhub/shared | workspace | reply/ack/answered 帧类型 + 校验器 + fixtures | 协议唯一事实源 [VERIFIED: packages/shared/src/index.ts] |
| node:http + node:crypto | Node 22 内置 | callback-receiver.mjs | smoke.mjs 同款零依赖模式 [VERIFIED: scripts/smoke.mjs:1-6] |

### Supporting（既有，版本实查于各 package.json）

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| @cloudflare/vitest-plugin | 1.1.0 | 服务端集成测试（真 workerd + 真 DO + 真 WS） | 全部 reply/alarm/回调链测试 [VERIFIED: packages/server/package.json] |
| vitest | 4.1.11 | 测试框架 | server（--max-workers=1 --no-isolate）与 web-sdk（node 环境） |
| @playwright/test | 1.62.1 | 测试页 E2E | 真浏览器交互（点击回复按钮、验签器粘贴流） |
| marked / dompurify（经 pushhub.js） | 18.0.11 / 3.4.14 | answered_content Markdown 渲染 | 测试页复用 `window.PushHub.renderMarkdown`，零重复实现 |

> **注意（修正项）：** CLAUDE.md「推荐技术栈」记录的 `@cloudflare/vitest-pool-workers 0.22.0` 已过时——仓库实际使用 **`@cloudflare/vitest-plugin@1.1.0`**（`packages/server/package.json` devDependencies，`vitest.config.ts` 从 `@cloudflare/vitest-plugin` import `cloudflareTest`）[VERIFIED: packages/server/vitest.config.ts:6]。

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| DO alarm 重试 | Cloudflare Queues | 已被 CLAUDE.md Do-NOT-use 排除（额外产品维度）；alarm 免费且 at-least-once 足够 |
| HTTP 回复接口 | WS reply 帧 | D-45 已锁 WS 内；另开通道纯多余 |
| message 帧重发同步 answered | 独立 answered 帧 | SeqDedup 硬约束使前者不可行（见 Pitfall 2） |
| 每消息签名存 messages 表 | DO meta 表每频道一行 | secret 是频道级非消息级；meta 先例（代际行）现成 |

## Package Legitimacy Audit

**本期不安装任何外部包**——服务端改动全部使用 Workers 运行时内置 API；测试页是 vanilla 静态资产；callback-receiver.mjs 只用 Node 内置模块。无需运行 legitimacy check。

| Package | Registry | Age | Downloads | Source Repo | Verdict | Disposition |
|---------|----------|-----|-----------|-------------|---------|-------------|
| （无新包） | — | — | — | — | — | — |

*Packages discovered via WebSearch or training data that have not been verified against an authoritative source are tagged `[ASSUMED]` and the planner must gate each install behind a `checkpoint:human-verify` task.*

## Architecture Patterns

### System Architecture Diagram

```
发送方脚本                        PushHub Worker (无状态)                ChatRoom DO (每频道一个)
──────────                      ─────────────────────                ─────────────────────────
POST /api/send ──────────────▶  handleSend
  (Bearer Send Key)              sk: 预检 → validateSendBody
                                 └─ /publish 转发 (X-PH-Verified) ──▶ 落库(seq/wid/options/callback_url)
                                                                     扇出 message 帧 ─┐
                                                                     setAlarm 判空 ──┼──▶ alarm 单槽
                                                                                      │   (min(retention_due,
                                                                                      │    next_retry_due))
客户端 A/B/N (测试页/SDK/桌面)                                                                     │
─────────────────────────                                                                        │
GET /api/ws/:key ──────────▶  ch: 预检 ── /ws 转发 ──────────▶ acceptWebSocket
                                (携带 X-PH-Signing-Secret)          meta.signing_secret 落盘
                                                                     首拉 history ◀────┘
客户端 A 点击快捷选项 / 输入 Markdown：
  ws.send(reply 帧) ─────────────────────────────────────────▶ webSocketMessage
                                                                 │ 1. 结构校验(shared 纯函数)
                                                                 │ 2. SELECT by wid → 不存在: error(not_found)
                                                                 │ 3. answered=1 已置: error(already_replied)
                                                                 │ 4. 白名单/恰一/by≤64: error(invalid_frame)
                                                                 │ 5. UPDATE answered 四列
                                                                 │ 6. ack 帧 → 回复者
                                                                 │ 7. answered 帧 → 全连接扇出 ──▶ 其余客户端按钮冻结
                                                                 │ 8. callback_url 非空 → 入队 callbacks 表
                                                                 │    (body 预序列化一次) + 重排 alarm
                                                                 ▼
                                            alarm() 到点（双职责调度器）
                                             ├─ 到期重试行: fetch(url, 签名三头) ──▶ 发送方 callback_url
                                             │    2xx → status=delivered
                                             │    失败 → attempts+1, next=now+档位, 重排 alarm
                                             │    attempts≥5 → status=failed + last_error
                                             └─ retention_due 到期: 保留清理（D-08 原逻辑）
                                             尾部: setAlarm(min(下一重试, retention_due))

发送方验签（callback-receiver.mjs / 测试页验签器）:
  |t - now| ≤ 5min → 重算 HMAC-SHA256(ts "." rawBody, secret) → 常时比较 hex → 按 message_id 幂等
```

### Recommended Project Structure（增量）

```
packages/shared/src/index.ts          # ReplyFrame/AckFrame/AnsweredFrame + ErrorCode 扩展 + BY_MAX
packages/shared/src/validators.ts     # validateInboundFrame 增 reply 分支（结构层）
packages/shared/fixtures/
  reply-frame.positive.json           # 新增（正例数组）
  reply-frame.negative.json           # 新增（{_violation, frame} 反例数组）
  answered-frame.positive.json        # 新增（服务端发射帧——结构检查器锁定，同 history 模式）
  ws-error-frame.json                 # 修改：追加 already_replied / not_found 两例（协议事件）
packages/server/src/chat-room.ts      # reply 处理 + callbacks 表 + alarm 重构 + /callback-failures
packages/server/src/keys.ts           # ch: 记录 signingSecret 字段 + 生成器 + normalize
packages/server/src/admin.ts          # signing-secret 查/重置端点（CHANNELS_PATH_RE 白名单扩展）
packages/server/src/index.ts          # /ws 转发携带 X-PH-Signing-Secret（可选 /callback-failures 公网路由）
packages/server/public/test.html      # 新增
packages/server/public/test.js        # 新增
packages/web-sdk/src/pushhub.ts       # reply() 方法 + answered 事件
packages/web-sdk/src/frames.ts        # parseServerFrame 增 answered/ack 分支
packages/web-sdk/src/connection-machine.ts  # handleFrame 增 answered 分支（emitAnswered 动作）
packages/web-sdk/build.mjs            # injectCacheBustVersion 增 test.html
packages/web-sdk/e2e/test-page.spec.ts# 新增
packages/server/test/reply-chain.test.ts      # 新增：reply→ack/error→answered 扇出→竞态
packages/server/test/callback-delivery.test.ts# 新增：签名回调→重试→失败记录
scripts/callback-receiver.mjs         # 新增（SC5）
scripts/smoke.mjs                     # 扩展：回复链冒烟步骤（部署后验证）
```

### Pattern 1: 冻结协议合规演进（三帧 + 两错误码）

**What:** D-07 规则下新增帧类型 = 加法演进：ClientFrame/ServerFrame 联合类型扩展 + validators 结构校验 + fixtures 正反例 + fixtures-contract 测试扩展。**任何既有帧/字段/错误码不动。**
**When to use:** 本期唯一协议变更路径。

当前联合类型（扩展点）[VERIFIED: packages/shared/src/index.ts:130,156]：

```typescript
/** 客户端 → 服务端帧全集（当前 v:1 仅 ping / sync 两种）。 */
export type ClientFrame = PingFrame | SyncFrame;

/** 服务端 → 客户端帧全集。 */
export type ServerFrame = MessageFrame | HistoryFrame | PongFrame | WsErrorFrame;
```

建议新增（字段集为研究建议，进 fixtures 前规划定稿）：

```typescript
/** v:1 reply 帧（客户端 → 服务端，D-45/D-46/D-52/D-53）：
 *  selected_option 与 text 恰提供其一；by 为自报展示名（≤64 UTF-16 码元，可缺省=匿名）。 */
export interface ReplyFrame {
  v: typeof PROTOCOL_VERSION;
  type: "reply";
  wid: string;
  selected_option?: string;
  text?: string;
  by?: string;
}

/** v:1 ack 帧（服务端 → 回复者本人，确认回复被接受；D-45）。 */
export interface AckFrame {
  v: typeof PROTOCOL_VERSION;
  type: "ack";
  wid: string;
}

/** v:1 answered 帧（服务端 → 全连接扇出，RPL-05 状态同步）。
 *  独立帧是硬约束：SDK SeqDedup 按 seq 去重会丢弃同 seq 重发的 message 帧。 */
export interface AnsweredFrame {
  v: typeof PROTOCOL_VERSION;
  type: "answered";
  wid: string;
  seq: number;
  answered: boolean;           // 恒 true（本期 answered 只有置位路径）；字段保留给未来撤答扩展
  answered_by: string | null;
  answered_at: number;
  answered_content: string | null;
}
```

错误码扩展 [VERIFIED: packages/shared/src/index.ts:70-78 现有 8 码逐字引用：`"invalid_key" | "payload_too_large" | "rate_limited" | "invalid_body" | "invalid_json" | "server_error" | "invalid_frame" | "invalid_version"`]：追加 `"already_replied" | "not_found"` 两枚。D-42 明确要求区分"消息不存在"与"已回复"。D-46 的结构校验失败（非恰一/超长/by 超限/白名单外选项）建议沿用 `invalid_frame`（与 sync 域坏帧语义一致）；`already_replied`/`not_found` 是域级拒绝。WsErrorFrame 的 code 在消费侧是透明 string（frames.ts isErrorShape 只查 `typeof v.code === "string"`，[VERIFIED: packages/web-sdk/src/frames.ts:105-107]），新码对旧客户端零破坏。

### Pattern 2: DO alarm 多事件单槽调度器（D-50 × D-08 并存）

**What:** 官方推荐模式——事件日程持久化在存储里，alarm() 是"处理一切到期事件然后按 min(下一到期) 重排"的调度器。
**When to use:** 回调重试与保留清理共享 DO 唯一 alarm 槽位。

现状与冲突 [VERIFIED: packages/server/src/chat-room.ts:713-728]——现有 alarm 尾部无条件重设：

```typescript
  async alarm(): Promise<void> {
    try {
      this.ctx.storage.sql.exec(
        "DELETE FROM messages WHERE seq <= (SELECT MAX(seq) - ?1 FROM messages)",
        RETENTION_KEEP,
      );
      ...
    } catch {
      // 吞异常：清理失败不阻断重设节奏；数据幂等（下一天同条件重删）。
    } finally {
      await this.ctx.storage.setAlarm(Date.now() + RETENTION_INTERVAL_MS);
    }
  }
```

官方事实 [VERIFIED: developers.cloudflare.com/durable-objects/api/alarms/]：
- "Each Durable Object is able to schedule a single alarm at a time by calling `setAlarm()`."——**单槽**。
- "If you call `setAlarm` when there is already one scheduled, it will override the existing alarm."——**覆盖**。
- 重试仅在 alarm() 抛未捕获异常时发生："Retries are performed using exponential backoff starting at a 2 second delay from the first failure with up to 6 retries allowed."——**2s 起指数退避、至多 6 次**（与 chat-room.ts:707 注释"alarm 自带重试仅 6 次即放弃"一致）。
- "Only one instance of `alarm()` will ever run at a given time per Durable Object instance."——无并发 alarm。
- 官方多事件模式原文要点："you can manage many scheduled and recurring events by storing your event schedule in storage and having the `alarm()` handler process due events, then reschedule itself for the next one."
- 官方推荐 catch 内部异常 + 主动重设以获得无限重试（现有代码已遵守）。

**重构形态建议：**

```typescript
// meta 表新增行（既有 CREATE_META_DDL 幂等建表，无需迁移）：
//   k = "retention_due"  v = 下次保留清理的 epoch ms
//   k = "signing_secret" v = 频道签名密钥（/ws 转发时落盘）

/** 统一重排：setAlarm(min(下一到期重试, retention_due))；无任何到期项则不设。 */
private async scheduleNextAlarm(): Promise<void> {
  const nextRetry = this.ctx.storage.sql
    .exec("SELECT MIN(next_attempt_at) AS m FROM callbacks WHERE status = 'pending'")
    .one() as { m: number | null };
  // retention_due 从 meta 读（缺省 = 现在，立即补跑一次清理）
  const next = Math.min(
    nextRetry.m ?? Number.MAX_SAFE_INTEGER,
    this.readRetentionDue() /* 缺省 now */,
  );
  if (next <= Number.MAX_SAFE_INTEGER) {
    await this.ctx.storage.setAlarm(Math.max(next, Date.now() + 1));
  }
}

async alarm(): Promise<void> {
  try {
    await this.dispatchDueCallbacks();   // 到期回调 fetch（逐条 await，量级极小）
    if (Date.now() >= this.readRetentionDue()) {
      this.runRetentionCleanup();        // D-08 原逻辑原样搬入
      this.writeRetentionDue(Date.now() + RETENTION_INTERVAL_MS);
    }
  } catch {
    // 吞异常保节奏（官方推荐 + 既有注释语义）；回调行的 attempts 语义自带幂等
  } finally {
    await this.scheduleNextAlarm();
  }
}
```

**关键红线：**
- publish 的判空播种点（chat-room.ts:522-524 `if ((await this.ctx.storage.getAlarm()) === null)`）保留——首次 publish 时同时确保 `retention_due` meta 行存在（缺省 now+24h）。
- `handlePurge` 的 `deleteAll + deleteAlarm` 成对不变（callbacks 表随 deleteAll 一并清除，语义正确：频道已删无需回调）。
- 回调入队与 alarm 重排之间：新入队的 next_attempt_at（now+1s）几乎必然早于当前 alarm，需在入队后调 `scheduleNextAlarm()` 覆盖式提前。
- alarmInfo 参数（`{retryCount, isRetry}`）可观测但**不依赖**它做业务计数（官方重试只针对最近一次 setAlarm）。

### Pattern 3: 回调投递（入队预序列化 + 每次重签）

**What:** 首答触发时构造回调 body 一次并序列化存库；每次投递尝试用**当下时间戳重新签名**、body 字节不变。
**When to use:** RPL-03/RPL-04 全路径。

表结构建议（挂进构造器幂等 DDL，同 CREATE_RATE_SENDS_DDL 模式）：

```sql
CREATE TABLE IF NOT EXISTS callbacks (
  wid              TEXT PRIMARY KEY,   -- 一消息一回调（D-43 恰首答一次）
  url              TEXT NOT NULL,
  body             TEXT NOT NULL,      -- 入队时预序列化的 D-49 结构（重试字节不变）
  attempts         INTEGER NOT NULL DEFAULT 0,
  next_attempt_at  INTEGER NOT NULL,   -- 到期投递时间（调度键）
  status           TEXT NOT NULL DEFAULT 'pending',  -- pending|delivered|failed
  last_error       TEXT,               -- 末次失败摘要（状态码/网络错误）
  created_at       INTEGER NOT NULL,
  final_failed_at  INTEGER             -- status='failed' 时填
)
```

投递尝试次序（attempts 在 fetch **之前**递增——崩溃在 fetch 中途时按已消耗计，at-least-once 语义、接收方按 message_id 幂等兜底，SC5 正是要验证这一点）：

```
t0 = 首答即时投递（reply 处理内同步发起或入队后立即 dispatch）
失败 → next_attempt_at = t0 + 1s   → t1 重试
失败 → +2m  → t2
失败 → +10m → t3
失败 → +30m → t4（第 5 次尝试）
仍失败 → status='failed', final_failed_at=now, last_error=摘要   [D-50 档位为建议值，规划定稿]
```

额度核算：每条消息回调外呼封顶 5 次 fetch + 至多 5 次 alarm 唤醒（每次 alarm 计 1 DO 请求）——远低于免费层 10 万/天 [VERIFIED: CLAUDE.md 免费额度表 + developers.cloudflare.com/workers/platform/limits/]。

**投递判定：** `resp.ok`（2xx）= delivered；3xx 由 fetch 自动跟随重定向（每一跳计 1 子请求，免费层 50/次调用充足）；4xx/5xx/网络异常 = 记 last_error 进下次。官方最佳实践：不读响应体时 `response.body.cancel()` 释放内存 [CITED: developers.cloudflare.com/workers/platform/limits/#subrequests]。

### Pattern 4: HMAC 签名（服务端签名 + 三环境验签）

**签名（DO 内，Web Crypto）** [VERIFIED: developers.cloudflare.com/workers/runtime-apis/web-crypto/——HMAC 的 sign/verify/generateKey/importKey 全支持；hex 编码模式取自官方 DigestStream 示例 `[...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')`]：

```typescript
// signed_payload = `${timestamp}.${rawBody}`（Stripe 同款 "." 分隔——消除
// "timestamp 数字与 body 首字符"的拼接歧义）[VERIFIED: docs.stripe.com/webhooks Step 2]
async function signCallback(secret: string, timestampMs: number, body: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(`${timestampMs}.${body}`));
  return [...new Uint8Array(mac)].map(b => b.toString(16).padStart(2, "0")).join("");
}

// 投递：
const ts = String(Date.now());  // 建议毫秒（见 Open Questions Q2）
const sig = await signCallback(secret, ts, body);
await fetch(url, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "PushHub-Message-Id": wid,
    "PushHub-Timestamp": ts,
    "PushHub-Signature": sig,        // D-48 三头，one-way 契约
  },
  body,                              // 入队时预序列化的字节串，逐次不变
});
```

**每次重试重新生成 timestamp + 签名**（Stripe 官方行为："If Stripe retries an event ... we generate a new signature and timestamp for the new delivery attempt" [VERIFIED: docs.stripe.com/webhooks]）——这样新投递永远落在接收方容忍窗内，重试语义与防重放天然自洽。

**验签三环境：**

| 环境 | 常时比较 | 时间窗 |
|------|---------|--------|
| Workers（服务端内部复用） | `crypto.subtle.timingSafeEqual(a, b)`——官方明示 "non-standard extension to the Web Crypto API"，入参 ArrayBuffer/TypedArray [VERIFIED: developers.cloudflare.com/workers/runtime-apis/web-crypto/]；既有 D-13 两段式实现 admin.ts:74-96 整体可复制 | `Date.now()` 差值 |
| Node（callback-receiver.mjs） | `node:crypto.timingSafeEqual(Buffer, Buffer)`（长度不等抛错——先比长度，同 D-13 两段式）[ASSUMED——Node 标准库常识，实现时一行验证] | `Date.now()` |
| 浏览器（测试页验签器） | **无内置**——手写 XOR 累加：`let diff = a.length ^ b.length; for (i...) diff |= a[i] ^ b[i]; return diff === 0`（对 hex 编码后的 Uint8Array） | `Date.now()` |

Stripe 官方对容忍窗的告诫（适用接收方文档）："Don't use a tolerance value of 0. Using a tolerance value of 0 disables the recency check entirely." [VERIFIED: docs.stripe.com/webhooks]。默认 5 分钟 = 300_000 ms（D-48 量级已锁，具体值规划定稿）。

**signing secret 生成**（对齐既有拒绝采样，消除取模偏差）[VERIFIED: packages/server/src/keys.ts:74-99——`generateRandomString(length)` + `BASE62_USABLE_BYTES = 248` 逐字在案]：

```typescript
// keys.ts 既有：const BASE62_USABLE_BYTES = 248;  // 256 % 62 == 8：丢弃 >= 248 的字节消除取模偏差
// 建议：SIGNING_SECRET_PREFIX = "phsig_"（区别 phc_/phs_）+ generateRandomString(32)
// ≈ 190 bit 熵，HMAC-SHA256 密钥强度充裕
```

### Pattern 5: signing secret 传递链（KV → DO meta）

**推荐方案：X-PH-Signing-Secret 随 /ws 转发，DO 落 meta 表。**

- Worker 的 `handleWebSocket` 已经 `resolveChannelKey`（ch: 全量记录在手）[VERIFIED: packages/server/src/index.ts:90-105]——转发时加一个内部头是**零额外 KV 读**。
- DO 在升级路径把 secret 写进 meta 表（`INSERT ... ON CONFLICT(k) DO UPDATE`，照 kick-all 代际落盘同款 chat-room.ts:313-320）。
- **正确性论证**：回调仅在回复后发生；回复必经一条已鉴权 WS 连接；该连接升级时 secret 已落 meta——**secret 永远先于任何回调就位**。/publish 路径无需携带（sk: 解析不含 ch:，补读要 +1~2 次 KV 读/条消息，无必要）。
- 重置流：admin reset 端点 KV 写新 secret → DO 转发 `/set-signing-secret`（或复用 kick-all 同一转发携带）→ meta 覆盖。KV 60s 边缘缓存窗口内的旧值会短暂写入 meta——与 Channel Key 重置的既有 60s 双活窗口（Pitfall 8，文档化行为）同族，重置转发以 KV 写**之后**的权威值为准即可窗口收敛。
- 备选（不推荐但列出）：DO 直接读 KV（DO 支持 KV 绑定，官方有 "Use Workers KV from Durable Objects" 示例页 [CITED: developers.cloudflare.com/durable-objects/examples/use-workers-kv-from-durable-objects/]）——每次回调 +1 KV 读且 DO 需先知道自己 channelId（要再传一次），复杂度更高。

### Pattern 6: KV ch: schema 演进（normalize 兼容层）

现状 [VERIFIED: packages/server/src/keys.ts:40-44 逐字引用]：

```typescript
/** ch:<key> 命中后的值结构。 */
export interface ChannelKeyInfo {
  channelId: string;
  name: string;
  createdAt: number;
}
```

演进（照 SendKeyInfo 的 label/createdAt 增量可选字段先例——"旧值无此键天然合法" keys.ts:29-31 原注）：

```typescript
export interface ChannelKeyInfo {
  channelId: string;
  name: string;
  createdAt: number;
  signingSecret?: string;   // Phase 4 增量可选；旧频道缺省 = 未配置（惰性补发路径）
}
```

- `createChannel` 写入新字段（三前缀写序不变）；`resolveChannelKey` 读侧天然兼容（JSON 解析旧值无此键 = undefined）。
- **生产遗留**：0.1.0~0.1.12 建的约 10 个频道无 signingSecret（0.1.12 部署记录实证列表 10 频道 [VERIFIED: DEPLOY.md 0.1.11/0.1.12 行]）。惰性补发：admin reveal/reset 端点发现缺省即生成 + KV 写（migrate-on-touch，normalizeIdRecord 同款哲学）。遗留频道在补发前：回复链正常（answered 扇出不依赖 secret），回调入队时发现 meta 无 secret → 直接落 status='failed'、last_error="no signing secret"——测试页可见、操作者可循补发。

### Pattern 7: SDK reply API（fail-fast）与 answered 事件

**reply() 不进状态机**（discretion 项定稿建议）：connection-machine 是连接生命周期纯状态机（02-02 冻结语义载体），用户动作排队/重试语义会把业务策略混进连接层。建议 pushhub.ts 直接实现：

```typescript
/** WEB-03：发起回复。恰一载荷（option 或 text）；by 为自报展示名（≤64）。
 *  WS 未连接（非 online）时 fail-fast：emitError(code="not_connected")，不排队。
 *  结果经 answered 事件（成功扇出含本人）与 error 事件（already_replied 等）送达。 */
reply(wid: string, reply: { selected_option: string } | { text: string }, by?: string): void;
```

- 状态可观测（`machine.status` 公开只读口 [VERIFIED: connection-machine.ts:382-384]）；`this.ws.readyState === WebSocket.OPEN` 检查后 `ws.send(JSON.stringify(frame))`（照 sendSync 动作接线 pushhub.ts:170-180 同款防御）。
- **answered 进事件面**：D-16 四事件是 02-01 one-way 公开契约；加第五事件 `answered` 是纯加法（宿主不监听则无感），与 D-07 演进哲学同构。frames.ts `parseServerFrame` 增 `"answered"` case + isAnsweredShape 结构校验；machine `handleFrame` 增 case 输出 `emitAnswered` 动作（新动作种类，照 emitHistory 模式）。
- ack 帧 SDK 消费建议：**静默吞掉**（answered 扇出即是对回复者的公共确认信号，含 answered_by 可自识别）；单独的 reply-ack 公共事件徒增 API 面。规划可改，但默认不加。
- 展示名 SDK 侧持久化：不进 SDK（无 localStorage 依赖纪律）；测试页自己存（D-24 模式）。

### Pattern 8: 测试页（test.html + test.js）

- **结构照 viewer.js 骨架** [VERIFIED: packages/server/public/viewer.js:23-240——接入表单/statusDot/errorBar/messages 列表/localStorage try-catch/URL 参数预填/window.__pushhub 调试句柄全模式在案]：五区块 = 连接配置（server + Channel Key + Send Key + 展示名）→ 消息构造表单（title/text/priority/options×4/callback_url）→ 实时消息流（wid→DOM 索引，answered 帧回写冻结按钮 + 追加"已由X回复"行）→ 验签器（粘贴 headers/body/secret → 时间窗 + HMAC 重算 + XOR 常时比较，分步可视化）→ 失败记录查询（按频道）。
- **CSP 复制 index.html 纵深**（`script-src 'self'` 禁 inline——test.js 独立文件；`connect-src 'self' ws: wss: http: https:` 已放行外呼 fetch，验签器/查询无碍）[VERIFIED: packages/server/public/index.html:9-11]。
- **渲染唯一管道纪律**：text 与 answered_content 一律 `window.PushHub.renderMarkdown(...)` 后 innerHTML；answered_by、title、wid 等纯文本一律 textContent（D-53——展示名是任意外部输入，防名字藏 XSS）[VERIFIED: admin.js:28-32 同款纪律注释在案]。
- **发送**：`POST /api/send`（Bearer Send Key）同源相对路径。
- **回复**：快捷按钮点击 / Markdown 输入框提交 → `hub.reply(wid, ..., by)`。
- **build.mjs 联动（必改项）**：`injectCacheBustVersion` 现只注入 index.html 与 admin.html [VERIFIED: packages/web-sdk/build.mjs:71-72]；test.html 引用 `pushhub.js?v=` 时必须追加第三个调用——refRe 硬断言"恰命中一次"自动护航。`cache-bust-sync.test.ts` 同步扩展。
- **localStorage 取舍提示**：Send Key 敏感度高于 Channel Key（可发消息）。建议存 server/channel/name 三项、Send Key 会话内存态不落盘（页面注明取舍）——规划定稿。

### Pattern 9: 回复处理挂载（webSocketMessage 扩展）

挂载点 [VERIFIED: packages/server/src/chat-room.ts:626-646——现有 ping 防御忽略/sync 分支结构]：

```typescript
// validateInboundFrame 扩展后（结构层在 shared 纯函数，白名单等语义层在 DO）：
if (frame.type === "reply") {
  // 1. SELECT ... FROM messages WHERE wid = ?（options/answered/callback_url 一次取全）
  // 2. 无行 → ws.send(error{code:"not_found"})；return（不断连）
  // 3. answered ≠ 0 → ws.send(error{code:"already_replied"})；return（D-42/D-44）
  // 4. selected_option 白名单：JSON.parse(options) includes 检查 → 否则 error{invalid_frame}
  // 5. UPDATE messages SET answered=1, answered_by=?, answered_at=?, answered_content=?（同步块零 await）
  // 6. ack 帧发回本人；answered 帧全连接扇出（publish 扇出遍历同款 + 死连接 try/catch 清理）
  // 7. callback_url 非空 → callbacks 入队（body 预序列化）+ scheduleNextAlarm()
}
```

D-44 竞态论证：DO 单线程输入门串行处理两条 reply——第二条进入时 UPDATE 已提交（SQLite 同步 exec 即持久化），读到 answered=1 → already_replied。零锁。

attachment 演进（D-52）[VERIFIED: chat-room.ts:607-610 现结构 `{clientId, connectedAt}` 逐字在案]：

```typescript
server.serializeAttachment({
  clientId: crypto.randomUUID(),
  connectedAt: Date.now(),
  displayName: by ?? null,   // 增量可选字段；上限 2048 字节远够
});
```

### Pattern 10: 测试策略（vitest-plugin + Playwright）

- **WS 回复链集成测试**：directPublish（带 options + callback_url）→ 两个 WS 客户端（**attach-then-trigger 铁律**：监听先挂、accept 与首帧监听间零 await——STATE.md 实证教训）→ A 发 reply → 断言：A 收 ack、A/B 各收 answered、B 对同 wid 再发 reply 收 `already_replied` error 帧。模式照 ws-fanout/group-semantics 既有测试。
- **alarm 重试测试**：`runDurableObjectAlarm(stub)` 直调（**不是 fake timers**——workerd 内 Date 不归 vi 管）[VERIFIED: packages/server/test/retention-alarm.test.ts:128,157 `expect(await runDurableObjectAlarm(stub)).toBe(true)` 既有先例]。时序操控：`runInDurableObject` 内 SQL 种入 `next_attempt_at` 已过期的 callbacks 行 → run alarm → 断言 attempts/next/status。
- **回调 fetch 目标**：优先验证 `cloudflare:test` 的 fetchMock 是否可用于拦截 DO 外呼 [ASSUMED——vitest-pool-workers 文档记忆，实现首日验证]；保底方案：测试内起本地 `node:http` 服务器作 callback_url（workerd 测试进程可 fetch localhost）——两方案都先 spike 一小步再铺开。
- **签名交叉验证**：测试用 Node `node:crypto.createHmac` 重算比对 DO 产出的 hex（跨实现一致性证明）。
- **E2E（Playwright）**：`test-page.spec.ts` 沿用 playwright.config.ts（wrangler dev 127.0.0.1:4911 + 构建前置）；回调接收器用 globalSetup/beforeAll 子进程拉起 `callback-receiver.mjs`（CLAUDE.md 端口规约：非标准端口）。

### Anti-Patterns to Avoid

- **在 alarm() 里裸抛异常依赖平台重试**：平台只重试 6 次（2s 起指数退避）[VERIFIED: DO alarms 官方文档]——官方明确建议 catch 后主动重设。现有代码已遵守，重构不要丢。
- **入队后不重排 alarm**：新回调 next_attempt_at=+1s 几乎必然早于已设 alarm；漏调 scheduleNextAlarm 则首次重试被推迟到旧 alarm 时点。
- **回调 body 每次重试重新 JSON.stringify**：键序漂移 → 字节变化 → 接收方验签失败。入队序列化一次，永不再动。
- **用 message 帧重发同步 answered**：SeqDedup 按 seq 丢弃（dedup.ts:24-27），群内其他客户端永远看不到状态更新。
- **浏览器验签器用 `crypto.subtle.timingSafeEqual`**：浏览器没有这个 API（Workers 专有非标准扩展）——运行时 TypeError。
- **callback_url 未做 scheme 校验就 fetch**：见 Security Domain——SSRF 面（send 侧 scheme 白名单 + fetch 跟随重定向的额外跳数）。
- **answered_content 渲染走 innerHTML 直拼**：回复是任意外部输入（同消息 text），必经 renderMarkdown 消毒管道（D-19/D-20 唯一管道纪律）。
- **给 reply 开 HTTP 接口**：D-45 已锁 WS 内——不要"顺手"加 REST 回复。

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| 常时比较（Workers 侧） | 自写 XOR | `crypto.subtle.timingSafeEqual` + 长度前置（D-13 两段式，admin.ts:74-96 复制） | 运行时内置 + 项目既有实现 |
| 回调重试调度 | 自写轮询/setInterval | DO alarm 多事件调度（官方模式） | setInterval 在 DO 休眠时死掉；alarm 唤醒即计费、at-least-once |
| HMAC 实现 | 自写 SHA-256 | `crypto.subtle`（Workers/浏览器）/ `node:crypto`（Node） | Web Crypto 官方全支持 HMAC；手写密码学是禁区 |
| 随机 secret | Math.random / 直接取模 | `generateRandomString`（拒绝采样，keys.ts:88-99） | 取模偏差；既有实现零成本复用 |
| 回调重试队列产品 | Cloudflare Queues | callbacks 表 + alarm | CLAUDE.md Do-NOT-use；免费额度内 Queues 是额外维度 |
| 测试页 Markdown 渲染 | test.js 内嵌第二套渲染 | `window.PushHub.renderMarkdown` | 双管道漂移 = 消毒防线失守（prohibition） |
| 邮件通知般的"可靠投递"语义 | 消息表/双写/事务日志 | callbacks 单表 + at-least-once + 接收方幂等 | Stripe 同哲学（官方文档 Handle duplicate events：去重责任在接收方，按 event ID） |

**Key insight:** 本期所有"新"问题（调度、签名、重试）在平台层和代码库里都已有标准答案——alarm 官方模式、Web Crypto、D-13 两段式、generateRandomString、normalizeIdRecord。计划的任务是**组装既有模式**，不是发明新机制。

## Runtime State Inventory

> 本期含 KV schema 演进 + DO 新表 + 生产遗留频道——按迁移核对。

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data (KV) | 生产 KV 约 10 个 ch: 记录（0.1.0~0.1.12 建）无 signingSecret 字段 [VERIFIED: DEPLOY.md 0.1.11 行"10 个频道"+ keys.ts 现结构] | 惰性补发（reveal/reset 端点 migrate-on-touch）；不需要迁移脚本 |
| Stored data (DO SQLite) | messages 表 answered 四列已在（只 UPDATE）；**callbacks 新表经构造器幂等 DDL 在下次唤醒自动创建**——既有 DO 零迁移 [VERIFIED: chat-room.ts:231-244 构造器重跑 DDL 先例] | 无 |
| Stored data (DO meta) | 现有 `channel_key_gen` 行不动；新增 `retention_due` / `signing_secret` 行（缺省语义各自兜底） | 代码 edit |
| Live service config | 生产 Worker 0.1.12（Version 68251efb）；部署 +1 走 DEPLOY.md 规约 | 常规部署 |
| OS-registered state | 无（无 pm2/Task Scheduler/launchd） | 无——代码库与部署记录无任何 OS 注册项 |
| Secrets/env vars | ADMIN_KEY（wrangler secret）不变；signing secret 是 KV 数据非 Worker secret | 无 |
| Build artifacts | pushhub.js 将变更（reply/frames/事件）→ 字节数变化 → 版本 +1 + `?v=` 注入联动（build.mjs 机制自动） | 常规构建部署 |

**Nothing found in category:** OS-registered state（以上显式核对）。

## Common Pitfalls

### Pitfall 1: alarm 单槽覆盖——重试调度被保留清理"吃掉"（或反之）
**What goes wrong:** 在 reply 处理里 `setAlarm(now+1000)` 而不动现有 alarm() 尾部 `finally setAlarm(+24h)`：首次重试 alarm 触发后尾部无条件重设 +24h，1s/2m/10m/30m 档位全部作废（下一次重试被推迟到 24h 后）。
**Why it happens:** DO 单 alarm 槽是平台语义（setAlarm 覆盖），单职责时代的"尾部无条件重设"是正确模式、双职责时代变成 bug。
**How to avoid:** Pattern 2 的 scheduleNextAlarm 单点重排 + retention_due 持久化到 meta；全部 setAlarm 调用收敛到这一个函数（publish 判空播种点除外）。
**Warning signs:** 集成测试里第二次 runDurableObjectAlarm 后 getAlarm 仍是 +24h 量级而 callbacks.next_attempt_at 是分钟级。

### Pitfall 2: SDK 静默丢弃 answered 同步（若用 message 帧重发）
**What goes wrong:** 群内其他客户端永远看不到"已回复"状态——SeqDedup.shouldDeliver 对已见 seq 返回 false。
**Why:** D-17 去重是防重发机制，同 seq 的任何重发（含内容变化）都被吞。
**How to avoid:** 独立 answered 帧（不带 seq 语义冲突，wid 寻址）；SDK 侧 answered 事件不去重（重复 answered 帧幂等——同一 wid 第二次 answered 理论上不会出现，出现也不破坏 UI）。
**Warning signs:** 单客户端测试通过（本人直接见 ack），双客户端测试失败（对方无反应）。

### Pitfall 3: 浏览器验签器调用不存在的 API
**What goes wrong:** `crypto.subtle.timingSafeEqual` 在 Chrome/Firefox/Safari 抛 TypeError（它是 Workers 专有非标准扩展）。
**Why:** 三个环境三个 API 面（Workers/Node/浏览器）；把服务端实现复制进 test.js。
**How to avoid:** test.js 验签器手写 XOR 累加常时比较（对 hex 字符串的 Uint8Array）；callback-receiver.mjs 用 node:crypto。
**Warning signs:** 验签器一跑就 TypeError: crypto.subtle.timingSafeEqual is not a function。

### Pitfall 4: 回调 body 重序列化导致验签失败
**What goes wrong:** 每次重试 `JSON.stringify(payload)` 重新构造——V8/workerd 不保证键序跨调用稳定（对象字面量插入序虽然实践中稳定，但任何重构/条件字段都会改变），接收方按 rawBody 重算 HMAC 与签名头不匹配。
**Why:** 签名覆盖的是字节不是语义。
**How to avoid:** 入队时序列化一次存 callbacks.body 列，投递永远发送该字符串；timestamp 每次新造但 body 字节冻结。
**Warning signs:** 首次投递验签通过、重试验签失败（或反之）。

### Pitfall 5: 回复 UPDATE 与扇出/入队间插入 await
**What goes wrong:** UPDATE 后 `await`（如 fetch 签名密钥）期间输入门打开，第二条 reply 进来读到 answered=1 被拒——这没错；但若顺序颠倒（先扇出后 UPDATE），两条 reply 都可能成功。
**Why:** DO 输入门在 I/O await 时放行并发事件（既有"零 await 纪律 Pitfall 9"同一根源）。
**How to avoid:** UPDATE 在同步块内完成（exec 即提交）后再做任何 await；签名/入队/重排都在 UPDATE 之后。竞态正确性只依赖 UPDATE 的同步性。
**Warning signs:** 竞态测试（两连接同毫秒发 reply）偶现双成功。

### Pitfall 6: SSRF——callback_url 是发送方可控的 fetch 目标
**What goes wrong:** callback_url 指向内网/元数据端点/任意第三方，DO 替发送方发起请求（放大器 + 探测器）。
**Why:** 回调是产品核心功能，但 URL 完全外部可控。
**How to avoid:** send 侧 scheme 白名单（仅 http/https——现 validateSendBody 只查长度不查 scheme，本期补）；重试封顶 5 次已是放大器上界；响应体不读即 cancel。深防（IP 黑名单/禁私网解析）v1 不做、文档记录取舍。
**Warning signs:** 无直接症状——code review 项 + secure-phase 复查项。

### Pitfall 7: 测试页 Send Key 落 localStorage
**What goes wrong:** Send Key 比 Channel Key 权限高（可发消息烧额度），localStorage 明文滞留。
**How to avoid:** 会话内存态 + 页面注明（或用户明知取舍选择存储）——规划定稿。
**Warning signs:** 无——纯风险项。

### Pitfall 8: 遗留频道无 secret 时回调静默消失
**What goes wrong:** 0.1.12 前建的频道回复后回调不入队也无记录——用户以为功能坏了。
**How to avoid:** Pattern 6——meta 无 secret 时落 status='failed' + last_error="no signing secret"，测试页可见可循补发。

### Pitfall 9: E2E 忘记先 build
**What goes wrong:** `/pushhub.js` 404（playwright.config.ts 注释 Pitfall 9 既有）。
**How to avoid:** webServer command 已链式 build，不改配置即安全；新增 e2e 文件沿既有 testDir。

## Code Examples

### 回调入队（reply 处理尾部，DO 内）

```typescript
// Source: 组装建议（依据 chat-room.ts handlePublish 扇出模式 + keys.ts 序列化先例）
const callbackBody = JSON.stringify({
  message_id: wid,
  reply: selectedOption ?? text,        // D-49/D-54：reply 与 replied_by 字段
  replied_by: by ?? null,
  replied_at: answeredAt,
  channel_id: this.readChannelIdFromMeta(),  // /ws 转发时随内部头落 meta（一次性）
});
this.ctx.storage.sql.exec(
  "INSERT OR REPLACE INTO callbacks (wid, url, body, attempts, next_attempt_at, status, created_at) " +
    "VALUES (?1, ?2, ?3, 0, ?4, 'pending', ?5)",
  wid, callbackUrl, callbackBody, Date.now() + FIRST_RETRY_MS, Date.now(),
);
await this.scheduleNextAlarm();
```

### alarm 到期分发（DO 内）

```typescript
// Source: 组装建议（官方多事件单 alarm 模式 + chat-room.ts alarm 既有骨架）
private async dispatchDueCallbacks(): Promise<void> {
  const due = this.ctx.storage.sql
    .exec("SELECT wid, url, body, attempts FROM callbacks WHERE status = 'pending' AND next_attempt_at <= ?1", Date.now())
    .toArray() as unknown as DueRow[];
  for (const row of due) {
    // attempts 先行递增（崩溃在 fetch 中途按已消耗计——at-least-once）
    this.ctx.storage.sql.exec(
      "UPDATE callbacks SET attempts = attempts + 1, next_attempt_at = ?2 WHERE wid = ?1",
      row.wid, Date.now() + retryDelayMs(row.attempts + 1),   // 档位函数：1s/2m/10m/30m
    );
    const secret = this.readMeta("signing_secret");
    try {
      if (secret === null) throw new Error("no signing secret");
      const ts = String(Date.now());
      const sig = await signCallback(secret, ts, row.body);   // Pattern 4
      const resp = await fetch(row.url, { method: "POST", headers: { /* 三头 */ }, body: row.body });
      if (resp.ok) {
        this.ctx.storage.sql.exec("UPDATE callbacks SET status = 'delivered' WHERE wid = ?1", row.wid);
        continue;
      }
      this.ctx.storage.sql.exec("UPDATE callbacks SET last_error = ?2 WHERE wid = ?1", row.wid, `HTTP ${resp.status}`);
      resp.body?.cancel();
    } catch (e) {
      this.ctx.storage.sql.exec("UPDATE callbacks SET last_error = ?2 WHERE wid = ?1", row.wid, String(e).slice(0, 200));
    }
    // 封顶判定：attempts >= CALLBACK_MAX_ATTEMPTS → status='failed', final_failed_at=now
  }
}
```

### 浏览器常时比较（test.js 验签器）

```javascript
// Source: 组装建议（浏览器无 timingSafeEqual——手写 XOR 累加；hex 串等长比较前置）
function timingSafeEqualHex(aHex, bHex) {
  var a = new TextEncoder().encode(aHex);
  var b = new TextEncoder().encode(bHex);
  var diff = a.length ^ b.length;
  for (var i = 0; i < Math.min(a.length, b.length); i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
```

### callback-receiver.mjs 验签核心（Node）

```javascript
// Source: 组装建议（D-48 三步：时间窗 → 重算 → 常时比较；Stripe 手动验签同构）
import { createHmac, timingSafeEqual } from "node:crypto";

function verify(rawBody, headers, secret, toleranceMs = 300_000) {
  const ts = headers["pushhub-timestamp"];
  const sig = headers["pushhub-signature"];
  const wid = headers["pushhub-message-id"];
  if (!ts || !sig || !wid) return { ok: false, reason: "missing headers" };
  if (Math.abs(Date.now() - Number(ts)) > toleranceMs) return { ok: false, reason: "timestamp outside tolerance" };
  const expected = createHmac("sha256", secret).update(`${ts}.${rawBody}`).digest("hex");
  const a = Buffer.from(expected), b = Buffer.from(sig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "signature mismatch" };
  return { ok: true, wid };
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| 单职责 alarm（D-08 保留清理） | 多事件单槽调度（官方模式：存储日程 + min 重排） | 本期引入 | alarm() 成为调度器；retention_due 必须持久化 |
| vitest-pool-workers 0.22（CLAUDE.md 记录） | @cloudflare/vitest-plugin 1.1.0 | Phase 1 已切换 | 测试 import 自 `@cloudflare/vitest-plugin`；`runDurableObjectAlarm`/`runInDurableObject` 来自 `cloudflare:test` 不变 |
| 消息单向（send→fanout） | 双向闭环（reply→answered→callback） | 本期 | 协议首个 C→S 业务帧（sync/ping 之外） |

**Deprecated/outdated:**
- `@cloudflare/workers-types` 手动安装——已被 `wrangler types` 取代（CLAUDE.md 既有记录，继续遵守）。
- CLAUDE.md「vitest-pool-workers 0.22.0」表述——仓库实况是 `@cloudflare/vitest-plugin@1.1.0`（见 Standard Stack 修正项）。

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Node `node:crypto.timingSafeEqual` 长度不等抛错、需两段式（长度前置） | Pattern 4 / Code Examples | 低——Node 标准库常识，实现时一行验证；即使记错也在首跑暴露 |
| A2 | `cloudflare:test` 提供 fetchMock 可拦截 DO 外呼 fetch | Pattern 10 | 低——有保底方案（本地 node:http 服务器作 callback_url）；实现首日 spike 定夺 |
| A3 | callbacks 表量级极小（个人/小团队），逐条 await 分发足够 | Pattern 3 | 低——若并发大可改 Promise.all（受 6 并发连接上限约束） |
| A4 | workers.dev 测试进程可 fetch localhost（E2E/集成回调目标） | Pattern 10 | 低——与 A2 同一 spike 验证；wrangler dev 下 DO 与测试同机 |
| A5 | 回答帧 answered_content ≤32KB 落 TEXT 列无压力 | Pattern 9 | 极低——SQLite 单行 2MB 上限，32KB 文本远低 |
| A6 | timestamp 用毫秒（与 created_at/answered_at 同口径） | Pattern 4 / Open Q2 | 低——纯约定，接收方按头解析；ms/s 混淆会导致容忍窗错 1000 倍，callback-receiver 与文档必须同口径 |

**其余全部 claims 已 VERIFIED/CITED**（代码引用开行号、平台事实引官方文档）。

## Open Questions

1. **signing secret 管理 UI 的落点（D-47 与 D-58 表面冲突）**
   - What we know: D-47 说"管理页可查可重置（掩码显示同 D-29）"；D-58 说"管理页本期不动（admin.js 不再膨胀）"。
   - What's unclear: 查/重置的 UI 放哪。
   - Recommendation: 本期交付 **API 端点**（GET reveal / POST reset，CHANNELS_PATH_RE 白名单加 `signing-secret` 段）+ 201/200 响应即完整值返回（D-13 唯一完整返回点先例）；admin.html UI 集成延后（尊重 D-58）。若用户想要 UI，最小方案是 test 页加一个可选 Admin Key 的管理小区块。规划时向用户确认。
2. **timestamp 单位（ms vs s）**
   - What we know: 协议全域时间戳（created_at/answered_at）都是 Date.now() 毫秒。
   - Recommendation: 毫秒，全局同口径；测试页验签器与 callback-receiver.mjs 同值常量。风险见 A6。
3. **失败记录查询 API 的鉴权层级**
   - What we know: D-58 锁测试页为入口；测试页天然持有 Channel Key 与 Send Key。
   - Recommendation: 新公网路由 `GET /api/callback-failures`（Bearer **Channel Key**，KEY-01 定义 Channel Key = 接收+回复权限，失败记录是频道域诊断数据）→ Worker ch: 预检 → DO 内部 `/callback-failures` 转发（D-36 模式换鉴权域）。备选：admin 域路由（测试页需加 Admin Key 输入，加重使用负担）。规划定稿。
4. **ack 帧字段最小集**
   - What we know: D-45 锁三帧但字段细节 discretionary。
   - Recommendation: `{v, type:"ack", wid}` 最小集（成功信号无需冗余——answered 扇出紧随其后携带全量状态）；SDK 静默消费 ack、以 answered 事件为公共确认信号。
5. **回调即时首投（t0）在 reply 处理内同步做还是入队后立即 dispatch**
   - Recommendation: 入队 + 立即 dispatch 一次（复用同一条投递函数），失败才走 alarm 档位——代码单路径、竞态面最小。

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | callback-receiver.mjs / smoke / 测试 | ✓ | 22（smoke.mjs 既有前提） | — |
| pnpm | workspace 命令 | ✓ | 10.33.0（packageManager 字段） | — |
| wrangler | dev/deploy | ✓ | 4.126.0（server devDeps） | — |
| Playwright | 测试页 E2E | ✓ | 1.62.1 + 既有 config | — |
| 生产入口 | 部署验证 | ✓ | https://pushhub.dyun.org（自定义域名，UAT 已验证可用） | workers.dev 本机被 SNI/DNS 污染阻断（STATE.md 记录） |
| 本地回调端口 | SC5/E2E 接收器 | ✓ | 任选非标准端口（CLAUDE.md 端口规约） | — |

**Missing dependencies with no fallback:** 无。
**Missing dependencies with fallback:** 无。

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | vitest 4.1.11 + @cloudflare/vitest-plugin 1.1.0（server，真 workerd）；vitest node 环境（web-sdk 单测）；@playwright/test 1.62.1（E2E） |
| Config file | packages/server/vitest.config.ts（cloudflareTest + wrangler configPath + ADMIN_KEY 测试注入）/ packages/web-sdk/vitest.config.ts / packages/web-sdk/playwright.config.ts |
| Quick run command | `pnpm --filter @pushhub/server exec vitest run test/reply-chain.test.ts --max-workers=1 --no-isolate`（单文件）；`pnpm --filter @pushhub/web-sdk exec vitest run test/frames.test.ts` |
| Full suite command | `pnpm test`（server + web-sdk 单测）+ `pnpm --filter @pushhub/web-sdk run e2e` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| RPL-01/RPL-02 | reply 帧 → 校验 → ack/answered；text 为 Markdown 透传 | integration | `pnpm --filter @pushhub/server exec vitest run test/reply-chain.test.ts --max-workers=1 --no-isolate` | ❌ Wave 0 |
| RPL-05 + D-42/D-44 | answered 扇出 + 二次 reply 拒绝（already_replied/not_found 区分）+ 双客户端竞态 | integration | 同上（同文件 describe） | ❌ Wave 0 |
| RPL-03 + KEY-06 | 回调 POST 三头 + HMAC 签名（Node createHmac 交叉验证） | integration | `pnpm --filter @pushhub/server exec vitest run test/callback-delivery.test.ts --max-workers=1 --no-isolate` | ❌ Wave 0 |
| RPL-04 | alarm 重试档位/封顶/failed 记录/与保留清理并存 | integration | 同 callback-delivery（runDurableObjectAlarm 直调） | ❌ Wave 0 |
| D-46/D-53 | reply 载荷恰一/白名单/by 上限反例 | unit（shared） | `pnpm --filter @pushhub/server exec vitest run test/fixtures-contract.test.ts --max-workers=1 --no-isolate` | ✅ 存在，需扩展 |
| WEB-03 | SDK reply()/answered 事件/frames 守卫 | unit | `pnpm --filter @pushhub/web-sdk exec vitest run test/frames.test.ts test/adapter-lifecycle.test.ts` | ✅ 存在，需扩展 |
| ADM-04 | 测试页全交互（构造→发送→流→回复→冻结→验签→失败查询） | e2e | `pnpm --filter @pushhub/web-sdk run e2e --grep test-page` | ❌ Wave 0 |
| SC5 | 生产回复链冒烟（smoke 扩展步骤） | smoke | `PH_SMOKE_URL=https://pushhub.dyun.org PH_ADMIN_KEY=... node scripts/smoke.mjs` | ✅ smoke.mjs 在，需扩展 |

### Sampling Rate

- **Per task commit:** 单文件 quick run（上表对应行）
- **Per wave merge:** `pnpm test`（server + 单测全量）
- **Phase gate:** 全量 + e2e + 生产部署冒烟（DEPLOY.md D-15 流程 + 回复链扩展步）

### Wave 0 Gaps

- [ ] `packages/server/test/reply-chain.test.ts` — covers RPL-01/02/05、D-42/D-44 竞态
- [ ] `packages/server/test/callback-delivery.test.ts` — covers RPL-03/04、KEY-06（含 alarm 重试与并存回归）
- [ ] `packages/web-sdk/e2e/test-page.spec.ts` — covers ADM-04、SC1/SC4 页面侧
- [ ] fetchMock 可用性 spike（A2）——callback-delivery 测试的前置一步
- [ ] `cache-bust-sync.test.ts` 扩展 test.html（若 test.html 引用 pushhub.js?v=）

*(shared fixtures 契约测试与 web-sdk 单测文件已存在，仅需扩展——不是 gap 是任务)*

## Security Domain

> security_enforcement: true（config.json），ASVS Level 1。

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes（密钥鉴权延续） | Channel Key 路径段（WS 域）；Bearer（send/admin 域）；本期无新身份体系 |
| V3 Session Management | no（新增） | 既有 WS 会话语义不变 |
| V4 Access Control | yes | 失败记录查询鉴权（Open Q3：Channel Key 域）；signing secret 管理端点 admin 鉴权 |
| V5 Input Validation | yes | validateInboundFrame reply 分支（恰一/白名单/长度——shared 纯函数）；callback_url scheme 白名单（本期补） |
| V6 Cryptography | yes | HMAC-SHA256 仅经 Web Crypto / node:crypto（禁手写）；常时比较三环境各有标准实现；secret 生成拒绝采样 |

### Known Threat Patterns for CF Workers + WS + 回调

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| 伪造回调（发送方被第三方欺骗） | Spoofing | KEY-06 全部：三头 + HMAC + 时间窗 + 常时比较 |
| 回调重放 | Repudiation/Replay | timestamp 入签名（改 ts 即签名失效）+ 容忍窗拒收（Stripe 同构） |
| 篡改回调 body | Tampering | 签名覆盖 rawBody 字节（Pattern 4 预序列化保证重试字节不变） |
| SSRF via callback_url | Information Disclosure / 扩大攻击 | send 侧 scheme 白名单（仅 http/https）+ 重试封顶 5 次 + 响应体 cancel；深防取舍文档化 |
| answered_by 藏 XSS（展示名/回复内容） | Tampering/XSS | textContent（纯文本）或 renderMarkdown 消毒管道（D-53 明令）；测试页双路纪律 |
| 验签侧时序侧信道 | Information Disclosure | 常时比较（Workers 内置 / Node 内置 / 浏览器手写 XOR）+ 长度前置 |
| signing secret 泄露 | Elevation | 与 Send Key 权限分离（D-47）；可独立重置；管理端点 D-13 两段式鉴权 |
| 重试放大（DoS 第三方） | DoS | 档位 1s/2m/10m/30m + 封顶 5 次（每消息回调子请求上界 5） |
| 测试页 Send Key 滞留 | Information Disclosure | localStorage 取舍明示（Pitfall 7，规划定稿） |

## Sources

### Primary (HIGH confidence)

- [DO Alarms API 官方文档（Markdown 直读）](https://developers.cloudflare.com/durable-objects/api/alarms/) — 单 alarm 槽/setAlarm 覆盖/2s 起 6 次重试/单实例串行/多事件单 alarm 官方模式/getAlarm 运行中返回 null/构造器 setAlarm 前置检查/alarmInfo
- [Workers Web Crypto 官方文档（Markdown 直读）](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/) — HMAC 全支持矩阵、timingSafeEqual 非标准扩展声明、官方 hex 编码模式
- [Workers Platform Limits 官方文档（2026-07-28 更新，Markdown 直读）](https://developers.cloudflare.com/workers/platform/limits/) — 子请求 50/次（免费）、并发连接 6/次、DO alarm 墙钟 15 分钟、CPU 10ms
- [Stripe Webhooks 官方文档（Markdown 直读）](https://docs.stripe.com/webhooks) — signed_payload = ts + "." + rawBody、HMAC-SHA256、常时比较、5 分钟默认容忍、禁 0 容忍、重试新生成签名
- 仓库源码（全部 Read 实读，行号见各 VERIFIED 引用）：shared/src/index.ts、shared/src/validators.ts、shared/README.md、shared/fixtures/（3 例抽样 + 全目录清单）、server/src/chat-room.ts、index.ts、admin.ts、keys.ts、envelope 经 admin.ts 交叉、server/public/{index.html,viewer.js,admin.js(掩码段)}、web-sdk/src/{pushhub.ts,frames.ts,dedup.ts,connection-machine.ts,render/render-markdown.ts}、build.mjs、wrangler.jsonc、vitest.config.ts ×2、playwright.config.ts、package.json ×3、test/{retention-alarm,fixtures-contract}.test.ts、scripts/smoke.mjs、DEPLOY.md、STATE.md、REQUIREMENTS.md、04-CONTEXT.md

### Secondary (MEDIUM confidence)

- [Use Workers KV from Durable Objects（官方示例页存在性，nav 目录确认）](https://developers.cloudflare.com/durable-objects/examples/use-workers-kv-from-durable-objects/) — DO 可用 KV 绑定（备选方案依据，未取正文）
- [Elson Tan: DO alarm task queue pattern](https://elsontan.com/blog/alarm-driven-task-queues/) — attempts 先行递增的 dead-letter 模式佐证（与官方 at-least-once 组合）

### Tertiary (LOW confidence)

- `cloudflare:test` fetchMock 可拦截 DO 外呼——[ASSUMED]（A2，实现首日 spike）

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — 零新包；全部平台 API 官方文档直读核实
- Architecture: HIGH — 全部集成点实读源码并记录行号；alarm 重构模式来自官方推荐范式；竞态/去重两个硬约束有代码级实证
- Pitfalls: HIGH — 每条有代码行号或官方文档出处；Pitfall 1/2/4 是本期最可能造成返工的三项

**Research date:** 2026-08-28
**Valid until:** 2026-09-27（平台事实稳定；Cloudflare 文档页更新频繁但 alarm/limits 语义多年未变）
