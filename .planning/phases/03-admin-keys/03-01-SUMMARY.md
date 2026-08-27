---
phase: 03-admin-keys
plan: 01
subsystem: admin-ui
tags: [cloudflare-workers, kv-schema, vanilla-js, static-assets, cache-bust, playwright-e2e]

# Dependency graph
requires:
  - phase: 01-foundation
    provides: Admin API (POST/GET /api/admin/channels, checkAdminAuth, keys.ts KV 三前缀写路径), D-06 错误信封
  - phase: 02-web-sdk
    provides: build.mjs ?v= 注入机制, cache-bust-sync.test.ts, viewer.js localStorage/错误条模式, playwright.config.ts webServer 编排
provides:
  - id:/sk: KV 值新格式契约（sendKeys: SendKeyRecord[] + label 字段）+ normalizeIdRecord 兼容读层（旧格式零破坏）
  - 管理页静态资产 admin.html/admin.js（登录屏障/频道列表/创建/接入片段卡/密钥掩码行）
  - build.mjs 对 admin.html 的 ?v= 注入（恰一次硬断言）+ cache-bust-sync 双断言
  - E2E admin.spec.ts 切片一（4 test：登录反例/创建片段/掩码揭示/SC4 标记头）与 #login-form/#channel-list/#channel-detail/data-testid=snippet-card 锚点体系
affects: [03-admin-keys(Plan 02-05), 04-reply-loop(admin 页复用掩码/错误条/确认框模式)]

# Actuals (#2632) — same chars/4 scale as the plan estimate.
actuals:
  tokens: 16047   # 64187 diff chars / 4 over 5ca59fe..86c1be7 (12 files, +1295/-50)
  tasks: 3
  commits: 4

tech-stack:
  added: []   # 零新依赖（D-37 vanilla 静态资产约束达成）
  patterns:
    - normalizeIdRecord 兼容层（migrate-on-write 读侧半边：旧格式映射、新格式透传、损坏记录防御兜底）
    - <template> 克隆 inline SVG（CSP script-src 'self' 下零 innerHTML 的图标注入法）
    - build.mjs 注入函数化（injectCacheBustVersion 每文件独立恰一次硬断言，新增宿主页面零复制粘贴）

key-files:
  created:
    - packages/server/public/admin.html
    - packages/server/public/admin.js
    - packages/web-sdk/e2e/admin.spec.ts
  modified:
    - packages/server/src/keys.ts
    - packages/server/test/admin-channels.test.ts
    - scripts/smoke.mjs
    - packages/web-sdk/build.mjs
    - packages/web-sdk/test/cache-bust-sync.test.ts
    - packages/web-sdk/e2e/viewer.spec.ts
    - packages/web-sdk/e2e/reconnect.spec.ts
    - packages/web-sdk/e2e/tracer.spec.ts
    - packages/web-sdk/scripts/chaos-sc2.mjs

key-decisions:
  - "schema 演进以 normalize 兼容层落地而非迁移脚本：旧格式 id: 记录（生产 10+ 冒烟频道）读时映射 sendKeys 单元素数组，任何被管理操作触碰的频道才升级（migrate-on-write）——05 删除功能 dogfooding 时自然清理"
  - "normalizeIdRecord 防御兜底：既无 sendKeys 数组也无顶层 sendKey 的损坏记录按 sendKeys: [] 带出，列表形态完整、消费方遍历零异常"
  - "curl 接入片段 JSON 载荷用 \"text\"（D-02 冻结协议字段）而非 UI-SPEC 示例的 \"body\"——片段的意义是复制即可用，协议外字段会 400"
  - "e2e createChannel helper 对外形态不变（ChannelInfo.sendKey 保留），实现从 sendKeys[0].key 取值——消费点零改动（最小侵入联动，Pitfall 4 解法）"
  - "眼睛图标经 <template> 克隆：CSP 兼容且全文件零 innerHTML（T-03-02 纪律）"

patterns-established:
  - "Pattern: 多宿主页面 ?v= 注入 = injectCacheBustVersion(fileName) 一行一文件——新增页面不会忘（恰一次断言独立生效）"
  - "Pattern: 密钥行组件 buildKeyRow（掩码/眼睛/复制三件套）——Plan 02-05 的 Send Key 管理、重置明文卡复用同一组件"
  - "Pattern: 错误条 handleApiFailure 统一出口（401 特例清存储回登录屏障 + 信封 code/message 透传）"

requirements-completed: [ADM-01, ADM-05, KEY-02]

coverage:
  - id: D1
    description: "id:/sk: KV schema 演进：SendKeyRecord/sendKeys[] 新格式恒写 + 旧格式 normalize 兼容列出"
    requirement: KEY-02
    verification:
      - kind: unit
        ref: "packages/server/test/admin-channels.test.ts#201 三件套：phc_/phs_ 前缀 + 恰 32 字符、channelId 16 字符、name/createdAt 回显、sendKeys 数组（D-30/D-35）"
        status: pass
      - kind: unit
        ref: "packages/server/test/admin-channels.test.ts#旧格式 id: 记录（顶层 sendKey）经 normalize 兼容列出为 sendKeys 数组（D-30/D-35）"
        status: pass
    human_judgment: false
  - id: D2
    description: "响应结构演进四消费方（+1 计划外）同版本联动：admin-channels 断言、smoke.mjs、e2e 三 spec helper、chaos-sc2.mjs"
    verification:
      - kind: integration
        ref: "pnpm test（server 61/61 + web-sdk 单测 86/86）+ pnpm --filter @pushhub/web-sdk e2e（12/12 含 viewer/reconnect/tracer 无回归）"
        status: pass
    human_judgment: false
  - id: D3
    description: "管理页登录屏障：无存储仅登录卡；错误 Admin Key → invalid_key 错误条停留屏障；已存储 401 清存储回登录卡"
    requirement: ADM-01
    verification:
      - kind: e2e
        ref: "packages/web-sdk/e2e/admin.spec.ts#D-28 登录反例：错误 Admin Key → 错误条含 invalid_key，主界面保持隐藏"
        status: pass
    human_judgment: false
  - id: D4
    description: "创建频道 → 列表新增+自动选中（aria-current）→ 接入片段卡三块（curl 含完整 Send Key / Channel Key 明文 / viewer 链接 noopener）+ 复制 data-copied 反馈"
    requirement: ADM-01
    verification:
      - kind: e2e
        ref: "packages/web-sdk/e2e/admin.spec.ts#D-28/D-39 登录+创建+片段卡：curl 块含完整 Send Key，viewer 链接参数 + noopener，复制反馈"
        status: pass
    human_judgment: false
  - id: D5
    description: "密钥行：默认掩码 slice(0,7)+…+slice(-4)，眼睛切换完整 36 字符，揭示态不撑破详情面板（overflow backstop）"
    verification:
      - kind: e2e
        ref: "packages/web-sdk/e2e/admin.spec.ts#D-29 掩码与揭示：默认 phc_ 前 7 字符掩码，眼睛切换完整 36 字符，不撑破详情面板"
        status: pass
    human_judgment: false
  - id: D6
    description: "build.mjs 对 admin.html 的 ?v= 注入（恰一次硬断言，双行注入日志）+ cache-bust-sync admin.html 双断言"
    requirement: ADM-05
    verification:
      - kind: unit
        ref: "packages/web-sdk/test/cache-bust-sync.test.ts#admin.html pushhub.js ?v= === 根 package.json version（恰一次）+ 构建后仍成立"
        status: pass
      - kind: other
        ref: "pnpm --filter @pushhub/web-sdk run build（两行注入日志 + BUILD SMOKE OK，退出码 0）"
        status: pass
    human_judgment: false
  - id: D7
    description: "SC4 静态资产零 Worker 请求程序化对照：/admin.html 无 x-ph-worker 头 vs /api/admin/channels x-ph-worker: 1"
    requirement: ADM-05
    verification:
      - kind: e2e
        ref: "packages/web-sdk/e2e/admin.spec.ts#SC4 标记头对照：/admin.html 资产命中零 Worker 请求，API 必经 Worker（stampMarker 双证据）"
        status: pass
    human_judgment: false
  - id: D8
    description: "管理页视觉布局与 UI-SPEC token 合规（两栏形态、色彩/字号/间距刻度、浅深色模式）在真实浏览器的整体观感"
    requirement: ADM-01
    verification: []
    human_judgment: true
    rationale: "E2E 已覆盖功能行为与 overflow backstop，但布局美感、token 合规与浅深色模式的视觉 adequacy 无自动化断言——留 end-of-phase 人工 UAT（config human_verify_mode: end-of-phase）"

# Metrics
duration: 21min
completed: 2026-08-28
status: complete
---

# Phase 03 Plan 01: 管理页骨架 tracer 切片 Summary

**KV id:/sk: schema 演进为 sendKeys[]（normalize 兼容 + 五消费方联动）+ vanilla 管理页端到端（登录屏障→建频道→接入片段卡→密钥掩码）+ admin.html ?v= 注入机制化 + SC4 资产零 Worker 双证据 E2E**

## Performance

- **Duration:** 21 min
- **Started:** 2026-08-27T15:51:07Z
- **Completed:** 2026-08-27T16:12:36Z
- **Tasks:** 3/3
- **Files modified:** 12（3 created / 9 modified）

## Accomplishments

- **schema 演进定型（KEY-02/D-30/D-35）**：`id:` 值 `sendKey` 单值 → `sendKeys: SendKeyRecord[]`，`sk:` 值增 `label` 可选键；createChannel 恒写新格式，normalizeIdRecord 兼容读旧格式（服务端测试直种旧格式记录证明映射），损坏记录防御兜底 `sendKeys: []`
- **管理页骨架端到端（ADM-01/D-28/D-37/D-38/D-39）**：admin.html（CSP 与 viewer 同串、两栏布局、UI-SPEC token 逐字落地）+ admin.js（登录屏障、频道列表 0/1/N、创建→自动选中→片段卡三块、掩码/揭示/复制、D-06 信封错误条、零 innerHTML、无自动轮询）
- **缓存注入机制扩展（ADM-05）**：build.mjs 注入函数化，admin.html 独立恰一次硬断言，构建输出双行注入日志；cache-bust-sync 增 admin.html 两条同型断言
- **E2E admin.spec.ts 切片一**：4 test 全绿（登录反例/创建片段卡/掩码揭示含 overflow backstop/SC4 标记头双证据），每 test 断言零 CSP 违规；既有 8 个 E2E 无回归
- **Tracer 反馈门通过**：Task 1 verify 全链路重跑（server 61 测试 + typecheck + web-sdk 84 单测 + 8 E2E）四绿后展开扩张任务

## Task Commits

Each task was committed atomically:

1. **Task 1: keys.ts schema 演进 + 四消费方联动** - `a44070a` (feat)
2. **Task 2: admin.html/admin.js/build.mjs（TDD）** - `4ac1e1e` (test, RED) + `fcc0717` (feat, GREEN)
3. **Task 3: admin.spec.ts 切片一** - `86c1be7` (test)

**Plan metadata:** 见本文件提交（docs commit）

## Files Created/Modified

- `packages/server/src/keys.ts` - SendKeyRecord 接口、ChannelRecord.sendKeys、SendKeyInfo.label、normalizeIdRecord 兼容层、createChannel 恒写新格式
- `packages/server/test/admin-channels.test.ts` - 201/断言迁移 sendKeys[0].key + 旧格式 normalize 测试（直种旧 id: 记录）
- `scripts/smoke.mjs` - SEND_KEY 取值 channel.sendKeys[0].key（正则断言同步）
- `packages/web-sdk/e2e/viewer.spec.ts` / `reconnect.spec.ts` / `tracer.spec.ts` - createChannel helper 内部取值迁移（对外形态不变）
- `packages/web-sdk/scripts/chaos-sc2.mjs` - 计划外第五消费方同任务联动（Rule 1）
- `packages/server/public/admin.html` - 新：管理页骨架（CSP 同串、两栏、token 体系、眼睛图标 template）
- `packages/server/public/admin.js` - 新：登录屏障/列表/创建/片段卡/掩码行/错误条（零 innerHTML）
- `packages/web-sdk/build.mjs` - injectCacheBustVersion 函数化 + admin.html 注入
- `packages/web-sdk/test/cache-bust-sync.test.ts` - admin.html 两条同型断言
- `packages/web-sdk/e2e/admin.spec.ts` - 新：管理页 E2E 切片一（4 test）

## Decisions Made

- schema 演进走 normalize 兼容层而非迁移脚本（详见 frontmatter key-decisions；与 RESEARCH Pattern 2 一致）
- normalizeIdRecord 分支序：新格式（Array.isArray(sendKeys)）优先透传 → 旧格式（typeof sendKey === "string"）映射 → 损坏记录 sendKeys: [] 兜底（TS 收窄与防御双收益）
- curl 片段载荷字段 "text"（协议冻结字段）替代 UI-SPEC 示例的 "body"——复制即可用优先于文案逐字（偏差已记录）
- e2e helper 对外形态不变、内部迁移取值——Pitfall 4 联动的最小侵入解法
- Task 2 按 tdd="true" 走 RED（4ac1e1e 失败测试先行）→ GREEN（fcc0717）
- Tracer 反馈门按 autonomous 分支执行（plan frontmatter autonomous: true + config mode yolo + human_verify_mode end-of-phase）：verify 全绿即扩展

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] chaos-sc2.mjs 是 schema 演进的第五消费方（计划只列了四个）**
- **Found during:** Task 1（联动消费方全仓 grep 时发现）
- **Issue:** `packages/web-sdk/scripts/chaos-sc2.mjs` 的 createChannel 消费 `channel.sendKey`（115/137/144 行）——schema 演进后为 undefined，下次生产混沌演练必 401 假红
- **Fix:** 同任务联动：`const SEND_KEY = channel.sendKeys[0].key;` + 三处取值替换
- **Files modified:** packages/web-sdk/scripts/chaos-sc2.mjs
- **Verification:** 全仓 grep 确认无 `.sendKey` 非键名残留消费点；该脚本需生产环境才可实跑（部署期冒烟覆盖）
- **Committed in:** a44070a（Task 1 联动提交）

**2. [Rule 3 - Blocking] normalizeIdRecord 落空分支 TS 收窄失败（typecheck 红）**
- **Found during:** Task 1 verify（server typecheck）
- **Issue:** 联合类型 fall-through `return stored` 无法证明为 IdRecordStored（TS2322）
- **Fix:** 显式防御兜底——既无 sendKeys 数组也无 sendKey 字符串的损坏记录按 `{channelKey, sendKeys: [], name, createdAt}` 带出
- **Files modified:** packages/server/src/keys.ts
- **Verification:** typecheck 零错误；既有测试全绿
- **Committed in:** a44070a（Task 1 提交内）

**3. [Rule 1 - Bug] UI-SPEC curl 示例载荷字段 "body" 不在冻结发送协议内**
- **Found during:** Task 2（admin.js buildSnippetCard 落地时）
- **Issue:** D-39 片段的意义是"复制即可用"；协议字段是 `text`（D-02 冻结），`body` 会导致复制粘贴的 curl 收 400
- **Fix:** 载荷改为 `{"title": "Hello", "text": "来自 PushHub 的第一条消息"}`（title 是有效可选字段，保留）
- **Files modified:** packages/server/public/admin.js
- **Verification:** E2E curl 块断言含 /api/send 与完整 Send Key；载荷字段与 send API 契约一致
- **Committed in:** fcc0717（Task 2 GREEN 提交内）

---

**Total deviations:** 3 auto-fixed（2 bug / 1 blocking）
**Impact on plan:** 均为正确性必需，无范围蔓延。#1 把"四消费方联动"补全为五个（计划盲区，Pitfall 4 预警兑现）；#3 是 UI-SPEC 文案与冻结协议的冲突裁决，方向为可用性。

## Issues Encountered

None — 三任务全部一次通过验证链（Task 1 首轮 typecheck 红为上述偏差 #2，修复后全绿；Task 3 E2E 4 test 首跑全绿）。

## Authentication Gates

None — 全程本地 wrangler dev（--var ADMIN_KEY:e2e-admin-key），无外部认证依赖。

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- schema 契约（sendKeys[] + label）已定型：Plan 02（Send Key 增删吊销）、Plan 03（重置/删除）直接在 id: 记录上做读改写，normalize 层保证旧频道记录在首次管理操作前不炸
- buildKeyRow 组件、handleApiFailure 错误出口、snippetBlock 片段块构造器可直接被 Plan 02-05 复用（重置后的明文一次性卡 = 同款）
- E2E 锚点体系（#login-form/#channel-list/#channel-detail/data-testid）已就位，后续 plan 递进扩展 admin.spec.ts
- 待办（计划内后续）：生产实证留 Plan 05（smoke.mjs 新取值路径 + 旧格式频道 normalize 生产列出）；D8 视觉 UAT 留 end-of-phase
- 需求标记：ADM-01/ADM-05/KEY-02 被兄弟 plan 共享声明，shared-ID gate 暂缓标记（本 plan SUMMARY 落盘后由最后一个声明 plan 完成时统一翻绿）

---
*Phase: 03-admin-keys*
*Completed: 2026-08-28*

## Self-Check: PASSED

All 4 created files exist on disk; all 5 task/metadata commits (a44070a, 4ac1e1e, fcc0717, 86c1be7, a5f6f24) verified in git log.
