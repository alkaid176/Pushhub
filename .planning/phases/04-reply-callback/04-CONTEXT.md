# Phase 4: 回复链与回调送达 - Context

**Gathered:** 2026-08-28
**Status:** Ready for planning

<domain>
## Phase Boundary

落地旗舰差异化闭环——完整回复链：客户端可回复消息（快捷选项或自定义 Markdown，RPL-01/02）、answered 状态群内实时同步防重复处置（RPL-05）、服务端将回复 HMAC 签名后 POST 回发送方 callback_url 并带 alarm 指数退避重试与最终失败记录（RPL-03/04，KEY-06 验签）；Web SDK 补齐回复 API（WEB-03）；交付独立测试页 test.html（ADM-04：可视化构造消息 + 实时流 + 回复 + 回调验签演示 + 失败记录查询）与 Node 回调接收器脚本（SC5 真实自动化场景证据 + 用户可拷贝的验签参考实现）。

**不在本期**：Windows/安卓客户端回复 UI（Phase 5/6，本期测试页即三端联调工具）、每用户真实身份体系（EXT-04，v2——本期自报展示名即可）、已读回执/撤回（v2）、消息编辑（v2）、npm 包形态（v2）。

</domain>

<decisions>
## Implementation Decisions

### 回复语义与锁定（ROADMAP 点名的 spec 级产品决策）

- **D-42:** 回复**一次锁定**：服务端首答即写入 answered 四字段（D-03 已冻结字段集），后续对同消息的回复请求全部拒绝——错误响应/错误帧须区分"消息不存在"与"已回复"。SC1"快捷按钮冻结防重复处置"的服务端最强保证；个人/小团队告警群一人处置即完成，重复处置无意义 — **Reversibility:** one-way — 回复锁定语义进线协议与回调契约，发布后变更即破坏四端联动契约
- **D-43:** 回调**恰首答触发一次**：只有首次成功回复触发一次 callback POST，被拒回复不回调。发送方按 message_id 天然幂等（SC5 幂等语义最简，发送方去重零成本） — **Reversibility:** one-way — 回调触发语义是对外契约，发送方脚本按此设计
- **D-44:** 回复竞态**先到先得**：DO 单线程串行处理天然无锁，首到者成功、次到者收错误帧；败者客户端随后收到 answered 状态帧，UI 自然冻结（用户看到"已由他人回复"），无需重试 — **Reversibility:** reversible
- **D-45:** 回复走 **WS 内 v:1 reply 帧**（客户端→服务端 wid + selected_option?/text? + by?），服务端回 ack/error 帧 + 全连接扇出 answered 状态帧。协议新增 3 个帧类型（reply/ack/answered 或等价命名）+ golden fixtures 正反例（D-07 只加帧不改语义，合规演进）。**不另开 HTTP 回复接口**——浏览器 WS 已连着（鉴权复用），另开通道纯多余 — **Reversibility:** one-way — 新帧类型进冻结协议 + golden fixtures，删除即协议事件
- **D-46:** 回复载荷验证**恰一 + 白名单**：selected_option 必须在原消息 options 内（白名单校验）；自定义 text ≤ 32KB（同 D-02 text 上限口径）；二者**恰提供其一**（不允许同时/都不提供）；校验失败回错误帧不断连（对齐服务端宽容忽略坏帧的既定语义） — **Reversibility:** costly — 验证规则进 golden fixtures 反例

### 签名密钥方案（KEY-06）

- **D-47:** **每频道独立 signing secret**：随频道创建生成并下发（沿用 201 唯一完整返回点先例，D-13/D-35），管理页可查可重置（掩码显示同 D-29）；回调用 HMAC-SHA256 签名。与 Send Key 权限分离——Send Key 泄露不能伪造回调，signing secret 泄露不能发消息（Stripe/Slack/GitHub webhook 同模式）。存储进 KV ch: 记录（低频写，额度安全） — **Reversibility:** costly — KV 值结构演进（normalize 兼容层既有先例）+ API 响应结构变更
- **D-48:** 签名覆盖 **timestamp + raw body**：headers `PushHub-Message-Id` / `PushHub-Timestamp` / `PushHub-Signature`（HMAC-SHA256 hex）。防重放（timestamp 超时拒收，容忍窗如 5 分钟）+ 防篡改（body 字节变动签名失效）双保险；发送方验签三步：比时间窗 → 重算 HMAC → 常时比较（timingSafeEqual，复用 D-13 两段式模式）。Stripe 同款 — **Reversibility:** one-way — 签名头名与算法是对外契约，发布后发送方脚本按此验签
- **D-49:** 回调 body 用**回调域专用结构**：`{message_id(wid), reply(text 或 selected_option), replied_by, replied_at, channel_id}`——不复用 WS MessageFrame（回调面向脚本、WS 面向聊天客户端，两域客不同不耦合） — **Reversibility:** one-way — 回调 body 结构是对外契约
- **D-50:** 回调重试用 **DO alarm 驱动指数退避**（档位如 1s/2m/10m/30m，总次数封顶 ~5 次），最终失败写 SQLite 失败记录行（wid/url/错误/重试次数/时间），测试页可查。休眠零成本（alarm 唤醒才计费），每条消息回调请求次数封顶，额度可控。**注意与 D-08 保留清理 alarm 的并存设计**（alarm 处理器内分支或独立管理） — **Reversibility:** reversible

### 回复者身份（answered_by 取值）

- **D-51:** answered_by 用**自报展示名**：客户端随回复自报（如"小明的手机""运维笔记本"），服务端不验证直接存 answered_by 并扇出。零账号体系但群内能区分谁处置；同名无害（个人工具）；EXT-04 升级真实身份时可平滑替换 — **Reversibility:** reversible
- **D-52:** 展示名**随 reply 帧携带**（`by?` 字段）——用时才报，未回复的连接可完全匿名挂着；名字可进 attachment（跨休眠存活），后续 reply 默认复用。**不设连接时 identity 声明帧**（避免多一次协议往返与服务端连接→名字映射状态） — **Reversibility:** costly — reply 帧字段集进冻结协议
- **D-53:** 展示名 **≤64 字符（UTF-16 码元，与频道名/label 同口径）可缺省**（缺省 = 匿名回复，answered_by 存 null）；超限回错误帧。客户端渲染 answered_by 时走 textContent 或同消毒管道（防名字藏 XSS——名字是任意外部输入） — **Reversibility:** reversible
- **D-54:** 回调 body **携带 replied_by**（可 null，与 answered_by 同源同值）——发送方脚本可记录"谁确认的"（部署审批日志场景关键上下文） — **Reversibility:** reversible

### 测试页与 SC5（ADM-04）

- **D-55:** 测试页为**独立 test.html + test.js** 静态资产（vanilla 单文件，同 D-37 viewer/admin 模式，零构建零依赖）：全功能双向工具——构造消息表单（title/text/priority/options/callback_url 逐字段可视化输入）+ 发送（Send Key Bearer）+ 实时消息流（Channel Key 经 pushhub.js 接入，复用 SDK 消毒渲染）+ 回复操作（快捷选项按钮 + 自定义输入 + 展示名）+ 回调验签器 + 失败记录查询。**viewer 保持轻量不动**（D-22"只收不发的 demo"定位延续） — **Reversibility:** reversible
- **D-56:** 测试页内置**本地验签器 + 回调观察窗**：粘贴回调 headers/body 可本地验签（时间窗 + HMAC 重算 + 常时比较的可视化演示，教育发送方接入）；callback_url 输入框支持任意外部接收器（webhook.site 等）。浏览器页面不能直接收 POST——观察外部接收器 + 本地验签器组合覆盖可视化需求 — **Reversibility:** reversible
- **D-57:** SC5 交付 **Node 回调接收器脚本**（`scripts/callback-receiver.mjs` 或同级）：本地监听端口收回调 POST → 完整验签 → 打印结果；配合发送脚本模拟"部署完成通知 → 人工点确认 → 脚本收到回调继续执行"全链路。双重交付：SC5 验收证据（真实自动化语境）+ 用户可直接拷贝的验签参考实现 — **Reversibility:** reversible
- **D-58:** 回调最终失败记录（RPL-04 可查）查询入口在**测试页**（按频道拉取，显示 wid/URL/错误/重试次数/最终时间）——测试页是协议排障工具的定位闭环；**管理页本期不动**（ADM-04 域内完成，admin.js 不再膨胀） — **Reversibility:** reversible

### Claude's Discretion

- 新帧类型的具体命名（reply/ack/answered 或 reply_result/message_updated 等）与 ack 帧字段细节——规划阶段随协议细化定，进 golden fixtures 前都可调
- answered 状态同步帧的形态：独立 answered 帧 vs 更新后的 message 帧重发（注意：SDK SeqDedup 按 seq 去重会丢同 seq 重发的 message 帧——倾向独立 answered 帧，规划时定稿）
- 回调重试档位具体数值与总次数上限（~5 次量级已定）
- timestamp 容忍窗具体值（~5 分钟量级已定）
- signing secret 的生成方式与长度（对齐既有 generateSendKey 拒绝采样模式）
- 测试页消息流与 viewer 消息渲染的代码复用方式（test.js 内嵌 vs 提取共享模块——vanilla 零构建约束下倾向简单复制或共享小模块）
- 验签器的 UI 布局与交互细节
- 回调失败记录的 API 路径设计（对齐 D-35 REST 风格 + D-36 内部路由转发模式）
- attachment 存展示名的具体结构演进（现有 clientId/connectedAt 基础上加字段）
- E2E 测试组织（沿用 Phase 2/3 e2e/ 目录模式）

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### 冻结协议与演进规则（本期的最高权威文件）
- `packages/shared/src/index.ts` — v1 线协议唯一事实源：MessageFrame（含 answered 四字段 D-03）、ClientFrame/ServerFrame 全集、LIMITS——本期新增 reply/ack/answered 帧在此扩展
- `packages/shared/README.md` — 协议演进三规则（只加字段不改语义/未知字段忽略/未知 v 断连）——新增帧类型属合规演进，fixtures 联动是协议事件
- `packages/shared/src/validators.ts` — 纯函数校验器模式——reply 帧校验器（恰一+白名单+长度上限）在此扩展
- `packages/shared/fixtures/` — 12 个 golden fixtures——新增帧类型的正反例 fixtures 落此处，逐字节契约测试对齐

### 服务端集成点
- `packages/server/src/chat-room.ts` — ChatRoom DO 全貌：messages 表 13 列（answered 列已在）、webSocketMessage 入站帧处理（reply 帧挂载点）、alarm 处理器（D-08 保留清理——D-50 回调重试 alarm 的并存设计参照）、attachment 结构（D-52 展示名存储点）
- `packages/server/src/index.ts` — Worker 路由分发与 DO 转发模式（X-PH-Verified 内部头）——回调失败记录查询 API 的转发参照
- `packages/server/src/admin.ts` — Admin API 完整路由（D-35 参数化路由 + D-13 两段式常时比较）——D-47 signing secret 管理端点（查/重置）的扩展位
- `packages/server/src/keys.ts` — KV 三前缀键表与 normalize 兼容层——D-47 signing secret 进 ch: 记录的 schema 演进主战场

### 前端资产模式
- `packages/server/public/index.html` + `viewer.js` — viewer 轻量模式（D-22 只收不发——本期保持不动）与 CSP 纵深、localStorage 免填模式——test.html 直接照此模式
- `packages/server/public/admin.html` + `admin.js` — 管理页表单+列表模式与掩码显示（D-29）——测试页表单与 signing secret 展示参照
- `packages/web-sdk/src/pushhub.ts` — SDK 公开 API 类——WEB-03 回复方法（reply() 之类）在此扩展，事件 API 表面延续 D-16 四事件模式
- `packages/web-sdk/src/connection-machine.ts` — 纯状态机——reply 发送是否进状态机（错误重试语义）规划时定；attachment 名字缓存参照
- `packages/web-sdk/src/render/` — 消毒渲染管线（D-19/D-20）——测试页消息流渲染直接复用（经 pushhub.js 的 renderMarkdown）

### 项目规划
- `.planning/ROADMAP.md` §Phase 4 — 阶段目标、5 条成功标准（SC1 锁定同步/SC2 签名回调/SC3 重试可查/SC4 测试页/SC5 真实脚本场景）、Research note（回调重试语义 spike——本次讨论 D-42/D-43 已裁决）
- `.planning/REQUIREMENTS.md` — RPL-01~05、KEY-06、WEB-03、ADM-04 八条本期需求
- `.planning/phases/01-server-core/01-CONTEXT.md` — D-01~D-15（特别是 D-02 上限口径、D-03 answered 字段集、D-06 错误信封、D-07 协议演进规则、D-13 两段式常时比较）
- `.planning/phases/02-web-sdk/02-CONTEXT.md` — D-16~D-27（特别是 D-16 事件 API、D-17 seq 去重——answered 同步不能重发 message 帧的根因、D-19 renderMarkdown、D-22 viewer 定位）
- `.planning/phases/03-admin-keys/03-CONTEXT.md` — D-28~D-41（特别是 D-29 掩码显示、D-35 REST 路由、D-36 内部 /history 转发、D-37 vanilla 单文件模式）

### 部署与验收
- `DEPLOY.md` — 版本 +1 规约、D-15 生产冒烟 checklist——本期部署沿用；SC5 真实场景用 scripts/callback-receiver.mjs（D-57）
- `scripts/smoke.mjs` — 既有生产冒烟脚本——回复链冒烟步骤的扩展位
- `packages/web-sdk/e2e/` + `playwright.config.ts` — Playwright E2E 组织模式（D-26/D-41 沿用）

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `chat-room.ts` 的 messages 表 answered 四列——D-03 Phase 1 已建全，本期只写 UPDATE 不改 schema
- `chat-room.ts` 的 webSocketMessage 入站帧分发结构——reply 帧处理直接挂进既有 switch
- `chat-room.ts` 的 alarm 处理器——D-08 保留清理已验证 alarm 模式，回调重试（D-50）同机制扩展
- `keys.ts` 的 generateSendKey 拒绝采样生成器 + normalize 兼容层——D-47 signing secret 生成与 schema 演进直接复用
- `admin.ts` 的 checkAdminAuth 两段式常时比较——验签常时比较（D-48 发送方侧）与 secret 管理端点鉴权直接复用
- `web-sdk` 的 renderMarkdown（经 pushhub.js 暴露）——测试页消息流消毒渲染零重复实现
- `viewer.js` 的接入表单 + 状态指示 + localStorage 模式——test.html 结构起点

### Established Patterns
- 协议演进：新帧类型 + golden fixtures 正反例 + 逐字节契约测试（D-07 合规路径）
- Worker→DO 转发：INTERNAL_ORIGIN + X-PH-Verified 内部头——失败记录查询 API 沿用
- 错误信封 D-06 + 错误码枚举扩展——"已回复"错误码进枚举
- vanilla 单文件静态资产（D-37）+ build.mjs ?v= 构建期注入——test.html 挂载即得
- 测试：vitest-pool-workers（服务端回复/回调链）+ Playwright 真浏览器 E2E（测试页交互）

### Integration Points
- `shared/src/index.ts` ClientFrame/ServerFrame 联合类型——reply/ack/answered 帧加入点
- `chat-room.ts` webSocketMessage——reply 帧处理入口；answered 扇出复用 publish 的全连接遍历模式
- `chat-room.ts` alarm()——回调重试调度挂载点（与保留清理并存）
- KV ch: 记录——signing secret 字段加入点（normalize 兼容层扩展）
- `server/public/`——test.html + test.js 落位点（wrangler.jsonc assets 无需改动）
- SDK `pushhub.ts`——reply 公开方法与 answered 事件暴露点
- DO 内 fetch() 外呼——回调 POST 的发送点（无状态 fetch + alarm 重试）

</code_context>

<specifics>
## Specific Ideas

- ROADMAP Research note 原文"回调重试语义需 spike（首答触发 vs 每答触发为 spec 级产品决策）"——本次讨论 D-42/D-43 已裁决：一次锁定 + 首答触发一次，spike 需求就此关闭
- SC1"已由某人回复：内容"的"某人"由 D-51 自报展示名承载——匿名时显示"已回复：内容"
- 签名方案对标 Stripe webhook（timestamp+body HMAC + 时间窗拒收）——发送方接入文档可直接引用 Stripe 心智
- SC5"部署完成通知 → 人工点确认 → 脚本收到回调继续执行"——callback-receiver.mjs 是这个场景的可拷贝实体，测试页是人工点确认的操作台
- SDK seq 去重（D-17/SeqDedup）决定了 answered 同步必须是新帧类型而非 message 帧重发——这是代码层硬约束（同名 seq 第二次出现会被静默丢弃）

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 4-回复链与回调送达*
*Context gathered: 2026-08-28*
