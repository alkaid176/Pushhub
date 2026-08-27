---
phase: 03-admin-keys
plan: 04
subsystem: admin-ui
tags: [cloudflare-workers, durable-objects, keyset-pagination, vanilla-js, render-markdown, sanitization, playwright-e2e, tdd]

# Dependency graph
requires:
  - phase: 03-admin-keys(Plan 01)
    provides: admin.html/admin.js 骨架（renderDetail 全量重建架构、错误条/加载态组件）、?v= 注入、E2E 锚点体系
  - phase: 03-admin-keys(Plan 03)
    provides: admin.ts 参数化路由骨架（messages 占位分支）、Worker→DO X-PH-Verified 转发模式、readChannelRecord 参数化路由共用读点
  - phase: 02-web-sdk(Plan 01-03)
    provides: /pushhub.js 构建产物与 renderMarkdown 消毒管道、viewer appendMessage/maybeSeparator 渲染先例
provides:
  - DO GET /history 内部路由（keyset 倒序 + LIMIT n+1 判 has_more + oldest_kept_seq + clampAdminLimit 缺省 50/钳 [1,500]）
  - GET /api/admin/channels/:id/messages?before=&limit=（KV id: 先读 miss 404 不触 DO + 查询串透传 + DO 层单点钳制——D-35 参数化路由五分支全部落位完结）
  - 管理页历史折叠区（懒加载/倒序渲染/加载更多游标翻页/清理分隔线/answered 徽标双态）
  - renderMarkdown 唯一管道纪律的构建期硬断言机制（全文件字面量恰 1 处）
  - admin.spec.ts 切片四（2 test：消毒/倒序/徽标/空态 + API before 抽查）——Phase 4 回复闭环的既有视图复用点（answered 展示与已回复绿样式）
affects: [04-reply-loop(answered 徽标绿态启用/历史视图复用), 07-生产清理(排障入口支撑 dogfooding)]

# Actuals (#2632) — same chars/4 scale as the plan estimate.
actuals:
  tokens: 11244   # 44975 diff chars / 4 over 0df00d6..115f2b8 (6 files, +912/-20)
  tasks: 3
  commits: 4

tech-stack:
  added: []   # 零新依赖（sql.exec 绑定参数/URL.searchParams/renderMarkdown 均既有）
  patterns:
    - admin 域 limit 钳制独立常量与独立函数（clampAdminLimit 与 WS 域 clampSyncLimit 刻意分离——冻结契约与宽松语义互不牵连）
    - 查询串透传转发（Worker 不解析 before/limit，钳制在 DO 层单点——两处钳制必然漂移）
    - 唯一入口纪律的构建期硬断言（token 检查脚本对源文件字面量计数——机制化而非 review 纪律）
    - 迟到响应防御（fetch 回调时校验 historyState.channelId 未变才渲染）

key-files:
  created:
    - packages/server/test/admin-history.test.ts
  modified:
    - packages/server/src/chat-room.ts
    - packages/server/src/admin.ts
    - packages/server/public/admin.js
    - packages/server/public/admin.html
    - packages/web-sdk/e2e/admin.spec.ts

key-decisions:
  - "非数字 before 归首页（与 limit NaN 归缺省的宽松语义对齐）：admin 排障入口对坏参数不报错不空转——与 WS sync 域 invalid_frame 冻结契约形成两域刻意分化"
  - "limit=501 上界钳制用例以 runInDurableObject 直插 502 行播种：RATE_LIMIT_PER_MIN=30/Send Key 固定窗口 × 频道 10 Key 上限 = 单测试窗口最多 300 条真实发送，502 条必触 429——查询路径仍走真实 Worker→DO 全链（见 Deviations 1）"
  - "历史区 DOM 结构由 admin.js 动态构建而非 admin.html 静态骨架：renderDetail() 全量重建架构（03-01 定型）下静态子元素首次渲染即被清除——五 token 契约检查天然读 admin.js，与 03-03「HTML 骨架零文案」模式一致（见 Deviations 2）"
  - "同频道 refreshChannels 后历史页从 historyState 重放（不重新拉取）：renderDetail 重建 DOM 时已加载页保留——历史状态随频道切换重置、随登出清空"
  - "buildEyeButton 03-02 遗留注释中的字面量措辞调整：唯一入口硬断言按字面量计数，注释里的词也计入——硬断言机制自身的第一次实战即抓到一处（证明其必要性）"

patterns-established:
  - "Pattern: 唯一管道纪律硬断言 = node 脚本对源文件 match(/innerHTML/g).length !== 1 即 exit 1——纪律从 review 约定升格为构建期机制"
  - "Pattern: E2E 消毒断言三件套 = locator('script') 计数 0 + locator('[onerror]') 计数 0 + evaluate 全元素 on* 属性扫描（viewer.spec audit 同款）"
  - "Pattern: keyset 倒序翻页（LIMIT n+1 判 has_more）第三处复用（sendHistory 首拉/send 增量/admin 倒序）——同一技巧三方向（DESC 首页/ASC 增量/DESC 游标）全覆盖"

requirements-completed: [ADM-03]

coverage:
  - id: D1
    description: "DO GET /history：keyset 倒序（before 游标无重叠无遗漏）、clampAdminLimit（缺省 50/钳 [1,500]/NaN 归缺省）、oldest_kept_seq、响应三键契约"
    requirement: ADM-03
    verification:
      - kind: unit
        ref: "packages/server/test/admin-history.test.ts#首页倒序/limit=2/before 两连页/limit 钳制（0→1、abc→50、501→500）/空频道 五用例"
        status: pass
      - kind: other
        ref: "chat-room.ts /history 查询零 OFFSET、全绑定参数 ?n 占位（acceptance_criteria 逐条核对）"
        status: pass
    human_judgment: false
  - id: D2
    description: "messages 元素与扇出 MessageFrame 逐字段同构（rowToMessageFrame 复用无新映射）：answered 四字段（false/null/null/null）、无 title 键省略语义、wid/priority/created_at 全字段"
    requirement: ADM-03
    verification:
      - kind: unit
        ref: "packages/server/test/admin-history.test.ts#首页用例逐字段断言（v/type/wid 正则/title 省略语义/answered 四字段）"
        status: pass
    human_judgment: false
  - id: D3
    description: "Worker GET messages 转发：admin 鉴权后 KV id: 读取（miss 404 不触 DO——T-03-17）+ 查询串原样透传 + X-PH-Verified 转发"
    requirement: ADM-03
    verification:
      - kind: unit
        ref: "packages/server/test/admin-history.test.ts#不存在 channelId 404 / 无鉴权 401 用例 + 全部正路径经真实 Worker 入口（exports.default.fetch）"
        status: pass
    human_judgment: false
  - id: D4
    description: "管理页历史折叠区：懒加载首展、倒序渲染（#seq/时间 mono/标题行条件渲染/answered 徽标双态）、加载更多 before=最小 seq 游标、has_more=false 按钮隐藏、清理分隔线（oldest_kept_seq>1）、空态文案、错误条复用"
    requirement: ADM-03
    verification:
      - kind: e2e
        ref: "packages/web-sdk/e2e/admin.spec.ts#D-40 历史渲染与消毒 + D-40 空态与 API before 翻页抽查（2 test）"
        status: pass
      - kind: other
        ref: "web-sdk build 绿 + 五 token 检查（history UI tokens OK）+ innerHTML 恰 1 处硬断言"
        status: pass
    human_judgment: false
  - id: D5
    description: "renderMarkdown 唯一管道纪律机制化：全文件字面量恰 1 处且右值为 window.PushHub.renderMarkdown 调用（T-03-16 消毒关键路径）"
    requirement: ADM-03
    verification:
      - kind: other
        ref: "node -e token 检查脚本 exit 非 0 机制（match(/innerHTML/g).length!==1 即失败）——实抓 03-02 遗留注释一处后修正"
        status: pass
      - kind: e2e
        ref: "packages/web-sdk/e2e/admin.spec.ts#攻击样本用例：#history-list 无 script、无 onerror、on* 全扫描空"
        status: pass
    human_judgment: false
  - id: D6
    description: "E2E 消毒与倒序：首条 #seq=#3（最新在最上）、strong 计数恰 1（renderMarkdown 真路径 + 无 title 不渲染标题行）、API before 抽查返回恰 [seq1]"
    requirement: ADM-03
    verification:
      - kind: e2e
        ref: "packages/web-sdk/e2e/admin.spec.ts#切片四 2 test（admin.spec 12/12，全套 20/20 零回归）"
        status: pass
    human_judgment: false
  - id: D7
    description: "历史折叠区视觉观感（summary 对齐 h2、消息卡边框式、徽标灰/绿双色呈现、分隔线居中灰字）"
    requirement: ADM-03
    verification: []
    human_judgment: true
    rationale: "E2E 已覆盖功能行为与逐字文案，但折叠区布局美感与 token 合规（4 字号/2 字距/间距刻度）无自动化断言——留 end-of-phase 人工 UAT（config human_verify_mode: end-of-phase，同 03-01 D8/03-03 D7）"

# Metrics
duration: 11min
completed: 2026-08-28
status: complete
---

# Phase 03 Plan 04: 管理页消息历史（排障视图） Summary

**DO GET /history keyset 倒序翻页（clampAdminLimit 独立域钳制 + oldest_kept_seq）+ Worker messages 转发（D-35 参数化路由完结）+ 管理页历史折叠区（懒加载/renderMarkdown 唯一管道硬断断言/加载更多/清理分隔线/answered 徽标双态）——ADM-03/SC3 排障入口端到端闭合，Phase 4 回复闭环的既有视图复用点就位**

## Performance

- **Duration:** 11 min
- **Started:** 2026-08-27T16:54:06Z
- **Completed:** 2026-08-27T17:05:10Z
- **Tasks:** 3/3
- **Files modified:** 6（1 created / 5 modified）

## Accomplishments

- **DO GET /history 内部路由（D-36 + RESEARCH Example 2）**：before 游标 keyset 倒序（`WHERE seq < ?1 ORDER BY seq DESC LIMIT ?2` 绑定参数，禁 OFFSET）；LIMIT n+1 多取 1 条判 has_more（sendHistory 同款技巧第三处复用）；oldest_kept_seq = MIN(seq)（空表 0，D-10 诚实缺口语义）；clampAdminLimit（null/NaN → 50，钳 [1,500]）与 WS 域 clampSyncLimit 刻意分离——admin 域独立常量，冻结契约与宽松语义互不牵连；行映射复用 MESSAGE_COLUMNS + rowToMessageFrame（answered 四字段与扇出帧逐字段同构，零新映射函数）
- **Worker GET messages 转发（D-35 最后一条参数化路由）**：checkAdminAuth 后 KV id: 读取（miss → 404 not_found 不触 DO——T-03-17/T-03-19）→ 查询串原样透传（`new URL(request.url).search` 拼接——before/limit 原样到达 DO，钳制单点在 DO 层）→ X-PH-Verified: 1 转发直接返回 DO 响应
- **翻页矩阵测试 admin-history.test.ts（8 用例）**：首页倒序 [3,2,1] + MessageFrame 逐字段同构断言 / limit=2 恰 2 条 / before 两连页无重叠无遗漏 + 计划字面用例（before=3&limit=2 → [2,1]）/ limit 钳制三态（0→1 行为断言、abc→缺省 50、501→500 恰回 500 条）/ 空频道三键 / 404+401 边界 / 攻击样本哑管道逐字返回（SRV-02，消毒断言在前端 E2E）
- **管理页历史折叠区（D-40 + UI-SPEC Interaction #4）**：`<details>` 首展懒加载 + 切换频道状态重置（同频道 refresh 后从 historyState 重放不重拉）；每条头部 #seq（mono）+ 时间（mono graytext）+ title 条件渲染（无 title 不渲染标题行——viewer appendMessage 同款）+ answered 徽标双态（false→「未回复」graytext；true→「已回复」绿样式先行定义 Phase 4 复用）；正文经 window.PushHub.renderMarkdown 渲染（全管理页唯一该类 DOM 写入口）；加载更多带 before=已渲染最小 seq 游标 + 请求期 disabled「加载中…」+ has_more=false 隐藏；清理分隔线（has_more=false 且 oldest_kept_seq>1——viewer maybeSeparator 同款判定）；空态逐字文案；SDK 缺失前置检查走错误条
- **renderMarkdown 唯一管道纪律机制化（T-03-16）**：验证脚本对 admin.js 字面量计数恰 1 处硬断言（exit 1 机制）——实抓 03-02 遗留 buildEyeButton 注释一处并修正措辞，机制第一次运行即证明其价值
- **E2E 切片四 2 test 全绿**：倒序（首条 #seq=#3）+ renderMarkdown 真路径（**加粗**→strong 恰 1——同时证明无 title 不渲染标题行）+ 消毒三件套（script 计数 0/[onerror] 计数 0/on* 属性 evaluate 全扫描空）+ 未回复徽标 ×3 + has_more=false 按钮隐藏；空频道空态逐字文案 + API before=<第 2 条 seq> 抽查返回恰 [seq1]（has_more false + oldest_kept_seq 1）
- **TDD 纪律**：Task 1 RED（16668cf，8 个新测试 7 红）→ GREEN（e19b160，admin-history 8/8 + server 全量 84/84 + typecheck 绿）

## Task Commits

Each task was committed atomically:

1. **Task 1: DO /history + Worker messages 转发 + 翻页矩阵（TDD）** - `16668cf` (test, RED) + `e19b160` (feat, GREEN)
2. **Task 2: 管理页历史折叠区** - `db76caf` (feat)
3. **Task 3: E2E 切片四** - `115f2b8` (test)

**Plan metadata:** 见本文件提交（docs commit）

## Files Created/Modified

- `packages/server/src/chat-room.ts` - /history 内部路由分支 + handleHistory + clampAdminLimit/ADMIN_HISTORY_* 常量（独立于 SYNC_* 域）；文件头职责注释补记
- `packages/server/src/admin.ts` - handleGetMessages（KV id: 先读 + 查询串透传 + X-PH-Verified 转发）；messages 分支落位（参数化路由五分支完结）；路由文档注释更新
- `packages/server/test/admin-history.test.ts` - 新：8 用例翻页矩阵（含 502 行直插播种的上界钳制用例）
- `packages/server/public/admin.html` - 历史区 CSS（独立滚动/summary 对齐 h2/消息卡/hist-msg-body overflow-wrap: anywhere/分隔线/加载更多按钮）+ 徽标注释更新（「已回复」绿态 Phase 4 前恒不触发）
- `packages/server/public/admin.js` - 历史折叠区完整交互（buildHistoryBlock/buildHistoryMessage/renderHistoryInto/loadHistory + historyState 状态机）；文件头安全纪律更新；buildEyeButton 注释措辞修正（字面量计数）
- `packages/web-sdk/e2e/admin.spec.ts` - 切片四 2 test + sendMessageSeq helper + 文件头切片四说明

## Decisions Made

- 非数字 before 归首页（宽松语义与 limit 对齐）——admin 排障入口对坏参数不报错不空转（frontmatter key-decisions 首条）
- 501 上界钳制用例直插播种的必要性论证（限流算术：30/分/Key × 10 Key = 300 < 502）
- 历史区 DOM 由 JS 动态构建（renderDetail 重建架构约束下的唯一一致解）
- 同频道 refresh 后历史页重放保留（避免每次 refreshChannels 都重拉 DO 历史）
- 登出清空 historyState（跨会话状态卫生）
- 强制性字面量计数断言抓到 03-02 注释遗留——纪律机制化的第一份实战证据

## Deviations from Plan

无 Rule 1-4 触发。两处计划文本解读偏差，均按 key_links 意图落地：

**1. [Plan interpretation] limit=501 钳制用例的播种方式**
- **计划原文：** 「seed 用 sendRequest 发真实消息（经 /api/send 全链路，非直插 SQL）」——behavior 含「?limit=501 → 钳制为 500」
- **落地：** 翻页矩阵全部用例（3 条消息级）均经 /api/send 真实链路；唯 501 上界用例（需 502 行）经 runInDurableObject 直插播种，查询路径仍走真实 Worker→DO 全链
- **理由：** RATE_LIMIT_PER_MIN=30/Send Key 固定窗口 + 每频道 Key 上限 10（D-31）= 单测试窗口最多 300 条真实发送；502 条必触 429，且等待窗口翻越（60s×2）不可接受。直插行与 handlePublish 同列同形，被测对象（/history 查询与钳制）完全真实
- **Committed in:** 16668cf（测试）/ e19b160（实现）

**2. [Plan interpretation] 历史区 DOM 结构落点**
- **计划原文：** 「admin.html：详情面板新增 <details> 折叠区 + 内部 #history-list + 底部加载更多按钮」（Task 2 action 首句）
- **落地：** 结构元素（details/summary/#history-list/#btn-history-more）由 admin.js buildHistoryBlock 动态构建；admin.html 承载全部样式
- **理由：** renderDetail() 以 `channelDetail.textContent = ""` 全量重建详情面板（03-01 定型架构）——静态骨架在首次渲染即被清除。动态构建是架构下唯一一致解，且五 token 契约检查本就针对 admin.js（验证命令读 admin.js），与 03-03「逐字契约文案单一来源在 admin.js、HTML 骨架零文案」模式一致
- **Committed in:** db76caf

---

**Total deviations:** 0 auto-fixed（2 处计划文本解读，无正确性缺口）

## Issues Encountered

None（验证链四轮全绿）。Task 2 首轮 token 检查抓到 innerHTML 计数 2——03-02 遗留 buildEyeButton 注释中的字面量；修正措辞后恰 1（硬断言机制按字面量计数含注释，这正是其设计意图——机制首次运行即抓到一处历史遗留，证明纪律需要机制而非 review）。

RED 基线如实记录：8 个新测试中 1 个（404/401 负路径）在 RED 即绿——占位路由 404 巧合满足负路径契约（同 03-02/03-03 基线，负路径保持的旁证）；7 个正路径行为全部 RED 红、GREEN 绿。

## Authentication Gates

None — 全程本地 miniflare/wrangler dev（测试注入 ADMIN_KEY），无外部认证依赖。

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- D-35 参数化路由五分支（send-keys POST/DELETE、reset-channel-key、DELETE 频道、messages）全部落位——admin.ts 路由表面本期定形
- answered 徽标「已回复」绿样式与数据通路（answered 四字段经 /history 全量下发）就位——Phase 4 回复闭环只需写 answered 字段 + 徽标自动翻绿，历史视图零改动复用
- renderMarkdown 唯一管道硬断言脚本可随 Phase 4 新交互直接复用（计数上限随入口数调整）
- DO 内部路由表定形（/publish /ws /cleanup-rate /kick-all /purge /history——六路由）
- 需求标记：ADM-03 由本 SUMMARY 落盘为数据源，orchestrator 在 wave 完成后统一处理
- 端到端验证链：server 84/84 + web-sdk 86/86 + e2e 20/20 + typecheck + build + token 检查全绿（03-05 dogfooding 的安全网再加固一层）

## Self-Check: PASSED

1 created file (packages/server/test/admin-history.test.ts) exists on disk; all 4 task commits (16668cf, e19b160, db76caf, 115f2b8) verified in git log; final verification chain green (server 84/84 + web-sdk unit 86/86 + e2e 20/20 + typecheck clean + build green + history UI tokens OK with innerHTML count exactly 1).
