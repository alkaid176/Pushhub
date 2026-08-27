---
phase: 02-web-sdk
plan: "04"
subsystem: web-sdk
tags: [dompurify, xss, svg-anchor, forbid-tags, websocket, connection-machine, tdd]

requires:
  - phase: 02-web-sdk
    provides: "02-01/02-02/02-03 已交付的 render-markdown 管道、connection-machine 纯状态机、pushhub adapter 与 68 例测试基线"
provides:
  - "G-02-2 闭合：render-markdown afterSanitizeAttributes tagName 两分支判定，SVG 命名空间锚点与 HTML 锚点同等携带 target=_blank + rel=noopener noreferrer"
  - "G-02-4 WR-02 闭合：DOMPurify FORBID_TAGS 收敛（style/form/input/button/select/textarea/label/option）"
  - "G-02-4 WR-04 闭合：畸形 serverUrl 构造容错——WS_FAIL 机器事件 + openSocket try/catch + setTimeout(0) 延迟派发"
  - "attack-samples.json 增补 4 条样本（svg-anchor/style-tag/form-controls/task-list）实证固化回归锁定"
affects: [02-06（构建/部署/查看器端到端验证）， Phase 5（Tauri 前端复用 render 模块）]

actuals:
  tokens: 2310
  tasks: 2
  commits: 4

tech-stack:
  added: []
  patterns:
    - "消毒放行面收敛用 FORBID_TAGS 黑名单追加（非 ALLOWED_TAGS 白名单反转）——改动面最小、默认 profile 语义保持"
    - "构造器同步抛的容错模式：try/catch + setTimeout(0) 延迟一跳派发机器事件，保证宿主 on() 监听注册先于事件（构造即连 D-18 时序）"

key-files:
  created: []
  modified:
    - packages/web-sdk/src/render/render-markdown.ts
    - packages/web-sdk/src/connection-machine.ts
    - packages/web-sdk/src/pushhub.ts
    - packages/web-sdk/test/fixtures/attack-samples.json
    - packages/web-sdk/test/machine-fatal.test.ts
    - packages/web-sdk/test/adapter-lifecycle.test.ts

key-decisions:
  - "FORBID_TAGS 清单定稿 8 标签（style/form/input/button/select/textarea/label/option）：UAT 点名 4 个 + 等字覆盖同族表单控件；GFM 任务列表复选框字形随 input 消失（文本保留）是 UAT Test 4 用户裁决的明知取舍，task-list fixture 固化证据，后续保留复选框只需去掉 input 即有护航"
  - "WS_FAIL 采用 fatal 语义（报错 + 停止 + 不复活，不武装任何定时器）：畸形 URL 是确定性配置错误，重试无意义；仅 connecting 态消费，其余态防御性忽略"
  - "openSocket 捕获后延迟一跳（setTimeout 0）派发而非同步 dispatch：构造即连（D-18）时序下构造函数内同步 emitError 会在宿主 on() 注册前丢失——这是查看器卡连接中的另一半根因；错误文案静态英文不内嵌 wsUrl（路径段含 Channel Key）"
  - "style-tag 样本实证发现 DOMPurify 默认 profile 已清除 <style>（与计划行为假设不符）：expected 仍固化收敛形态，样本保留为纵深防御回归锁定——实证流程（RESEARCH Pattern 2）优先于计划表述"

patterns-established:
  - ".tagName 大小写两分支判定（HTML 命名空间大写 / SVG 命名空间小写）——DOM API 中命名空间敏感判定的通用坑，Phase 5 Tauri 前端移植同款注意"

requirements-completed: [WEB-05, WEB-01]

coverage:
  - id: D1
    description: "SVG 命名空间锚点（tagName 小写 'a'）与 HTML 锚点同等携带 target=_blank + rel=noopener noreferrer——D-21 tabnabbing 加固不可绕过（G-02-2）"
    requirement: WEB-05
    verification:
      - kind: unit
        ref: "packages/web-sdk/test/render.test.ts#样本 svg-anchor：输出逐字匹配实证表且结构无害"
        status: pass
    human_judgment: false
  - id: D2
    description: "DOMPurify FORBID_TAGS 收敛：style/form/input/button/select/textarea/label/option 经消毒后从渲染输出消失（WR-02）"
    requirement: WEB-05
    verification:
      - kind: unit
        ref: "packages/web-sdk/test/render.test.ts#样本 form-controls：输出逐字匹配实证表且结构无害"
        status: pass
      - kind: unit
        ref: "packages/web-sdk/test/render.test.ts#样本 style-tag：输出逐字匹配实证表且结构无害"
        status: pass
    human_judgment: false
  - id: D3
    description: "GFM 任务列表取舍形态固化：FORBID input 后复选框消失、文本保留，fixture 锁定该有意取舍"
    requirement: WEB-05
    verification:
      - kind: unit
        ref: "packages/web-sdk/test/render.test.ts#样本 task-list：输出逐字匹配实证表且结构无害"
        status: pass
    human_judgment: false
  - id: D4
    description: "WS_FAIL 机器语义：connecting 态 emitError(fatal, connect_failed) + emitStatus(offline) + 不武装定时器；其余态零动作；此后不复活（WR-04 机器层）"
    requirement: WEB-01
    verification:
      - kind: unit
        ref: "packages/web-sdk/test/machine-fatal.test.ts#WS_FAIL：畸形 serverUrl 构造失败（WR-04，与 v!==1 fatal 同族语义）— 6 用例全过"
        status: pass
    human_judgment: false
  - id: D5
    description: "畸形 serverUrl 构造容错（adapter 层）：new PushHub 不抛异常，延迟一跳后宿主收到 error(fatal, code=connect_failed) + status offline，fatal 不重连，错误载荷不含 Channel Key（WR-04）"
    requirement: WEB-01
    verification:
      - kind: unit
        ref: "packages/web-sdk/test/adapter-lifecycle.test.ts#畸形 serverUrl 容错（WR-04，02-04）> WebSocket 构造抛 SyntaxError：构造不抛，延迟一跳后 error(fatal, connect_failed) + status offline，不再创建 socket"
        status: pass
    human_judgment: false

duration: 7min
completed: 2026-08-27
status: complete
---

# Phase 02 Plan 04: Gap 闭合（G-02-2 SVG 锚点 + G-02-4 WR-02/WR-04）Summary

**SVG 命名空间锚点两分支判定堵住 D-21 tabnabbing 绕过 + DOMPurify FORBID_TAGS 收敛 8 个表单/UI 标签 + 畸形 serverUrl 经 WS_FAIL 延迟派发走 error 事件路径——两任务各完成 RED→GREEN 提交对，79/79 测试全绿（68 基线零回退）**

## Performance

- **Duration:** 7 min
- **Started:** 2026-08-27T12:43:42Z
- **Completed:** 2026-08-27T12:50:54Z
- **Tasks:** 2
- **Files modified:** 6

## Accomplishments
- G-02-2（major）闭合：render-markdown.ts afterSanitizeAttributes 判定改为 `tagName === "A" || tagName === "a"` 两分支——SVG 命名空间锚点与 HTML 锚点同等设 target=_blank + rel=noopener noreferrer，D-21 加固不可绕过，fixture 回归锁定
- G-02-4 WR-02 闭合：purify.sanitize 增加 FORBID_TAGS（style/form/input/button/select/textarea/label/option），实证 form/input/button 经默认 profile 幸存、收敛后全部消失
- G-02-4 WR-04 闭合：connection-machine 增 WS_FAIL 输入事件（fatal 语义，与 v!==1 同族：报错 + 停止 + 不复活）；pushhub.openSocket 包 try/catch + setTimeout(0) 延迟派发——畸形 serverUrl 构造不抛，宿主可观察 error(fatal, connect_failed) + status offline
- attack-samples.json 增补 4 条实证固化样本（svg-anchor/style-tag/form-controls/task-list），GFM 任务列表复选框取舍形态固化

## Task Commits

Each task was committed atomically:

1. **Task 1: SVG 锚点两分支修复 + DOMPurify FORBID_TAGS 收敛（G-02-2 + WR-02）**
   - `02bf14a` (test, RED)：增补 SVG 锚点 + 禁用标签攻击样本——3 样本实证失败
   - `df81d41` (feat, GREEN)：两分支判定 + FORBID_TAGS 收敛——全绿
2. **Task 2: 畸形 serverUrl 构造容错——WS_FAIL 事件 + adapter 延迟派发（WR-04）**
   - `cd21f3c` (test, RED)：WS_FAIL 机器语义 6 用例 + 畸形 URL adapter 用例——7 用例实证失败
   - `519b33f` (feat, GREEN)：MachineEvent 联合扩展 + openSocket try/catch 延迟派发——全绿

**Plan metadata:** 见下方 git_commit_metadata 提交

_Note: TDD tasks each have a test (RED) → feat (GREEN) commit pair_

## Files Created/Modified
- `packages/web-sdk/src/render/render-markdown.ts` - afterSanitizeAttributes 两分支判定（G-02-2）+ FORBID_TAGS 收敛（WR-02）
- `packages/web-sdk/src/connection-machine.ts` - MachineEvent 联合增 WS_FAIL；input switch 增 case（仅 connecting 态消费，fatal 语义）
- `packages/web-sdk/src/pushhub.ts` - openSocket() 的 new WebSocket 包 try/catch，catch 内 setTimeout(0) 延迟派发 WS_FAIL
- `packages/web-sdk/test/fixtures/attack-samples.json` - 增补 svg-anchor/style-tag/form-controls/task-list 四条实证样本
- `packages/web-sdk/test/machine-fatal.test.ts` - 增 WS_FAIL describe（6 用例：connecting 消费 + 四态防御忽略 + 不复活）
- `packages/web-sdk/test/adapter-lifecycle.test.ts` - 增畸形 serverUrl 容错用例（构造不抛 + 延迟一跳事件 + 密钥纪律断言）

## Decisions Made
- FORBID_TAGS 清单定稿 8 标签：UAT 裁决点名 style/form/input/button，"等"字覆盖同族表单控件（select/textarea/label/option）；不引入 ALLOWED_TAGS 白名单反转（改动面失控）
- GFM 任务列表复选框消失为明知取舍：task-list fixture 固化证据，后续开发者想保留复选框从清单去掉 input 即有 fixture 护航
- WS_FAIL fatal 语义（不武装任何定时器）：畸形 URL 是确定性配置错误，重试无意义——与 D-07 客户端严格方向一致
- 延迟一跳派发（setTimeout 0）：构造即连（D-18）时序下同步 emitError 会在宿主 on() 注册前丢失——查看器卡"连接中"的另一半根因
- 错误文案静态英文（"failed to construct WebSocket for serverUrl"），不内嵌 wsUrl 全文（路径段含 Channel Key）——密钥不进错误载荷纪律

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
- 实证发现（非偏差，计划实证流程内）：DOMPurify 默认 profile 已清除 `<style>` 元素（style-tag 样本修复前后输出同为 "after"），与计划"其余三条在 FORBID_TAGS 生效前后输出不同"的表述不符——UAT 验证器此前亦实测到同一现象。style-tag 样本保留为纵深防御回归锁定（FORBID_TAGS 显式声明该意图）；WR-02 的实质攻击面收敛由 form-controls/task-list 两样本承载（form/input/button 实证默认幸存、收敛后消失）。RED 阶段失败样本恰 3 条（svg-anchor/form-controls/task-list），style-tag 直接通过。

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- 本计划三修复（G-02-2/WR-02/WR-04）全部改变 pushhub.js 产物字节——重建与部署统一归 02-06 的 0.1.9，不在本计划内
- 查看器端到端"呈现 error 态不卡连接中"验证归 02-06（避免与 02-05 同文件不同 wave 冲突）
- WR-03（viewer.js localStorage 读取侧 try/catch）归 02-05
- 全套测试 79/79 绿、typecheck 通过——02-05 执行者接手时基线即此状态

## Verification Results
- `pnpm --filter @pushhub/web-sdk test`：**79/79 全绿**（68 基线 + 4 render 样本 + 6 机器 WS_FAIL + 1 adapter 畸形 URL），零回退
- `pnpm --filter @pushhub/web-sdk run typecheck`：**exit 0**（MachineEvent 联合扩展后 switch 穷尽性由编译器保证）

---
*Phase: 02-web-sdk*
*Completed: 2026-08-27*
