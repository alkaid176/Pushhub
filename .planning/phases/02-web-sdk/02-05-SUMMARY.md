---
phase: 02-web-sdk
plan: "05"
subsystem: web-sdk
tags: [cache-bust, build-injection, version-sync, localstorage, viewer, e2e, tdd]

requires:
  - phase: 02-web-sdk
    provides: "02-01/02-02/02-03/02-04 已交付的 build.mjs 构建流水线、viewer 参考客户端、E2E 体系与 79 例测试基线"
provides:
  - "G-02-3 闭合：build.mjs 构建期自动注入根 package.json version 到 index.html pushhub.js?v=（恰一次硬断言，0/多命中即构建失败）——机制化取代人工同步纪律"
  - "cache-bust-sync.test.ts 恒一致断言（?v= === 根 version 且引用恰一次 + 构建幂等）——机制的双保险"
  - "chaos-sc2.mjs viewer-online 日志去硬编码版本（EXPECT_VERSION 插值）"
  - "G-02-4 WR-03 闭合：viewer.js localStorage 读取侧 try/catch（存储全禁环境免填降级，与写入侧防护对齐）+ 真浏览器 E2E 用例"
affects: [02-06（产物重建/部署/端到端验证）， Phase 5（Tauri 前端复用 viewer 免填降级语义）]

actuals:
  tokens: 2421
  tasks: 2
  commits: 5

tech-stack:
  added: []
  patterns:
    - "缓存参数恒一致机制：构建期注入（scoped 正则替换 + 恰一次硬断言 fail-safe）+ 磁盘双端断言测试——构建失败优先于静默 stale 缓存投放"
    - "无 @types/node 工作区的 node: 内置 import 处理：行级 @ts-expect-error 集中在 import 区（显式 node:process 导入取代 process 全局名），零新依赖"

key-files:
  created:
    - packages/web-sdk/test/cache-bust-sync.test.ts
  modified:
    - packages/web-sdk/build.mjs
    - packages/web-sdk/scripts/chaos-sc2.mjs
    - packages/server/public/index.html
    - packages/server/public/viewer.js
    - packages/web-sdk/e2e/viewer.spec.ts

key-decisions:
  - "注入 fail-safe 语义：正则命中数 != 1 即 console.error + exit 1（实证 0 命中构建失败）——未来 index.html 重构丢标签或多标签漂移时构建失败比静默 stale 缓存安全"
  - "类型缺失最小侵入：工作区无 @types/node（.mjs 构建脚本不经 tsc，node: import 从未暴露缺口；本测试是 tsc include 范围内首个消费者），行级 @ts-expect-error 而非新增 devDependency（项目有新包用户审批先例）"
  - "chaos 日志改 EXPECT_VERSION 插值：脚本自身已断言 rootVersion === EXPECT_VERSION，插值后日志语义比原硬编码字面量更准确"
  - "viewer 读取防护 catch 回退对齐优先级链：url 参数 || localStorage || 缺省——异常时 server 回退 window.location.origin、key 留空，try 范围仅限两行读取赋值"

patterns-established:
  - "构建产物引用与版本源的恒一致闭环：root package.json version → build.mjs 注入 → index.html ?v= → cache-bust-sync.test.ts 断言（计划 key_links 首条落地）"

requirements-completed: [WEB-01]

coverage:
  - id: D1
    description: "build.mjs 构建期版本注入机制：copy 产物后读根 package.json version 替换 index.html pushhub.js?v=，恰命中一次硬断言（G-02-3 核心）"
    requirement: WEB-01
    verification:
      - kind: unit
        ref: "packages/web-sdk/test/cache-bust-sync.test.ts#机制生效：执行一次构建后断言仍成立（注入幂等，重复构建不漂移）"
        status: pass
      - kind: unit
        ref: "packages/web-sdk/test/cache-bust-sync.test.ts#index.html pushhub.js ?v= === 根 package.json version，且引用恰出现一次"
        status: pass
      - kind: other
        ref: "command: 手工实证 fail-safe——sed 移除 ?v= 后 node build.mjs → 'INJECT FAIL: 期望恰 1 处，实际 0 处' exit 1；恢复后 'injected ?v=0.1.8' exit 0"
        status: pass
    human_judgment: false
  - id: D2
    description: "chaos-sc2.mjs 日志去硬编码版本：viewer-online 行 0.1.7 字面量改 ${EXPECT_VERSION} 插值（G-02-3 次要项）"
    requirement: WEB-01
    verification:
      - kind: other
        ref: "command: grep -n '0\\.1\\.[0-9]' packages/web-sdk/scripts/chaos-sc2.mjs → 仅剩头部用法示例（--expect-version 传参格式），日志行无硬编码版本"
        status: pass
    human_judgment: false
  - id: D3
    description: "viewer.js localStorage 读取侧防护：存储全禁环境（隐私模式/存储策略）查看器正常加载，server 回退页面 origin、key 留空、无未捕获异常（WR-03）"
    requirement: WEB-01
    verification:
      - kind: e2e
        ref: "packages/web-sdk/e2e/viewer.spec.ts#WR-03：localStorage 全禁环境查看器正常加载（回退缺省，无未捕获异常）"
        status: pass
    human_judgment: false

duration: 10min
completed: 2026-08-27
status: complete
---

# Phase 02 Plan 05: Gap 闭合（G-02-3 构建期版本注入 + G-02-4 WR-03 读取防护）Summary

**build.mjs 构建期自动注入根版本号到 index.html ?v=（恰一次硬断言 fail-safe + 恒一致双保险测试）+ viewer.js localStorage 读取侧 try/catch 存储全禁降级——两任务各完成 RED→GREEN 提交对，单测 81/81、E2E 7/7 全绿零回退**

## Performance

- **Duration:** 10 min
- **Started:** 2026-08-27T12:55:27Z
- **Completed:** 2026-08-27T13:05:52Z
- **Tasks:** 2
- **Files modified:** 6

## Accomplishments
- G-02-3（major）闭合：build.mjs 在 copy 产物到 server/public 之后注入根 package.json version 到 index.html 的 pushhub.js?v=——正则替换恰命中一次硬断言（0 命中/多命中即 console.error + exit 1，构建失败优先于静默 stale 缓存），人工同步纪律作废（注释同步改为机制化措辞）
- cache-bust-sync.test.ts 双保险落地：Test 1 恒一致主断言（?v= === 根 version 且引用恰一次，多标签漂移即失败）；Test 2 机制生效（真实执行构建后断言仍成立，注入幂等）
- chaos-sc2.mjs viewer-online 日志行 0.1.7 硬编码改 ${EXPECT_VERSION} 插值（脚本已断言 rootVersion === EXPECT_VERSION，语义更准确）
- G-02-4 WR-03 闭合：viewer.js 表单预填两行最小包裹 try/catch——localStorage 抛 SecurityError 时 server 回退 window.location.origin、key 留空（免填功能降级），优先级链与写入侧防护对齐
- E2E 新增存储全禁用例：addInitScript 重定义 localStorage getter 抛异常（先于 viewer.js 执行）→ 无 pageerror、输入框回退缺省、不自动连接（D-24 语义不变）

## Task Commits

Each task was committed atomically:

1. **Task 1: build.mjs 构建期版本注入 + chaos 日志修正（G-02-3）**
   - `e778955` (test, RED)：恒一致断言两用例——?v=0.1.7 vs 根 0.1.8 双双失败
   - `d4c0c63` (feat, GREEN)：注入步骤 + 恰一次断言 + index.html 注释机制化 + chaos 插值——81/81 转绿
2. **Task 2: viewer.js localStorage 读取侧防护（WR-03）**
   - `a4df22f` (test, RED)：存储全禁 E2E 用例——#server-url 空值 + 未捕获 SecurityError
   - `d30d439` (feat, GREEN)：预填两行 try/catch 回退——E2E 7/7 全绿

**Plan metadata:** 见下方 git_commit_metadata 提交

_Note: TDD tasks each have a test (RED) → feat (GREEN) commit pair_

## Files Created/Modified
- `packages/web-sdk/test/cache-bust-sync.test.ts` - 恒一致断言（?v= === 根 version 恰一次 + 构建幂等）；无 @types/node 工作区行级 @ts-expect-error
- `packages/web-sdk/build.mjs` - copy 产物后注入步骤：读根 version → scoped 正则替换 index.html ?v= → 恰一次硬断言否则 exit 1 → 注入日志
- `packages/web-sdk/scripts/chaos-sc2.mjs` - viewer-online 日志行改 ${EXPECT_VERSION} 插值
- `packages/server/public/index.html` - ?v= 约定注释改机制化措辞（构建期自动注入，勿手改）；值经构建注入 0.1.8
- `packages/server/public/viewer.js` - 表单预填两行 try/catch：读取异常回退 origin/空串
- `packages/web-sdk/e2e/viewer.spec.ts` - 新增 WR-03 独立用例（不动既有大用例）

## Decisions Made
- 注入 fail-safe 语义定稿：命中数 != 1 即构建失败（实证 0 命中 exit 1）——未来 index.html 重构丢标签/多标签漂移时，构建失败比静默 stale 缓存投放旧 SDK 字节安全
- 类型缺失走最小侵入而非新增 devDependency：工作区无 @types/node（.mjs 不经 tsc 从未暴露；本测试是 tsc 范围内首个 node: 消费者），行级 @ts-expect-error 集中在 import 区——项目有新包用户审批先例（02-01 包合法性门），装 @types/node 属可选后续改进
- chaos 插值而非删日志：EXPECT_VERSION 在脚本入口已断言 === rootVersion，插值后日志在语义上严格优于硬编码字面量
- viewer catch 回退重算两行赋值：getter 抛异常时第一行即跳 catch，catch 内 url 参数 || 缺省 与 try 路径优先级链一致，不抽新函数（计划禁止事项遵守）

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] 工作区无 @types/node，node: 内置 import 报 TS2591**
- **Found during:** Task 1（RED 测试编写时探针实证）
- **Issue:** 计划要求测试用 node:fs/node:path/node:url/node:child_process，但 tsconfig include 覆盖 test/**/*.ts 且工作区未装 @types/node——tsc 报 TS2591 Cannot find name 'node:fs'，typecheck 挂（.mjs 构建脚本不经 tsc，该缺口从未暴露）
- **Fix:** 行级 @ts-expect-error 集中压制在测试文件 import 区（探针验证 tsc exit 0）；GREEN 后 typecheck 复查发现 process 全局名同报 TS2591，补改从 node:process 显式导入 execPath
- **Files modified:** packages/web-sdk/test/cache-bust-sync.test.ts
- **Verification:** `tsc -p tsconfig.json` exit 0；单测 81/81（运行时 vitest node 环境正常解析 node: 模块）
- **Committed in:** e778955（RED 首版 import 压制）、eeda30d（process 全局名补修）

---

**Total deviations:** 1 auto-fixed (Rule 3 blocking × 同根因两处提交)
**Impact on plan:** 类型压制为最小侵入修复，未新增依赖、未改动计划行为语义。可选后续改进：装 @types/node 后删去 @ts-expect-error 行。

## Issues Encountered
- 计划 context 路径笔误（非偏差）："测试文件出发 ../../package.json 为根"——实际根 package.json 位于 test 出发 ../../../package.json（packages/web-sdk/test → packages → 仓库根）；计划的 ../../server/public/index.html 路径正确。按事实定位，无行为影响。

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- 本计划 index.html/viewer.js/build.mjs 变更与 02-04 的三修复共同改变部署形态——产物重建（pushhub.js 现为 81,398 bytes，含 02-04 源码修复字节）与 0.1.9 版本推进统一归 02-06；pushhub.js 在 .gitignore 中，本计划未提交产物（符合计划约束）
- 02-06 部署后 index.html ?v= 将随构建自动为 0.1.9——无需人工同步（机制本位）
- 全套测试 81/81 绿、typecheck 通过、E2E 7/7 绿——02-06 执行者接手时基线即此状态

## Verification Results
- `pnpm --filter @pushhub/web-sdk run build`：**injected ?v=0.1.8 into server/public/index.html**（注入日志可见）+ BUILD SMOKE OK（min 81,398 bytes / gzip 27,693）
- fail-safe 实证：移除 ?v= 引用后 `node build.mjs` → `INJECT FAIL: 期望恰 1 处，实际 0 处` exit 1；恢复后注入正常
- `pnpm --filter @pushhub/web-sdk test`：**81/81 全绿**（79 基线 + cache-bust-sync 2 用例），零回退
- `pnpm --filter @pushhub/web-sdk e2e`：**7/7 全绿**（既有 6 例 + WR-03 存储全禁新用例 157ms），零回退
- `pnpm --filter @pushhub/web-sdk run typecheck`：**exit 0**

## Self-Check: PASSED
- key-files.created（1 个）与 modified（5 个）全部存在于磁盘
- 5 个提交（e778955 / d4c0c63 / a4df22f / d30d439 / eeda30d）全部存在于 git log
- 两任务 done criteria 经自动化验证（构建注入 + 恰一次断言实证 + 单测/ E2E 全绿）

---
*Phase: 02-web-sdk*
*Completed: 2026-08-27*
