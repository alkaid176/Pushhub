---
phase: 02-web-sdk
plan: 02
subsystem: web-sdk
tags: [web-sdk, connection-machine, full-jitter, heartbeat-deadline, visibilitychange, dedup, playwright-e2e, deploy]
requires:
  - "02-01 pushhub.js tracer（PushHub 类基础实现 + API 表面定稿 + e2e 编排模式）"
  - "01-02 冻结协议包（HistoryFrame/oldest_kept_seq/has_more/SYNC_LIMIT_DEFAULT）"
  - "01-04 服务端 sync keyset 语义（多取 1 条判 has_more、accept 即推首拉 50 条）"
provides:
  - "connection-machine.ts 纯状态机（createMachine 输入事件流→输出动作流，零平台依赖——Phase 5 Tauri 移植同构参考）"
  - "常量：BACKOFF_BASE_MS=500 / BACKOFF_CAP_MS=60_000 / HEARTBEAT_INTERVAL_MS=30_000 / PONG_DEADLINE_MS=10_000 / PROBE_DEADLINE_MS=5_000 / SYNC_PAGE_MAX=100"
  - "行为契约固化：full jitter 退避曲线（cap 60s）、重连确定序列（首拉过滤→sync(syncBase)→has_more 翻页）、D-16×D-17 交集语义（history.messages 只含未见消息）、v!==1 fatal 不重连"
  - "e2e/reconnect.spec.ts 断连混沌三形态（意外断连/大缺口/被动 close）——浏览器层重连验证范式（socket 捕获法）"
  - "生产 0.1.6（Version 936e5e7f）：SDK 重连韧性进入分发产物（81,022 bytes min）"
affects:
  - "packages/web-sdk/src/pushhub.ts（重构为薄 adapter；公开 API 表面不变）"
  - "根 package.json（version 0.1.6）"
  - "DEPLOY.md / .planning/WINDOWS.md（部署记录 + #4 欠账关闭）"
tech-stack:
  added: []
  patterns:
    - "纯状态机 + adapter 接线（机器零平台 API，随机源/定时器全部注入——可移植性组织保障）"
    - "页面包装 WebSocket 构造器捕获底层 socket（setOffline 不关已建立 WS 时的断连混沌替代手段）"
    - "退避窗口确定性注入：页面内 Math.random 打补丁（机器缺省随机源经属性查找）"
key-files:
  created:
    - packages/web-sdk/src/connection-machine.ts
    - packages/web-sdk/test/helpers.ts
    - packages/web-sdk/test/machine-backoff.test.ts
    - packages/web-sdk/test/machine-fatal.test.ts
    - packages/web-sdk/test/machine-events.test.ts
    - packages/web-sdk/test/machine-heartbeat.test.ts
    - packages/web-sdk/test/history-filter.test.ts
    - packages/web-sdk/test/adapter-lifecycle.test.ts
    - packages/web-sdk/e2e/reconnect.spec.ts
  modified:
    - packages/web-sdk/src/pushhub.ts
    - packages/web-sdk/test/dedup.test.ts
    - package.json
    - DEPLOY.md
    - .gitignore
    - .planning/WINDOWS.md
decisions:
  - "机器动作经 input() 返回值传递（非 outputs 累积数组）——adapter 无内存泄漏、测试自收集；机器 import 仅 @pushhub/shared 常量 + 本包纯模块（prohibition 的'仅类型 import'按零平台 API 意图落地）"
  - "closeSocket 动作携带 reason（manual/fatal/deadline）——adapter 据此选 WS close code（1000/1002/4000）；机器 createSocket 不带 url（URL 是 adapter 所有权）"
  - "断连混沌手段（spike 结论落地）：页面包装 WebSocket 构造器捕获实例，对真实 socket 调 close(1000, reason)——实证无参 close() 在 wrangler dev 代理层下握手卡 CLOSING"
  - "E2E 退避窗口确定性：页面内 Math.random=0.99（机器缺省随机源改为属性查找）→ attempt0 重连延迟 ≈495ms，保证断连窗口内完成 Node 侧 fetch"
metrics:
  duration: 63min
  completed: 2026-08-26
  tasks: 3
  commits: 6
actuals:
  tokens: 22319
  tasks: 3
  commits: 6
status: complete
---

# Phase 2 Plan 2: 重连韧性与协议纵深完整化 Summary

把 02-01 tracer 的基础恢复路径扩成完整 SC2 能力：连接生命周期抽取为纯状态机 connection-machine.ts（full jitter 退避 cap 60s / 心跳 30s + pong 死线 10s / visibilitychange 探活 5s（D-27）/ v!==1 fatal 不重连 / has_more 翻页 SYNC_PAGE_MAX=100 硬上限 / D-16×D-17 交集语义唯一实现点），pushhub.ts 重构为行为等价的薄 adapter，断连混沌 E2E 三形态全绿，生产 0.1.6 部署 + SMOKE OK + SC4 字节级验证。

## What Was Built

**connection-machine.ts（纯状态机，~300 行）**：
- 输入事件 8 种（CONNECT/DISCONNECT/DESTROY/WS_OPEN/WS_CLOSE/FRAME(result)/VISIBILITY/TIMER），输出动作 10 种（createSocket/closeSocket(reason)/sendPing/sendSync(since,limit)/schedule/cancel/emitStatus/emitMessage/emitHistory/emitError）；`input()` 返回动作数组，机器内部状态 idle→connecting→online⇄reconnecting→offline(/destroyed)，emitStatus 仅标签变化时输出
- 零平台依赖（grep 机械验证：import 段仅 @pushhub/shared 常量 + ./frames 类型 + ./dedup 纯逻辑）；随机源经 options.random 注入（缺省 `() => Math.random()` 属性查找——页面可注入确定退避窗口）
- 重连确定序列固化：WS_OPEN → syncBase=dedup.last 快照 → 首拉 history（shouldDeliver 过滤进 emitHistory，oldest_kept_seq/has_more 原样透传）→ 无条件 sendSync(since=syncBase, limit=200) → has_more 以 dedup.last 续翻，连续 100 页（SYNC_PAGE_MAX）放弃并 emitError(sync_page_limit)（T-02-06 死循环防线）
- 心跳/死线/探活：WS_OPEN arm(heartbeat,30s)；TIMER(heartbeat) → sendPing + arm(pongDeadline,10s) + re-arm；FRAME(pong) 取消双死线；pongDeadline/probe 超时 → closeSocket(deadline) + 退避重连（T-02-08 假活防线）；VISIBILITY(visible) → sendPing + arm(probe,5s) + 心跳接管（D-27 iOS 冻结恢复路径）；hidden → 取消心跳与探活
- v!==1 fatal → emitError(fatal) + closeSocket(fatal) + offline，此后任何事件零动作（D-07 客户端严格方向；CONNECT 可手动恢复——02-01 语义保持）

**pushhub.ts adapter 重构（公开 API 表面零变化）**：
- WS onopen/onclose/onmessage、setTimeout 到点、document.visibilitychange 全部翻译 machine.input 事件；machine 输出映射回真实 WebSocket/PING 字面量直发/on 回调发射
- PushHubStatus/PushHubErrorPayload 类型上提到 connection-machine、pushhub re-export（宿主 import 路径兼容）
- visibilitychange 监听构造注册（typeof document 守卫——SSR 导入安全）、destroy() 移除（D-18）
- 陈旧 socket 竞态加固：openSocket 前 detach 旧句柄回调；全部 handler 校验 this.ws===ws 防迟到事件错认新连接

**测试七组（45→68 例）**：machine-backoff（30 次退避区间 + cap 恰 60_000 + attempt 归零）、machine-fatal（fatal 序列 + TIMER/WS_CLOSE/FRAME 全哑火 + CONNECT 恢复）、machine-events（交集过滤 + sendSync(syncBase) + 翻页续拉 + SYNC_PAGE_MAX 超限 + message 去重 + pong 重置 + error 透传 + 坏帧静默）、machine-heartbeat（pongDeadline/probe 死线、探活三态、hidden 取消、DESTROY 清定时器）、history-filter（交叠批次恰未见、全批已见仍发帧保 D-10 语义、完整重连序列宿主零重复）、dedup 增补（seq=2000 裁剪 + 窗口内判定不变 + 超窗语义文档化）、adapter-lifecycle（jsdom+FakeWebSocket+fake timers：心跳 30s 接线 + PING 逐字节 + visibilitychange 注册/探活/死线 + destroy 零定时器零监听不复活 + disconnect 可恢复）

**e2e/reconnect.spec.ts（SC2 三形态，页面 socket 捕获法）**：①意外断连 → status online→reconnecting→connecting→online → 补拉恰 2 条 seq 连续零重复零 error（857ms）；②55+5 大缺口：首拉 50 + has_more=true 翻页触发 + 60 条全到 {1..60} 零重复；③被动 socket close（非 disconnect()）自动恢复后新消息照常到达

**部署 0.1.6**：root version bump → pnpm run deploy 链式（Version 936e5e7f，pushhub.js 新资产上传）→ 生产 SMOKE OK（延迟 368ms、补拉恰 2 条、401/413 反例）→ /pushhub.js 200 + text/javascript + 81,022 字节与本地 dist 逐字节一致（SC4）→ DEPLOY.md 登记 → WINDOWS.md #4 关闭

## Verification Results

| 验证项 | 结果 |
|---|---|
| `pnpm --filter @pushhub/web-sdk test` | PASS——68/68（machine 31 + history-filter 3 + dedup 7 + frames 11 + render 10 + adapter-lifecycle 6） |
| `pnpm --filter @pushhub/web-sdk run typecheck` | PASS（0 错） |
| `pnpm --filter @pushhub/web-sdk run build` | PASS——min 81,022 / gzip 27,586 bytes（+2.3KB 状态机与探活逻辑；< 120KB 报警线）；BUILD SMOKE OK |
| `pnpm --filter @pushhub/web-sdk run e2e`（tracer + reconnect） | PASS——5/5：tracer 2/2（SC1 延迟 18ms 回归绿）+ reconnect 3/3（SC2 三形态） |
| `pnpm --filter @pushhub/server test` | PASS——60/60 回归基线不回退 |
| `pnpm run deploy` | PASS——Version 936e5e7f-d8ee-4b14-8487-a3ebf3894a5f |
| 生产冒烟（pushhub.dyun.org） | **SMOKE OK**——延迟 368ms；断线补拉恰 2 条零丢失零重复；401/413 反例全过 |
| SC4 分发路径 | PASS——/pushhub.js 200 + text/javascript + **81,022 字节与本地 dist 逐字节一致** |
| prohibition 机械验证 | PASS——connection-machine 零 WebSocket/window/document/Node 引用（grep 仅注释命中）；SYNC_PAGE_MAX=100 常量 + 超限 emitError（单测覆盖）；宿主 seq 零重复（单测 + E2E 双层断言） |

### Must-haves truths 逐条核对

- [x] 30 次重连退避 delay 全落 [0, min(60_000, 500*2^attempt)]，cap 恰 60_000（machine-backoff：random=1 时 attempt≥7 精确等于 60_000）
- [x] v!==1 → fatal error + offline + 后续 TIMER 零 createSocket（machine-fatal）
- [x] 30s ping / 10s pong 死线 / visible 立即探活 5s 死线超时强制重连续补拉（machine-heartbeat + adapter-lifecycle fake timers）
- [x] 55+5 大缺口经 has_more 翻页全部补齐：60 条全到零重复（reconnect.spec 用例二，has_more=true 实际观察到）
- [x] history.messages 永远只含未见消息、oldest_kept_seq/has_more 透传（history-filter 交叠 {20..50} 预置 {1..30} → 恰 {31..50}）
- [x] 断连混沌后自动重连续补拉宿主无感（reconnect.spec 三形态 + 零 error 事件断言）
- [x] 生产 0.1.6 SMOKE OK

### TDD 门序列（两 tdd 任务）

- Task 1：`test(02-02)` a50143d（3 文件 19 例 RED——模块不存在整批红）→ `feat(02-02)` 1987464（GREEN 45/45）
- Task 2：`test(02-02)` 1b50a02（11 例 RED——探活/VISIBILITY/死线路径未实现）→ `feat(02-02)` d354a06（GREEN 68/68）
- Task 3：`chore(02-02)` f1f5809 + typecheck 修正 b995bb5

## Decisions Made

1. **机器动作经返回值传递**（非研究草图的 `m.outputs` 累积数组）：adapter 无内存增长风险，测试自收集断言等价。
2. **prohibition"仅类型 import"的落地口径**：机器 import 段含 @pushhub/shared 的 SYNC_LIMIT_DEFAULT（值导入）与 SeqDedup（纯逻辑类）——按 prohibition 真实意图（零 WebSocket/DOM/Node 平台 API、Phase 5 可移植）执行，机械 grep 验证零平台引用；sendSync(limit) 常量直接出自冻结协议包单一来源。
3. **closeSocket 携带 reason 三态**（manual=1000/fatal=1002/deadline=4000），createSocket 不带 url（URL 归 adapter 所有权）——对计划动作签名的最小必要扩展。
4. **断连混沌实证三连**（详见 Deviations）：无参 close() 在 wrangler dev 代理层握手卡 CLOSING → 带 code+reason 正常；原生 WS 立即/静置 3s close 均正常（排除空闲超时假设）——定位为 SDK 测试路径差异后以带参 close 定稿。
5. **E2E 限流适配**：KEY-05（30 条/分钟/Send Key）使 55 条连发第 31 条起 429——分两批跨固定窗口（61s 等待，用例 setTimeout 150s），符合"限流是防开放中继的正确行为"的 Phase 1 决策，不绕过不降阈。

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - 竞态加固] 陈旧 socket 迟到事件错认新连接**
- **Found during:** Task 1 adapter 重构
- **Issue:** 02-01 的 handleClose 无条件 `this.ws=null` + 调度重连——退避到点创建新 socket 后，旧 socket 的迟到 onclose 会清掉新引用并二次调度重连（双 socket 竞态，jitter≈0 时窗口真实存在）
- **Fix:** openSocket 前 detach 旧句柄全部回调；四个 handler 均校验 `this.ws === ws` 迟到即忽略
- **Files:** packages/web-sdk/src/pushhub.ts
- **Commit:** 1987464

**2. [Rule 3 - 测试基建] 无参 close() 在 wrangler dev 下握手卡死**
- **Found during:** Task 3 E2E 首轮（三用例全挂 waitReconnecting）
- **Issue:** 页面内对 SDK 底层 socket 调无参 `close()` 后 readyState 永卡 2（CLOSING）、onclose 不触发；对照实验：原生 WS 无论立即还是静置 3s 后 close(1000, reason) 均正常完成握手——wrangler dev 代理层对无 code 的 Close 帧处理异常（生产 smoke.mjs Node 侧 close 无此问题）
- **Fix:** closeLiveSocket 定稿 `close(1000, "e2e unexpected disconnect")`
- **Files:** packages/web-sdk/e2e/reconnect.spec.ts
- **Commit:** f1f5809

**3. [Rule 3 - 测试基建] E2E 断连窗口不确定性 + KEY-05 限流**
- **Issue:** full jitter attempt0 延迟 ∈[0,500)ms，Node 侧 2 条 fetch 有 ~20% 概率晚于重连（消息变 live 到达，补拉路径未被压到）；55 条连发触发 429 rate_limited
- **Fix:** ①机器缺省随机源改属性查找（`() => Math.random()`），页面 pinBackoff 注入 0.99 → 确定性 ~495ms 断连窗口（生产行为零变化）；②55 条分两批跨 61s 固定窗口 + 用例 setTimeout(150s)
- **Files:** packages/web-sdk/src/connection-machine.ts, packages/web-sdk/e2e/reconnect.spec.ts
- **Commit:** f1f5809

**4. [Rule 1 - 测试修正] adapter-lifecycle 首轮两处时序设计错误**
- **Found during:** Task 2 GREEN
- **Issue:** ①FakeWebSocket 不回 pong——pongDeadline（10s < 周期 30s）会正确杀死无响应周期，第二 ping 永不发出（实为机器正确行为）；②前置用例的 hub 未 destroy，泄漏的 visibilitychange handler 跨用例串扰多创建 socket（D-18 同款问题在测试侧复现）
- **Fix:** 心跳用例手动喂 pong 解除死线；文件级 activeHub + afterEach 统一 destroy
- **Files:** packages/web-sdk/test/adapter-lifecycle.test.ts
- **Commit:** d354a06

**5. [Rule 1 - 类型] e2e close() 类型注解零参签名与带参调用不符（typecheck）**
- **Fix:** `{ close(code?: number, reason?: string): void }`
- **Commit:** b995bb5

**计划内顺带（不计偏差）**：machine-heartbeat.test.ts 与 adapter-lifecycle.test.ts 为新文件（计划 action 明示"并入 Task 1 测试文件或新文件"，一场景一文件惯例）；test-results/ 入 .gitignore。

## Auth Gates

无。

## Known Stubs

无——计划 must_haves 全部交付，无 placeholder/TODO 残留（机器探活逻辑为纯逻辑实现 + fake timers/adapter/E2E 三层验证；iOS 真机验证按 D-27 明确不追踪）。

## Threat Flags

无新增计划外安全面。计划威胁寄存器处置全部落地：

- T-02-04（协议混淆帧，medium）✓ machine-fatal 锁定 fatal 序列与"不再 createSocket"
- T-02-06（has_more 死循环 DoS，low）✓ SYNC_PAGE_MAX=100 硬上限 + 超限 emitError 单测
- T-02-07（交叠批次绕过去重，medium）✓ shouldDeliver 唯一闸门 + history-filter/E2E 零重复断言
- T-02-08（静默假活，low）✓ pong/probe 双死线强制重连（machine-heartbeat + adapter-lifecycle）

## Self-Check: PASSED

- 关键文件存在：packages/web-sdk/src/connection-machine.ts、test/{helpers,machine-backoff,machine-fatal,machine-events,machine-heartbeat,history-filter,adapter-lifecycle}.test.ts、e2e/reconnect.spec.ts——全部 FOUND
- 提交存在：a50143d / 1987464 / 1b50a02 / d354a06 / f1f5809 / b995bb5——git log 验证 FOUND
- 验证链：单测 68/68、typecheck 0 错、build 81,022 bytes、e2e 5/5、server 回归 60/60、生产 SMOKE OK、SC4 字节一致——全部 PASS
- WINDOWS.md #4（浏览器层重连验证欠账）已关闭（status: fixed）
