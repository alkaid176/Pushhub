# Project Research Summary — PushHub

**Synthesized:** 2026-08-26 from STACK / FEATURES / ARCHITECTURE / PITFALLS research
**Product:** Webhook 实时通知 + 群聊回复系统（Cloudflare Workers 服务端 + Tauri/Android/Web-SDK 三端客户端）

---

## Key Findings

### Stack（版本经 registry 实查，置信 HIGH）

- **Server**: Cloudflare Workers + SQLite-backed Durable Objects（Free 计划只支持 SQLite backend）+ KV（仅存密钥元数据）+ Static Assets（管理页与 pushhub.js 免费不限量托管）。wrangler 4.126.0，`wrangler types` 生成类型（取代手动 workers-types）。
- **核心省额度手段**: 必须用 `ctx.acceptWebSocket()`（Hibernation API）+ `setWebSocketAutoResponse()`（应用层 ping 零计费回 pong）+ `serializeAttachment`（连接状态跨休眠存活，≤2KB）。非休眠 `ws.accept()` 一个 24/7 群烧掉 83% 日时长预算（13,000 GB-s/天 ≈ 28.9 活跃小时）。
- **Desktop**: Tauri 2.11.5 + tokio-tungstenite 0.30（自写重连）+ tauri-plugin-notification；**WS 连接必须归 Rust 侧**（窗口可关、连接不断）；single-instance 插件 Windows 上必须第一个注册。
- **Android**: Kotlin 2.2 + OkHttp 5.5 WS + 前台服务类型用 **`specialUse`**（Android 15 对 dataSync 有每日 6 小时硬超时）；连接归前台服务所有，不放 Activity。
- **Web SDK**: TypeScript + esbuild 单文件 IIFE（~70KB min：SDK 逻辑 + marked 18 + DOMPurify 3.4）；手写指数退避重连；**DOMPurify 是必选项**——消息来自任意外部发送方，不消毒 = 存储型 XSS 直通所有客户端（本域最高危坑）。
- **Testing**: vitest-pool-workers 0.22（真 workerd/DO/WS）；注意 Vitest 4 时代文件级隔离、alarm 不隔离等已知怪癖——一场景一测试文件。
- **Monorepo**: pnpm workspace；`shared/` 协议包（TS 类型 + golden JSON fixtures）是四端契约，Rust/Kotlin 手工镜像，schema 变更 PR checklist 固定四端同步。

### Features（8 竞品一手文档对比，置信 HIGH）

- **差异化核心（无人占据的生态位）**: **D3 逐消息 callback_url**——8 个竞品（Telegram/Slack/Discord/ntfy…）全部要求预注册回调端点，没有人让发送方随消息附带新 callback_url。这是"Stripe webhook 模式应用于通知"，零常驻服务器的自动化脚本也能闭环。
- **Table stakes（缺了即感觉坏掉）**: title+body 分离（8/8 竞品都有，**PROJECT.md 草案 payload 缺 title**）、Markdown 默认渲染、离线补拉（since 游标重放）、密钥管理 UI、消息大小上限+明确错误码、2 秒内送达。
- **应答态同步（D4）**：所有人看到"X 已回复：确认"——没有它群聊退化为三人各回一次、callback 收三份重复回复。
- **反功能需坚守**：不做附件（用 Markdown 图片链接）、不做账号体系、不做 E2EE（与回调中继架构矛盾，诚实文档化信任模型）、不做邮件/短信扇出、不做服务端定时发送。

### Architecture（官方 workers-chat-demo 源码直接阅读为锚，MEDIUM-HIGH）

- 一个 Worker 三个平面：API（`/api/*`）+ 静态资产（管理页/pushhub.js）+ Channel DO namespace（一群一 DO）。
- **路由关键决策**: KV 存 `ch:<channel_key> → channelId`，DO 用 `idFromName(immutable channelId)` 寻址——直接按 key 路由则重置密钥会孤儿化全部历史。
- **鉴权分层**: Worker 入口 KV 预检（cacheTtl 60s，边缘缓存≈免费）→ DO 内强一致最终裁决；浏览器 WS 无法带 Authorization 头，v1 务实取舍为查询串带 key（泄露面仅自有日志，密钥可独立重置兜底）。
- **可靠性模型 = 游标对账**: 服务端先写库再扇出（write-ahead），消息 id 用 SQLite rowid 单调 seq，客户端记 last_seq，重连带 seq 补拉 + 按 seq 幂等去重——一个模型同时解决丢消息/重复/半开连接三个问题。
- **构建顺序原则**: 尽早冻结线协议（服务端核心 + Web SDK 参考实现），之后每个客户端都是纯移植、零服务端改动。

## Implications for Roadmap

建议 6 个 Phase（与 ARCHITECTURE Build Order 和 FEATURES 排序约束一致）：

1. **服务端核心 + 协议设计**（shared/ 协议包 + Worker 骨架 + KV 密钥模型 + ChatRoom DO：休眠 WS、扇出、SQLite 历史、sync/since 补拉 + `POST /api/send`）。协议三要素（seq 游标、answered 状态字段、版本字段 + golden fixtures）在此一次定对——四端联动返工成本是单端四倍。验收必须含"空闲群不产生 DO 时长计费"。
2. **Web SDK + 测试页**（重连退避、心跳、last_seq 补拉、DOMPurify 消毒模块）。它是其余客户端的参考实现，且是最便宜的端到端协议验证器。重连风暴防线（1,000 req/min 突发限额）在此与服务端同步落地。
3. **管理页 + 密钥生命周期**（create/list/reset/delete + kick-all）。真实客户端接入前必需；固化密钥轮换 ≤60s 双活窗口语义。
4. **回复链 + 回调送达**（options 渲染、reply API、answered-state 广播、callback POST + pending_callbacks alarm 重试 + 每 Send Key 限流）。旗舰差异化阶段、也是最大集成风险面——尽早用真实自动化脚本原型验证回调重试语义。
5. **Tauri 桌面客户端**（Rust WS 核心 + 托盘 + 通知 + 回复窗口）。用户有成熟 Tauri 经验，最快原生成果；协议此时已冻结。
6. **Android 客户端**（specialUse FGS + OkHttp + Room + 通知）。最重工具链、国产 ROM 风险最高，放最后移植已验证协议。**首周必须真机 spike**（specialUse 存活 + MIUI/EMUI 锁屏 8 小时验收）。

**Research flags**: Phase 1-2 建议带 `--research-phase`（wrangler types 与 vitest-pool-workers 兼容性 issue #8802 复查）；Phase 4 需回调重试语义 spike；Phase 6 需 Android FGS 真机 spike。Phase 3/5 模式成熟可跳过深度研究。

## Recommended Requirement Additions

PROJECT.md Active 需求可能遗漏、研究建议补充：

1. **`title` 字段**（table stakes #2）：全部 8 竞品分离 title/body，是通知标题行；PROJECT.md 消息模型只有 `text`。
2. **answered 状态同步**（D4）：广播"已由 X 回复"事件 + 随历史返回——没有它多客户端重复回复、callback 重复送达。
3. **离线补拉游标（seq/last_seq）作为协议脊柱**：PROJECT.md 有"历史消息"但未明确单调 seq + 幂等去重模型；这是可靠性的第一设计决策。
4. **`priority?: "low"|"normal"|"high"` 与 `click_url?`**：廉价 table stakes（ntfy/Bark/Server酱 均有），映射到 Android 通知通道 / Windows toast 场景。
5. **消息大小限制**（建议 text ≤ 8,192 字符、options 上限、callback_url ≤ 2,048 字符）+ 明确错误码。
6. **每 Send Key 限流**（如 30 条/分 + 1,000 条/天，桶存 DO SQLite）：防开放中继轰炸，不能"以后再加"。
7. **回调幂等契约文档化**：回调体带 message_id/attempt，文档首段声明"回调可能重复，按 message_id 幂等处理"。
8. **回调送达状态查询端点** `GET /messages/:id/callback-status`（发送方可轮询兜底）。
9. **消息保留期清理**（每频道 ~500 条，alarm 每日批量删除）——免费 DO 存储有限，删除也计行数。
10. **Android 通知权限引导**（POST_NOTIFICATIONS 被拒 = 通知静默失败）与**保活引导页**（国产 ROM 白名单）作为 Android 阶段显式需求。

## Risk Register

| # | 风险 | 后果 | 防线 | Phase |
|---|------|------|------|-------|
| 1 | 非休眠 WebSocket 烧 DO 时长 | 一个 24/7 群烧 83% 日预算，当天额度耗尽 | 只用 `ctx.acceptWebSocket()`；验收含空闲不计时长；上线首日看 dashboard duration 曲线归零 | 1 |
| 2 | Markdown XSS 直通三端 | 存储型 XSS 打所有群成员；Tauri XSS 可触达 IPC | 共享 DOMPurify 消毒模块（Web SDK 建立，Tauri 复用）+ Android Markwon（禁 HtmlPlugin）+ Tauri capabilities/CSP 收敛 + 攻击样本 fixture 回归 | 2/5/6 |
| 3 | 协议无 seq/游标 | 丢消息无法补拉、回复无法引用、事后加 = 四端迁移 | rowid 单调 seq + write-ahead + last_seq 对账 + golden fixtures | 1 |
| 4 | 重连风暴 × 1,000 req/min 突发限额 | 每次部署（本项目高频）后集体 429 雪崩 | 三端统一指数退避 + full jitter 上限 60s；每次部署当免费混沌测试 | 1-2 |
| 5 | Android 国产 ROM 杀前台服务 + 通知权限静默失败 | 真机隔夜断连、"收不到"三连 | specialUse FGS + 保活引导页 + `areNotificationsEnabled()` 常驻提示 + MIUI/EMUI 锁屏 8 小时真机验收 | 6（首周 spike） |
| 6 | KV 60s 最终一致（密钥重置双活窗口）+ wrangler dev 掩盖此差异 | 生产"重置了还能连"灵异现象；本地测试全绿 | 文档化 ≤60s 窗口；删除频道在 DO 内强一致吊销；每次部署后生产冒烟 checklist | 1/3 |
| 7 | 回调滥用（DDoS 放大器）+ 重复/乱序送达 | Worker 替攻击者发 POST；发送方重复触发动作 | callback_url 仅 https、5s 超时、重试 ≤1、并入限流桶；回调体含 attempt + 幂等文档 | 4 |
| 8 | DO 内存状态休眠后丢失 | 生产偶发状态丢失、本地复现不了 | 铁律：DO 内存字段一律视为缓存，任意时刻可从 getWebSockets/attachment/SQLite 重建 | 1 |
| 9 | 50 子请求/调用限制 | Worker 入口层循环扇出/重试即炸 | 每次调用子请求个位数：入口 1 KV 读 + 1 DO fetch；回调在 DO 内发 | 1/4 |
| 10 | Windows 通知无操作按钮 | roadmap 写出落不了地的验收标准 | 预期管理：Windows 通知 = 点击聚焦窗口定位消息，快捷回复在窗口内 | 5 |

## Confidence Assessment

| Area | Level | Notes |
|------|-------|-------|
| Stack | HIGH | 版本全部 registry 实查；CF 限额官方文档多页交叉 |
| Features | HIGH | 7/8 竞品一手官方文档；Telegram 细节 MEDIUM（搜索佐证） |
| Architecture | MEDIUM-HIGH | 官方 demo 源码直接阅读 = HIGH；客户端模式 MEDIUM |
| Pitfalls | HIGH | 官方文档为主；Android OEM 真机表现 MEDIUM（待 spike） |

**Gaps to address in phases**: 免费层入站 WS 是否 20:1 折算（按 1:1 保守）；Android specialUse 真机存活（Phase 6 首周 spike）；DO 存储账户级确切上限（部署后 dashboard 验证）；wrangler types × vitest-pool-workers 兼容（Phase 1 复查）；marked 18 实际体积（构建产物为准）；多次回复回调语义（首答触发 vs 每答触发——spec 级产品决策）。

## Sources

（详见各研究文件；主要来源）

- Cloudflare 官方文档: Workers Limits / DO Pricing & Limits / WebSocket Hibernation / KV Limits / Static Assets Billing / vitest-pool-workers Known Issues
- cloudflare/workers-chat-demo（源码直接阅读）
- Registry 实查（npm / crates.io / Maven Central，2026-08-26）
- 竞品一手文档: docs.ntfy.sh、github.com/Finb/Bark、gotify.net、sct.ftqq.com、github.com/easychen/pushdeer、api.slack.com、discord.com/developers
- Android 官方: FGS types required（14）、FGS timeouts（15）、通知运行时权限；dontkillmyapp.com
- Tauri v2 官方: notification 插件（Windows 限制）、testing、MSRV
