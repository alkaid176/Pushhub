---
phase: 01-server-core
plan: "04"
subsystem: api
tags: [cloudflare-workers, durable-objects, websocket-hibernation, sync-catchup, keyset-pagination, retention-alarm, sqlite, srk-contract-testing, group-chat]

requires:
  - phase: 01-server-core/01
    provides: "Worker 入口路由 + ChatRoom DO（publish/扇出/seq 分配/WS 升级）+ KV 预检 + 测试/部署流水线"
  - phase: 01-server-core/02
    provides: "冻结帧类型（HistoryFrame/SyncFrame/WsErrorFrame）+ validateInboundFrame + INITIAL_FETCH/SYNC_*/RETENTION_KEEP 常量 + golden fixtures（含 history 语义样例与 sync 反例）"
  - phase: 01-server-core/03
    provides: "rate_sends 限流表 + 冻结 MessageFrame 扇出 + runInDurableObject 测试工具实证 + worker-configuration.d.ts 全量运行时类型"
provides:
  - webSocketMessage 完整处理器：validateInboundFrame 白名单门（invalid_version/invalid_frame → WsErrorFrame 回帧不断连）→ sync keyset 补拉
  - 首连即推首拉 history 帧（最近 INITIAL_FETCH=50 条，D-09）——升级路径内全同步完成（accept 与 101 之间零 await）
  - sync 补拉语义（D-11）：WHERE seq > since ORDER BY seq ASC LIMIT n+1（多取 1 判 has_more）、limit 缺省 200/合法上限 500、OFFSET 禁用
  - oldest_kept_seq 诚实缺口标记（D-10）：MIN(seq)，空频道为 0——Phase 2 SDK 重连协议的冻结依据
  - alarm() 每日保留清理（D-08）：500 条窗口 DELETE（永不删 max 行）+ rate_sends 过期桶清扫 + 自 catch + finally 无条件重设 24h
  - SRV-04/05/06 行为钉子三件套：群聊互通零丢失、20 并发 seq 恰 1..20、evictDurableObject 驱逐后 pong/消息/attachment 全恢复
  - 冒烟脚本 D-15 ③ 完整版：断开→再发 2 条→重连→sync since 断言恰补 2 条且 seq 连续
affects: [01-05 Admin API, Phase 2 web-sdk（重连协议直接消费此冻结语义）, Phase 5 desktop, Phase 6 android]

actuals:
  tokens: 16736   # 66,944 diff chars / 4（estimate 36,000 的 47%——计划标注 confidence: low；实际含 ~75 分钟网络阻断等待，纯执行远快于墙钟）
  tasks: 3
  commits: 4      # d46bd71, bb99240, 6bf51a6, 68842cb（+ 本 SUMMARY docs commit）

tech-stack:
  added: []   # 零新增依赖；cloudflare:test 的 evictDurableObject/runDurableObjectAlarm 首次启用（插件自带，无安装）
  patterns:
    - "升级路径首推模式：acceptWebSocket → serializeAttachment → 同步 SQL 读取（.toArray() 即收）→ ws.send(首拉 history) → 返回 101——DO 无 waitUntil，响应返回后浮空 Promise 不可靠，同步入队是唯一可靠首连推送点"
    - "limit+1 取行判定 has_more（DESC 首拉与 ASC keyset 双路径同式），返回前裁掉多取行——禁 OFFSET 分页"
    - "workerd 同 isolate 帧监听铁律：message 事件不排队——监听器必须在触发动作前、且与 accept() 之间零 await 挂好（connect() 内同步预挂首帧监听；多连接先全部建连再统一 await）"
    - "alarm 自愈节奏：try 清理 → catch 自吞（内置重试 6 次即放弃）→ finally 无条件 setAlarm(+24h)；首个 alarm 仅在 publish 成功路径 getAlarm() 判空后设置（构造器绝不 setAlarm，Pitfall 7）"
    - "历史帧与扇出帧逐字段同构：rowToMessageFrame 与 publish 帧构造共用同一省略语义（NULL → 键不出现）——客户端单条渲染路径"
    - "测试限流规避双策略：DO /publish 内部端点直调（绕过 KV）+ Send Key 轮换（每键 ≤30 恰在阈值内）——600 条/220 条大批量场景注明于测试头"

key-files:
  created:
    - packages/server/test/sync-catchup.test.ts
    - packages/server/test/seq-monotonic.test.ts
    - packages/server/test/group-semantics.test.ts
    - packages/server/test/ws-hibernation-wiring.test.ts
    - packages/server/test/retention-alarm.test.ts
  modified:
    - packages/server/src/chat-room.ts（webSocketMessage 完整实现 + 首连推送 + sendHistory + alarm）
    - packages/server/test/ws-fanout.test.ts / send-payload-fields.test.ts（排空 D-09 首拉帧）
    - scripts/smoke.mjs（D-15 ②③ 完整版）
    - package.json（0.1.3）/ DEPLOY.md（部署记录）

key-decisions:
  - "Flagged Assumption SRV-05（limit 越界钳制不报错）与 01-02 逐字节冻结的 sync-frame.negative.json（\"limit 0/501 -> invalid_frame\"）冲突——按协议 one-way 门（用户裁决 freeze）以冻结契约落地：越界回 invalid_frame；clampSyncLimit 保留为 SQL 层纵深防线（缺省 200 是唯一热路径分支）"
  - "首连推送在返回 101 前同步完成（DO 无 waitUntil，浮空 Promise 在 fetch 返回后不可靠）——升级路径零 await，全同步查询入队后返回"
  - "workerd 同 isolate 下 message 事件即发即弃（不排队）——测试监听器必须 attach-before-trigger；此为 Task 2 三个测试文件初版挂死的根因，已固化为测试模式写进文件头"
  - "生产冒烟让位于网络现实：workers.dev SNI 阻断持续 ~75 分钟，部署本身成功（e20626bf）；以真实 workerd 52/52 为功能等价证据，冒烟补验记入 WINDOWS.md unrun-verify"

patterns-established:
  - "Pattern: 帧读取四式——预挂首帧监听（connect 返回 firstFrame promise）、attach-then-trigger（先挂监听再 publish/send）、多连接全建连后统一 await、Node 冒烟脚本 open 前挂监听帧按序入数组"
  - "Pattern: alarm 测试三板斧——runDurableObjectAlarm(stub) 即时触发（返回 bool 证 alarm 已设）、二次触发证幂等、runInDurableObject 读 getAlarm 证重设窗口"
  - "Pattern: 限流窗口内大批量发送 = 内部端点直调 + i%N 键轮换（每键恰 30 条阈值内全放行）"

requirements-completed: [SRV-04, SRV-05, SRV-06]

coverage:
  - id: D1
    description: "sync 补拉语义（D-09/D-10/D-11）：首连即收 50 条、keyset 翻页缺省 200、220 条三帧并集恰为 1..220 零丢失零重复、limit 三态（缺省 200/越界 invalid_frame 按冻结契约/合法 500 单页全量）、oldest_kept_seq 诚实标记、空频道 0、非法帧回 WsErrorFrame 不断连"
    requirement: SRV-05
    verification:
      - kind: integration
        ref: "packages/server/test/sync-catchup.test.ts（3/3 绿：220 全链路 + 空频道 + 非法帧矩阵，错误帧与 fixture 逐字节一致）"
        status: pass
    human_judgment: false
  - id: D2
    description: "群聊语义（SRV-06）：三客户端同帧互通（v/wid/seq/text 逐字段相等）、断开不影响其余端、重连 sync since=2 恰补 5 条离线窗口消息（seq 连续）、死连接不中断收件"
    requirement: SRV-06
    verification:
      - kind: integration
        ref: "packages/server/test/group-semantics.test.ts（1/1 绿，经真实 Worker 入口）"
        status: pass
    human_judgment: false
  - id: D3
    description: "seq 原子性与无服务端去重：20 并发 /api/send seq 集合恰为 1..20（DO 单线程 + 同步块原子提交证据）；同文本重发新 seq 新 wid"
    requirement: SRV-05
    verification:
      - kind: integration
        ref: "packages/server/test/seq-monotonic.test.ts（2/2 绿）"
        status: pass
    human_judgment: false
  - id: D4
    description: "Hibernation 接线（SRV-04）：ping 字面量零唤醒自动回 pong、evictDurableObject 驱逐后 pong 仍回（Pitfall 3 回归）/新消息仍达休眠连接句柄/attachment 跨驱逐逐字段恢复"
    requirement: SRV-04
    verification:
      - kind: integration
        ref: "packages/server/test/ws-hibernation-wiring.test.ts（1/1 绿，evict → pong → publish → message → attachment 对照）"
        status: pass
    human_judgment: false
  - id: D5
    description: "D-08 保留清理 alarm：600 条 → 恰存 500（oldest_kept_seq=101）、DELETE 恒为 seq <= max-500 形态永不删 max 行、二次触发幂等、清理后 seq=601 单调、过期限流桶清扫（活跃桶保留）、getAlarm 重设未来 24h 内"
    requirement: SRV-05
    verification:
      - kind: integration
        ref: "packages/server/test/retention-alarm.test.ts（1/1 绿：runDurableObjectAlarm 双触发 + runInDurableObject 表/alarm 读取对照）"
        status: pass
      - kind: other
        ref: "grep 验收：构造器 0 个 setAlarm；setAlarm 仅 publish 判空后与 alarm finally 两处；全量套件 12 文件 52/52 绿"
        status: pass
    human_judgment: false
  - id: D6
    description: "v0.1.3 生产部署（Worker Version e20626bf）+ D-15 ②③ 完整冒烟（首拉帧检查 + 断开→2 条→重连→sync since 恰补 2 条）"
    requirement: SRV-04
    verification:
      - kind: other
        ref: "pnpm --filter @pushhub/server run deploy → Deployed pushhub, Version ID e20626bf-2dfe-4c6a-ac28-ac73af3719e2（部署经 api.cloudflare.com 不受阻断影响）"
        status: pass
      - kind: e2e
        ref: "PH_SMOKE_URL=https://pushhub.snake160220.workers.dev node scripts/smoke.mjs —— 被本机网络对 *.workers.dev 的 SNI 阻断（持续 ~75 分钟，39 轮重试 + DoH/--resolve/边缘 IP/wrangler dev --remote/本地代理全部不可行）"
        status: unknown
    human_judgment: true
    rationale: "生产冒烟未能执行：网络层 SNI 重置 + DNS 污染属环境阻断非代码缺陷。功能等价证据为真实 workerd 52/52（与冒烟步骤逐一对应）。需网络恢复后重跑冒烟脚本补验，并由人工完成 D-15 ④ dashboard DO duration 观察（验收 3 的完整复核点——本计划后 sync/alarm 全部上线）"

duration: 97min
completed: 2026-08-26
status: complete
---

# Phase 1 Plan 4: 接收侧完整化 Summary

**sync 补拉全语义落地（首连推 50 + keyset 翻页 + oldest_kept_seq 诚实缺口）+ alarm 每日保留清理（500 条窗口 + 限流桶清扫 + 自愈重设）+ 群聊/seq 原子/休眠驱逐三组行为钉子——Phase 1 全量 12 测试文件 52/52 绿，v0.1.3 已部署（生产冒烟因网络阻断待补验）**

## Performance

- **Duration:** 97 min（墙钟，含 ~75 分钟 workers.dev 网络阻断等待；纯执行约 25 分钟）
- **Started:** 2026-08-26T07:33:48Z
- **Completed:** 2026-08-26T09:11:XXZ
- **Tasks:** 3/3
- **Files modified:** 11（5 测试创建 + chat-room.ts + 2 既有测试适配 + smoke.mjs + package.json + DEPLOY.md）

## Accomplishments

- **断线重连补拉零丢失零重复的完整链路成立（验收 2 服务端侧闭合）**：220 条场景三帧（首拉 50 + 翻页 200 + 20）seq 并集恰为 1..220；离线窗口 5 条恰补 5 条且 seq 连续；哑管道贯穿补拉路径（text 逐字透传、wid 全局唯一）
- **免费额度防线全部闭合（验收 3 的机制侧）**：休眠接线（evict 后 pong/消息/attachment 全恢复）、保留清理（600→恰 500，永不删 max 行）、限流桶清扫、构造器零 setAlarm（Pitfall 7 回归钉死）——空闲频道不烧 GB-s 的全部前提可自动化验证
- **协议冻结的最后一环接线**：validateInboundFrame 成为入站帧唯一白名单门（任何入站字符串不直接进 SQL，T-01-07 缓解落地）；history 帧与实时扇出帧逐字段同构；fixtures 字节基线未动（git diff 6ef00e6 HEAD -- packages/shared/fixtures/ 为空）
- **测试模式知识固化**：workerd 同 isolate 下 message 事件即发即弃——attach-before-trigger 铁律与 connect() 预挂首帧监听模式，写入各测试文件头供 01-05 与 Phase 2 复用

## Task Commits

1. **Task 1: sync 补拉语义——首连推送 50 条 + keyset 翻页 + oldest_kept_seq 缺口标记** — `d46bd71` (feat)
2. **Task 2: 群聊语义 + seq 幂等 + 休眠接线三组测试** — `bb99240` (test)
3. **Task 3: 保留清理 alarm——500 条窗口 + 限流桶清扫 + 永不删 max 行** — `6bf51a6` (feat，含 smoke.mjs D-15 ②③ 扩展)
4. **计划级验证：v0.1.3 部署记录（冒烟待补）** — `68842cb` (chore)

**Plan metadata:** 本 SUMMARY 所在 commit (docs)

## Files Created/Modified

- `packages/server/src/chat-room.ts` — webSocketMessage 完整实现（validateInboundFrame 门 + ping 防御忽略 + sync 分发）；sendHistory（首拉 DESC LIMIT+1 反转 / keyset ASC LIMIT+1，oldest_kept_seq=MIN(seq)??0）；升级路径首推（全同步）；rowToMessageFrame（与扇出帧同构）；clampSyncLimit（缺省 200/[1,500] 纵深钳制）；alarm()（两条 DELETE + 自 catch + finally 重设）；publish 成功路径 getAlarm 判空设首个 alarm
- `packages/server/test/sync-catchup.test.ts` — D-09/D-10/D-11 全语义（220 条全链路/空频道/非法帧矩阵，错误帧与 ws-error-frame.json 逐字节一致）
- `packages/server/test/seq-monotonic.test.ts` — 20 并发 seq 恰 1..20 + 同文本重发新 seq 新 wid
- `packages/server/test/group-semantics.test.ts` — 三端同帧互通/断开隔离/重连恰补 5 条/死连接不中断
- `packages/server/test/ws-hibernation-wiring.test.ts` — ping→pong 字节精确/evict 后 pong+消息+attachment 恢复
- `packages/server/test/retention-alarm.test.ts` — 600→恰 500（oldest=101）/幂等/seq=601/桶清扫/getAlarm 重设
- `packages/server/test/ws-fanout.test.ts` / `send-payload-fields.test.ts` — 排空 D-09 首拉帧（新连接契约适配）
- `scripts/smoke.mjs` — D-15 ②③ 完整版（首拉帧检查 + 断开→2 条→重连→sync 恰补 2 条 seq 连续；预挂监听帧收集模式）
- `package.json`（0.1.3）/ `DEPLOY.md`（0.1.3 行 + checklist ③ 状态更新）

## Decisions Made

- **Flagged Assumption 与冻结契约冲突的裁决（SRV-05 limit 越界语义）**：计划设想"limit>500 钳为 500、<1 钳为 1，均不报错"，但 01-02 逐字节冻结的 sync-frame.negative.json 明文 "limit 0 / 501 -> invalid_frame"（one-way 门，用户裁决 freeze）——按冻结契约落地：越界回 WsErrorFrame invalid_frame（连接保持）；clampSyncLimit 保留为 SQL 层纵深防线，缺省 200 是其唯一热路径分支。测试三态断言完整（缺省恰 200 / 999 与 0 回 invalid_frame 与 fixture 逐字节一致 / 合法 500 单页全量）
- **首连推送时点**：返回 101 前同步完成（DO 无 waitUntil，fetch 返回后浮空 Promise 不可靠）；升级路径零 await——accept → serialize → 同步查询 → send → 101
- **生产冒烟的诚实记录**：网络阻断不为凑绿而绕过（远程预览不支持 SQLite DO、本地 dev 违背 D-14 初衷均明确否决），以真实 workerd 52/52 为功能等价证据 + WINDOWS.md unrun-verify 追踪补验
- **测试内限流规避双策略**（220/600 条场景）：DO /publish 直调 + i%20 键轮换（每键恰 30 条阈值内全放行）——注明于测试文件头

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] D-09 首连推送破坏既有测试的帧序假设**
- **Found during:** Task 1（全量套件首跑：ws-fanout 1 例 + send-payload-fields 2 例失败）
- **Issue:** 01-04 起每次连接 accept 后立即收首拉 history 帧——既有三处测试假设"连接后首帧即 message 帧"
- **Fix:** 三处连接后先排空首拉 history 帧并断言 type（顺带成为 D-09 接线的额外断言）
- **Files modified:** packages/server/test/ws-fanout.test.ts, packages/server/test/send-payload-fields.test.ts
- **Verification:** 全量套件 52/52 绿
- **Committed in:** d46bd71

**2. [Rule 1 - Bug] 新测试初版挂死：workerd 同 isolate 下 message 事件即发即弃**
- **Found during:** Task 2（group-semantics / ws-hibernation-wiring 5s 超时；4 个诊断探针定位）
- **Issue:** 监听器在触发动作（publish/send）之后才挂——事件已带着无监听状态发过即丢；多连接场景逐个 await 建连同样丢帧
- **Fix:** attach-then-trigger 铁律 + connect() 内同步预挂首帧监听（accept 与 addEventListener 间零 await）
- **Files modified:** packages/server/test/group-semantics.test.ts, packages/server/test/ws-hibernation-wiring.test.ts（铁律写入文件头）
- **Verification:** 两文件单独与合跑均绿（254ms / 全量 2.8s）
- **Committed in:** bb99240

**3. [Rule 3 - Blocking] typecheck：toArray 返回类型与 MessageRow 直转被拒**
- **Found during:** Task 1（首次 typecheck）
- **Issue:** `Record<string, SqlStorageValue>[]` → `MessageRow[]` 无充分重叠
- **Fix:** `as unknown as MessageRow[]` 双转（与既有单元素转型风格一致处取数组形态）
- **Files modified:** packages/server/src/chat-room.ts
- **Verification:** typecheck 通过
- **Committed in:** d46bd71

**4. [计划歧义消解] Flagged Assumption（limit 越界钳制不报错）与冻结 fixtures 冲突**
- **Found during:** Task 1（sync-catchup 钳制断言设计时）
- **Issue:** 计划 flagged assumption 与 01-02 逐字节冻结的 sync-frame.negative.json（"limit 0/501 -> invalid_frame"）不可同时成立
- **Fix:** 冻结契约优先（协议 one-way 门）；钳制函数保留为纵深防线；测试按冻结语义断言（三态全覆盖）
- **Files modified:** packages/server/src/chat-room.ts, packages/server/test/sync-catchup.test.ts
- **Verification:** 错误帧与 fixture 逐字节 toEqual 通过
- **Committed in:** d46bd71

---

**Total deviations:** 3 auto-fixed（2 bug、1 blocking）+ 1 计划歧义消解
**Impact on plan:** 全部为必要修复，无范围蔓延；无 stub、无跳过的测试；1 个未运行的生产冒烟验证（环境阻断，见 Issues）。

## Issues Encountered

- **workers.dev 生产冒烟被网络阻断（未解决，已登记追踪）**：部署本身成功（Version e20626bf，经 api.cloudflare.com）；本机对 `*.workers.dev` 出现持续 ~75 分钟的 SNI 重置 + DNS 污染（AliDNS DoH 同样返回污染记录）。尝试路径全部否决：39 轮直接重试、DoH 解析真实 IP + `--resolve`（SNI 重置）、干净 Cloudflare 边缘 IP 换 SNI（同上）、`wrangler dev --remote`（**SQLite-backed DO 不支持远程预览**——独立发现已记入 DEPLOY.md）、本地代理 127.0.0.1:30808（未监听）。**补验命令**：`PH_SMOKE_URL=https://pushhub.snake160220.workers.dev node scripts/smoke.mjs`（脚本已含 D-15 ③ 完整断言）。已记入 WINDOWS.md（kind: unrun-verify）
- **D-15 ④ dashboard DO duration 人工核对**（计划 human-check 项）：本计划后 sync/alarm 全部上线，是验收 3 的完整复核点——待用户在 Cloudflare dashboard 观察（冒烟频道空闲数分钟 duration 应无增长）

## User Setup Required

None - no external service configuration required.（wrangler 登录态与 ADMIN_KEY 沿用；网络恢复后重跑冒烟即可补验。）

## Next Phase Readiness

- **就绪**：01-05（Admin API）——Phase 1 最后一个计划；DO 侧错误信封与 KV 键表写路径（ch:/sk:/id:）为剩余主体
- **就绪**：Phase 2 web-sdk——重连协议的全部服务端语义已冻结并可测：首连首拉 50、sync since keyset 翻页（缺省 200/上限 500）、oldest_kept_seq 缺口分隔线、has_more 续翻、部署断连后重连补拉（smoke.mjs 的 c1-c5 即客户端行为模板）
- **注意点**：① 生产冒烟补验 + dashboard duration 观察两项待网络窗口/人工（见 Issues）；② wrangler dev --remote 不支持 SQLite DO——生产差异验证只能走 workers.dev 部署（D-14 流程不变）；③ 测试监听 attach-before-trigger 铁律对 Phase 2 SDK 的 Playwright 页面测试同样适用
- **协议基线仍冻结**：`git diff 6ef00e6 HEAD -- packages/shared/fixtures/` 为空——本计划未触碰任何 fixture 字节

## Self-Check: PASSED

- 关键文件存在性：sync-catchup / seq-monotonic / group-semantics / ws-hibernation-wiring / retention-alarm 五个测试文件 + chat-room.ts 全部 FOUND
- 提交存在性：d46bd71、bb99240、6bf51a6、68842cb 均在 git log
- 验收复跑：`pnpm --filter @pushhub/server test` 52/52 绿（12 文件——01-VALIDATION 测试文件全集闭合）；`pnpm --filter @pushhub/server typecheck` 通过
- fixtures 字节冻结性：`git diff 6ef00e6 HEAD -- packages/shared/fixtures/` 为空
- 服务端零 Node 依赖：`grep -rn "node:" packages/server/src/` 为 0

---
*Phase: 01-server-core*
*Completed: 2026-08-26*
