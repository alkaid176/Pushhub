---
phase: 03-admin-keys
plan: 02
subsystem: admin-ui
tags: [cloudflare-workers, kv-schema, durable-objects, vanilla-js, native-dialog, playwright-e2e, tdd]

# Dependency graph
requires:
  - phase: 03-admin-keys(Plan 01)
    provides: sendKeys[]/label KV schema + normalizeIdRecord 兼容层、buildKeyRow/snippetBlock/handleApiFailure 组件、admin.html/admin.js 骨架、E2E 锚点体系
provides:
  - send-keys CRUD API（POST 201 {key,label,createdAt} / DELETE 204）+ send_key_limit 错误码（admin 域字符串）
  - admin.ts CHANNEL_ID_RE 参数化路由骨架（reset-channel-key/messages/DELETE 频道占位 404——后续 plan 只填分支不改结构）
  - keys.ts createSendKeyRecord/revokeSendKeyRecord 写路径（键空间红线延续）
  - DO POST /cleanup-rate 内部路由（rate_sends 行即时清理，后续重置/删除可复用转发模式）
  - 管理页 Send Key 管理区（创建表单/上限态/吊销 dialog/新 Key 片段卡）与 buildEyeButton/buildCurlText 可复用组件
affects: [03-admin-keys(Plan 03-05), 04-reply-loop(admin 页复用 dialog/行组件)]

# Actuals (#2632) — same chars/4 scale as the plan estimate.
actuals:
  tokens: 15748   # 62992 diff chars / 4 over 65b02e3..cf844b5 (7 files, +1238/-70)
  tasks: 3
  commits: 4

tech-stack:
  added: []   # 零新依赖（原生 <dialog> 替代任何确认框库——UI-SPEC Interaction #3）
  patterns:
    - 参数化路由骨架（精确匹配优先 + CHANNELS_PATH_RE 捕获 + channelId 白名单 + sub 资源白名单，全部置于 checkAdminAuth 之后）
    - 写路径判别联合结果（{ok:true,record}|{ok:false,reason:not_found|limit}——上游路由判定与下游 KV 时序红线同一函数内收口）
    - 三存储联动吊销（KV sk:/id: + DO /cleanup-rate 转发；DO 失败不阻断主路径——幂等键名 + alarm 兜底）

key-files:
  created:
    - packages/server/test/admin-send-keys.test.ts
  modified:
    - packages/server/src/admin.ts
    - packages/server/src/keys.ts
    - packages/server/src/chat-room.ts
    - packages/server/public/admin.js
    - packages/server/public/admin.html
    - packages/web-sdk/e2e/admin.spec.ts

key-decisions:
  - "上限检查收口进 createSendKeyRecord（判别联合结果）：计划原文 admin.ts 读 id: 计数与 keys.ts 写路径读 id: 是两次读——合并为写路径内单次读 + 写前判定，D-31 key_link「判定必须在 KV 写之前」由函数结构保证而非调用方纪律"
  - "revokeSendKeyRecord 的 id: 读点缺席防御兜底：sk: 已删（凭据已失效）即返回，id: 只影响列表完整性——吊销语义以 sk: 为准"
  - "DO /cleanup-rate 转发失败不阻断 204：rate_sends 残留行无害（phs_ 键名永不复用拒绝采样保证 + 每日 alarm 自然清扫兜底）——主路径可靠性优先于清理完整性"
  - "E2E 上限用例拆分修正：计划「API 直建 8 + UI 建 2」加初始 Key 共 11 超上限——按 1 初始 + API 7 + UI 2 = 10 落地（算术自洽解读，双层断言不变）"
  - "TDD RED 基线如实记录：9 个新测试中 3 个（404 防探测/无鉴权 401 负路径）在 RED 即绿——catch-all 路由巧合满足负路径契约；6 个新正路径行为全部 RED 红、GREEN 绿"

patterns-established:
  - "Pattern: 参数化资源路由 = 精确匹配优先 + CHANNEL_ID_RE 白名单 + sub 资源白名单正则 + 未知分支占位 404——Plan 03-05 填分支零结构改动"
  - "Pattern: Worker→DO 清理转发 = new Request(INTERNAL_ORIGIN+path, {X-PH-Verified, X-PH-Send-Key}) + try/catch 不阻断主响应——重置 kick/删除 purge 同款"
  - "Pattern: 原生 <dialog> 确认框 = 静态 HTML 骨架 + textContent 填充逐字契约文案 + cancel 事件清引用——D-33/D-34 确认框直接复用"
  - "Pattern: buildEyeButton(valueEl, key) 揭示组件与 buildKeyRow 解耦——Send Key 六要素行按 UI-SPEC 顺序组装不复用整行"

requirements-completed: [KEY-03, ADM-02]

coverage:
  - id: D1
    description: "D-30 建 Send Key：201 {key,label,createdAt}、label 缺省/null/类型/长度四态、列表含新 Key"
    requirement: KEY-03
    verification:
      - kind: unit
        ref: "packages/server/test/admin-send-keys.test.ts#POST send-keys 创建三用例（201 三字段 + 空/缺省 label + 400 invalid_body/invalid_json）"
        status: pass
      - kind: e2e
        ref: "packages/web-sdk/e2e/admin.spec.ts#D-30 建带标签 Key：sendkey-row 标签+掩码、片段卡 curl 含完整 Key（API 对照）、眼睛揭示、复制反馈"
        status: pass
  - id: D2
    description: "D-31 上限 10 双层防线：API 400 send_key_limit（判定在 KV 写前——列表仍恰 10 个）+ UI disabled + 相邻提示"
    requirement: KEY-03
    verification:
      - kind: unit
        ref: "packages/server/test/admin-send-keys.test.ts#第 11 个 POST -> 400 send_key_limit 且无第 11 个 Key 落盘"
        status: pass
      - kind: e2e
        ref: "packages/web-sdk/e2e/admin.spec.ts#D-31 上限态：至 10 个按钮 disabled + 提示可见；第 11 个 API 直建 400 body.error.code===send_key_limit"
        status: pass
  - id: D3
    description: "D-32 吊销三存储联动：204 空体、被吊销 Key 立即 401（本地强一致注释注明生产 ≤60s 窗口）、同频道其余 Key 200（泄露不互伤）、KV sk: 删除 + id: 移除 + rate_sends 仅该行即时删除"
    requirement: KEY-03
    verification:
      - kind: unit
        ref: "packages/server/test/admin-send-keys.test.ts#吊销两用例（主链路 + 三存储联动 runInDurableObject 直读 rate_sends）"
        status: pass
      - kind: e2e
        ref: "packages/web-sdk/e2e/admin.spec.ts#D-32 吊销链路：确认框逐字文案（含「最长约 1 分钟」）→ 行消失 → 401/200 双断言"
        status: pass
  - id: D4
    description: "T-03-07 防探测：channelId 15 字符与不存在同 404 同信封同文案；DELETE 他频道 Key/不存在 Key/不存在 channelId -> 404；两路由无鉴权 -> 401"
    requirement: KEY-03
    verification:
      - kind: unit
        ref: "packages/server/test/admin-send-keys.test.ts#404 防探测两用例 + 鉴权先于路由判定用例"
        status: pass
  - id: D5
    description: "UI-SPEC 逐字契约：空态文案、上限提示「已达上限（10 个）」、吊销确认框标题/正文、未命名 graytext"
    requirement: ADM-02
    verification:
      - kind: e2e
        ref: "packages/web-sdk/e2e/admin.spec.ts#D-31/D-32 断言上限提示与确认框正文含「最长约 1 分钟」「此操作不可撤销」；标题含掩码"
        status: pass
      - kind: other
        ref: "构建绿 + UI token 检查（sendkey-row/已达上限/未命名 三 token 在位）"
        status: pass

# Metrics
duration: 13min
completed: 2026-08-28
status: complete
---

# Phase 03 Plan 02: Send Key 全生命周期 Summary

**服务端 send-keys CRUD（参数化路由 + 上限 10 + 吊销三存储联动 KV/DO）+ 管理页 Send Key 管理区（创建/上限态/原生 dialog 吊销/片段卡）+ E2E 切片二——KEY-03「不同脚本各用各的 Key，泄露不互伤」端到端成立**

## Performance

- **Duration:** 13 min
- **Started:** 2026-08-27T16:18:41Z
- **Completed:** 2026-08-27T16:31:58Z
- **Tasks:** 3/3
- **Files modified:** 7（1 created / 6 modified）

## Accomplishments

- **服务端路由（D-35/D-30/D-31/D-32）**：admin.ts 参数化路由骨架一次定型（CHANNEL_ID_RE 白名单 + sub 资源白名单 + 占位 404）；POST send-keys（label 三段式校验、201 {key,label,createdAt} 密钥唯一完整返回点、400 send_key_limit）；DELETE send-keys/:key（sk: 归属预检 → KV 两环 → DO /cleanup-rate 转发 → 204）
- **写路径收敛（键空间红线）**：keys.ts createSendKeyRecord（单次读 + 写前上限判定 + 2 KV 写）/revokeSendKeyRecord（sk: 幂等删 + id: 重写移除）；SEND_KEY_LIMIT 单一来源导出
- **DO 即时清理**：chat-room.ts POST /cleanup-rate（X-PH-Verified 之后结构继承 + X-PH-Send-Key 契约违例 401 + ?1 绑定参数 DELETE）
- **管理页管理区（D-30~D-32 + UI-SPEC 逐字契约）**：创建表单（maxlength 64、空输入省略 label）→ 201 刷新 + 仅第 1 块片段卡；六要素 sendkey-row（未命名 graytext）；上限态 disabled + 提示；原生 dialog 吊销确认（逐字文案、cancel 清引用）；400 send_key_limit 错误条透传（竞态双保险）
- **E2E 切片二 3 test 全绿**：带标签建 Key（API 对照完整 Key + 揭示 + 复制）、吊销链路（两 Key 先证可用 → 确认框 → 行消失 → 401/200 双断言）、上限态（UI disabled + API 400 双层）；全套 15 test 零回归
- **TDD 纪律**：Task 1 RED（328e5ad，6 个新正路径行为红）→ GREEN（682cba1，70/70 绿）

## Task Commits

Each task was committed atomically:

1. **Task 1: 服务端 send-keys 路由 + DO /cleanup-rate（TDD）** - `328e5ad` (test, RED) + `682cba1` (feat, GREEN)
2. **Task 2: 管理页 Send Key 管理区** - `d771444` (feat)
3. **Task 3: E2E 切片二** - `cf844b5` (test)

**Plan metadata:** 见本文件提交（docs commit）

## Files Created/Modified

- `packages/server/src/admin.ts` - CHANNEL_ID_RE/CHANNELS_PATH_RE 参数化路由骨架、handleCreateSendKey/handleRevokeSendKey、DO 转发常量
- `packages/server/src/keys.ts` - SEND_KEY_LIMIT/CreateSendKeyResult/readIdRecord/createSendKeyRecord/revokeSendKeyRecord
- `packages/server/src/chat-room.ts` - fetch 路由 /cleanup-rate 分支 + handleCleanupRate
- `packages/server/test/admin-send-keys.test.ts` - 新：9 用例（创建三态/上限/吊销两用例/404 防探测/鉴权）
- `packages/server/public/admin.html` - Send Key 管理区样式（表单/上限/吊销红/dialog）+ revoke-dialog 原生确认框骨架
- `packages/server/public/admin.js` - buildSendKeysBlock/createSendKey/openRevokeDialog/buildSendKeySnippetCard/buildEyeButton/buildCurlText 提取、refreshChannels/fetchJsonPair helper
- `packages/web-sdk/e2e/admin.spec.ts` - 切片二 3 test + createSendKeyApi/selectChannel/maskKey helper

## Decisions Made

- 上限判定收口进 createSendKeyRecord 判别联合（见 frontmatter key-decisions 首条）——比计划原文少一次 KV 读且时序红线由结构保证
- 吊销链 DO 转发失败吞异常：键名永不复用 + 每日 alarm 清扫兜底（D-32 planner 即时清理裁定的可靠性边界）
- eye 按钮/复制按钮从 buildKeyRow 拆出为独立组件：Send Key 六要素行按 UI-SPEC 元素顺序 [标签][掩码][日期][眼睛][复制][吊销] 组装，Channel Key 行形态不变
- 标签色分义：有标签 canvastext、无标签「未命名」graytext（.sendkey-label.unnamed）——03-01 全 graytext 改为仅未命名 graytext，对齐 must_haves 文案

## Deviations from Plan

无 Rule 1-4 触发（三轮验证链全部一次通过）。两处计划文本解读偏差，均已按意图落地：

**1. [Plan interpretation] createSendKeyRecord 上限判定位置**
- **计划原文：** admin.ts 读 id: 计 sendKeys.length >= 10 判 400（b 段）与 keys.ts createSendKeyRecord 再读 id: 写入（d 段）——两次 KV 读
- **落地：** 判别联合结果 {ok:true,record}|{ok:false,reason:"not_found"|"limit"} 单次读收口在写路径内；admin.ts 按 reason 出 404/400 信封
- **理由：** key_links「上限检查必须在 KV 写之前」由函数结构保证（调用方无法先写后判）；省一次 id: 读额度
- **Committed in:** 682cba1

**2. [Plan interpretation] E2E 上限用例的建 Key 配比**
- **计划原文：** 「request API 直建 8 个 + UI 建 2 个」——加初始 Key 共 11，超出 10 上限，与「循环创建至 10 个」自相矛盾
- **落地：** 1 初始 + API 7 + UI 2 = 10（两条 UI 路径——带标签/空输入——都走到）；双层断言（UI disabled + API 400 send_key_limit）与计划一致
- **Committed in:** cf844b5

---

**Total deviations:** 0 auto-fixed（2 处计划文本解读，无正确性缺口）

## Issues Encountered

None — 三任务全部一次通过验证链。Task 1 RED 基线：9 个新测试 6 红 3 绿（3 个负路径用例被既有 catch-all 路由巧合满足——负路径契约保持的旁证，非测试缺陷）。

## Authentication Gates

None — 全程本地 miniflare/wrangler dev（测试注入 ADMIN_KEY），无外部认证依赖。

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- 参数化路由骨架就位：Plan 03（reset-channel-key + kick-all）/ Plan 04（messages）/ Plan 05（DELETE 频道）只填占位分支，零结构改动；channelId 白名单与 404 防探测策略直接继承
- Worker→DO 清理转发模式（X-PH-Verified + try/catch 不阻断）可被重置（kick-all）与删除（purge）复用；DO 内部路由挂载点已在 fetch 表定型
- 原生 dialog 确认框骨架 + cancel 清引用模式：D-33/D-34 确认框（重置/删除）直接复用；「未命名」graytext 与六要素行组件供 04-reply-loop 沿用
- 需求标记：KEY-03/ADM-02 与兄弟 plan 的 shared-ID gate 由 orchestrator 在 wave 完成后统一处理（本 SUMMARY 落盘为其数据源）
- D-32 生产实证注记：生产 KV cacheTtl 60 → 吊销后 ≤60s 双活窗口为文档化语义（UI 确认框文案已如实告知用户），非缺陷

## Self-Check: PASSED

1 created file exists on disk (packages/server/test/admin-send-keys.test.ts); all 4 task commits (328e5ad, 682cba1, d771444, cf844b5) verified in git log; final verification rerun green (server 70/70 + typecheck + UI tokens + e2e 15/15).
