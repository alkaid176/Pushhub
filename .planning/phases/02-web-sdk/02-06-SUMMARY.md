---
phase: 02-web-sdk
plan: "06"
subsystem: web-sdk
tags: [deploy, production-verification, gap-closure, e2e, version-bump, cache-bust]

requires:
  - phase: 02-web-sdk
    provides: "02-04 的 SVG 锚点两分支/FORBID_TAGS/WS_FAIL 修复与 02-05 的 build.mjs 版本注入/viewer 存储防护——全部源码修复就位待上线"
provides:
  - "生产 0.1.9（Worker Version db069038）：G-02-2/G-02-3/G-02-4 三个 gap 的修复字节全部上线并经程序化证据集闭环"
  - "?v= 构建期注入机制首次生产生效（/ 引用恰一处 pushhub.js?v=0.1.9）"
  - "畸形 serverUrl 查看器 error 态 E2E 用例（WR-04 端到端实证，含 jsdom/真浏览器环境分歧的实证修正）"
  - "DEPLOY.md 0.1.9 完整部署记录行（Version ID + 字节证据 + SMOKE OK 890ms）"
affects: [Phase 03（后续部署沿用 ?v= 注入机制与 0.1.10 版本序列）, Phase 05（Tauri 移植参考畸形 URL 容错语义）]

actuals:
  tokens: 1100
  tasks: 2
  commits: 3

tech-stack:
  added: []
  patterns:
    - "WebSocket 构造器相对引用解析坑：真浏览器按页面 base URL 合法化相对引用（new WebSocket(\"/path\") 同源特性）——jsdom 无 base 解析才同步抛；畸形 URL 的端到端用例必须选硬解析失败形态（如未闭合 IPv6 括号），单测输入不能直接照搬进 E2E"
    - "版本 bump 后的回归三连前置：cache-bust-sync 直读磁盘（index.html ?v= vs 根 version），bump 后必须先跑一次 build 注入再 pnpm test，否则 Test 1 必红——构建幂等使该前置无副作用"

key-files:
  created: []
  modified:
    - packages/web-sdk/e2e/viewer.spec.ts
    - package.json
    - packages/server/public/index.html
    - DEPLOY.md

key-decisions:
  - "畸形 serverUrl E2E 输入定稿为截断 IPv6 字面量（https://[::1）：计划的 not a url 在真实 Chromium 被按页面 base 相对解析合法化为 ws://<origin>/not%20a%20url/...（握手 404 → 无限重连，error-bar 永不出现）；截断 IPv6 是带 base 也无法解析的硬失败，构造器同步抛 → WS_FAIL 路径端到端可观察（Rule 1 事实假设修正，探针 4 候选输入行为矩阵实证）"
  - "pushhub.js 产物字节不入 git（.gitignore 既有约束）：生产一致性证据由 cmp 逐字节比对 + DEPLOY.md 记录承载（0.1.5/0.1.6 先例），不 force-add"
  - "版本 bump（0.1.9）后先跑一次 build 再执行回归三连：cache-bust-sync Test 1 直读磁盘断言 ?v= === 根 version，注入前置是三连全绿的机械前提（构建幂等，无行为影响）"

patterns-established:
  - "部署验证证据集三件套（本部署起固定）：①curl 落盘 cmp 逐字节比对 + min/gzip 字节数记录；②/ 的 ?v= 引用恰一处 grep；③curl -sI 资产响应无 x-ph-worker 标记头（SC4 对照法）——全部经自定义域名，workers.dev 本机被污染禁用"

requirements-completed: [WEB-01, WEB-04, WEB-05]

coverage:
  - id: D1
    description: "生产 /pushhub.js 与本地构建逐字节一致：81,398 字节 cmp IDENTICAL（0.1.8 为 81,022，+376 即 SVG 锚点两分支 + FORBID_TAGS + WS_FAIL 修复字节上线，G-02-2/WR-02/WR-04 闭合证据）"
    requirement: WEB-05
    verification:
      - kind: other
        ref: "command: curl -s https://pushhub.dyun.org/pushhub.js -o /tmp/prod-pushhub.js && cmp /tmp/prod-pushhub.js packages/server/public/pushhub.js → VERIFY-CMP-OK（Task 2 <verify> 门复跑）"
        status: pass
    human_judgment: false
  - id: D2
    description: "?v= 构建期注入机制首次生产生效：生产 / 引用恰一处 pushhub.js?v=0.1.9（G-02-3 端到端闭环）"
    requirement: WEB-01
    verification:
      - kind: other
        ref: "command: curl -s https://pushhub.dyun.org/ | grep -o 'pushhub.js?v=[0-9.]*' | sort -u → 仅 pushhub.js?v=0.1.9（恰一处）"
        status: pass
    human_judgment: false
  - id: D3
    description: "资产零计费标记头（SC4 对照法）：/pushhub.js 与 /viewer.js 均 200 且响应头无 x-ph-worker（静态资产命中不触发 Worker）"
    requirement: WEB-01
    verification:
      - kind: other
        ref: "command: curl -sI https://pushhub.dyun.org/{pushhub.js,viewer.js} → HTTP 200 + Content-Type text/javascript，无 x-ph-worker"
        status: pass
    human_judgment: false
  - id: D4
    description: "畸形 serverUrl 查看器呈现 error 态（WR-04 端到端）：error-bar 可见含致命错误 + connect_failed，状态最终已断开（不卡连接中）"
    requirement: WEB-01
    verification:
      - kind: e2e
        ref: "packages/web-sdk/e2e/viewer.spec.ts#WR-04：畸形 serverUrl 查看器呈现 error 态（不卡连接中）——180ms 通过"
        status: pass
    human_judgment: false
  - id: D5
    description: "全量回归零回退：server 60/60 + web-sdk 单测 81/81 + typecheck exit 0 + E2E 8/8（含存储禁用、畸形 serverUrl 两条新用例）"
    requirement: WEB-04
    verification:
      - kind: unit
        ref: "command: pnpm test → Test Files 13+10 passed，Tests 60+81 passed"
        status: pass
      - kind: e2e
        ref: "command: pnpm --filter @pushhub/web-sdk e2e → 8 passed (1.2m)"
        status: pass
    human_judgment: false
  - id: D6
    description: "D-15 生产冒烟（①建频道发消息 ②WS 实收 ③断线补拉 + 401/413 反例）：SMOKE OK，端到端延迟 890ms（< 2000ms 验收线）"
    requirement: WEB-04
    verification:
      - kind: other
        ref: "command: PH_SMOKE_URL=https://pushhub.dyun.org PH_ADMIN_KEY=<本地密钥文件> node scripts/smoke.mjs → SMOKE OK（sync since=2 恰补 2 条零丢失零重复）"
        status: pass
    human_judgment: false
  - id: D7
    description: "DEPLOY.md 0.1.9 完整记录行（Version ID db069038 + 变更说明 + 字节/标记头证据）"
    requirement: WEB-01
    verification:
      - kind: other
        ref: "commit 217c88a: DEPLOY.md 部署记录表增 0.1.9 行（版本/时间/URL/Worker Version ID/冒烟结果五列齐全）"
        status: pass
    human_judgment: false
  - id: D8
    description: "D-15④ dashboard DO duration 平直核对（Hibernation 生产验证）：既定人工批量项，非本计划任务"
    requirement: WEB-01
    verification: []
    human_judgment: true
    rationale: "DEPLOY.md 既定流程：每次部署人工在 dashboard 核对 DO Duration 平直与部署断连重连尖峰回落；0.1.8 轮已人工确认过同机制（CHAOS PASS 10.7s 恢复），本轮留待 phase 收尾批量核对"

duration: 17min
completed: 2026-08-27
status: complete
---

# Phase 02 Plan 06: Gap 闭合生产交付（G-02-2/G-02-3/G-02-4 → 生产 0.1.9）Summary

**消费 02-04/02-05 全部修复上线生产 0.1.9（Version db069038）：/pushhub.js 81,398 字节 cmp 逐字节一致（+376 修复字节）、?v= 构建期注入首次生产生效（恰一处 0.1.9）、畸形 serverUrl 查看器 error 态 E2E 绿（含 jsdom/真浏览器相对 URL 解析分歧的实证修正）——三连回归 60+81+8 全绿零回退，SMOKE OK 890ms，DEPLOY.md 完整登记**

## Performance

- **Duration:** 17 min
- **Started:** 2026-08-27T13:11:10Z
- **Completed:** 2026-08-27T13:27:54Z
- **Tasks:** 2
- **Files modified:** 4（tracked）

## Accomplishments
- 畸形 serverUrl 查看器 E2E 用例落地（WR-04 端到端）：error-bar 可见含"致命错误（connect_failed）"、状态最终"已断开"——输入经真浏览器探针实证修正（见 Deviations），用例内注释固化环境分歧供后续维护
- 版本推进 0.1.8 → 0.1.9（部署前 +1 规则）+ 全量回归三连：pnpm test（server 60/60 + web-sdk 81/81）→ typecheck exit 0 → E2E 8/8（7 基线 + 新用例 180ms）
- 部署 0.1.9（pnpm run deploy 链式 build→deploy，Worker Version ID db069038-aa2d-42bd-8c41-59980fab8124，3 资产全量上传）
- 生产程序化验证三件套全过：cmp 逐字节一致（81,398 = 81,398；0.1.8 为 81,022，+376 即 SVG 锚点两分支 + FORBID_TAGS 收敛 + WS_FAIL 容错 + 存储防护修复字节）；/ 引用恰一处 ?v=0.1.9（G-02-3 机制首次生产生效）；/pushhub.js 与 /viewer.js 无 x-ph-worker（资产零计费，SC4 对照法）
- D-15 生产冒烟真跑通（未触发降级路径）：SMOKE OK，端到端延迟 890ms，断线补拉恰 2 条零丢失零重复，401/413 反例全过
- DEPLOY.md 0.1.9 行完整登记（版本/时间/URL/Version ID/冒烟结果含变更说明）

## Task Commits

Each task was committed atomically:

1. **Task 1: 畸形 serverUrl 查看器 E2E + 版本 0.1.9 + 全量回归**
   - `1d39361` (test)：viewer.spec.ts 新增 WR-04 独立用例（含实证修正的输入与分歧注释）——E2E 8/8
   - `d5bf4bb` (chore)：根 package.json 0.1.8 → 0.1.9 + 三连全绿（60+81 / typecheck / E2E 8）
2. **Task 2: 部署 0.1.9 + 生产验证 + DEPLOY.md 登记**
   - `217c88a` (chore)：部署记录 + index.html（?v=0.1.9 机制注入）+ 生产证据集

**Plan metadata:** 见下方 git_commit_metadata 提交

## Files Created/Modified
- `packages/web-sdk/e2e/viewer.spec.ts` - 新增 WR-04 用例：畸形 serverUrl → error-bar 致命错误 + connect_failed + 已断开；注释固化 WebSocket 相对引用解析的环境分歧
- `package.json` - version 0.1.9（部署前 +1）
- `packages/server/public/index.html` - ?v=0.1.9（build.mjs 构建期注入，非手改）
- `DEPLOY.md` - 0.1.9 部署记录行
- *（packages/server/public/pushhub.js 构建产物 81,398 字节已部署生产，.gitignore 约束不入库——cmp 证据在 DEPLOY.md）*

## Decisions Made
- 畸形 serverUrl E2E 输入定稿截断 IPv6 字面量（https://[::1）：真浏览器 WebSocket 构造器按页面 base 解析相对引用，"not a url" 被合法化为 404 无限重连；探针矩阵实证仅硬解析失败形态（未闭合括号）可靠触发构造抛出
- pushhub.js 不 force-add 入 git：生产一致性以 cmp + DEPLOY.md 记录为证据（0.1.5/0.1.6 先例延续）
- bump 后先 build 再三连：cache-bust-sync Test 1 直读磁盘，注入前置保三连全绿（构建幂等无副作用）

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] E2E 用例输入实证修正：计划字面输入 "not a url" 在真实浏览器不触发 WS_FAIL 路径**
- **Found during:** Task 1（新用例首跑失败：error-bar 保持 hidden、状态停在"重连中"）
- **Issue:** 真实 Chromium 的 WebSocket 构造器把相对引用按页面 base URL 解析（同源 `new WebSocket("/path")` 特性）——"not a url/api/ws/…" 被合法化为 `ws://127.0.0.1:4911/not%20a%20url/api/ws/…` → 握手 404 → 意外断连无限重连（error 事件永不出现）。jsdom 单测环境无 base 解析才同步抛 SyntaxError——计划的事实假设源自单测环境，E2E（真页面有 base）不成立
- **Fix:** 输入改为截断 IPv6 字面量 `https://[::1`（经 replace 成 `wss://[::1/api/ws/…`，带 base 也无法解析 → 构造器同步抛 → WS_FAIL 延迟一跳派发 → error(fatal, connect_failed) + offline）；用例内注释固化分歧。计划的行为断言（error-bar 含"致命错误"、状态"已断开"）原样保留并加 connect_failed code 断言
- **探针证据:** 真 http 页面上下文测 4 候选输入——`not a url/…` CONSTRUCTED、`ws://exa mple.com/…` CONSTRUCTED（空格被编码）、`ws:///…` CONSTRUCTED、`wss://[::1/…` THREW SyntaxError；修正后调试 spec 观测页面即呈 `已断开 + 致命错误（connect_failed）`
- **Files modified:** packages/web-sdk/e2e/viewer.spec.ts
- **Verification:** E2E 8/8 全绿（新用例 180ms）；生产 0.1.9 该修复路径字节已上线（cmp 证据）
- **Commit:** 1d39361

**2. [Rule 3 - Blocking] 版本 bump 后需先跑一次 build 才能三连全绿**
- **Found during:** Task 1(c)
- **Issue:** cache-bust-sync Test 1 直读磁盘断言 index.html ?v= === 根 version——bump 0.1.9 后、注入前磁盘仍是 ?v=0.1.8，直接 pnpm test 必红（Test 2 的构建在 Test 1 之后才跑）
- **Fix:** bump 后先 `pnpm --filter @pushhub/web-sdk run build`（注入 ?v=0.1.9，构建幂等），再执行三连——全绿
- **Files modified:** 无源码变更（构建产物 index.html 由机制注入）
- **Verification:** pnpm test 全绿（81/81 含 cache-bust-sync 2 用例）
- **Commit:** 无独立提交（index.html 变更随 217c88a）

---

**Total deviations:** 2 auto-fixed (Rule 1 × 1 + Rule 3 × 1)
**Impact on plan:** 均不改变计划行为语义——Deviation 1 是对计划字面输入的事实修正（行为断言不变、意图保真），Deviation 2 是执行顺序的机械前提。环境分歧知识已固化进用例注释与 STATE.md 决策，供 Phase 05 Tauri 移植与后续 E2E 维护复用。

## Authentication Gates

None — wrangler OAuth 已认证（whoami 确认 snake160220@gmail.com），ADMIN_KEY 自 0.1.8 起既存于生产，本地密钥文件 `.claude/admin.key`（未跟踪）注入冒烟环境变量，secret 未进任何输出/提交。

## Issues Encountered

None beyond deviations above（冒烟未触发网络阻断降级路径——自定义域名全链路真实跑通，无需 WINDOWS.md 登记）。

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- Phase 02 全部 6 计划完成（01-06 SUMMARY 齐备）——gap closure 生产交付闭环，phase 可进入验证/收尾流程
- 生产 0.1.9 为当前版本；下次部署 0.1.10，?v= 注入机制自动生效（无人工同步）
- D-15④ dashboard DO duration 人工核对为既定批量项（见 coverage D8），建议 phase 收尾统一执行
- 遗留观察（非本计划范围）：用户粘贴无 scheme 的 serverUrl（如 "pushhub.example.com"）在真浏览器会走相对解析 404 重连循环且无 error 呈现——SDK 无法区分握手 404 与网络闪断（设计语义如此，D-07 方向）；如需产品化改进归 Phase 4 管理页/接入引导范畴

## Verification Results
- `pnpm test`：**server 60/60 + web-sdk 81/81** 全绿零回退
- `pnpm --filter @pushhub/web-sdk run typecheck`：**exit 0**
- `pnpm --filter @pushhub/web-sdk e2e`：**8/8 全绿**（1.2m；含存储禁用 + 畸形 serverUrl 两条新用例）
- 构建链：`injected ?v=0.1.9 into server/public/index.html` + pushhub.js min 81,398 / gzip 27,693 + BUILD SMOKE OK
- 部署：Worker Version ID **db069038-aa2d-42bd-8c41-59980fab8124**（3 资产上传：index.html / viewer.js / pushhub.js）
- 生产 cmp：`VERIFY-CMP-OK`（81,398 = 81,398 逐字节一致）
- 生产 ?v=：`pushhub.js?v=0.1.9`（恰一处）
- 生产标记头：/pushhub.js、/viewer.js 无 x-ph-worker（200 + text/javascript）
- 冒烟：`SMOKE OK`，延迟 890ms，补拉恰 2 条零丢失零重复，401/413 反例过

## Self-Check: PASSED
- 4 个 key-files.modified 全部存在于磁盘且已提交
- 3 个任务提交（1d39361 / d5bf4bb / 217c88a）全部存在于 git log
- 两任务 done criteria 与计划 must_haves.truths 全部经自动化验证（见 coverage D1-D7）

---
*Phase: 02-web-sdk*
*Completed: 2026-08-27*
