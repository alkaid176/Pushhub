---
phase: 03-admin-keys
plan: 03
subsystem: admin-ui
tags: [cloudflare-workers, durable-objects, kv-cleanup, websocket-kick, deleteall-alarm, vanilla-js, native-dialog, playwright-e2e, tdd]

# Dependency graph
requires:
  - phase: 03-admin-keys(Plan 01)
    provides: sendKeys[]/label KV schema + normalizeIdRecord 兼容层、buildKeyRow/snippetBlock/handleApiFailure 组件、admin.html/admin.js 骨架、E2E 锚点体系
  - phase: 03-admin-keys(Plan 02)
    provides: admin.ts CHANNEL_ID_RE 参数化路由骨架（reset/delete 占位分支）、Worker→DO X-PH-Verified 转发模式（/cleanup-rate 先例）、原生 dialog 确认框骨架 + cancel 清引用模式
provides:
  - DO POST /kick-all（close 1008 "channel key reset"，响应 {kicked}）与 POST /purge（踢连 + deleteAll + deleteAlarm 成对，响应 {kicked}）内部路由
  - POST /api/admin/channels/:id/reset-channel-key（201 {channelKey}——KV 写先 DO 踢后）与 DELETE /api/admin/channels/:id（204——DO purge 先 KV 键删后）
  - keys.ts resetChannelKey/deleteChannelKeys/readChannelRecord 写路径（键空间红线延续；id: 删序最后落）
  - 管理页重置/删除交互（逐字确认框、新密钥一次性展示卡、60s 双活提示条 #d9a300 边框式、删除前缀联动）
  - admin.spec.ts 切片三（3 test：双页踢连观察 / 旧 Key 401 / 删除五要素）
affects: [03-admin-keys(Plan 04-05), 04-reply-loop(dialog/危险区模式复用), 07-生产清理(dogfooding 删除冒烟频道)]

# Actuals (#2632) — same chars/4 scale as the plan estimate.
actuals:
  tokens: 13874   # 55495 diff chars / 4 over 8751f69..3a7cbc6 (8 files, +1155/-5)
  tasks: 3
  commits: 4

tech-stack:
  added: []   # 零新依赖（getWebSockets/deleteAll/deleteAlarm/KV delete 全部运行时内置）
  patterns:
    - 破坏性编排双顺序定稿（重置 KV 写先 DO 踢后 / 删除 DO purge 先 KV 键删后——顺序红线进函数头注释与代码结构）
    - deleteAll + deleteAlarm 成对红线（Pitfall 1 僵尸 DO 防御）+ runInDurableObject 直读 getAlarm 断言
    - 驻留 DO deleteAll 后未重跑构造器 → 表不存在 = 0 行等价断言（try/catch 语义化）

key-files:
  created:
    - packages/server/test/admin-reset-kick.test.ts
    - packages/server/test/admin-delete.test.ts
  modified:
    - packages/server/src/chat-room.ts
    - packages/server/src/admin.ts
    - packages/server/src/keys.ts
    - packages/server/public/admin.js
    - packages/server/public/admin.html
    - packages/web-sdk/e2e/admin.spec.ts

key-decisions:
  - "kick close code/reason 双值定稿（planner 裁定登记）：kick-all 用 close(1008, \"channel key reset\")、purge 用 close(1008, \"channel deleted\")——1008 policy violation 语义正确；web SDK 不区分 close code 一律退避重连（已实证），Phase 5/6 客户端展示可按 reason 细化"
  - "deleteChannelKeys 内部删序 id: 最后落（ch: → sk:* → id:）：与 createChannel 写序「id: 反向索引最后落」对称——部分失败时频道仍在列表，删除链可整链重试（计划字面顺序 ch:→id:→sk:* 在 id: 已删而 sk: 残留时会造 404 死角：残留 sk: 键仍可发送且无重试入口）"
  - "DO /purge 转发失败（fetch 抛错或非 2xx）→ 500 server_error 且不落任何 KV 删除：频道完整保留可重试——若吞错继续删 KV 会制造 key_links 论证要避免的不可达孤儿 DO"
  - "重置链 DO kick 转发失败不阻断 201（尽力语义）：KV 已切换，生产 ≤60s 缓存窗口后旧 Key 自然失效——与删除链的失败策略截然不同（删除失败必须可重试，重置失败已达成凭据轮换目标）"
  - "Destructive 逐字契约文案单一来源在 admin.js（textContent 填充，HTML 骨架零文案）：满足 token 契约检查的同时维持 T-03-09 纪律"

patterns-established:
  - "Pattern: 双页 E2E 观察 = context.newPage() 第二页连 viewer + 主页走管理页——踢连/重连类跨端行为的端到端形态"
  - "Pattern: 被踢断言 = dot-online 类名消失（waitForFunction 反包含）——Pitfall 5：SDK 退避重连永不 fatal，勿等 offline 终态"
  - "Pattern: DO 清理类路由的幂等重放断言 = 二次 DELETE 同频道走 404 miss 路径不抛错"

requirements-completed: [KEY-02, KEY-04, ADM-01, ADM-02]

coverage:
  - id: D1
    description: "DO /kick-all + /purge 内部路由：close 1008 双 reason、deleteAll+deleteAlarm 成对（顺序 deleteAll 前）"
    requirement: KEY-04
    verification:
      - kind: unit
        ref: "packages/server/test/admin-reset-kick.test.ts#踢连用例 close {code:1008, reason:'channel key reset'} 断言（attach-before-trigger）"
        status: pass
      - kind: unit
        ref: "packages/server/test/admin-delete.test.ts#runInDurableObject 直读 getAlarm()===null（删除前前置证明 alarm 在位）+ messages 0 行"
        status: pass
    human_judgment: false
  - id: D2
    description: "POST reset-channel-key：201 {channelKey 新 phc_ 36 字符}、name/sendKeys/createdAt 原样保留、旧 Key 401、历史保留、Send Key 存活（KEY-04 分级隔离）"
    requirement: KEY-04
    verification:
      - kind: unit
        ref: "packages/server/test/admin-reset-kick.test.ts#201 保留性对照（基线在追加第二 Key 后建立）+ SC2 服务端侧全链路用例"
        status: pass
    human_judgment: false
  - id: D3
    description: "DELETE /channels/:id：204 空体、KV 三前缀全清（listChannels/resolveChannelKey/resolveSendKey 三 miss）、DO 数据清空 + alarm 删除、404/401 边界、purge 幂等重放"
    requirement: KEY-02
    verification:
      - kind: unit
        ref: "packages/server/test/admin-delete.test.ts#三用例（全清理三断言 / 边界 / 二次 DELETE 404 不抛错）"
        status: pass
    human_judgment: false
  - id: D4
    description: "管理页重置交互：逐字确认框（三句契约）→ 201 新密钥明文一次性展示（mono+复制）+ 60s 提示条（#d9a300 边框式）+ 掩码行刷新"
    requirement: ADM-02
    verification:
      - kind: e2e
        ref: "packages/web-sdk/e2e/admin.spec.ts#SC2 重置踢连端到端：确认框含「最长约 1 分钟」「频道历史消息完整保留」、new-key-display 卡 + key-reset-hint 在位"
        status: pass
      - kind: other
        ref: "pnpm --filter @pushhub/web-sdk run build 绿 + 四逐字契约 token 检查（UI contract tokens OK）"
        status: pass
    human_judgment: false
  - id: D5
    description: "管理页删除交互：GitHub 删仓库模式前缀联动（初始 disabled #9a9a9a / 错误输入仍 disabled / 正确前缀启用）→ 204 列表消失 + 详情空态"
    requirement: ADM-01
    verification:
      - kind: e2e
        ref: "packages/web-sdk/e2e/admin.spec.ts#D-34 删除交互：五要素断言（含反转错误输入与 slice(0,3) 前缀）"
        status: pass
    human_judgment: false
  - id: D6
    description: "SC2 端到端三证据：viewer 双页观察被踢离开 online（Pitfall 5 红线遵守）+ 旧 Key Upgrade 401 + 新 Key 重连历史含重置前 2 条"
    requirement: KEY-04
    verification:
      - kind: e2e
        ref: "packages/web-sdk/e2e/admin.spec.ts#SC2 双页用例（dot-online 消失 + pre-reset message one/two 重连后可见）+ 旧 Key 401 用例"
        status: pass
    human_judgment: false
  - id: D7
    description: "重置/删除确认框与新密钥展示卡的视觉观感（dialog 布局、60s 提示条边框式呈现、危险区分隔）"
    requirement: ADM-02
    verification: []
    human_judgment: true
    rationale: "E2E 已覆盖功能行为与逐字文案，但 dialog/hint 卡的布局美感与 token 合规无自动化断言——留 end-of-phase 人工 UAT（config human_verify_mode: end-of-phase，同 03-01 D8）"

# Metrics
duration: 16min
completed: 2026-08-28
status: complete
---

# Phase 03 Plan 03: Channel Key 重置与频道硬删除 Summary

**DO kick-all/purge 路由（deleteAll+deleteAlarm 成对）+ reset/delete 双编排顺序定稿（重置 KV 先 DO 踢后 / 删除 DO 先 KV 后）+ 管理页逐字确认框与新密钥一次性展示 + E2E 双页踢连观察——KEY-04 分级重置与 KEY-02 硬删除端到端闭合**

## Performance

- **Duration:** 16 min
- **Started:** 2026-08-27T16:34:56Z
- **Completed:** 2026-08-27T16:50:31Z
- **Tasks:** 3/3
- **Files modified:** 8（2 created / 6 modified）

## Accomplishments

- **DO 内部路由（D-33/D-34 + RESEARCH Example 3）**：POST /kick-all（getWebSockets 遍历 close(1008, "channel key reset")，死连接容错计数）与 POST /purge（踢连 close(1008, "channel deleted") → deleteAll → deleteAlarm 成对——红线注释注明 Pitfall 1 僵尸 DO 语义；幂等：对已清 DO 重放 no-op）
- **Worker 路由与编排顺序定稿（key_links）**：POST reset-channel-key（keys.ts resetChannelKey 三键写先 → DO kick-all 转发后 → 201 {channelKey}；转发失败不阻断——尽力语义）；DELETE /channels/:id（DO /purge 转发先 → deleteChannelKeys 逐键删后 → 204；purge 失败 500 不落 KV 删除保重试安全）
- **keys.ts 写路径收敛**：resetChannelKey（ch:old 删 + ch:new 写 + id: 重写，sendKeys/name/createdAt 原样）、deleteChannelKeys（ch: → sk:* → id: 最后删）、readChannelRecord（参数化路由共用读点，经 normalize）
- **管理页交互（UI-SPEC 逐字契约）**：重置确认框三句正文 → 新密钥明文一次性展示卡（mono+复制，片段卡同款）+ 60s 双活提示条（#d9a300 边框式非填充）；删除确认框 GitHub 前缀联动（input.value.length > 0 && name.startsWith(input) 才启用，disabled 文字 #9a9a9a）→ 204 列表移除 + 详情空态；两操作 busy 态 + 错误条透传 + Esc/取消清引用 + 登出兜底
- **E2E 切片三 3 test 全绿**：双页踢连观察（pageB viewer dot-online 消失——Pitfall 5 红线遵守 → 新 Key 重连 online 恢复 + 历史含重置前 2 条）、旧 Key Upgrade 401、删除五要素；全套 18 test 零回归（admin 10 + viewer/reconnect/tracer 8）
- **TDD 纪律**：Task 1 RED（d38accb，6 个新测试 5 红——负路径用例被占位路由巧合满足同 03-02 基线）→ GREEN（3d82122，76/76 + typecheck 绿）

## Task Commits

Each task was committed atomically:

1. **Task 1: DO kick-all/purge + reset/delete 路由（TDD）** - `d38accb` (test, RED) + `3d82122` (feat, GREEN)
2. **Task 2: 管理页重置与删除交互** - `cdf75b2` (feat)
3. **Task 3: E2E 切片三** - `3a7cbc6` (test)

**Plan metadata:** 见本文件提交（docs commit）

## Files Created/Modified

- `packages/server/src/chat-room.ts` - fetch 路由 /kick-all 与 /purge 分支 + handleKickAll/handlePurge（deleteAll+deleteAlarm 成对红线注释）
- `packages/server/src/admin.ts` - handleResetChannelKey（KV 先 DO 后）与 handleDeleteChannel（DO 先 KV 后，purge 失败 500 保重试）；参数化骨架仅剩 messages 占位（03-04）
- `packages/server/src/keys.ts` - resetChannelKey/deleteChannelKeys/readChannelRecord（写路径三，键空间红线延续）
- `packages/server/test/admin-reset-kick.test.ts` - 新：3 用例（201 保留对照 / 踢连 close 1008+旧 Key 401+历史保留+Send Key 存活 / 404-401 边界）
- `packages/server/test/admin-delete.test.ts` - 新：3 用例（204+三前缀 miss+getAlarm null+messages 0 / 404-401 边界 / 幂等重放二次 404）
- `packages/server/public/admin.html` - reset-dialog/delete-dialog 骨架、.revoke-btn:disabled #9a9a9a、.dual-window-hint（#d9a300 边框式）、.danger-block 分隔
- `packages/server/public/admin.js` - 重置/删除交互（逐字文案 textContent 填充、前缀联动、一次性展示卡、登出兜底）
- `packages/web-sdk/e2e/admin.spec.ts` - 切片三 3 test + sendMessage/waitViewerOnline helper

## Decisions Made

- kick close code 1008 + 双 reason 值定稿（planner 裁定，见 frontmatter key-decisions 首条——CONTEXT Discretion 要求的决策表登记）
- deleteChannelKeys 删序 id: 最后落（frontmatter key-decisions 第二条——retry-safe 论证）
- DO purge 失败 → 500 不落 KV 删除 vs DO kick 失败不阻断 201——两条链失败策略按各自目标语义分化（凭据轮换已达成 vs 硬删除必须原子可重试）
- 逐字契约文案单一来源 admin.js（token 检查契约与 T-03-09 纪律两全）
- 驻留 DO deleteAll 后未重跑构造器：messages 表不存在以 0 行等价断言（try/catch 语义化，测试注释注明两态等价）

## Deviations from Plan

无 Rule 1-4 触发。两处计划文本解读偏差，均已按 key_links 意图落地：

**1. [Plan interpretation] deleteChannelKeys 内部删序**
- **计划原文：** 「顺序 await 逐键 KV delete ch:<旧 channelKey>、id:<channelId>、每个 sk:<Key>」（id: 第二个删）
- **落地：** ch: → sk:* → id:（id: 最后删）——与 createChannel 写序「id: 反向索引最后落」对称
- **理由：** key_links 断言「正序部分失败可重试」；若 id: 先删而某 sk: 删除失败，重试读 id: miss → 404，残留 sk: 键仍可发送（指向已清 DO，凭据永久有效）且无重试入口；id: 最后删则任何部分失败频道仍在列表，整链重试幂等
- **Committed in:** 3d82122

**2. [Plan interpretation] DO /purge 转发失败的处理**
- **计划原文：** 未明确规定 purge 转发失败时的行为（仅论证反序孤儿与正序可重试）
- **落地：** fetch 抛错或响应非 ok → 500 server_error 信封且不执行任何 KV 删除
- **理由：** key_links「正序部分失败时频道仍在列表，重试幂等」的严格执行——吞错继续删 KV 即制造其要避免的不可达孤儿 DO
- **Committed in:** 3d82122

---

**Total deviations:** 0 auto-fixed（2 处计划文本解读，无正确性缺口）

## Issues Encountered

None（验证链三轮全绿）。Task 1 GREEN 首轮 2 个测试侧修正（非实现缺陷）：
- 保留性断言的基线在追加第二个 Send Key 之后建立（原基线缺新 Key 导致 toEqual 必红）
- runInDurableObject 对 deleteAll 后驻留内存的 DO 直查 messages 抛 no such table——驻留实例未重跑构造器，表不存在语义即 0 行（try/catch 等价断言，两态注释注明）

RED 基线如实记录：6 个新测试中 1 个（404/401 负路径）在 RED 即绿——占位路由 404 巧合满足负路径契约（同 03-02 基线，负路径保持的旁证）。

## Authentication Gates

None — 全程本地 miniflare/wrangler dev（测试注入 ADMIN_KEY），无外部认证依赖。

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- 参数化路由骨架四分支全部落位，仅剩 messages 分支（03-04 直接填占位）；DO 内部路由表定型（/publish /ws /cleanup-rate /kick-all /purge）
- 双破坏性操作的全部编排注释与测试断言成为 03-05 dogfooding（用删除功能清理生产 10+ 冒烟频道）的安全网
- E2E 双页观察模式（context.newPage + viewer URL 参数）可供 04-reply-loop 回复流跨端断言复用
- 需求标记：KEY-02/KEY-04/ADM-01/ADM-02 与兄弟 plan 共享声明，由 orchestrator 在 wave 完成后统一处理（本 SUMMARY 落盘为其数据源）
- D-32/D-33 同款生产注记：重置/删除后 KV ≤60s 边缘缓存双活窗口为文档化语义（确认框与提示条文案已如实告知）

---
*Phase: 03-admin-keys*
*Completed: 2026-08-28*

## Self-Check: PASSED

All 2 created files + SUMMARY exist on disk; all 5 commits (d38accb, 3d82122, cdf75b2, 3a7cbc6, fb325f0) verified in git log; final verification chain green (server 76/76 + typecheck + web-sdk 86/86 + build + UI tokens + e2e 18/18).
