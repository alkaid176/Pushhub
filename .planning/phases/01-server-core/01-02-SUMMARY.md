---
phase: 01-server-core
plan: "02"
subsystem: protocol
tags: [protocol-freeze, wire-protocol, typescript, golden-fixtures, validators, shared-package, srk-contract-testing]

requires:
  - phase: 01-server-core/01
    provides: "monorepo 骨架 + @pushhub/shared 最小集（PROTOCOL_VERSION/Priority/MessageFrame）+ 生产部署与冒烟流水线"
provides:
  - 冻结的 v1 线协议完整 TS 类型集（MessageFrame D-03 全字段 + Sync/History/Pong/WsError/ClientFrame/ServerFrame/ErrorEnvelope/SendBody/SendResult/ErrorCode）
  - 协议常量（LIMITS D-02 上限表、RETENTION_KEEP/INITIAL_FETCH/SYNC_*/RATE_LIMIT_PER_MIN/WID_*）
  - 纯函数校验器 validateSendBody / validateInboundFrame（零运行时依赖，server 与未来 SDK 共用）
  - 12 个 golden JSON fixtures（正反例逐字节冻结，四端契约基线——Phase 5 Rust / Phase 6 Kotlin 直接读文件）
  - 协议演进规则 README（只加字段 / 未知字段忽略含 Rust serde 禁 deny_unknown_fields / 未知 v 即断连）
affects: [01-03 校验与限流, 01-04 sync 补拉, 01-05 Admin API, Phase 2 web-sdk, Phase 5 desktop, Phase 6 android]

actuals:
  tokens: 34747   # 138,989 diff chars / 4（estimate 34,000 的 102%）
  tasks: 3
  commits: 4      # 9b52ac0, 6ef00e6, 2acf2cd, + 本 SUMMARY docs commit

tech-stack:
  added: []   # 零新增依赖——纯类型与纯函数层（shared typescript 7.0.2 为 devDep 显式化，原 peerDep）
  patterns:
    - golden fixtures 静态 import 契约测试（workspace exports 子路径 ./fixtures/* + resolveJsonModule；排序键集 toEqual + 逐字段精确断言，零子集匹配）
    - 判别联合校验器返回（{ok:true,...}|{ok:false,status,code,message}——HTTP 语义直接携带）
    - 反例元数据约定（_violation 尾段即期望错误码，测试解析驱动断言——反例与校验器闭环）
    - _ 前缀键 = 非契约元数据（_note/_violation/_meta 不参与序列化，README 冻结该约定）
    - 阈值单一来源（validators 只引用 index.ts 常量，文件内零裸数字——上限变更只改一处四端同源）

key-files:
  created:
    - packages/shared/src/validators.ts
    - packages/shared/README.md
    - packages/shared/tsconfig.json
    - packages/shared/fixtures/（12 个 JSON）
    - packages/server/test/validators.test.ts
    - packages/server/test/fixtures-contract.test.ts
  modified:
    - packages/shared/src/index.ts（最小集 → 完整冻结版，01-01 导出全保留）
    - packages/shared/package.json（typecheck script + ./validators、./fixtures/* exports）
    - package.json（0.1.1）/ DEPLOY.md（部署记录）/ pnpm-lock.yaml

key-decisions:
  - "Task 1 用户裁决 freeze：v1 线协议按 CONTEXT D-01~D-07 原样冻结（one-way 门关闭——后续字段删除/语义变更须走 v:2 协议版本升级 + 四端联动）"
  - "chat-room.ts 帧发射升级不在本计划：01-03 Task 1 已显式覆盖（扇出帧与冻结 MessageFrame 形态一致）；server 包 typecheck 随之延后到 01-03（当前 chat-room 本地帧字面量缺 type/created_at 字段，接入冻结全量类型需先重接线）"
  - "fixtures 数量歧义消解：计划 action 枚举 11 个 JSON 但验收标准写 12——补 pong-frame.positive.json（auto-response 回帧基线，与'全部 WS 帧类型'truth 一致）"
  - "validateSendBody 接受字符串输入按原始 JSON 体解析（invalid_json 路径实体化；01-03 可直接传 request.text()）"
  - "可选字段 null 一律视为未提供（SRV-02 省略语义统一适用于 title/options/callback_url/click_url/priority）"
  - "TextDecoder 以模块级最小 ambient 声明接入（ESNext lib 不含该 Web 标准 API；不为契约包引入整个 DOM lib）"

patterns-established:
  - "Pattern: 反例 fixtures 的 _violation 尾段即期望拒绝 code（'reason -> code'），测试解析后断言——四端复用同一闭环"
  - "Pattern: fixtures 键集断言 = Object.keys().sort() toEqual 期望数组（全键冻结，防 fixture 自身漂移）"
  - "Pattern: options 出现即非空数组（省略语义双向冻结：发送侧空数组归一省略、帧侧永不出现空数组）"

requirements-completed: [SRV-07, SRV-02]  # SRV-02 与 01-03 共享——ready-ids 门只放行已就绪者

coverage:
  - id: D1
    description: "shared 冻结类型集 + 全部协议常量（PROTOCOL_VERSION/LIMITS/RETENTION_*/SYNC_*/RATE_LIMIT_PER_MIN/WID_*，MessageFrame D-03 全字段 + 全帧类型 + ErrorCode 八码）"
    requirement: SRV-07
    verification:
      - kind: unit
        ref: "packages/server/test/fixtures-contract.test.ts#message-frame positive 全字段断言（排序键集 toEqual 15 键 + 逐字段精确值）"
        status: pass
      - kind: other
        ref: "pnpm --filter @pushhub/shared typecheck（tsc 7.0.2 通过，含 fixtures JSON 语法校验）"
        status: pass
    human_judgment: false
  - id: D2
    description: "纯函数校验器：validateSendBody（D-02 全上限 413/D-04 枚举与结构 400/省略语义/D-07 未知字段忽略）+ validateInboundFrame（版本先行 invalid_version/帧结构 invalid_frame）"
    requirement: SRV-02
    verification:
      - kind: unit
        ref: "packages/server/test/validators.test.ts（16/16 绿：32768/32769、256/257、4×64/5项/65、2048/2049 边界对、省略语义、枚举、v:2、非 JSON）"
        status: pass
    human_judgment: false
  - id: D3
    description: "12 个 golden fixtures 逐字节契约基线 + 正反例闭环（8 message 反例驱动 validateSendBody、5 sync 反例驱动 validateInboundFrame、3 history 反例结构拒绝、4 错误信封逐 code）"
    requirement: SRV-07
    verification:
      - kind: unit
        ref: "packages/server/test/fixtures-contract.test.ts（13/13 绿；宽松子集匹配断言计数 0）"
        status: pass
    human_judgment: false
  - id: D4
    description: "协议演进规则 README 三条（只加字段 / 未知字段必须忽略含 Rust serde 禁 deny_unknown_fields / 未知 v 即断连）+ 帧清单 + 错误码 + 上限表 + fixtures 四端消费说明"
    requirement: SRV-07
    verification:
      - kind: other
        ref: "验收 grep：README 含'未知字段'与'deny_unknown_fields'与断连规则表述；shared 包无 KV 前缀定义、无 Workers 运行时依赖"
        status: pass
    human_judgment: false
  - id: D5
    description: "v0.1.1 生产部署冒烟（D-14）：纯类型变更回归确认生产路径未受损"
    requirement: SRV-07
    verification:
      - kind: e2e
        ref: "PH_SMOKE_URL=https://pushhub.snake160220.workers.dev node scripts/smoke.mjs → SMOKE OK（Version 4c416bed，延迟 1119ms < 2000ms 验收线）"
        status: pass
    human_judgment: false

duration: 20min
completed: 2026-08-26
status: complete
---

# Phase 1 Plan 2: v1 线协议冻结 Summary

**v1 线协议冻结为四端契约基线：shared 完整帧类型 + D-02/D-04 纯函数校验器 + 12 个 golden fixtures 逐字节契约测试（29 新测试全绿），v0.1.1 生产冒烟回归通过（延迟 1119ms）**

## Performance

- **Duration:** 20 min（墙钟，含 Task 1 冻结检查点用户交互等待）
- **Started:** 2026-08-26T06:33:28Z
- **Completed:** 2026-08-26T06:53:34Z
- **Tasks:** 3/3（Task 1 checkpoint:decision 用户裁决 freeze + Task 2 auto + Task 3 auto）
- **Files modified:** 27（22 任务文件 + lockfile 等附属）

## Accomplishments

- **协议 one-way 门关闭（Task 1 用户裁决 freeze）**：v1 线协议按 CONTEXT D-01~D-07 原样冻结——后续任何字段删除或语义变更须走 v:2 协议版本升级 + 四端联动改造，后续计划引用不再重议
- **四端契约基线就位**：任何一端（TS/Web/Rust/Kotlin）可仅凭 shared 包 + fixtures 实现协议，零口头约定——Rust/Kotlin 直接读仓库内 fixtures 文件断言
- **正反例闭环**：每个反例都驱动校验器返回冻结的错误码（`_violation` 元数据尾段即期望 code，同一闭环四端复用）；fixtures 契约测试零宽松子集断言
- **01-01 零回归**：ws-fanout 3/3 仍绿（既有导出 PROTOCOL_VERSION/Priority/MessageFrame 全保留）；v0.1.1 部署冒烟 SMOKE OK

## Task Commits

1. **Task 1: v1 协议冻结确认** — checkpoint:decision（blocking），用户裁决 freeze，无代码
2. **Task 2: shared 完整类型 + 常量 + validators + README** — `9b52ac0` (feat)
3. **Task 3: golden fixtures + 契约测试** — `6ef00e6` (test)
4. **计划级验证：v0.1.1 部署 + 冒烟记录** — `2acf2cd` (chore)

**Plan metadata:** 本 SUMMARY 所在 commit (docs)

## Files Created/Modified

- `packages/shared/src/index.ts` — 冻结版协议全集：常量（LIMITS/RETENTION_KEEP/INITIAL_FETCH/SYNC_LIMIT_DEFAULT/SYNC_LIMIT_MAX/RATE_LIMIT_PER_MIN/WID_PREFIX/WID_LENGTH）+ 类型（MessageFrame D-03 十五字段、Ping/Pong/Sync/History/WsError、ClientFrame/ServerFrame、ErrorEnvelope、SendBody/SendResult、ErrorCode 八码）
- `packages/shared/src/validators.ts` — validateSendBody（413/400 判别联合、UTF-16 长度口径、省略语义、枚举匹配、未知字段忽略）+ validateInboundFrame（版本先行、ping/sync 结构、since/limit 整数与范围检查）
- `packages/shared/README.md` — 演进规则三条、帧清单表、HTTP 侧六码 + WS 侧两码触发条件表、上限常量表、fixtures 四端消费方式、_ 前缀元数据约定
- `packages/shared/fixtures/` — 12 个 golden JSON（message/sync/history 正反对、四错误信封、ws-error 两例、pong 基线；history 正例含 50 条首拉截断例）
- `packages/shared/tsconfig.json` + package.json（typecheck script、./validators 与 ./fixtures/* exports）
- `packages/server/test/validators.test.ts`（16 用例）/ `packages/server/test/fixtures-contract.test.ts`（13 用例）
- `package.json`（0.1.1）/ `DEPLOY.md`（部署记录 0.1.1 行）

## Decisions Made

- **freeze（用户裁决，Task 1 blocking 检查点）**：按 D-01~D-07 原样冻结，无字段修订
- **chat-room.ts 帧发射升级延后至 01-03**：其计划 Task 1 已显式覆盖"扇出帧与冻结 MessageFrame 形态一致"；本计划按"纯类型变更"验证口径不触服务端运行时；server 包 typecheck 一并延后（本地帧字面量缺 type/created_at，需 01-03 重接线后方可过检）
- **pong-frame.positive.json 补为第 12 个 fixture**：消解计划 action（11 文件）与验收标准（12 JSON）的计数歧义
- **字符串输入 = 原始 JSON 请求体**：validateSendBody 的 invalid_json 路径实体化，01-03 可直接传 `await request.text()`
- **可选字段 null 统一视为未提供**：SRV-02 省略语义从 options 扩展适用于全部可选字段（README 冻结）
- **TextDecoder 模块级 ambient 声明**：Web 标准 API 不在 ESNext lib，以最小声明接入而非引入 DOM lib——保持契约包运行时无关

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] TextDecoder 类型缺失（TS2304）**
- **Found during:** Task 2（首次 `pnpm --filter @pushhub/shared typecheck`）
- **Issue:** tsconfig lib 仅 ESNext，不含 Web 标准 TextDecoder；引入 DOM lib 违背运行时无关契约包定位
- **Fix:** validators.ts 模块级最小 ambient 声明（`new (label?) => { decode }`）
- **Files modified:** packages/shared/src/validators.ts
- **Verification:** typecheck 通过；validators 16/16 绿
- **Committed in:** 9b52ac0

**2. [Rule 1 - Bug] JSON 数组帧被误判 invalid_version**
- **Found during:** Task 2（validators 单测首跑：`[]` 输入期望 invalid_frame 实得 invalid_version）
- **Issue:** 数组通过 `typeof === "object"` 检查但无 `v` 字段，落入版本分支——帧结构违例误分类为版本错误
- **Fix:** parsed 检查补 `Array.isArray` 拒绝
- **Files modified:** packages/shared/src/validators.ts
- **Verification:** 非 JSON/非对象帧用例全绿
- **Committed in:** 9b52ac0

**3. [Rule 3 - Blocking] 单测期望与设计语义不一致（字符串输入）**
- **Found during:** Task 2（同次首跑第二失败）
- **Issue:** 首版用例期望 `validateSendBody("text")` → invalid_body；设计语义为字符串按原始 JSON 体解析 → invalid_json
- **Fix:** 用例改为合法 JSON 但非对象（`'["text"]'`）驱动 invalid_body；非 JSON 字符串路径由 invalid_json 专测覆盖
- **Files modified:** packages/server/test/validators.test.ts
- **Verification:** 16/16 绿
- **Committed in:** 9b52ac0

**4. [计划歧义消解] fixtures 计数 11 vs 12**
- **Found during:** Task 3（action 枚举 11 个 JSON 文件，验收标准要求 12 个）
- **Fix:** 补 pong-frame.positive.json（pong 属"全部 WS 帧类型"，且 auto-response 回帧字面量需要冻结基线）
- **Files modified:** packages/shared/fixtures/pong-frame.positive.json
- **Verification:** 12 个 JSON 全部存在且可解析；契约测试含 pong 键集断言
- **Committed in:** 6ef00e6

---

**Total deviations:** 3 auto-fixed（1 missing critical/blocking、1 bug、1 test-expectation）+ 1 计划内歧义消解
**Impact on plan:** 全部为必要修复，无范围蔓延；无 stub、无跳过的测试、无未运行的验证步骤。

## Issues Encountered

- **workers.dev 本轮冒烟一次通过**（无 UND_ERR_CONNECT_TIMEOUT 重试）；延迟 1119ms 高于 0.1.0 轮的 285ms，属本机至 workers.dev 网络波动，仍低于 2000ms 验收线——已记入 DEPLOY.md 部署记录。

## User Setup Required

None - no external service configuration required.（wrangler 登录态与 ADMIN_KEY 沿用 01-01。）

## Next Phase Readiness

- **就绪**：01-03（校验与限流）可直接接线——Worker 入口 import `validateSendBody` 传 `await request.text()`；错误信封文案与 fixtures 逐字一致（invalid_key / payload_too_large / invalid_body 已冻结）；send-validation 测试逐条驱动 message-frame.negative.json（8 反例期望值现成）
- **就绪**：01-04（sync 补拉）可用 `validateInboundFrame`（返回解析后的 ClientFrame）；HistoryFrame 类型与 history fixtures 语义样例（oldest_kept_seq/has_more 翻页）已冻结
- **注意点**：① chat-room.ts 当前发射的最小 message 帧缺 `type:"message"` 与 `created_at` 及可选三字段——01-03 Task 1 重接线时按冻结 MessageFrame 补齐（届时删本地 MessageFrameFull 改用 shared 全量类型）；② server 包尚无 tsconfig/typecheck（同上延后）；③ fixtures 自本计划起逐字节冻结——任何字节变化都是协议事件（git diff 6ef00e6 -- packages/shared/fixtures/ 为空即基线未动）
- **Flagged Assumption 待 01-04 落实**：服务端对 v 不匹配入站帧回 WsErrorFrame（invalid_version）并忽略、不断连——validators 已按此返回错误码

## Self-Check: PASSED

- 关键文件存在性：index.ts、validators.ts、README.md、tsconfig.json、validators.test.ts、fixtures-contract.test.ts 全部 FOUND；fixtures 12 个 JSON 全部可解析
- 提交存在性：9b52ac0、6ef00e6、2acf2cd 均在 git log
- fixtures 字节冻结性：`git diff 6ef00e6 2acf2cd -- packages/shared/fixtures/` 为空（基线自冻结提交未动）
- 验收复跑：`pnpm --filter @pushhub/server test` 32/32 绿（ws-fanout 3 + validators 16 + fixtures-contract 13）；`pnpm --filter @pushhub/shared typecheck` 通过；生产冒烟 SMOKE OK（1119ms）

---
*Phase: 01-server-core*
*Completed: 2026-08-26*
