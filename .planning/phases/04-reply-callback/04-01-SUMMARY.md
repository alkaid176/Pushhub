---
phase: 04-reply-callback
plan: 01
subsystem: shared-protocol + server-do
tags: [protocol-evolution, reply-chain, durable-objects, golden-fixtures, websocket]
requires:
  - "Phase 1 冻结协议（v:1 帧全集 + golden fixtures 基线 6ef00e6）"
  - "messages 表 answered 四列（D-03，Phase 1 已建全）"
  - "webSocketMessage 入站帧 switch（01-04）"
provides:
  - "ReplyFrame/AckFrame/AnsweredFrame 三帧类型 + ErrorCode 两新码 + BY_MAX=64（@pushhub/shared 单一事实源）"
  - "validateInboundFrame reply 结构分支（恰一/长度/wid——白名单域级校验在 DO）"
  - "ChatRoom.handleReply：一次锁定 + ack 单发 + answered 全连接扇出 + attachment displayName"
  - "reply/answered fixtures 正反例逐字节冻结基线（04-03 SDK 守卫与 04-04 测试页的契约依据）"
affects:
  - "packages/web-sdk（ws-error fixture 消费断言已联动扩至四例）"
tech-stack:
  added: []
  patterns:
    - "服务端发射帧契约锁定模式：结构检查器（同 history 先例）——无入站校验器的帧由测试侧检查器冻结"
    - "协议事件联动：fixture 追加后所有消费方断言同步更新（server + web-sdk 双侧）"
key-files:
  created:
    - packages/shared/fixtures/reply-frame.positive.json
    - packages/shared/fixtures/reply-frame.negative.json
    - packages/shared/fixtures/answered-frame.positive.json
    - packages/server/test/reply-chain.test.ts
  modified:
    - packages/shared/src/index.ts
    - packages/shared/src/validators.ts
    - packages/shared/fixtures/ws-error-frame.json
    - packages/shared/README.md
    - packages/server/src/chat-room.ts
    - packages/server/test/validators.test.ts
    - packages/server/test/fixtures-contract.test.ts
    - packages/web-sdk/test/frames.test.ts
decisions:
  - "Task 2 用户裁决 approve-freeze（2026-08-28）：三帧/两错误码/BY_MAX=64 按 Task 1 实现形态冻结，4 项裁量点按现状落定——错误文案（Message not found. / Message already replied. / selected_option is not one of the message options.）、reply 可选字段 null 视为未提供（SRV-02 同源）、AnsweredFrame.answered_at 非空 number、回复者先 ack 后 answered"
metrics:
  duration: 66min
  completed: 2026-08-28
status: complete
actuals:
  tokens: 30700
  tasks: 3
  commits: 4
---

# Phase 04 Plan 01: 回复链 tracer——三帧协议演进 + DO reply 处理 Summary

**One-liner:** 冻结协议（D-07）首次合规演进落地：reply/ack/answered 三帧 + already_replied/not_found 两错误码进 @pushhub/shared 并经用户裁决 approve-freeze 逐字节冻结进 golden fixtures；DO 内 reply 处理（恰一+白名单+同步块一次锁定）双客户端集成测试证明端到端回复闭环与竞态先到先得。

## What Was Built

### 1. 协议层（packages/shared）

- `index.ts`：`ReplyFrame`（v/type/wid/selected_option?/text?/by?，恰一）、`AckFrame`（恰 v/type/wid 三键）、`AnsweredFrame`（wid/seq/answered恒true/answered_by/answered_at/answered_content）三接口；`ErrorCode` 追加 `already_replied`/`not_found`（D-42 两域级拒绝严格区分）；`BY_MAX = 64`（UTF-16 码元，与频道名/label 同口径）；`ClientFrame`/`ServerFrame` 联合扩展。既有帧/字段/错误码零改动（D-07 只加不改）。
- `validators.ts`：`validateInboundFrame` reply 分支——wid 非空 string、恰一（null 与缺省均视为未提供）、text/selected_option ≤ TEXT_MAX、by ≤ BY_MAX；白名单校验明确不在此纯函数（需读库，属 DO 域级——D-46 分层）。

### 2. 服务端（packages/server/src/chat-room.ts）

- `webSocketMessage` 挂 reply 分支 → `handleReply`（全程同步零 await，Pitfall 5）：SELECT 目标行 → not_found/already_replied/白名单 invalid_frame 三类错误帧均不断连 → 同步块 UPDATE answered 四列（一次锁定，竞态正确性唯一依赖）→ ack 单发回复者 → answered 全连接扇出（含死连接 try/catch 收集后 close(1011)，handlePublish 同款）。
- attachment 演进：`displayName: by ?? null` 增量字段（D-52——展示名跨休眠存活，升级点初始化 null、reply 带 by 时更新）。
- callback_url 读而不动作——04-02 回调入队的挂载点已在（计划明示的可后补功能性缺口）。

### 3. Golden fixtures 冻结（裁决 approve-freeze）

- `reply-frame.positive.json`：恰 option/恰 text/带 by/匿名四形态。
- `reply-frame.negative.json`：9 反例（同真/同假/wid 缺失/非字符串/空串/text 超限 32769/selected_option 超限/by 超一字符/by 非字符串），`_violation -> invalid_frame` 闭环驱动校验器。
- `answered-frame.positive.json`：answered_by string/null 两形态（结构检查器锁定——服务端发射帧同 history 模式）。
- `ws-error-frame.json`：追加 already_replied/not_found 两例（四键形态，文案与 handleReply 逐字一致）。
- `fixtures-contract.test.ts`：正例通过数=条目数、反例拒绝数=条目数、全键严格相等纪律（禁止子集匹配）。

### 4. 集成/单元测试

- `reply-chain.test.ts` 六组用例全绿：ack 恰三键 + 双客户端 answered 全量断言；二次回复 already_replied 连接保持；不存在 wid not_found；**双客户端零间隔竞态恰一成功**（胜者 [ack,answered] / 败者 [answered,error]，两客户端合计恰 1 ack + 1 already_replied——D-44 先到先得证明）；invalid_frame 四连拒连接保持（白名单外/同真/同假/by 超长）；answered_by 自报与匿名两形态 + Markdown 原文透传（RPL-02）。
- `validators.test.ts` reply 边界对：恰一/同真/同假/null 省略/text 恰 32768/by 恰 64 与 65/wid 三反例。

## Task 2 裁决记录（one-way 门经用户之手关闭）

用户裁决 **approve-freeze**（2026-08-28）：三帧帧形（reply/ack/answered 字面量 + ack 恰 {v,type,wid} + 两新错误码 + BY_MAX=64）按 Task 1 实现形态冻结进 golden fixtures。4 项实现裁量点全部按现状落定：

1. 错误帧文案：`"Message not found."` / `"Message already replied."` / `"selected_option is not one of the message options."`（前两例已逐字进 ws-error-frame.json）
2. reply 可选字段 null 视为未提供（省略语义与 SRV-02 同源）
3. AnsweredFrame.answered_at 为非空 number（帧只在成功回复后发射）
4. 同一回复者先收 ack 后收 answered（同 handler 内先单发后扇出，顺序保证）

## Verification Results

| 验证 | 结果 |
|------|------|
| Task 1 verify（reply-chain + validators） | 29/29 绿 |
| Task 3 verify（fixtures-contract + reply-chain + validators） | 45/45 绿 |
| server 全量回归 | 102/102 绿（原 84 → 99（Task 1）→ 102（Task 3），既有用例零破坏） |
| web-sdk 回归 | 86/86 绿（fixture 消费联动后恢复） |
| typecheck（shared + server） | 干净 |

TDD 门合规：RED commit 409f4ea（9 判别性用例失败）→ GREEN commit a5f7d2e（全绿）→ 无需 REFACTOR。

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] 测试基建两处 bug（GREEN 期发现，随 GREEN commit 修复）**
- **Found during:** Task 1 GREEN
- **Issue:** (a) `publishOne` 误将 publish 响应 `SendResult.id` 解构为 `wid`，reply 帧 wid=undefined 被结构层拒绝；(b) 同一 socket 挂两个单帧监听器，首帧到达时双双触发，`answeredAPromise` 被 ack 提前 resolve
- **Fix:** (a) 显式映射 `result.id → wid`；(b) 同 socket 多帧断言改计数收集器 `nextFrames(socket, n)`（与竞态用例一致）
- **Files:** packages/server/test/reply-chain.test.ts
- **Commit:** a5f7d2e

**2. [Rule 2 - 关键文档对齐] README.md 帧清单/错误码/常量表同步**
- **Found during:** Task 3
- **Issue:** 计划 files_modified 未列 README，但冻结后帧清单表不同步会造成契约文档与基线漂移（README 是 D-07 演进规则载体，四端实现者依赖）
- **Fix:** 帧清单表加 reply/ack/answered 三行、WS 错误码表加两码行、常量表加 BY_MAX 行
- **Files:** packages/shared/README.md
- **Commit:** e306f21

**3. [Rule 3 - 阻塞联动] web-sdk fixture 消费断言同步**
- **Found during:** Task 3 全量回归
- **Issue:** web-sdk `frames.test.ts` 消费同一 `ws-error-frame.json` 并断言恰 2 例——fixture 追加后 SDK 测试失败（fixture 追加即协议事件，消费方有联动义务）
- **Fix:** 断言扩至四例（`parseServerFrame` error 守卫只查 `typeof code === "string"` 不枚举，天然兼容新码；reply/answered 帧 SDK 侧消费在 04-03）
- **Files:** packages/web-sdk/test/frames.test.ts
- **Commit:** e306f21

## Auth Gates

None.

## Known Stubs

None——callback_url 读而不动作是计划明示的 04-02 挂载点（非 stub：本计划目标是回复闭环，回调链在下一计划落地）。

## TDD Gate Compliance

- RED：409f4ea `test(04-01): ...`（判别性用例失败确认）✓
- GREEN：a5f7d2e `feat(04-01): ...`（全绿）✓
- REFACTOR：无需（sendWsError 辅助已消重，结构最小）✓
- 注：RED 期"预期 invalid_frame"的负例（同真/同假等）因 reply 类型当时整体未识别而恰好通过——判别性用例（恰一通过/ack/answered/not_found/already_replied）全部失败，RED 门有效。

## Threat Model Mitigations (per-plan)

- **T-04-02 (DoS, mitigate)**：结构层恰一/长度校验（shared 纯函数）+ 域级白名单/存在性/已回复判定（DO 单线程）+ 非法帧回错误帧不断连——reply-chain Test 5 四连拒连接保持已证明。
- **T-04-03 (Repudiation, mitigate)**：UPDATE 在同步块零 await 完成 + 竞态集成测试恰一成功（Test 4）——D-44 先到先得经证明。
- **T-04-01 (XSS, mitigate→04-03/04-04)**：服务端透传不转义按计划落地（RPL-02 哑管道，Test 6 Markdown 原文透传断言）；渲染消毒（renderMarkdown/textContent）在 04-03 SDK 与 04-04 测试页落实——威胁登记表既定排期。
- **T-04-04 (Elevation, accept)**：by 自报展示名是产品语义（D-51），无权限语义。

## Threat Flags

None——无计划外新增安全面（新帧走既有已鉴权 WS 通道；无新网络端点/文件访问/信任边界变更）。

## Self-Check: PASSED

全部关键文件存在（shared 三帧源文件、4 个 fixtures、DO、3 个测试文件、SUMMARY）；全部提交存在（409f4ea RED / a5f7d2e GREEN / e306f21 fixtures 冻结）。
