---
phase: 01-server-core
plan: "01"
subsystem: infra
tags: [cloudflare-workers, durable-objects, websocket-hibernation, sqlite, pnpm-monorepo, vitest, workers-dev]

requires:
  - phase: none (greenfield)
    provides: "—"
provides:
  - pnpm monorepo 骨架（packages/shared + packages/server，workspace:*）
  - @pushhub/shared 线协议常量（PROTOCOL_VERSION=1、最小 MessageFrame 类型）
  - ChatRoom DO 类（类名部署即定型；Hibernation WS + SQLite messages 表 + 显式 seq 分配 + 全连接扇出）
  - Worker 入口路由（POST /api/send、GET /api/ws/:channelKey）+ KV ch:/sk: 预检 + X-PH-Verified 内部转发
  - 生产部署 https://pushhub.snake160220.workers.dev（KV namespace ffc9065c…、ADMIN_KEY secret）
  - 测试基建（@cloudflare/vitest-plugin 真实 workerd，--max-workers=1 --no-isolate）
  - 生产冒烟脚本 scripts/smoke.mjs + DEPLOY.md（D-15 checklist 固化）
affects: [01-02 协议冻结, 01-03 校验与限流, 01-04 sync 补拉, 01-05 Admin API, Phase 2 web-sdk, Phase 5 desktop, Phase 6 android]

actuals:
  tokens: 24797   # 99,189 diff chars / 4（estimate 42,000 的 59%）
  tasks: 3
  commits: 3      # a8c2d5a, 63a0e96, + 本 SUMMARY docs commit

tech-stack:
  added:
    - "@cloudflare/vitest-plugin@1.1.0（用户批准——Task 1 blocking-human 检查点）"
    - vitest@4.1.11
    - wrangler@4.126.0
    - typescript@7.0.2
    - pnpm@10.33.0 workspace
  patterns:
    - DO 类经 wrangler.jsonc 顶层 exports 声明（非 legacy migrations）——生产 reconciliation 验证通过
    - Hibernation 三件套：构造器幂等 DDL + setWebSocketAutoResponse 重设 + acceptWebSocket/serializeAttachment
    - 显式 seq 赋值：同步块内 COALESCE(MAX(seq),0)+1 → INSERT（禁 AUTOINCREMENT）
    - Worker 层 KV 预检（cacheTtl 60）先于 DO stub 创建——无效密钥不唤醒 DO（DoS 防护）
    - D-06 错误信封 {"error":{code,message}} + 内部头 X-PH-Verified: 1 转发
    - 测试文件以 crypto.randomUUID() 派生唯一频道名（no-isolate 共享存储隔离手段）

key-files:
  created:
    - pnpm-workspace.yaml / package.json / tsconfig.base.json / .gitignore / pnpm-lock.yaml
    - packages/shared/src/index.ts
    - packages/server/{wrangler.jsonc, vitest.config.ts, public/index.html, src/index.ts, src/chat-room.ts, src/keys.ts, test/ws-fanout.test.ts, worker-configuration.d.ts}
    - scripts/smoke.mjs / DEPLOY.md
  modified: []

key-decisions:
  - "Task 1 用户裁决 approve-plugin：采用 @cloudflare/vitest-plugin@1.1.0（blocking-human 包合法性门，npm 页人工核验通过）"
  - "exports 声明在生产验证通过（Created: ChatRoom）——A2 假设成立，DO 类名 ChatRoom 首版定型"
  - "compatibility_date 2026-08-25 被 wrangler 4.126.0 接受（A4 成立，无需回退）"
  - "WebSocketRequestResponsePair 是 workerd 全局构造器而非 cloudflare:workers 模块导出（执行中发现并修正研究 Pattern 2 的导入写法）"
  - "ADMIN_KEY 由执行器以 node crypto 生成 64 hex 字符并经 wrangler secret put 落位（用户未自备值）"

patterns-established:
  - "Pattern: DO 内部路由 /publish 与 /ws，仅信 X-PH-Verified: 1 内部头"
  - "Pattern: ping/pong 帧字面量 {\"v\":1,\"type\":\"ping\"} / {\"v\":1,\"type\":\"pong\"}（setWebSocketAutoResponse，零计费心跳）"
  - "Pattern: wid 生成 m_ + 16 字符（WID_ALPHABET 去易混淆字符，crypto.getRandomValues）"
  - "Pattern: 测试命令 vitest run --max-workers=1 --no-isolate（WS+DO 硬约束）"

requirements-completed: [SRV-01, SRV-03, SRV-04, KEY-01]

coverage:
  - id: D1
    description: "pnpm monorepo 骨架 + @pushhub/shared 协议常量 + wrangler.jsonc（exports 声明 ChatRoom/KV/assets）+ 测试基建接线"
    requirement: SRV-04
    verification:
      - kind: integration
        ref: "packages/server/test/ws-fanout.test.ts#ws fanout (walking skeleton)（3/3 通过，真实 workerd）"
        status: pass
      - kind: other
        ref: "pnpm --filter @pushhub/server exec wrangler types --include-runtime=false（worker-configuration.d.ts 生成，含 KV/CHANNELS Env 声明）"
        status: pass
    human_judgment: false
  - id: D2
    description: "POST /api/send：Bearer Send Key → KV sk: 预检 → ChatRoom publish（seq 分配 + SQLite 落库）→ {id, seq} 响应"
    requirement: SRV-01
    verification:
      - kind: integration
        ref: "packages/server/test/ws-fanout.test.ts#send-1（seq=1、m_ 前缀 wid 断言）"
        status: pass
      - kind: e2e
        ref: "PH_SMOKE_URL=https://pushhub.snake160220.workers.dev node scripts/smoke.mjs（send-1 OK）"
        status: pass
    human_judgment: false
  - id: D3
    description: "ChatRoom DO WS 扇出：双客户端实收同一条 v:1 message 帧，text 逐字一致（哑管道）"
    requirement: SRV-03
    verification:
      - kind: integration
        ref: "packages/server/test/ws-fanout.test.ts#双 WS 客户端实收 seq=2 帧"
        status: pass
      - kind: e2e
        ref: "scripts/smoke.mjs#ws-receive（生产 v:1 帧逐字一致，LATENCY 285ms）"
        status: pass
    human_judgment: false
  - id: D4
    description: "无效 Send Key /api/send 与无效 Channel Key WS 握手均 401 + invalid_key 信封，且不创建 DO stub"
    requirement: KEY-01
    verification:
      - kind: integration
        ref: "packages/server/test/ws-fanout.test.ts#无效 Send Key / 无效 Channel Key 两用例"
        status: pass
      - kind: e2e
        ref: "scripts/smoke.mjs#invalid-key（生产 401 + invalid_key）"
        status: pass
    human_judgment: false
  - id: D5
    description: "生产部署 + 冒烟：workers.dev 部署成功（Version 1104cd81）、SMOKE OK、端到端延迟 285ms（< 2000ms 验收线）、ADMIN_KEY secret 落位"
    requirement: SRV-01
    verification:
      - kind: e2e
        ref: "PH_SMOKE_URL=... node scripts/smoke.mjs → SMOKE OK, LATENCY: 285ms"
        status: pass
      - kind: other
        ref: "wrangler secret list 列出 ADMIN_KEY；wrangler.jsonc kv id 回填 ffc9065c998a4567a4a2754ede9eca8b"
        status: pass
    human_judgment: false
  - id: D6
    description: "SRV-04 Hibernation 生效验证：冒烟频道空闲数分钟后 Cloudflare dashboard 的 DO duration 指标不增长（验收 3，manual-only——wrangler dev 不驱逐 DO，只能生产核对）"
    requirement: SRV-04
    verification: []
    human_judgment: true
    rationale: "DO duration 指标只能在 Cloudflare dashboard 人工观察（D-15 checklist ④）；自动化路径不存在。用户需在 dashboard → Workers → pushhub → Durable Objects 核对空闲 duration 无增长。"

duration: 33min
completed: 2026-08-26
status: complete
---

# Phase 1 Plan 1: Walking Skeleton Summary

**从零搭起 pnpm monorepo，一条消息打穿全栈：POST /api/send（KV 预检）→ ChatRoom DO（Hibernation WS + SQLite 落库 + 显式 seq + 扇出）→ 双 WS 客户端实收 v:1 帧；vitest 真实 workerd 3/3 绿 + workers.dev 生产冒烟 SMOKE OK（285ms）**

## Performance

- **Duration:** 33 min（墙钟，含两次用户交互暂停：Task 1 包合法性裁决 + wrangler login OAuth）
- **Started:** 2026-08-26T05:53:37Z
- **Completed:** 2026-08-26T06:26:42Z
- **Tasks:** 3/3（Task 1 checkpoint + Task 2 tracer + Task 3 auto）
- **Files modified:** 18（16 created in Task 2 + 2 in Task 3，另 2 文件修改）

## Accomplishments

- 全栈 tracer 切片端到端打通并在生产验证：发送方 → Worker KV 预检 → ChatRoom DO（SQLite 落库、seq 分配、Hibernation WS 扇出）→ 多客户端实收，生产端到端延迟 **285ms**（验收线 2000ms）
- 架构定型并经生产 reconciliation 验证：`exports` 声明的 ChatRoom DO（sqlite）、KV namespace（ffc9065c…）、协议 v:1 帧、ping/pong 字面量、`m_` wid、X-PH-Verified 内部头——后续计划零架构变更的地基
- 测试基建就绪：@cloudflare/vitest-plugin（用户批准）在真实 workerd 跑真 DO/KV/WS，`--max-workers=1 --no-isolate` 隔离策略落地
- 生产部署与运维固化：DEPLOY.md（D-15 checklist + 版本规约 0.1.0）、冒烟脚本零依赖可重复运行、ADMIN_KEY secret 落位

## Task Commits

1. **Task 1: 测试栈包合法性确认** — checkpoint:human-verify（blocking-human），无代码；用户裁决 approve-plugin
2. **Task 2: 全栈 tracer 切片** — `a8c2d5a` (feat)
3. **Task 3: 生产部署与首次冒烟** — `63a0e96` (feat)

**Plan metadata:** 本 SUMMARY 所在 commit (docs)

## Files Created/Modified

- `pnpm-workspace.yaml` / `package.json`(root, v0.1.0) / `tsconfig.base.json` / `.gitignore` / `pnpm-lock.yaml` — monorepo 脚手架
- `packages/shared/src/index.ts` — PROTOCOL_VERSION=1 + 最小 MessageFrame（01-02 冻结完整集）
- `packages/server/wrangler.jsonc` — exports 声明 ChatRoom（sqlite）+ CHANNELS binding + KV（真实 id）+ assets（asset-first）
- `packages/server/src/chat-room.ts` — ChatRoom DO：13 列幂等 DDL、COALESCE(MAX(seq))+1 显式赋值、Hibernation 三件套、全连接扇出、m_+16 wid
- `packages/server/src/index.ts` — Worker 入口：/api/send 与 /api/ws/:channelKey 路由 + KV 预检 + 内部转发 + D-06 信封
- `packages/server/src/keys.ts` — KV ch:/sk: 读路径（cacheTtl 60）
- `packages/server/vitest.config.ts` / `packages/server/test/ws-fanout.test.ts` — cloudflareTest 接线 + E2E（3 用例）
- `packages/server/public/index.html` — 静态资产占位（asset-first）
- `packages/server/worker-configuration.d.ts` — wrangler types 生成（Env 含 KV/CHANNELS/ASSETS）
- `scripts/smoke.mjs` — 生产冒烟（kv 种键 → send → WS 实收+延迟 → 401 断言 → SMOKE OK）
- `DEPLOY.md` — D-15 checklist、版本规约、首次部署记录

## Decisions Made

- **approve-plugin**（用户裁决）：`@cloudflare/vitest-plugin@1.1.0` 经 npm 页人工核验后批准使用；退路 vitest-pool-workers 未启用
- **ADMIN_KEY**：用户未自备值，由执行器 node crypto 生成 64 位 hex 串写入 secret（值在本次执行输出中一次性展示，用户应已记入密码管理器）
- **worker-configuration.d.ts 与 pnpm-lock.yaml 入库**：虽为生成物（files_modified 未列），官方模板惯例提交 worker-configuration.d.ts；lockfile 为 workspace 标准实践

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] pnpm 10 拦截 esbuild/workerd 构建脚本**
- **Found during:** Task 2（pnpm install）
- **Issue:** pnpm 10 默认拒绝执行依赖的 postinstall——esbuild（vitest 传递依赖）与 workerd（wrangler 传递依赖）二进制未安装，测试栈无法运行
- **Fix:** 根 package.json 增加 `pnpm.onlyBuiltDependencies: ["esbuild", "workerd"]`（二者为已批准测试栈的成熟官方传递依赖，非新增供应链）后重装
- **Files modified:** package.json
- **Verification:** install 输出显示两个 postinstall Done；测试全绿
- **Committed in:** a8c2d5a（Task 2 commit）

**2. [Rule 1 - Bug] WebSocketRequestResponsePair 导入源错误**
- **Found during:** Task 2（首次测试运行：`WebSocketRequestResponsePair is not a constructor`）
- **Issue:** 研究 Pattern 2 示例将其从 `cloudflare:workers` 模块导入，但该构造器在 workerd 运行时是全局变量（同 WebSocketPair），模块导入在运行时为 undefined
- **Fix:** 移除导入、直接使用全局构造器，并留注释防回归
- **Files modified:** packages/server/src/chat-room.ts
- **Verification:** 测试 3/3 绿；生产冒烟 ws-open/ws-receive 通过（auto-response 已配置，ping 行为由 01-02 测试补断言）
- **Committed in:** a8c2d5a（Task 2 commit）

---

**Total deviations:** 2 auto-fixed（1 missing critical/blocking、1 bug）
**Impact on plan:** 均为必要修复，无范围蔓延。研究文档的两处偏差（导入源、pnpm 10 行为）已在 Deviations 与 Decisions 中记录供后续计划借鉴。

## Issues Encountered

- **workers.dev 间歇性不可达（中国大陆网络）**：首次冒烟 `UND_ERR_CONNECT_TIMEOUT`（DNS 正常、TCP 间歇超时，间歇性阻断模式）；重试即成功（HTTP 200 → SMOKE OK）。已在 DEPLOY.md 固化操作注意（遇此错误重跑；部署本身走 api.cloudflare.com 不受影响）。
- **wrangler kv namespace create 的自动回写提示**在非交互上下文自动选 no——按计划手动回填 wrangler.jsonc（预期行为，非问题）。

## Authentication Gates

- **Task 1（blocking-human 包合法性门）**：@cloudflare/vitest-plugin 6 天龄 SUS 标记 → 用户核验 npm 页后回复 approve-plugin → 继续安装。
- **Task 3 前置（wrangler login）**：`wrangler whoami` 未认证 → checkpoint:human-action → 用户完成浏览器 OAuth（账号 snake160220@gmail.com）→ whoami 核验通过 → 部署继续。
- **ADMIN_KEY**：用户选择由执行器生成 → node crypto 32 字节 hex → `wrangler secret put` 落位 → `wrangler secret list` 核验。

## User Setup Required

**外部服务人工步骤已完成**（wrangler login OAuth ✓、ADMIN_KEY secret 落位 ✓）。详见 [01-USER-SETUP.md](./01-USER-SETUP.md)（状态：Complete）。

**遗留人工核对（非 setup，属验收 3）：** 请在 Cloudflare dashboard → Workers → pushhub → Durable Objects 观察冒烟频道（smoketest）：空闲数分钟后 **duration 指标应无增长**（Hibernation 生效，SRV-04/验收 3；wrangler dev 不驱逐 DO，只能生产核对）。核对结果记入阶段验证。

## Next Phase Readiness

- 就绪：monorepo 骨架、ChatRoom DO 架构（类名定型）、KV 键表读路径、v:1 帧先例、测试基建、部署/冒烟流水线——01-02（协议冻结）可直接在 shared 包扩展完整类型/上限常量/validators/fixtures 并补 worker-configuration 类型接线
- 注意点：① `WebSocketRequestResponsePair` 全局构造器的 TS 类型声明缺失（--include-runtime=false 不含运行时全局类型），01-02 接 typecheck 时需处理（手写 ambient declaration 或调整 types 策略）；② workers.dev 间歇阻断已文档化，后续自动化冒烟需容忍重试；③ server 包暂无独立 tsconfig（本切片未引入 tsc 检查），01-02 起 typecheck 需补齐

## Self-Check: PASSED

- 关键文件存在性：pnpm-workspace.yaml、chat-room.ts、index.ts、keys.ts、ws-fanout.test.ts、smoke.mjs、DEPLOY.md、worker-configuration.d.ts 全部 FOUND
- 提交存在性：a8c2d5a、63a0e96 均在 git log
- 验收复跑：`pnpm --filter @pushhub/server test ws-fanout` EXIT 0（3/3）；生产冒烟 SMOKE OK + 285ms

---
*Phase: 01-server-core*
*Completed: 2026-08-26*
