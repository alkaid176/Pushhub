---
phase: 01-server-core
plan: "03"
subsystem: api
tags: [cloudflare-workers, input-validation, rate-limiting, fixed-window, durable-objects, sqlite, srk-contract-testing, error-envelope]

requires:
  - phase: 01-server-core/01
    provides: "Worker 入口路由 + ChatRoom DO（publish/扇出/seq 分配）+ KV 预检 + 测试/部署流水线"
  - phase: 01-server-core/02
    provides: "冻结的 validateSendBody/validateInboundFrame + LIMITS/RATE_LIMIT_PER_MIN 常量 + golden fixtures（反例矩阵与错误信封文案的唯一依据）"
provides:
  - POST /api/send 完整校验链（400 invalid_json / 413 payload_too_large / 400 invalid_body / 401 invalid_key 全错误矩阵，D-06 信封与 fixtures 逐字节同构）
  - SRV-02 字段全量透传：options/callback_url/click_url/title/priority 全字段落库 + 随冻结 MessageFrame 形态扇出（省略语义，哑管道逐字节可断言）
  - KEY-05 限流：ChatRoom DO 内 rate_sends 表固定窗口 30/min（Pattern 5 三分支），429 + Retry-After 头透传，分键隔离，被拒消息不消耗 seq
  - shared RATE_WINDOW_MS 常量（窗口长度/阈值双双单一来源）
  - server 包 typecheck 基线（tsconfig + 全量运行时类型 worker-configuration.d.ts，补齐 01-02 遗留）
  - 冒烟脚本 413 超限反例步（D-15 契约随冒烟同步扩展）
affects: [01-04 sync 补拉, 01-05 Admin API, Phase 2 web-sdk, Phase 4 回调送达, Phase 5 desktop, Phase 6 android]

actuals:
  tokens: 10979   # 手写代码 diff 43,916 chars/4（estimate 30,000 的 37%）；含再生的 15k 行 worker-configuration.d.ts 全量 diff 为 160,406 tokens——生成物按估算器不可见噪声剔除并如实注明
  tasks: 2
  commits: 4      # d0231a2, a105688, 4c9b971, 410da2f（+ 本 SUMMARY docs commit）

tech-stack:
  added: []   # 零新增依赖
  patterns:
    - Worker 入口即拒：validateSendBody(await request.text()) 在 KV 预检后、DO 转发前——非法载荷不唤醒 DO（T-01-05）
    - DO 纵深防御复用同一冻结校验器：Worker 与 DO 拒绝信封逐字节一致（D-06 单一来源）
    - 内部头 X-PH-Send-Key：Worker→DO 可信通道携带限流分键原值，不外泄响应
    - 限流检查先于 seq 分配：被拒消息不消耗 seq、不写 messages（seq 连续无空洞可断言）
    - Retry-After = 窗口剩余毫秒向上取整（窗口内恒 >= 1）
    - runInDurableObject 经 cloudflare:test 导入（env/exports 在 cloudflare:workers——插件将运行时绑定与测试工具分离，实证记录供 01-04 复用）

key-files:
  created:
    - packages/server/test/send-basic.test.ts
    - packages/server/test/send-validation.test.ts
    - packages/server/test/send-payload-fields.test.ts
    - packages/server/test/rate-limit.test.ts
    - packages/server/tsconfig.json
  modified:
    - packages/server/src/index.ts（校验链接入 + 归一化转发 + X-PH-Send-Key）
    - packages/server/src/chat-room.ts（校验器复用 + 冻结 MessageFrame 扇出 + rate_sends 限流）
    - packages/shared/src/index.ts（+RATE_WINDOW_MS）
    - packages/shared/README.md（常量表补窗口行）
    - packages/server/worker-configuration.d.ts（再生为全量运行时类型）
    - packages/server/package.json（typecheck 脚本；cf-typegen 改全量）
    - scripts/smoke.mjs（413 超限步）
    - package.json（0.1.2 + deploy 脚本修复）/ DEPLOY.md（部署记录）

key-decisions:
  - "限流实现裁决（reversible 裁量项）：RESEARCH Pattern 5 固定 60s 窗口逐字落地；边界瞬时 2× 突发按 Flagged Assumption 文档化接受（如需平滑仅调 shared 常量不动表结构）"
  - "RATE_WINDOW_MS=60_000 上提 shared：计划要求窗口长度与阈值均单一来源——常量为纯新增，fixtures 未动（非协议事件）"
  - "worker-configuration.d.ts 再生为全量运行时类型（--include-runtime=false → 默认）：兑现 CLAUDE.md 'wrangler types 取代 workers-types 手装' 路线，WebSocketRequestResponsePair/DurableObject/Request 全部就位，typecheck 零手写 ambient"
  - "DO publish 缺 X-PH-Send-Key 时 401 invalid_key（内部契约违例防御——真实 Worker 恒带该头）"
  - "生产 429 验证取低打扰口径：本地真实 workerd 测试覆盖 31 连发，生产冒烟仅验 200/401/413 三态（计划 verification 3 明示允许）"

patterns-established:
  - "Pattern: 错误信封断言 = 顶层键集 toEqual ['error'] + error 键集 toEqual ['code','message'] + 与 fixture .error 逐字节 toEqual（三层严格）"
  - "Pattern: 反例矩阵测试逐条驱动冻结 fixtures 经 HTTP 入口（_violation 尾段即期望 code/status）——不自行发明用例"
  - "Pattern: 帧形态断言 = Object.keys().sort() toEqual 冻结全集/省略子集（options 永不为空数组、省略字段键不出现）"
  - "Pattern: 窗口滚动测试用 runInDurableObject 直接回拨表内 window_start（免真实等待 60s）"

requirements-completed: [SRV-01, SRV-02, KEY-05]

coverage:
  - id: D1
    description: "/api/send 校验链接入：fixtures 全部 8 反例经 HTTP 入口驱动按冻结 status/code 拒绝（413/400），非 JSON → 400 invalid_json，信封结构严格且文案与 fixtures 逐字节一致（含 401 基线与 SendResult 精确 {id,seq}）"
    requirement: SRV-01
    verification:
      - kind: integration
        ref: "packages/server/test/send-validation.test.ts（4/4：反例矩阵全驱动 + invalid_json + 非对象 + 413 文案逐字节）"
        status: pass
      - kind: integration
        ref: "packages/server/test/send-basic.test.ts（3/3：{id,seq} 精确键集 + seq 单调 + 401 信封逐字一致 + 缺 Authorization）"
        status: pass
    human_judgment: false
  - id: D2
    description: "SRV-02 字段全量透传：options/callback_url/click_url/title/priority 落库并随冻结 MessageFrame 形态扇出——含 Markdown+尖括号 text 逐字节哑管道断言、全字段帧 15 键集精确、省略/空数组归一为键不出现"
    requirement: SRV-02
    verification:
      - kind: integration
        ref: "packages/server/test/send-payload-fields.test.ts（2/2：全字段逐字段相等 + 键集冻结 + 省略语义）"
        status: pass
    human_judgment: false
  - id: D3
    description: "KEY-05 固定窗口限流：同一 Send Key 第 31 条 → 429 rate_limited（信封与 fixture 逐字节一致）+ Retry-After 正整数头；分键隔离；被拒消息不消耗 seq（后续 seq 连续）；window_start 回拨 61s 后恢复 200"
    requirement: KEY-05
    verification:
      - kind: integration
        ref: "packages/server/test/rate-limit.test.ts（3/3：31 连发边界 + 隔离与 seq 连续 + 窗口滚动表操作）"
        status: pass
    human_judgment: false
  - id: D4
    description: "v0.1.2 生产部署 + 冒烟（D-14）：全量套件 44/44 绿后部署 Worker Version a937b5b4，SMOKE OK（延迟 277ms），冒烟新增超限反例步 32769 字符 text → 413 payload_too_large 边缘即拒"
    requirement: SRV-01
    verification:
      - kind: e2e
        ref: "PH_SMOKE_URL=https://pushhub.snake160220.workers.dev node scripts/smoke.mjs → SMOKE OK, LATENCY: 277ms（kv-seed/send-1/ws-open/ws-receive/invalid-key/oversized 六步全绿）"
        status: pass
    human_judgment: false
  - id: D5
    description: "server 包 typecheck 基线（补齐 01-02 遗留）：tsconfig + 全量运行时类型再生 + typecheck 脚本——src 全量 tsc 通过且既有套件零回归"
    requirement: SRV-01
    verification:
      - kind: other
        ref: "pnpm --filter @pushhub/server typecheck（tsc 7.0.2 通过）；pnpm --filter @pushhub/server test 44/44"
        status: pass
    human_judgment: false

duration: 21min
completed: 2026-08-26
status: complete
---

# Phase 1 Plan 3: 发送侧完整化 Summary

**/api/send 从"能发"到"契约完备"：冻结校验器接入入口（413/400/401 全矩阵 + D-06 信封逐字节同构）、SRV-02 字段经冻结 MessageFrame 全量透传、ChatRoom DO 内 rate_sends 固定窗口限流（429 + Retry-After）——13 个新测试全绿，v0.1.2 生产冒烟 SMOKE OK（277ms）**

## Performance

- **Duration:** 21 min
- **Started:** 2026-08-26T06:59:12Z
- **Completed:** 2026-08-26T07:20:22Z
- **Tasks:** 2/2（Task 1 auto + Task 2 auto）
- **Files modified:** 14（5 created + 9 modified）

## Accomplishments

- **发送方错误契约程序化可依赖**：任何非法输入得到可预期 status + code——fixtures 全部 8 反例经真实 HTTP 入口驱动拒绝，非 JSON 请求体 400 invalid_json，超限载荷在 Worker 边缘即拒不唤醒 DO（T-01-05），错误信封三层严格断言（结构/键集/文案与 fixtures 逐字节一致）
- **哑管道端到端可证明**：options/callback_url/click_url/title/priority 全字段落库（13 列 INSERT）并随冻结 MessageFrame 形态扇出；含 `<script>` 标签与 Markdown 语法的 text 逐字节透传断言；省略语义冻结（空数组归一、键不出现、永不为空数组）；服务端零 fetch 消费发送方 URL（SRV-02 两条 Prohibition 复核）
- **滥用防线就位（KEY-05）**：ChatRoom DO 内 rate_sends 表固定窗口 30/min（Pattern 5 三分支：重置/拒绝/自增），第 31 条 429 + Retry-After 头透传；分键隔离；被拒消息不消耗 seq（seq 连续无空洞断言）；窗口滚动经 runInDurableObject 表回拨验证（免真实等待）
- **补齐 01-02 遗留的 typecheck 基线**：server 包 tsconfig + 全量运行时类型再生（WebSocketRequestResponsePair/DurableObject 全就位）+ typecheck 脚本；顺带修复 root deploy 脚本在 pnpm 10 下的保留命令冲突

## Task Commits

1. **Task 1: /api/send 校验链接入 + SRV-02 字段全量透传** — `d0231a2` (feat)
2. **Task 2: KEY-05 限流——ChatRoom DO 内固定窗口计数表** — `a105688` (feat)
3. **计划级验证：v0.1.2 部署 + 冒烟记录** — `4c9b971` (chore)
4. **deploy 脚本 pnpm 10 修复** — `410da2f` (fix)

**Plan metadata:** 本 SUMMARY 所在 commit (docs)

## Files Created/Modified

- `packages/server/src/index.ts` — handleSend 校验链：validateSendBody(await request.text()) 入口即拒（413/400 信封）→ 归一化载荷 + X-PH-Send-Key 内部头转发 DO
- `packages/server/src/chat-room.ts` — DO 复用冻结校验器（纵深防御）；扇出帧重接线为冻结 MessageFrame（type/created_at/可选三字段 + 省略语义）；rate_sends DDL + checkRateLimit 三分支（先于 seq 分配）；wid 常量改引 shared
- `packages/server/test/send-basic.test.ts` — SRV-01 基线：SendResult 精确键集、seq 单调、401 信封逐字一致、缺 Authorization
- `packages/server/test/send-validation.test.ts` — fixtures 8 反例全驱动 + invalid_json + 非对象 JSON + 413 文案逐字节
- `packages/server/test/send-payload-fields.test.ts` — 全字段逐字段透传 + 15 键集冻结 + text 逐字节哑管道 + 省略/空数组归一
- `packages/server/test/rate-limit.test.ts` — 31 连发边界 + Retry-After 头 + 分键隔离 + seq 连续 + 窗口滚动
- `packages/shared/src/index.ts` — +RATE_WINDOW_MS = 60_000（窗口/阈值单一来源）
- `packages/shared/README.md` — 常量表补 RATE_WINDOW_MS 行
- `packages/server/tsconfig.json` + `package.json`（typecheck 脚本、cf-typegen 全量化）
- `packages/server/worker-configuration.d.ts` — 再生为全量运行时类型（15k 行）
- `scripts/smoke.mjs` — 超限反例步（32769 字符 → 413）
- `package.json`（0.1.2 + deploy 脚本修复）/ `DEPLOY.md`（0.1.2 部署记录）

## Decisions Made

- **限流实现按 RESEARCH Pattern 5 逐字落地**（reversible 裁量项）：固定 60s 窗口 / 30 条；边界瞬时 2× 突发按 Flagged Assumption 文档化接受，平滑化只需调 shared 常量不动表结构
- **RATE_WINDOW_MS 上提 shared**：计划要求窗口长度与阈值均引用 shared 常量——纯常量新增，fixtures 未动（不构成协议事件）
- **worker-configuration.d.ts 转为全量运行时类型**：兑现 CLAUDE.md 官方类型路线（wrangler types 取代 workers-types 手装），typecheck 零手写 ambient 声明
- **生产 429 验证取低打扰口径**（计划 verification 3 明示允许）：本地真实 workerd 覆盖 31 连发全行为，生产仅验 200/401/413 三态
- **Retry-After 取窗口剩余毫秒向上取整**（Flagged Assumption 口径）：窗口内恒 >= 1，规避 Pattern 5 草式在 59.5s 处算出 0 的边界缺陷

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] message 帧构造的 created_at 简写引用了不存在的变量**
- **Found during:** Task 1（新测试首跑：ReferenceError: created_at is not defined）
- **Issue:** 帧对象简写属性 `created_at,` 按标识符解析，而局部变量名为 camelCase `createdAt`
- **Fix:** 改为显式 `created_at: createdAt`
- **Files modified:** packages/server/src/chat-room.ts
- **Verification:** 新 3 测试文件与全量套件转绿
- **Committed in:** d0231a2（Task 1 commit 内）

**2. [Rule 3 - Blocking] server 包 typecheck 缺失（01-02 遗留，本计划接线时兑现）**
- **Found during:** Task 1（按 env 指示补齐）
- **Issue:** server 无 tsconfig/typecheck；且旧 worker-configuration.d.ts（--include-runtime=false）不含 KVNamespace/DurableObject/WebSocketRequestResponsePair 等运行时类型，src 无法通过 tsc
- **Fix:** 再生全量运行时类型 + 新增 tsconfig（include src + 生成文件）+ typecheck 脚本；cf-typegen 同步改默认全量
- **Files modified:** packages/server/{tsconfig.json, package.json, worker-configuration.d.ts}
- **Verification:** pnpm --filter @pushhub/server typecheck 通过；全量套件零回归
- **Committed in:** d0231a2

**3. [Rule 3 - Blocking] root deploy 脚本在 pnpm 10 下失效**
- **Found during:** 计划级验证（v0.1.2 部署步骤）
- **Issue:** `pnpm --filter <pkg> deploy` 触发 pnpm 自身保留命令（ERR_PNPM_INVALID_DEPLOY_TARGET）
- **Fix:** root 脚本改为 `pnpm --filter @pushhub/server run deploy`（经包脚本路由），--dry-run 验证
- **Files modified:** package.json
- **Verification:** dry-run 输出 bindings 清单后正常退出；v0.1.2 已部署成功
- **Committed in:** 410da2f

**4. [计划歧义消解] shared 无窗口长度常量可引用**
- **Found during:** Task 2（计划要求"窗口长度 60000 与阈值均引用 shared 常量"，但 RATE_WINDOW_MS 不存在）
- **Fix:** shared 新增 RATE_WINDOW_MS = 60_000（纯新增常量，fixtures 未动）；README 常量表补行
- **Files modified:** packages/shared/src/index.ts, packages/shared/README.md
- **Verification:** chat-room.ts 限流分支零裸数字；fixtures 字节基线未动（git diff 6ef00e6..HEAD -- packages/shared/fixtures/ 为空）
- **Committed in:** a105688

---

**Total deviations:** 3 auto-fixed（1 bug、2 blocking）+ 1 计划内歧义消解
**Impact on plan:** 全部为必要修复，无范围蔓延；无 stub、无跳过的测试、无未运行的验证步骤。

## Issues Encountered

- **runInDurableObject 导入源**：`cloudflare:workers` 不导出该测试工具（运行时得到 undefined 而非模块错误）——正确来源为 `cloudflare:test`。已记入 patterns（01-04 的 sync/alarm 测试直接复用）。
- **workers.dev 本轮冒烟一次通过**（无 01-01 的间歇阻断重试），延迟 277ms。

## User Setup Required

None - no external service configuration required.（wrangler 登录态与 ADMIN_KEY 沿用 01-01。）

## Next Phase Readiness

- **就绪**：01-04（sync 补拉）——DO webSocketMessage 已留位；validateInboundFrame 返回解析后的 ClientFrame 可直接消费；HistoryFrame/INITIAL_FETCH/SYNC_* 常量与 history fixtures 语义样例（oldest_kept_seq/has_more）均已冻结；runInDurableObject 表操作模式已验证可用于 alarm 测试
- **就绪**：01-05（Admin API）——D-06 信封构造与 KV 键表写路径（ch:/sk:/id:）为剩余工作；错误码枚举已含 invalid_key
- **注意点**：① 限流表 rate_sends 的过期桶行清理依赖每日 alarm（D-08）——alarm 本体归 01-04+，届时一并挂清理；② 每次部署断开全部 WS 连接（已知平台行为），客户端重连逻辑在 Phase 2/5/6 落地；③ dashboard DO duration 空闲不增长的人工核对仍为每次部署的 D-15 ④ 项（沿用 01-01 遗留说明）
- **协议基线仍冻结**：`git diff 6ef00e6 HEAD -- packages/shared/fixtures/` 为空——本计划未触碰任何 fixture 字节

## Self-Check: PASSED

- 关键文件存在性：send-basic / send-validation / send-payload-fields / rate-limit 四测试文件 + server tsconfig 全部 FOUND
- 提交存在性：d0231a2、a105688、4c9b971、410da2f 均在 git log
- 验收复跑：`pnpm --filter @pushhub/server test` 44/44 绿（7 文件）；`pnpm --filter @pushhub/server typecheck` 通过；生产冒烟 SMOKE OK（277ms，六步含新增 413 步）
- fixtures 字节冻结性：`git diff 6ef00e6 HEAD -- packages/shared/fixtures/` 为空
- SRV-02 禁令复核：服务端源码零 fetch 消费 callback_url/click_url（grep 仅有 DO stub fetch）；存储与扇出均原文

---
*Phase: 01-server-core*
*Completed: 2026-08-26*
