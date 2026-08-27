---
phase: 03-admin-keys
plan: 05
subsystem: infra
tags: [cloudflare-workers, deploy, playwright-e2e, journey-test, production-smoke, sc4-static-assets, cache-bust, dogfooding, human-acceptance]

# Dependency graph
requires:
  - phase: 03-admin-keys(Plan 01-04)
    provides: 管理页全功能面（登录屏障/频道 CRUD/多 Send Key/重置踢连/删除确认框/历史排障）+ Admin API 五路由 + E2E 切片一至四断言原子与 helper
  - phase: 02-web-sdk(Plan 05-06)
    provides: 部署链规约（版本 +1 → pnpm run deploy → 冒烟 → DEPLOY.md 登记）、x-ph-worker 标记头对照法（stampMarker）、?v= 构建期注入机制
provides:
  - D-41 全链路 journey test（admin.spec.ts 第 13 个 test——核心用户旅程九步单 test 自动化，Phase 3 回归安全网定稿）
  - 生产 0.1.11：/admin.html 管理页首次公网上线（Version 05b89819）+ SC4 双证据闭环（程序化标记头对照 + dashboard 人工计数核对）
  - normalize 兼容层生产实证 + D-34 删除功能首次真实 dogfooding（用户经管理页删除 1 个 smoke- 旧冒烟频道）
  - Phase 3 七项需求（ADM-01/02/03/05、KEY-02/03/04）验证闭合；WINDOWS.md 账本 6/7/8 关闭
affects: [04-reply-loop(answered 徽标绿态启用/管理页复用), 07-生产清理(剩余 7 个 smoke- 频道清理入口), phase-03-verify-work(人工验收已完成的证据基线)]

# Actuals (#2632) — same chars/4 scale as the plan estimate.
actuals:
  tokens: 5140   # 20563 diff chars / 4 over b31561b..24060a9 (6 files, +248/-6；docs 收口提交另计)
  tasks: 3
  commits: 3

tech-stack:
  added: []   # 零新依赖（部署/E2E/冒烟全部既有链路）
  patterns:
    - journey 串联 E2E（复用切片 test 的断言原子作步骤间检查点；频道自建自删自证——删除步骤即清理，零 fixture 残留）
    - 生产验收三件套（冒烟 SMOKE OK + 标记头对照程序化半边 + dashboard 人工计数半边——静态资产不占请求额度的三级证据）

key-files:
  created: []
  modified:
    - packages/web-sdk/e2e/admin.spec.ts
    - package.json
    - DEPLOY.md
    - .planning/WINDOWS.md
    - packages/server/public/admin.html   # 构建期 ?v=0.1.11 注入
    - packages/server/public/index.html   # 同上
    - .planning/phases/03-admin-keys/03-05-SUMMARY.md

key-decisions:
  - "journey test 自建自删自证：不依赖 beforeEach 频道 fixture，test 内登录→建频道→…→删除即清理——E2E 零残留策略定型（回归不因 fixture 漂移而抖动）"
  - "dogfooding one-way 操作由用户亲手执行（T-03-22 reversibility 门即 checkpoint:human-verify 本体）：生产频道 10→9（smoke- 8→7），uat-/chaos-sc2- 完整保留——D-34 删除功能首次真实使用且误删防线（前缀确认框）经真实浏览器验证"
  - "账本 entry 5（Phase 2 D-15④ DO Duration 平直/部署尖峰/更广 dashboard 观察）不随 entry 6 一并勾销：本次用户验收范围是 SC4 请求计数（admin.html 刷新不增计数），entry 5 观察面更广——保守勾销纪律，留待 ship 前批量核对（当前 open_count=1）"

patterns-established:
  - "Pattern: journey/串联 E2E = 切片 test 保留证明各步骤边界 + 单 journey test 证明业务旅程连续性（双 page 跨端观察：管理页主页 + viewer 副页 online→被踢→新 Key 重连三态）"
  - "Pattern: 生产验收三件套 = SMOKE OK（功能链）+ x-ph-worker 标记头对照（资产无头/Worker 有头——程序化）+ dashboard 请求计数（人工）——SC4「静态资产不占请求额度」三级证据法"

requirements-completed: [ADM-05, KEY-02, KEY-03, KEY-04, ADM-01, ADM-02, ADM-03]

coverage:
  - id: D1
    description: "D-41 全链路 journey test：登录→建频道→片段卡→建带标签 Send Key→经该 Key 发消息(200)→历史倒序首条+未回复徽标→viewer 连接→重置踢连（pageB 离开 online+新 Key 明文卡）→新 Key 重连历史保留→吊销该 Key 401→前缀确认删除→频道消失+详情空态——九步单 test，自建自删零残留"
    requirement: KEY-02
    verification:
      - kind: e2e
        ref: "packages/web-sdk/e2e/admin.spec.ts#D-41 全链路 journey（真浏览器 × 真 wrangler dev，viewer 第二 page 三态断言）"
        status: pass
      - kind: other
        ref: "全量回归：pnpm test server 84/84 + web-sdk 单测 86/86；pnpm --filter @pushhub/web-sdk e2e 21/21（admin 13/13 含 journey）"
        status: pass
    human_judgment: false
  - id: D2
    description: "生产部署 0.1.11（版本先 +1 再 deploy 规约）：pnpm run deploy 链式构建注入双页 ?v=，Worker Version ID 05b89819-f36a-4884-b96a-a02432cd1d2e，DEPLOY.md 登记完整（版本/时间/URL/Version ID/冒烟结果/管理页上线说明）"
    verification:
      - kind: other
        ref: "root package.json version=0.1.11 + DEPLOY.md 58 行 0.1.11 记录行（Task 2 verify 脚本 exit 0）"
        status: pass
      - kind: other
        ref: "生产冒烟 PH_SMOKE_URL=https://pushhub.dyun.org node scripts/smoke.mjs → SMOKE OK，端到端延迟 384ms（sendKeys[0].key 新取值路径生产首次实跑）"
        status: pass
    human_judgment: false
  - id: D3
    description: "SC4 程序化证据：/admin.html 200 且响应无 x-ph-worker（资产命中零 Worker 请求）vs /api/send 401 反例带 x-ph-worker: 1（stampMarker 对照）；/ 与 /admin.html 各恰一处 pushhub.js?v=0.1.11（构建注入生产生效）"
    requirement: ADM-05
    verification:
      - kind: other
        ref: "curl -sI 生产响应头对照（0.1.8 先例同法）+ 双页 ?v= 恰一处断言（DEPLOY.md 0.1.11 行内记录）"
        status: pass
    human_judgment: false
  - id: D4
    description: "normalize 兼容层生产实证：GET /api/admin/channels 列出 10 个频道全部含 sendKeys 数组结构（8 个 smoke- 旧格式冒烟频道经 normalizeIdRecord 兼容列出——migrate-on-write 零破坏）；非 smoke 频道（uat-/chaos-sc2-）完整保留"
    requirement: KEY-03
    verification:
      - kind: other
        ref: "生产 API 响应核对（24060a9 提交记录 + DEPLOY.md 0.1.11 行）；dogfooding 后复核：total=9 / smoke=7 / 非 smoke 2 个原样"
        status: pass
    human_judgment: false
  - id: D5
    description: "用户三项人工验收（Task 3 checkpoint:human-verify）：① SC4 dashboard 请求计数核对（admin.html 多次刷新不增 Worker 请求计数）② 管理页核心旅程浏览器走查（登录/建频道/片段/Send Key 发消息/历史/重置踢连）③ D-34 dogfooding——用户经删除确认框亲手删除 1 个 smoke- 旧冒烟频道"
    requirement: ADM-01
    verification:
      - kind: manual_procedural
        ref: "用户回复 approved（2026-08-28，三项逐项通过）；生产复核：频道 10→9、smoke- 8→7、uat-/chaos-sc2- 保留"
        status: pass
    human_judgment: true
    rationale: "人工验收即交付物本身：dashboard 曲线目视与浏览器交互走查无自动化等价物；dogfooding 是 one-way 生产数据操作（T-03-22），reversibility 门要求用户亲手执行——checkpoint:human-verify 的设计目的"

# Metrics
duration: 20min active（wall ~3h，跨人工验收等待窗口）
completed: 2026-08-28
status: complete
---

# Phase 03 Plan 05: 阶段收口——D-41 journey + 生产 0.1.11 + 用户人工验收 Summary

**D-41 九步全链路 journey test（真浏览器×真 wrangler dev 单 test 串联核心用户旅程）+ 生产 0.1.11 管理页上线（SMOKE OK 384ms / SC4 标记头对照 / 双页 ?v= 注入 / normalize 兼容生产实证）+ 用户三项人工验收 approved（SC4 dashboard 计数核对 / 旅程走查 / D-34 dogfooding 删除 smoke- 频道）——Phase 3 七项需求验证闭合**

## Performance

- **Duration:** 20min active（Task 1-2 于 2026-08-27T17:08-17:19Z 执行 11min；收口 ~10min）；wall-clock ~3h（中间为 Task 3 人工验收等待窗口）
- **Started:** 2026-08-27T17:07:32Z
- **Completed:** 2026-08-27T20:10:00Z（本地 2026-08-28 04:10 +0800）
- **Tasks:** 3/3（2 auto + 1 human-verify checkpoint，全部闭合）
- **Files modified:** 7（0 created / 7 modified；其中 2 个为构建产物 ?v= 注入）

## Accomplishments

- **D-41 全链路 journey test（admin.spec.ts 第 13 test，202 行）**：单 test 串联九步——登录→建频道（唯一名）→断言片段卡三块→建带标签 Send Key（journey-bot）→经该 Key request.post /api/send 200→历史区倒序首条+「未回复」徽标→pageB viewer URL 参数连接（waitViewerOnline）→重置确认框→pageB 离开 online+新 Key 明文卡→pageB 新 Key 重连 online 且历史保留→吊销确认框（含标签展示）→401→删除确认框输入频道名前缀→频道从列表消失+详情空态。test 自建自删自证，零 beforeEach fixture 依赖
- **全量回归零失败**：`pnpm test` server 84/84 + web-sdk 单测 86/86（含 cache-bust-sync 双文件断言）；`pnpm --filter @pushhub/web-sdk e2e` 21/21（admin 13/13 含 journey + viewer + reconnect + tracer）——Phase 3 全量安全网定稿
- **生产部署 0.1.11（版本 +1 → deploy 规约）**：Worker Version ID `05b89819-f36a-4884-b96a-a02432cd1d2e`；冒烟 `SMOKE OK` 端到端延迟 384ms（`sendKeys[0].key` 新取值路径——03-01 schema 演进联动的生产首次实跑）；DEPLOY.md 0.1.11 记录行完整（管理页上线说明 + 全部生产证据）
- **SC4 程序化半边证据**：`/admin.html` 200 且响应**无** `x-ph-worker`（静态资产命中零 Worker 请求）vs `/api/send` 401 反例**带** `x-ph-worker: 1`（stampMarker 对照法，0.1.8 先例）；`/` 与 `/admin.html` 各恰一处 `pushhub.js?v=0.1.11`（构建期注入生产生效）
- **normalize 兼容生产实证**：生产 `GET /api/admin/channels` 列出 10 个频道全部含 sendKeys 数组——8 个 smoke- 前缀旧格式冒烟频道（0.1.0~0.1.10 各版遗留）经 normalizeIdRecord 兼容列出，migrate-on-write 零破坏；非 smoke 频道 2 个（uat-/chaos-sc2-）完整保留
- **用户三项人工验收全部 approved（2026-08-28）**：① SC4 dashboard 请求计数核对——多次刷新 /admin.html Worker 请求计数无增长；② 管理页核心旅程浏览器走查全通；③ D-34 dogfooding——用户经删除确认框（频道名前缀联动启用）亲手删除 1 个 smoke- 旧冒烟频道，**生产复核：频道 10→9、smoke- 8→7、uat-/chaos-sc2- 原样保留**——删除功能首次真实使用且防线交互经真实浏览器验证
- **WINDOWS.md 账本 6/7/8 关闭**（resolved_at 2026-08-27T20:05Z，用户 approved 记录见本 SUMMARY D5/coverage 与 Task 3 段）

## Task Commits

Each task was committed atomically:

1. **Task 1: D-41 全链路 journey test + 全量回归** - `23b698b` (test)
2. **Task 2: 生产部署 0.1.11 + 冒烟 + /admin.html 资产对照 + normalize 生产实证** - `24060a9` (chore)
3. **Task 3: 用户人工验收（checkpoint:human-verify）** - 无代码提交（用户 approved 三项；勾销记录 = WINDOWS.md 6/7/8 fixed + 本 SUMMARY，随 docs 提交落盘）

**Plan metadata:** 见本文件提交（docs commit）

## Files Created/Modified

- `packages/web-sdk/e2e/admin.spec.ts` - D-41 journey test（+202 行，单 test 九步串联；snippet-card locator 按标题限定作用域——频道卡与 Send Key 卡在详情面板共存）
- `package.json` - root version 0.1.10 → 0.1.11
- `DEPLOY.md` - 0.1.11 部署记录行（Version ID/SMOKE OK 384ms/SC4 证据/normalize 实证/回归数字/管理页上线说明）
- `.planning/WINDOWS.md` - Task 3 三项人工验收登记（entries 6/7/8，本收口标记 fixed）
- `packages/server/public/admin.html` / `packages/server/public/index.html` - 构建期 `?v=0.1.11` 注入（deploy 链产物）
- `.planning/phases/03-admin-keys/03-05-SUMMARY.md` - 本文件

## Decisions Made

- journey 自建自删自证（无 fixture 依赖，删除步骤即清理）——E2E 零残留策略定型
- dogfooding one-way 操作由用户亲手执行（T-03-22 reversibility 门 = checkpoint:human-verify 本体）；删除目标限定 smoke- 前缀，uat-/chaos-sc2- 明示不得删除
- 账本 entry 5 不随 entry 6 一并勾销（保守勾销纪律——本次验收范围是 SC4 请求计数，entry 5 的 DO Duration/部署尖峰观察面更广，留 ship 前批量核对；当前 open_count=1）

## Deviations from Plan

None - plan executed exactly as written（Task 2 网络一次顺畅走通自定义域名入口，(g) 网络阻断应对路径未触发）。

## Issues Encountered

None（部署/冒烟/资产对照一次通过；用户验收三项一次通过）。

## Human Verification (Task 3)

checkpoint:human-verify（gate=blocking）于 Task 2 后暂停，用户逐项验收后回复 **approved**（2026-08-28）：

| # | 验收项 | 结果 |
|---|--------|------|
| ① | SC4 dashboard 请求计数核对（多次刷新 /admin.html，Workers 请求计数无增长） | approved |
| ② | 管理页核心旅程浏览器走查（登录→建频道→片段→Send Key 发消息→历史→重置踢连） | approved |
| ③ | D-34 dogfooding 删除 1 个 smoke- 旧冒烟频道（前缀确认框交互） | approved |

生产复核证据（收口时只读 API）：频道总数 10→9，smoke- 8→7（smoke-20260827-171729 等剩余 7 个），uat-/chaos-sc2- 完整保留。WINDOWS.md entries 6/7/8 已标记 fixed。

## Authentication Gates

None — 部署链凭据有效（Task 2 precondition 满足）；冒烟 Admin Key 经本地密码库注入，无交互认证门。

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Phase 3 全部 5 个 plan 完成，七项需求（ADM-01/02/03/05、KEY-02/03/04）验证闭合——`/gsd-verify-work` 前置条件（Task 3 用户三项验收勾销）已满足
- 管理页生产可用：https://pushhub.dyun.org/admin.html（0.1.11）——Phase 4 回复闭环的 answered 徽标绿态数据通路就位（03-04 遗产）
- WINDOWS.md 仅剩 entry 5（Phase 2 D-15④ 更广 dashboard 观察：DO Duration 平直/部署尖峰）open——ship 前批量核对项
- 生产剩余 7 个 smoke- 旧冒烟频道可经管理页随时清理（07-生产清理阶段或用户自行 dogfooding）
- 回归安全网：server 84/84 + 单测 86/86 + e2e 21/21——Phase 4 起任何协议触碰的基线数字

## Self-Check: PASSED

1. 0 created source files（journey 追加进既有 spec）；修改文件 7 个全部在工作树/提交中（git diff b31561b..24060a9 六文件 + 本 SUMMARY）
2. 全部任务提交经 `git log` 核验存在：23b698b（test）、24060a9（chore）；docs 收口提交见本次 commit
3. WINDOWS.md entries 6/7/8 status=fixed（windows status open_count=1，仅 entry 5 保留）；生产频道复核 total=9/smoke=7 与 dogfooding 记录一致
