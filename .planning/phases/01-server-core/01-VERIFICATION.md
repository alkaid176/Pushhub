---
phase: 01-server-core
verified: 2026-08-26T19:55:00Z
status: human_needed
score: 4/5 must-haves verified
behavior_unverified: 1 # SC3 production DO-duration observation (manual-only; mechanism itself has a passing behavioral test)
overrides_applied: 0
behavior_unverified_items:
  - truth: "频道空闲（有挂起 WS 连接但无消息流量）时，生产环境 Cloudflare dashboard 的 DO duration 不增长——Hibernation 生效，免费额度不被空闲连接烧掉"
    test: "在 https://pushhub.snake160220.workers.dev 上保持一条 WS 连接（如 wss://…/api/ws/<channelKey>），空闲 5-10 分钟后打开 Cloudflare dashboard → Workers & Pages → pushhub → Durable Objects → Duration 指标"
    expected: "空闲期间 duration 曲线平直不增长（部署后的 WS 重连尖峰回落为平直属预期）"
    why_human: "wrangler dev 不驱逐 DO，本地无法观察；DO duration 是生产计费指标，仅 dashboard 可见（D-15 checklist ④，wrangler dev 不驱逐 DO 故只能生产验证）"
coincidental_reliance_items:
  - truth: "SC1 生产端到端延迟 < 2 秒（当前部署版本）"
    reason: undeclared-precondition
    harden: "量化延迟证据（285ms/1119ms）来自 v0.1.0/v0.1.1 生产冒烟；当前 v0.1.4 因网络阻断未做生产冒烟（核心扇出路径自 01-01 结构未变，本地真 workerd 60/60 为等价证据）。网络窗口恢复后重跑 smoke.mjs（含 LATENCY 输出）即为该前置条件的显式确认"
human_verification:
  - test: "观察生产 DO duration（验收 3 / SRV-04）"
    expected: "冒烟频道空闲数分钟后 dashboard 的 Durable Objects Duration 指标无增长"
    why_human: "计费指标仅生产 dashboard 可见；本地 wrangler dev 不驱逐 DO"
  - test: "网络窗口恢复后重跑生产冒烟：PH_SMOKE_URL=https://pushhub.snake160220.workers.dev PH_ADMIN_KEY=<secret> node scripts/smoke.mjs（通过后同时关闭 WINDOWS.md 条目 2/3）"
    expected: "输出 SMOKE OK 且 LATENCY < 2000ms（含 admin 建频道、断线补拉恰 2 条、401/413 反例全过）"
    why_human: "*.workers.dev 对本机 SNI 阻断 + DNS 污染（本次验证再探 15s 超时确认仍阻断）——环境问题非代码缺陷"
  - test: "裁决 CR-01（评审 Critical）：packages/server/src/admin.ts:44-49 长度前置检查用 UTF-16 码元数而非字节数——构造等码元长度的非 ASCII Bearer 可使 timingSafeEqual 抛未捕获异常返回 500（违反 D-06 信封契约与'一律 401'不变量）。修复为按 TextEncoder 字节长度比较（评审给出 5 行修复）"
    expected: "修复后补非 ASCII Bearer 反例断言 401；或明示接受为已知问题（接受则在本 frontmatter 加 overrides 条目，Phase 3 管理页前修复）"
    why_human: "实现符合 01-05 计划字面（'先比长度再比较'），缺陷在计划设计本身；评审标记 advisory，属接受/立即修复的裁量决策"
  - test: "确认 4 条 judgment 级禁令的验证结论（grep + 测试证据已由验证器采集）：① 服务端哑管道（不解析/截断/改写 Markdown，text 逐字节透传有测试断言）；② 密钥不落日志（src 零日志语句）；③ Phase 1 不对 callback_url/click_url 发服务端 fetch（src 无外连 fetch）；④ shared 包零 Workers 运行时依赖与 KV 前缀（grep 零命中）"
    expected: "用户确认四条禁令均未发生（结论：全部成立）"
    why_human: "judgment 级禁令按流程需人工背书；自动化证据为 grep/测试，语义判断需人确认"
---

# Phase 1: Server Core Verification Report

**Phase Goal:** 外部系统 POST 的通知消息实时送达频道内所有 WebSocket 客户端，断线重连补拉零丢失，且服务端在 Cloudflare 免费额度内运行；线协议（seq 游标、answered 状态字段、版本字段 + golden fixtures）就此冻结
**Verified:** 2026-08-26T19:55:00Z
**Status:** human_needed
**Re-verification:** No — initial verification

## Goal Achievement

验证方法：不信任 SUMMARY 陈述，全部对照实际代码库——通读 `packages/server/src/*`（6 文件）与 `packages/shared/src/*`（2 文件）、独立重跑全量测试与 typecheck、核对 git log 25 个提交、核查 DEPLOY.md/WINDOWS.md 部署与阻断记录、亲自探测生产 URL 现状。

### Observable Truths（按 ROADMAP 成功标准）

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | 发送方以 Send Key 调 POST /api/send（title、Markdown body、可选 options/callback_url），同频道所有在线 WS 客户端 2 秒内实时收到 | ✓ VERIFIED（含 1 条 coincidental-reliance 顾问项） | 代码链完整：index.ts handleSend（Bearer→KV sk: 预检→validateSendBody→DO 转发）+ chat-room.ts handlePublish（落库→冻结 MessageFrame 扇出）。行为测试：ws-fanout（双客户端实收）、send-payload-fields（全字段透传+Markdown 逐字节哑管道）、group-semantics（三端同帧）。生产证据：v0.1.0 SMOKE OK 285ms、v0.1.1 SMOKE OK 1119ms（均 < 2000ms，同一扇出架构）；当前 v0.1.4 生产再冒烟因网络阻断待补（见 human items） |
| 2 | 多客户端互通；离线重连经 since 补拉零丢失，按 seq 幂等去重零重复 | ✓ VERIFIED | 真实 workerd 行为测试：sync-catchup（220 条三帧并集 Set 恰 1..220、wid 全唯一、keyset 翻页、limit 三态、oldest_kept_seq 诚实）；group-semantics（断开后其余端照收、重连 sync since 恰补 5 条 seq 连续）；seq-monotonic（20 并发 seq 集恰 1..20、同文本重发新 seq/wid）。补拉查询为 `WHERE seq > ? ORDER BY seq ASC LIMIT n+1`，无 OFFSET |
| 3 | 频道空闲时生产 DO duration 不增长（免费额度不被空闲连接烧掉） | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED（生产维度） | 机制全部就位且有行为测试：构造器 setWebSocketAutoResponse（休眠唤醒重设）、acceptWebSocket（全码无标准 ws.accept()）、serializeAttachment；ws-hibernation-wiring 经 evictDurableObject 真驱逐后 ping→pong 字节精确、消息仍达、attachment 逐字段恢复。但"生产 dashboard duration 平直"本身只能人工观察（wrangler dev 不驱逐 DO）——见 Human Verification #1 |
| 4 | 无效/缺失密钥的 /send 与 WS 被拒；单 Send Key 超 30 条/分钟收到 429 | ✓ VERIFIED | rate-limit.test：第 31 条 429 + 冻结信封逐字节一致 + Retry-After 整数头、分键隔离、被拒不消耗 seq、窗口滚动恢复；ws-fanout/send-basic：无效 Send Key/Channel Key 双路径 401 invalid_key 且不创建 DO stub；admin-channels：三级密钥双向隔离（Channel Key 发送 401 / Send Key 连 WS 401 / Admin 不通用）。注：admin 路径存在 CR-01 边缘缺陷（非 ASCII Bearer 构造可 500 而非 401）——不影响本条 SC 的 /send 与 WS 主张，见 Gaps Summary 与 Human Verification #3 |
| 5 | shared/ 协议包（TS 类型 + golden fixtures，含版本字段）就位，服务端测试对正反例 fixture 全部通过——三端移植契约基线 | ✓ VERIFIED | packages/shared/src/index.ts（PROTOCOL_VERSION=1、全帧类型、LIMITS/RETENTION/INITIAL_FETCH/SYNC_*/RATE_*/WID_* 常量）；validators.ts（纯函数，阈值全引用常量零裸数字）；12 个 golden fixtures 实存；fixtures-contract.test.ts 14 例（排序键集 toEqual + 逐字段精确断言，无宽松子集匹配）；全部帧顶层含 v:1；README 冻结三条演进规则（只加字段/未知字段忽略含 serde 禁 deny_unknown_fields/未知 v 断连）。60/60 全绿含此契约 |

**Score:** 4/5 truths verified（1 present, behavior-unverified：SC3 生产观察维度）

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `packages/server/src/index.ts` | Worker 入口：路由 + KV 预检 + 校验链 + admin 分发 | ✓ VERIFIED | 119 行实质实现，四路由齐全 |
| `packages/server/src/chat-room.ts` | ChatRoom DO：Hibernation WS + SQLite + seq + 扇出 + sync + alarm | ✓ VERIFIED | 495 行实质实现，全部机制在场且被测试驱动 |
| `packages/server/src/keys.ts` | KV 三前缀读 + 写路径（createChannel/listChannels） | ✓ VERIFIED | 读 cacheTtl 60；写路径拒绝采样 base62、三前缀各一次 put、游标分页 |
| `packages/server/src/admin.ts` | Admin API 最小集 + timingSafeEqual 鉴权 | ✓ VERIFIED（含 CR-01 缺陷注记） | 实现符合计划字面；CR-01 长度前置缺陷见下 |
| `packages/server/src/envelope.ts` | D-06 信封单点 | ✓ VERIFIED | index/admin 共用；chat-room 存在平行副本（WR-02） |
| `packages/shared/src/index.ts` | 冻结线协议全集 | ✓ VERIFIED | 常量 + 15 字段 MessageFrame + 全帧类型 + 8 错误码 |
| `packages/shared/src/validators.ts` | 纯函数校验器 | ✓ VERIFIED | UTF-16 判长、枚举匹配、省略语义、版本先行 |
| `packages/shared/fixtures/`（12 JSON） | golden 正反例 | ✓ VERIFIED | 实存且被契约测试静态 import 逐字节断言 |
| `packages/shared/README.md` | 协议演进规则 | ✓ VERIFIED | 三条规则 + 帧清单 + 上限表 + 四端消费说明 |
| `packages/server/wrangler.jsonc` | exports 声明 ChatRoom(sqlite) + KV 真实 id + assets | ✓ VERIFIED | 无 migrations 数组；KV id ffc9065c…（真实，部署验证） |
| `scripts/smoke.mjs` | D-15 全自动冒烟 | ✓ VERIFIED | admin 建频道→401 反例→发送→WS 实收+LATENCY→断线补拉恰 2 条→413 反例→SMOKE OK；本地真 workerd 验证过（11ms） |
| `DEPLOY.md` | 部署手册 + 记录 | ✓ VERIFIED | 五版本全记录（含两次阻断的完整证据链） |
| 13 个测试文件 | 行为钉子 | ✓ VERIFIED | 全部实质测试（深读 3 文件 + 结构核查其余），无占位 |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|----|--------|---------|
| index.ts | keys.ts | resolveSendKey/resolveChannelKey（KV 预检先于 DO stub） | ✓ WIRED | index.ts:51,80；无效密钥不触发 getByName |
| index.ts | chat-room.ts | CHANNELS.getByName(channelId).fetch + X-PH-Verified | ✓ WIRED | index.ts:72,88；DO 侧校验内部头（chat-room.ts:199） |
| chat-room.ts | @pushhub/shared | 帧类型 + 全部常量（INITIAL_FETCH/SYNC_*/RETENTION_KEEP/RATE_*/WID_*） | ✓ WIRED | chat-room.ts:21-40 import 并实际消费 |
| index.ts | @pushhub/shared/validators | validateSendBody 入口即拒 | ✓ WIRED | index.ts:21,57；DO 内纵深复跑（chat-room.ts:235） |
| index.ts | admin.ts | /api/admin/* 前缀分发 | ✓ WIRED | index.ts:97-99；鉴权先于路由（admin.ts:57） |
| admin.ts | keys.ts | createChannel/listChannels | ✓ WIRED | admin.ts:22,86,94 |
| chat-room.ts | validators.ts | webSocketMessage 逐帧过 validateInboundFrame | ✓ WIRED | chat-room.ts:396；坏帧回 WsErrorFrame 不断连（测试断言连接保持） |
| fixtures-contract.test.ts | shared/fixtures/*.json | 静态 import（resolveJsonModule） | ✓ WIRED | exports 子路径 ./fixtures/* 就位 |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|--------------|--------|-------------------|--------|
| handlePublish | frame (MessageFrame) | SQLite INSERT 行 + 载荷 | 是——落库后扇出，测试断言帧=发送值逐字节 | ✓ FLOWING |
| sendHistory | HistoryFrame.messages | `SELECT … FROM messages`（keyset/首拉双路径） | 是——220 条场景断言 | ✓ FLOWING |
| listChannels | records | KV list+get（id: 前缀） | 是——分页测试跨页拉全 | ✓ FLOWING |
| handleSend | validation.normalized | 请求体解析 + 校验器归一 | 是——反例矩阵按冻结 code 拒绝 | ✓ FLOWING |

无静态返回/硬编码/mock 数据源。

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| 全量测试套件（真实 workerd） | `pnpm --filter @pushhub/server test` | 13 files / 60 tests passed, exit 0, 4.77s | ✓ PASS |
| shared 包 typecheck | `pnpm --filter @pushhub/shared typecheck` | tsc 通过，零错误 | ✓ PASS |
| server 包 typecheck | `pnpm --filter @pushhub/server typecheck` | tsc 通过，零错误 | ✓ PASS |
| 生产可达性探测 | `curl --max-time 15 https://pushhub.snake160220.workers.dev/api/send …` | 000（15s 连接超时） | ? BLOCKED（网络，非代码） |

### Probe Execution

| Probe | Command | Result | Status |
|-------|---------|--------|--------|
| 生产冒烟（smoke.mjs） | 需 PH_ADMIN_KEY 且网络可达 | 本次验证无法执行（探测确认 *.workers.dev 仍阻断） | ? BLOCKED — 已列 human item #2，WINDOWS.md 条目 2/3 追踪中 |
| 本地等价冒烟 | wrangler dev（真 workerd） | 01-05 SUMMARY 记录 SMOKE OK / 11ms / 补拉恰 2 条 | ✓ PASS（记录证据；脚本为交付物，本次验证未重跑本地 dev 以免状态副作用） |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| SRV-01 | 01-01, 01-03 | POST /send（Send Key 鉴权，title/Markdown/可选 priority） | ✓ SATISFIED | send-basic + send-validation（反例矩阵逐条驱动 fixtures）+ 生产冒烟 v0.1.0/0.1.1 |
| SRV-02 | 01-02, 01-03 | options(≤4)/callback_url 随消息分发 | ✓ SATISFIED | send-payload-fields（全字段透传 + 键集冻结 + 省略语义） |
| SRV-03 | 01-01 | WS 频道连接 + 实时扇出 | ✓ SATISFIED | ws-fanout（双客户端）+ group-semantics（三端） |
| SRV-04 | 01-01, 01-04 | Hibernation API，空闲不计时长 | ✓ SATISFIED（代码层）| acceptWebSocket/auto-response/attachment 全接线 + evict 行为测试；生产 dashboard 观察为 human item |
| SRV-05 | 01-04 | SQLite 持久化 + 单调 seq + since 补拉 | ✓ SATISFIED | sync-catchup + seq-monotonic + retention-alarm（500 窗口） |
| SRV-06 | 01-04 | 群聊语义：互通、成员变更不丢消息 | ✓ SATISFIED | group-semantics（断开不影响其余端 + 补拉完整到达） |
| SRV-07 | 01-02 | 版本字段协议 + 三端不漂移契约基线 | ✓ SATISFIED | 12 golden fixtures + 契约测试 14 例 + 演进规则 README |
| KEY-01 | 01-01, 01-05 | 三级密钥体系 | ✓ SATISFIED | admin-channels（8 例：闭环 + 双向隔离 + 分页 + 鉴权矩阵） |
| KEY-05 | 01-03 | 30 条/分钟限流 429 | ✓ SATISFIED | rate-limit（31st→429 + Retry-After + 隔离 + 不耗 seq + 窗口滚动） |

ORPHANED 检查：REQUIREMENTS.md 映射到 Phase 1 的 9 个 ID 与五个 PLAN requirements 字段的并集完全一致，无孤儿。

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| packages/server/src/admin.ts | 44-49 | CR-01：长度前置按 UTF-16 码元而非字节——等码元长非 ASCII Bearer 使 timingSafeEqual 抛未捕获异常 → 运行时 500（破坏 D-06 信封与"一律 401"） | ⚠️ Warning（评审定级 Critical；不阻断阶段目标——核心消息链路与 5 条 SC 不受影响，无鉴权绕过/数据泄漏） | 未鉴权可稳定触发的异常路径 + 冻结契约违例；需人工裁决修复时机（5 行修复） |
| packages/server/src/index.ts | 57 | WR-01：无 Content-Length 前置防护，合法 Send Key 可 POST 超大体耗尽 10ms CPU（1102 而非 413） | ⚠️ Warning | 额度滥用加固项；建议随 CR-01 一并修 |
| packages/server/src/chat-room.ts | 104-109, 338-352 | WR-02：错误信封三处平行实现（本地 errorEnvelope + 429 手拼 JSON），违反 envelope.ts 单点约定 | ⚠️ Warning | 维护性缺陷，冻结文案漂移风险 |
| src 全目录 | — | TBD/FIXME/XXX/TODO/PLACEHOLDER/console.log：零命中 | — | 债务标记门通过；密钥不落日志禁令经 grep 证实 |

### Human Verification Required

见 frontmatter `human_verification`（4 项）：

1. **生产 DO duration 观察（SC3/验收 3）** — dashboard → Workers & Pages → pushhub → Durable Objects → Duration；空闲挂 WS 数分钟后应平直不增。这是 SC3 唯一的完成证据路径。
2. **生产冒烟补跑（SC1 最终版确认）** — 网络窗口恢复后 `PH_SMOKE_URL=https://pushhub.snake160220.workers.dev PH_ADMIN_KEY=<secret> node scripts/smoke.mjs`，期望 SMOKE OK + LATENCY < 2000ms；通过后关闭 WINDOWS.md 条目 2/3。
3. **CR-01 裁决** — 立即修复（推荐，5 行）或明示接受（加 override、Phase 3 前修）。
4. **4 条 judgment 级禁令背书** — 验证器 grep/测试证据均为"未发生"，按流程需用户确认。

### Gaps Summary

**阶段目标已在代码库层面达成**：消息实时扇出、断线补拉零丢失零重复、免费额度保护机制（Hibernation + KV 预检 + 限流 + 保留清理）、线协议冻结（类型 + 常量 + 12 golden fixtures + 严格契约测试）全部有真实 workerd 行为测试证据（本次独立重跑 60/60 绿）与生产部署证据（5 个版本，v0.1.0/0.1.1 生产冒烟通过且延迟远低于验收线）。

不阻塞但需知悉的缺陷：CR-01（admin 鉴权边缘路径 500，评审 Critical、本次验证确认在场未修——实现忠实于计划字面，缺陷在计划设计本身，故列为人工裁决而非自动 gap）；WR-01/WR-02 为加固与收敛项。

两项待办属环境/人工依赖而非代码缺口：生产 dashboard DO duration 观察（manual-only）、v0.1.4 生产冒烟（网络阻断，本次验证再探确认仍不通；WINDOWS.md 已追踪，本地真 workerd 全量测试为功能等价证据）。

结论：**human_needed** — 自动化可判定范围全部通过；4 个人工项（1 项验收观察、1 项网络补验、1 项缺陷裁决、1 项禁令背书）完成后阶段即可 closed。

---

_Verified: 2026-08-26T19:55:00Z_
_Verifier: Claude (gsd-verifier)_
