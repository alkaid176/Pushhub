---
phase: 01-server-core
plan: "05"
subsystem: api
tags: [cloudflare-workers, admin-api, key-management, kv-write-path, timing-safe-equal, base62, three-tier-keys, smoke-checklist, deploy]

requires:
  - phase: 01-server-core/01
    provides: "Worker 入口路由 + ChatRoom DO + KV 读路径 + 测试/部署流水线"
  - phase: 01-server-core/03
    provides: "/api/send 校验链 + KEY-05 限流 + 错误信封形态"
  - phase: 01-server-core/04
    provides: "WS 首连推送/sync 补拉/alarm 保留清理全语义 + smoke.mjs ②③ 框架 + attach-before-trigger 测试铁律"
provides:
  - Admin API 最小集（D-12）：POST /api/admin/channels（201 三件套 channelId/channelKey/sendKey/name/createdAt）+ GET /api/admin/channels（200 列表）——Phase 3 管理页直接复用，零重复建设
  - 密钥写路径（keys.ts）：generateRandomString（crypto.getRandomValues base62 + 拒绝采样去偏差）/generateChannelKey(phc_+32)/generateSendKey(phs_+32)/generateChannelId(16)/createChannel（ch:/sk:/id: 三前缀各一次 KV 写的唯一入口）/listChannels（游标循环拉全）
  - Admin Key 常时比较鉴权（D-13）：长度前置 + crypto.subtle.timingSafeEqual 两段式；单一 401 invalid_key 码；ADMIN_KEY 未配置 → 500 server_error（Flagged Assumption 落地）
  - smoke.mjs D-15 定稿：admin API 建频道（替代 kv 种键，生产路径全真实）+ ①②③④ 全自动 + 错误 Admin Key 反例；DEPLOY.md 定稿（四步 checklist + dashboard 观察入口与预期现象 + 版本规则 + 排障三条）
  - src/env.d.ts：ADMIN_KEY 的 Env 声明合并模式（secret 不在 wrangler.jsonc，wrangler types 生成不了）
affects: [Phase 3 管理页（直接复用 admin API）, Phase 2 web-sdk（smoke 流程即客户端行为模板）, Phase 5/6 客户端（三级密钥使用方式）]

actuals:
  tokens: 12246   # 48,984 diff chars / 4（estimate 26,000 的 47%——confidence: low 的高估模式与 01-04 一致）
  tasks: 2
  commits: 2      # 0cbcbea, f343e34（+ 本 SUMMARY docs commit）

tech-stack:
  added: []   # 零新增依赖；crypto.subtle.timingSafeEqual（运行时内置非标准扩展）首次启用
  patterns:
    - "D-06 错误信封单点化：envelope.ts 唯一实现，index/admin 共用——冻结契约禁止两处各写一份漂移"
    - "常时比较两段式：先比长度（不同直接 401，规避 timingSafeEqual 长度不等抛错的时序泄漏）再 Uint8Array 化常时比较；401 与业务密钥同码同文案——不给'接近正确'信号（T-01-03）"
    - "base62 生成拒绝采样：256 % 62 == 8，丢弃 >=248 字节消除取模偏差——凭据字符分布必须均匀（研究草案的'5 行取模'升级）"
    - "secret 的 Env 类型补充：src/env.d.ts 全局 interface Env 声明合并（wrangler types 只生成 wrangler.jsonc 内声明的 bindings）+ vitest 经 miniflare.bindings 注入测试专用值"
    - "鉴权先于路由：/api/admin/* 未过 Admin Key 校验不进入路径判定——不鉴权不暴露路径存在性"

key-files:
  created:
    - packages/server/src/admin.ts
    - packages/server/src/envelope.ts
    - packages/server/src/env.d.ts
    - packages/server/test/admin-channels.test.ts
  modified:
    - packages/server/src/keys.ts（写路径全量：生成器 + createChannel + listChannels）
    - packages/server/src/index.ts（/api/admin/* 前缀路由 + 信封改引 envelope.ts）
    - packages/server/vitest.config.ts（miniflare.bindings 注入测试专用 ADMIN_KEY）
    - scripts/smoke.mjs（D-15 定稿：admin 建频道 + ①②③④ 全自动）
    - DEPLOY.md（定稿：四步 checklist + 版本规则 + 排障三条 + 0.1.4 记录）
    - package.json（0.1.4）

key-decisions:
  - "D-06 错误信封抽到 envelope.ts 单点实现（计划外新文件）：index ⇄ admin 循环引用 vs 两处各写一份冻结契约，两者都不可接受——第三条路是单点模块；信封形态是对外契约，漂移即事故"
  - "generateRandomString 用拒绝采样消除 256->62 取模偏差（研究草案为直接取模）：密钥是凭据，字符分布均匀性值得 5 行额外代码"
  - "未知 admin 路径与非 GET/POST 方法一律 404 not_found：不新增 method_not_allowed 错误码——D-06 错误码枚举是冻结契约，Phase 3 管理页成型前不扩面"
  - "版本规则定稿为'部署前 +1'（原文档写'冒烟通过后 +1'与计划验收'本次部署前完成 +1'冲突）——部署记录里的版本即本次代码版本，语义更准"
  - "smoke.mjs 在本地 wrangler dev（真 workerd）全绿作为脚本功能等价证据：生产冒烟被网络阻断时，脚本本身的正确性仍可验证（网络是环境问题，脚本是交付物）；临时 .dev.vars 用测试专用 key，验证后即删"

patterns-established:
  - "Pattern: secret 类 binding 的测试注入——vitest.config.ts miniflare.bindings 写测试值 + src/env.d.ts 声明合并补类型；生产 secret 绝不入库"
  - "Pattern: 经 Worker 入口的 WS 升级测试——Request 必须带 Upgrade/Connection 头（DO 依据其判定升级，缺失走 404 分支）"
  - "Pattern: KV 游标分页的可测性——listChannels 带 options.pageSize（仅测试用，压缩分页验证成本），pageSize=1 断言跨页拉全"

requirements-completed: [KEY-01]

coverage:
  - id: C1
    description: "D-13 Admin Key 鉴权：错误/缺失/长度不匹配/非 Bearer 方案 → 401 invalid_key；ADMIN_KEY 未配置 → 500 server_error（Flagged Assumption）"
    requirement: KEY-01
    verification:
      - kind: integration
        ref: "packages/server/test/admin-channels.test.ts（鉴权 describe 2 例：401 矩阵 5 形态 + 500 未配置分支）"
        status: pass
    human_judgment: false
  - id: C2
    description: "D-12 创建契约：201 三件套（phc_+32/phs_+32/channelId 16 字符 base62/name/createdAt 回显）；name 缺失/非字符串/超 64 → 400 invalid_body；非 JSON → 400 invalid_json"
    requirement: KEY-01
    verification:
      - kind: integration
        ref: "packages/server/test/admin-channels.test.ts（建频道 describe 2 例）"
        status: pass
    human_judgment: false
  - id: C3
    description: "三级密钥闭环：admin 建的 Send Key 立即经 /api/send 得 200、Channel Key 立即连 WS 收首拉 history 帧且含刚发消息（三前缀 KV 写读 + DO 全链路）"
    requirement: KEY-01
    verification:
      - kind: integration
        ref: "packages/server/test/admin-channels.test.ts（闭环 describe：经真实 Worker 入口）"
        status: pass
    human_judgment: false
  - id: C4
    description: "权限隔离双向 + Admin 不通用：Channel Key 发送 401 / Send Key 连 WS 401（webSocket 为 null）/ Admin Key 发送与连 WS 均 401"
    requirement: KEY-01
    verification:
      - kind: integration
        ref: "packages/server/test/admin-channels.test.ts（隔离 describe）"
        status: pass
    human_judgment: false
  - id: C5
    description: "D-12 列表：GET /api/admin/channels 含刚建频道且逐字段等于创建响应；id: 游标分页跨页拉全（pageSize=1）"
    requirement: KEY-01
    verification:
      - kind: integration
        ref: "packages/server/test/admin-channels.test.ts（列表 describe 2 例）"
        status: pass
    human_judgment: false
  - id: C6
    description: "D-15 冒烟定稿：admin 建频道（时间戳名）→ 错误 Admin Key 401 → 发送 200 → WS 实收延迟打印 → 断线补拉恰 2 条 → 401/413 反例 → SMOKE OK"
    requirement: KEY-01
    verification:
      - kind: e2e
        ref: "PH_SMOKE_URL=https://pushhub.snake160220.workers.dev PH_ADMIN_KEY=<secret> node scripts/smoke.mjs —— DNS 污染（workers.dev 被解析到 Facebook/Twitter IP 段）连接超时，按既定策略仅试一轮；沿用 WINDOWS.md unrun-verify 追踪网络窗口补跑"
        status: unknown
      - kind: other
        ref: "本地 wrangler dev（真 workerd）全绿：SMOKE OK，延迟 11ms，补拉恰 2 条零丢失，phc_/phs_ 格式断言全过——脚本交付物功能等价证据；全量套件 13 文件 60/60 绿 + typecheck 通过"
        status: pass
    human_judgment: true
    rationale: "生产冒烟与 dashboard 观察为环境/人工依赖：网络窗口恢复后重跑冒烟命令（DEPLOY.md 部署步骤节），并由人工完成 D-15 ④ dashboard DO duration 观察（验收 3 最终复核）"

duration: 13min
completed: 2026-08-26
status: complete
---

# Phase 1 Plan 5: 三级密钥体系与 Admin API Summary

**三级密钥体系闭合（KEY-01）：admin 建频道 → phc_/phs_ 密钥即刻可用（发/收全链路）→ 双向隔离有测试证据；timingSafeEqual 常时比较 + D-06 信封单点化 + D-15 冒烟 checklist 定稿——Phase 1 收口：全量 13 文件 60/60 绿，v0.1.4 已部署（生产冒烟待网络窗口，本地真 workerd SMOKE OK）**

## Performance

- **Duration:** 13 min（含一次生产冒烟尝试 + 本地全量验证；无 01-04 式网络等待——本轮按策略不烧重试）
- **Started:** 2026-08-26T11:15:39Z
- **Completed:** 2026-08-26T11:28:XXZ
- **Tasks:** 2/2
- **Files:** 10（4 创建 + 6 修改）

## Accomplishments

- **KEY-01 闭合：三级密钥各司其职有自动化证据**——Admin Key 只能管理（常时比较鉴权，错误/缺失/长度不匹配/非 Bearer 全 401 同码）、Send Key 只能发、Channel Key 只能连 WS，互不通用双向断言；admin 建的密钥立即在真实入口生效（发送 200 + WS 首拉帧含刚发消息）
- **外部系统自助开通闭环成立（Phase 1 成功标准）**：curl/脚本三行——POST admin 建频道拿三件套 → Send Key 发消息 → Channel Key 收消息；D-12 的 API 路径与响应结构即 Phase 3 管理页的直接复用面
- **安全细节到位**：拒绝采样消除 base62 取模偏差；长度前置规避 timingSafeEqual 抛错时序；鉴权失败不回显凭据、不落日志（Prohibition）；ADMIN_KEY 未配置 500 通用信封不泄漏配置细节（Flagged Assumption 落地）；三前缀 KV 写收敛到 createChannel 唯一入口（键空间红线）
- **D-15 定稿为此后每次版本 +1 的固定仪式**：smoke.mjs ①②③④ 全自动（admin 建频道替代 kv 种键——生产路径全真实）+ DEPLOY.md 四步 checklist（dashboard 观察入口与预期现象写清）+ 排障三条

## Task Commits

1. **Task 1: 密钥写路径 + Admin API 最小集 + timingSafeEqual 鉴权** — `0cbcbea` (feat)
2. **Task 2: D-15 冒烟 checklist 固化 + 阶段级生产验证（v0.1.4 部署 + 冒烟尝试 + 本地等价验证）** — `f343e34` (chore)

**Plan metadata:** 本 SUMMARY 所在 commit (docs)

## Files Created/Modified

- `packages/server/src/keys.ts` — 写路径：generateRandomString（拒绝采样 base62）、generateChannelKey/SendKey/ChannelId、createChannel（ch:/sk:/id: 三次 KV 写，id: 最后落的失败语义）、listChannels（list_complete/cursor 循环 + options.pageSize 测试口）
- `packages/server/src/admin.ts` — handleAdminApi：鉴权先于路由；POST 201 三件套（name ≤64 校验）/GET 200 {channels}；未知路径与方法 404 不扩错误码面
- `packages/server/src/envelope.ts` — D-06 错误信封唯一实现（index/admin 共用）
- `packages/server/src/index.ts` — /api/admin/ 前缀分发；errorEnvelope 改引 envelope.ts
- `packages/server/src/env.d.ts` — ADMIN_KEY 的 Env 声明合并（string | undefined，缺失分支是真实运行时形态）
- `packages/server/vitest.config.ts` — miniflare.bindings 注入测试专用 ADMIN_KEY（生产 secret 不入库）
- `packages/server/test/admin-channels.test.ts` — 8 例：401 矩阵/500 未配置/201 格式/name 校验/三级闭环/列表/分页/双向隔离（经真实 Worker 入口）
- `scripts/smoke.mjs` — D-15 定稿：去 kv 种键机制，admin API 建时间戳频道，错误 Admin Key 反例，①②③④ 全自动
- `DEPLOY.md` — 版本规则（部署前 +1）、deploy 命令修正、四步 checklist、排障三条、0.1.4 记录
- `package.json` — 0.1.4

## Decisions Made

- **信封单点化（计划外文件 envelope.ts）**：admin.ts 需要复用 D-06 信封——import index.ts 成循环引用、两处各写一份会漂移（冻结契约）；抽出单点模块是唯一正解
- **拒绝采样升级研究草案**：Pattern 6 草案是"5 行手写取模"，256->62 的 3% 偏差对 190-bit 密钥本可忽略，但凭据生成值得消除该疑问（+5 行）
- **未知 admin 路径 404 而非 405**：D-06 错误码枚举冻结，method_not_allowed 是扩面；Phase 3 管理页成型时再评估
- **版本规则修正**：原文档"冒烟通过后 +1"与本计划验收"部署前 +1"冲突——取后者（部署记录的版本即本次代码版本），DEPLOY.md 已改
- **生产冒烟受阻时的诚实处理（沿 01-04 先例）**：脚本本身在本地真 workerd 全绿验证（交付物正确性），生产运行按 WINDOWS.md 追踪；不为凑绿绕过（远程预览不支持 SQLite DO 已知）

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] 经 Worker 入口的 WS 测试请求缺 Upgrade 头 → 404**
- **Found during:** Task 1（admin-channels 首跑：闭环用例 404 非 101）
- **Issue:** 既有测试都直连 DO stub（显式带 Upgrade 头）；经 Worker 入口的 Request 也必须带 Upgrade/Connection 头——DO 依据其判定升级，缺失走 404 分支
- **Fix:** wsRequest() 补 `Upgrade: websocket` + `Connection: Upgrade` 头（与浏览器升级请求同形）
- **Files modified:** packages/server/test/admin-channels.test.ts
- **Verification:** 8/8 绿（全量 60/60）
- **Committed in:** 0cbcbea

**2. [Rule 1 - Bug] DEPLOY.md 部署命令不可用：`pnpm --filter @pushhub/server deploy` 被 pnpm 拦截**
- **Found during:** Task 2（实际执行 deploy 即报 ERR_PNPM_INVALID_DEPLOY_TARGET）
- **Issue:** pnpm 把裸 `deploy` 子命令拦截为自己的内置命令，必须带 `run`
- **Fix:** DEPLOY.md 命令改为 `pnpm run deploy` 并注明原因；排障说明补入部署步骤节
- **Files modified:** DEPLOY.md
- **Verification:** `pnpm run deploy` 成功部署 v0.1.4（Version 9255d9d3）
- **Committed in:** f343e34

**3. [Rule 3 - Blocking] 信封复用路径：admin.ts 与 index.ts 的循环引用风险**
- **Found during:** Task 1（admin.ts 需要同一 D-06 错误信封）
- **Issue:** 计划未指定信封复用方式——import index.ts 形成模块环；复制一份则冻结契约两处维护必漂移
- **Fix:** 抽出 src/envelope.ts 单点实现，index/admin 共同引用（计划外新文件，语义上是重构既有代码）
- **Files modified:** packages/server/src/envelope.ts（新）、packages/server/src/index.ts、packages/server/src/admin.ts
- **Verification:** typecheck + 60/60 绿；既有信封行为零变化（纯移动）
- **Committed in:** 0cbcbea

**4. [计划内文件清单扩充] vitest.config.ts 与 src/env.d.ts**
- **Found during:** Task 1（ADMIN_KEY 注入测试环境的落地方式）
- **Issue:** 计划 files_modified 未列这两个文件，但 action 5 明确要求经 vitest 配置注入；ADMIN_KEY 的 Env 类型也无处安放（wrangler types 只生成 wrangler.jsonc 内 bindings）
- **Fix:** vitest.config.ts 加 miniflare.bindings（测试专用值）；src/env.d.ts 声明合并补 ADMIN_KEY 类型
- **Files modified:** packages/server/vitest.config.ts、packages/server/src/env.d.ts（新）
- **Verification:** 测试全绿 + typecheck 通过
- **Committed in:** 0cbcbea

---

**Total deviations:** 2 auto-fix bug + 1 blocking 结构修复 + 1 计划文件清单扩充
**Impact on plan:** 无范围蔓延；对外契约（D-12 响应结构、D-06 错误码）严格按计划落地。

## Issues Encountered

- **生产冒烟仍被网络阻断（沿 01-04 已知问题，未解决、已追踪）**：v0.1.4 部署成功（Version `9255d9d3-5e50-480a-8412-f14236c19285`，经 api.cloudflare.com）；冒烟一轮尝试即失败——DNS 污染实锤：`pushhub.snake160220.workers.dev` 被本机 DNS 解析到 Facebook IPv6 段（`2a03:2880:...face:b00c`）与 Twitter IP（`199.59.148.201`），fetch 连接超时（UND_ERR_CONNECT_TIMEOUT）。按既定策略不烧重试；smoke.mjs 定稿版经本地 wrangler dev（真 workerd）全绿（SMOKE OK / 延迟 11ms / 补拉恰 2 条 / phc_/phs_ 格式 / 401 与 413 反例）。**网络窗口恢复后补跑**：`PH_SMOKE_URL=https://pushhub.snake160220.workers.dev PH_ADMIN_KEY=<secret> node scripts/smoke.mjs`（通过即同时闭合 WINDOWS.md #2 的 v0.1.3 补验——同 worker 同步骤超集）。已追加 WINDOWS.md unrun-verify 条目
- **D-15 ④ dashboard DO duration 人工核对**（计划 human-check 项，验收 3 最终复核）：待用户在 dashboard 观察（冒烟频道空闲数分钟 duration 平直不增）；DEPLOY.md checklist 已写清入口路径与预期现象

## User Setup Required

None - no external service configuration required.（ADMIN_KEY secret 沿用 01-01；网络窗口恢复后重跑冒烟 + dashboard 人工核对两项待办见 Issues。）

## Next Phase Readiness

- **Phase 1 全部 5 计划完成**：SRV-01~07 + KEY-01 + KEY-05 九项需求闭合（60/60 测试，v0.1.4 生产部署）；两项人工尾巴——生产冒烟补跑 + dashboard duration 观察（WINDOWS.md #1/#2 与本轮新条目追踪，/gsd-verify-work 或 /gsd-ship 前处理）
- **就绪**：Phase 2 web-sdk——三级密钥的使用方式（phc_ 连 WS/phs_ 发送）与补拉协议（smoke.mjs 的 c1-c5 即客户端行为模板）全部生产验证路径就绪
- **就绪**：Phase 3 管理页——POST/GET /api/admin/channels 直接复用（鉴权方式 Bearer ADMIN Key、响应结构、name ≤64 校验均已冻结）；删除/重置/吊销 API 届时随页扩展（D-13 边界）
- **协议基线仍冻结**：`git diff 6ef00e6 HEAD -- packages/shared/fixtures/` 为空——本计划未触碰任何 fixture 字节

## Self-Check: PASSED

- 关键文件存在性：admin.ts / envelope.ts / env.d.ts / admin-channels.test.ts / smoke.mjs / DEPLOY.md 全部 FOUND
- 提交存在性：0cbcbea、f343e34 均在 git log
- 验收复跑：`pnpm --filter @pushhub/server test` 13 文件 60/60 绿；`pnpm --filter @pushhub/server typecheck` 通过
- 201 响应格式：channelKey/sendKey 前缀 + 恰 32 字符（测试正则断言 + 生产冒烟本地运行断言双证）
- 三级隔离双向断言：admin-channels.test.ts 隔离 describe（Channel Key 发送 401 / Send Key 连 WS 401 / Admin 双拒）
- 生产 secret 不入库：生产 ADMIN_KEY 值未写入任何仓库文件（临时 .dev.vars 用测试专用值且已删除）

---
*Phase: 01-server-core*
*Completed: 2026-08-26*
