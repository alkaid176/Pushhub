---
phase: 02-web-sdk
verified: 2026-08-27T01:45:00Z
status: human_needed
score: 10/10 must-haves verified
behavior_unverified: 0 # 全部行为依赖型 truth 均有本次独立重跑的通过测试或可复现程序化证据
overrides_applied: 0
deferred: # 信息性——非本阶段范围的缺口，按 REQUIREMENTS 追溯表属 Phase 4
  - truth: "WEB-03：SDK 支持宿主页面发起回复（快捷选项或自定义文本）"
    addressed_in: "Phase 4"
    evidence: "REQUIREMENTS.md Traceability：WEB-03 → Phase 4 Pending（RPL 双向通信阶段，路线图既定拆分，非本阶段遗留）"
  - truth: "ADM-04：测试页（可视化发消息/看消息流/发起回复）"
    addressed_in: "Phase 4"
    evidence: "REQUIREMENTS.md Traceability：ADM-04 → Phase 4 Pending（查看器 D-22 边界已明示'回复属 Phase 4'）"
human_verification:
  - test: "Cloudflare dashboard 三角验证（WINDOWS.md #5，唯一开放项，end-of-phase 设计）"
    expected: "① Workers & Pages → pushhub → Durable Objects → Duration 空闲挂 WS 数分钟后平直不增（D-15④/SRV-04）；② 0.1.7/0.1.8 两次部署的全量断连重连尖峰后回落；③ /pushhub.js 请求不出现在 Workers 请求计数曲线（SC4 dashboard 视角终验；标记头对照已给程序化等价证据，此为三角验证）"
    why_human: "计费/duration 指标仅生产 dashboard 可见，wrangler dev 不驱逐 DO；程序化探针无法读取 dashboard 曲线"
  - test: "裁决 WR-01（评审 Warning，验证器本次已实证复现）：render-markdown.ts:54 钩子判定 node.tagName === 'A' 大小写敏感，SVG 命名空间锚点（tagName 小写 'a'，如 <svg><a xlink:href=\"https://x\">t</a></svg>）不带 target=_blank / rel=noopener noreferrer——D-21 tabnabbing 加固分支可绕过（点击后当前标签页导航离开）；XSS 主防线不受影响（SVG 分支下 javascript:/data: href 仍被 DOMPurify 清除，验证器已测）"
    expected: "修复（两行：tagName === 'A' || node.tagName === 'a'，并在 attack-samples.json 增补 SVG 锚点样本固化回归）或明示接受（接受则在本 frontmatter 加 overrides 条目）"
    why_human: "实现忠实于计划字面（计划只要求 A 元素 hook），缺陷在计划设计；评审定级 Warning、无脚本执行路径——属接受/修复的裁量决策"
  - test: "裁决 CR-01（评审 Critical，advisory）：index.html:130 SDK 缓存参数钉在 ?v=0.1.7 而根版本已是 0.1.8；README 约定措辞（'每次重建产物并部署后同步更新'）与 02-03 决策措辞（'值=产物内容最近一次变更时的部署版本号'）语义不一致；chaos-sc2.mjs:114 另有硬编码 '0.1.7' 日志。当前无功能影响——验证器实测 0.1.7→0.1.8 pushhub.js 字节未变（生产与本地 81,022B 逐字节一致），缓存命中的是相同字节"
    expected: "统一 ?v= 语义（建议：build.mjs 构建期自动注入根版本号，或 CI 断言 index.html ?v= 与根 version 一致）并同步修正 chaos-sc2.mjs 日志；或明示接受'内容变更'语义并改写 README 措辞"
    why_human: "约定语义二选一是流程决策；当前无用户可见缺陷，评审 Critical 定级针对未来部署的机制性风险"
  - test: "裁决 WR-02/WR-03/WR-04 加固批次（可选）：WR-02 DOMPurify 默认 profile 放行面收敛（FORBID_TAGS style/form/input/button 等；注：验证器实测评审给出的 <style> 具体示例经实际管道已被清除，该示例不成立，但默认 profile 广度论点仍有效）；WR-03 viewer.js localStorage 读取路径无 try/catch（写入侧有）；WR-04 畸形 serverUrl 使构造函数同步抛异常、查看器 UI 卡'连接中'"
    expected: "批次修复（均为小改动）或登记为 Phase 4/5 前加固项"
    why_human: "健壮性/加固项，不阻断阶段目标；优先级裁量在用户"
  - test: "背书 14 条 prohibitions（三个 PLAN 的 must_haves.prohibitions，验证器已全部机械验证通过，见 Anti-Patterns 段）"
    expected: "用户确认各条'未发生'结论成立（依赖恰三项/仅 IIFE 单格式/render 模块仅 marked+dompurify/jsdom 承载断言/src 零 innerHTML/PING 常量直发/协议零复制/状态机零平台 API/SYNC_PAGE_MAX 上限/宿主零重复/viewer renderMarkdown 唯一入口/viewer 零 api 调用/文件名无 api 前缀/CSP 无 unsafe-inline）"
    why_human: "prohibition 按流程需人工背书；自动化证据为 grep/测试，语义判断需人确认"
  - test: "处理 MVP 模式格式差异：ROADMAP Phase 2 标记 Mode: mvp，但 Goal 非 User Story 格式（user-story.validate → valid: false）"
    expected: "运行 /gsd mvp-phase 2 重排 Goal 为 User Story 格式，或明示接受现状（本次验证已按 02-01-PLAN 内的用户故事直译完成 User Flow Coverage）"
    why_human: "Goal 措辞归属规划流程；验证器只上报差异，不代为改写路线图"
---

# Phase 2: Web SDK 参考客户端 Verification Report

**Phase Goal:** 任何网页引入单文件 pushhub.js 即可实时接收频道消息并安全渲染；SDK 同时是后续 Tauri/Android 移植的参考实现，以及最廉价的端到端协议验证器
**Verified:** 2026-08-27T01:45:00Z
**Status:** human_needed
**Re-verification:** No — initial verification（本阶段无先前 VERIFICATION.md）

## 验证方法

不信任 SUMMARY 陈述，全部对照实际代码库：通读 `packages/web-sdk/src/` 全部 6 个源文件与 `packages/server/public/{index.html,viewer.js}`、抽查 3 个 E2E spec 与关键单测断言体；**独立重跑** web-sdk 单测（68/68 绿）与 server 回归（60/60 绿）；**独立探测生产**（/pushhub.js 字节比对、x-ph-worker 标记头对照、页面 CSP 与 script 引用）；机械验证全部 14 条 prohibitions；**独立复现**评审 WR-01 的 SVG 锚点绕过（确认存在）与 WR-02 的 style 示例（确认不成立）；核对 git log 13 个阶段提交与 DEPLOY.md 0.1.5–0.1.8 四行记录。

### MVP 模式差异（上报项）

ROADMAP Phase 2 标记 `**Mode:** mvp`，但 Goal 不符合 User Story 格式（`gsd-tools query user-story.validate` → `valid: false`）。按 `verify-mvp-mode.md` 规则应上报差异。因 02-01-PLAN objective 内存在 Goal 的用户故事直译且四条 SC 明确可测，本报告按该用户故事完成 User Flow Coverage，未中止验证——差异处理见 human_verification 末项。

## User Flow Coverage

User story（02-01-PLAN 对 Goal 的直译）：«As a 网页开发者，I want to 在任意页面引入单个 script 标签并 new PushHub(serverUrl, channelKey)，so that 零依赖零构建获得频道消息的实时接收与安全渲染能力。»

| Step | Expected | Evidence | Status |
|------|----------|----------|--------|
| 引入单文件 | `<script src="/pushhub.js">` 即得全局 PushHub（零依赖零构建） | build.mjs 产 IIFE 单文件（81,022B）；本次实测生产 200 + text/javascript + 与本地 dist 逐字节一致；E2E 页面即此形态（tracer.spec.ts:69） | ✓ |
| 构造连接 | `new PushHub(serverUrl, channelKey)` 构造即连 | pushhub.ts:90-105（恰两参，构造即 dispatch CONNECT）；tracer E2E 断言 status → online | ✓ |
| 实时接收 | on("message") 收到频道消息 | tracer.spec.ts:115-122（POST /api/send 后 2000ms 内 text 逐字一致，实测 25ms）；生产 SMOKE OK 338ms（DEPLOY.md 0.1.7） | ✓ |
| 安全渲染 | renderMarkdown 输出可入 DOM 的安全 HTML；或只用原始数据 | render.test（jsdom 10 例）+ 真浏览器 E2E 断言全绿（本次重跑 68/68 内）；README 记载双形态（WEB-05） | ✓ |
| Outcome：零依赖零构建的实时接收+安全渲染 | 用户故事结果子句为真 | 查看器页（生产 https://pushhub.dyun.org/，本次实测 200 含两 script 引用 + CSP）自身即该结果的活样本（D-23） | ✓ |

## Goal Achievement

### Observable Truths（ROADMAP 四条 SC 与三 PLAN truths 合并）

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | SC1：空白页两行接入即收实时消息，零依赖零构建（WEB-01/WEB-02） | ✓ VERIFIED | tracer.spec.ts 实质断言（2s 验收线、text 逐字一致、error 零事件）；viewer.spec.ts 部署形态页面同链路；生产 / 200 且含 /pushhub.js?v=0.1.7 与 /viewer.js 引用（本次实测）；生产 SMOKE OK 338ms < 2000ms（DEPLOY.md 0.1.7） |
| 2 | SC3：攻击样本经渲染辅助输出安全 HTML，fixture 回归通过；宿主也可只用原始数据（WEB-05） | ✓ VERIFIED（附 WR-01 警告） | attack-samples.json 8 类样本 + render.test（首行 jsdom docblock）逐条断言 + tracer/viewer E2E 真浏览器 DOM 审计（无 script/无 on*/无 javascript:/data: href、锚属性齐备）——本次重跑全绿；**验证器独立复现管道**：HTML 锚点带 target/rel、SVG 分支 javascript: href 仍被清除；README 双形态 + click_url 白名单参考实现。⚠ WR-01：SVG 命名空间锚点不带 target/rel（tabnabbing 加固分支绕过，已实证——见 Human Verification #2，XSS 主防线不受影响） |
| 3 | SC2（机制层）：full jitter 退避 cap 60_000、心跳 30s、pong 死线 10s、探活死线 5s（D-27）、v!==1 fatal 断连不重连（WEB-04） | ✓ VERIFIED | connection-machine.ts 常量与逻辑逐行核读（51-66、151-152、189-253、312-354）；machine-backoff（30 次 delay ∈ [0, min(60_000, 500·2^attempt)]，random=1 时 attempt≥7 精确 60_000）、machine-fatal（fatal 后 TIMER/WS_CLOSE/FRAME 全哑火）、machine-heartbeat（三死线 + hidden 取消）、adapter-lifecycle（fake timers 接线 + destroy 零残留）——本次重跑 68/68 全绿 |
| 4 | SC2（行为层）：断连自动重连续补拉，55+5 大缺口 has_more 翻页补齐，宿主零重复零丢失 | ✓ VERIFIED | reconnect.spec.ts 三用例实质断言（意外断连恰补 2 条 seq 精确匹配、55+5 后 seq 恰为 1..60 且 has_more=true 实际观察到、被动 close 恢复；全程零 error 事件）+ history-filter/machine-events 单测；SUMMARY 记录 6/6 e2e 绿 |
| 5 | D-16×D-17 交集语义：on("history") 的 messages 永远只含宿主未见消息，oldest_kept_seq/has_more 原样透传 | ✓ VERIFIED | 唯一实现点 connection-machine.ts:226-253（shouldDeliver 单闸门 + 帧结构原样 spread）；history-filter.test 三例（预置 {1..30} 喂 {20..50} → 恰 {31..50}；全批已见仍发帧保 D-10；完整重连序列宿主零重复）——本次重跑绿 |
| 6 | SC2（生产维度）：查看器保持连接期间重新部署（0.1.8），自动重连续补拉断连期间消息 | ✓ VERIFIED | chaos-sc2.mjs 在库且实质（部署子进程编排 + 90s 轮询 + 事件/DOM 双层恰补断言）；DEPLOY.md 0.1.8 行记录 CHAOS PASS（status 轨迹、10.7s 恢复、恰 2 条零重复，Version 34b63d1b）；本次佐证：0.1.8 特有的 x-ph-worker 标记头生产在线实测工作正常 |
| 7 | SC4：pushhub.js 由静态资产分发，不产生 Worker 请求计费 | ✓ VERIFIED | **本次独立复现标记头对照**：GET /pushhub.js、/、/viewer.js 均 200 且无 x-ph-worker 头（fetch handler 未运行）；POST /api/send（401 反例）带 x-ph-worker: 1（Worker 恰运行）——与 DEPLOY.md 0.1.8 记录一致。dashboard 曲线三角验证留人工项（WINDOWS.md #5） |
| 8 | 生产 /pushhub.js 200 且与本地 dist 字节一致 | ✓ VERIFIED | 本次实测：200 + text/javascript + 81,022 bytes，Buffer.compare 与本地 dist/pushhub.js 逐字节相同（0.1.8 未改 SDK 字节的裁决获独立佐证） |
| 9 | 心跳 PING 字符串常量逐字节等于服务端 auto-response 匹配串 | ✓ VERIFIED | pushhub.ts:60 `const PING = '{"v":1,"type":"ping"}'` ≡ chat-room.ts:44 `PING_FRAME`（逐字符比对相同）；ws.send(PING) 直发（pushhub.ts:161）；adapter-lifecycle 单测含逐字节断言 |
| 10 | 查看器排障细节（D-24/D-10/D-22）+ CSP 纵深 + README API 契约文档（三端移植依据） | ✓ VERIFIED | viewer.js 逐行核读：URL 参数预填自动连接、localStorage 键 pushhub.server/key、oldest_kept_seq 分隔线（>1 修正 + 单次渲染）、click_url scheme 白名单 + noopener、renderMarkdown 唯一 DOM 入口（body.innerHTML 仅此一处）、window.__pushhub/__pushhubViewer 调试句柄、零 /api 调用；index.html:10 CSP `script-src 'self'`（无 unsafe-inline）+ 两外链 script；README 含交集契约原文（"messages 永远只含宿主未见消息"）、四事件表、生命周期、renderMarkdown 双形态、七参数表、三端移植注意、?v= 约定 |

**Score:** 10/10 truths verified（0 present-but-behavior-unverified）

### Deferred Items

| # | Item | Addressed In | Evidence |
|---|------|-------------|----------|
| 1 | WEB-03（SDK 回复能力） | Phase 4 | REQUIREMENTS.md Traceability → Phase 4 Pending；查看器 D-22 边界明示"回复属 Phase 4" |
| 2 | ADM-04（测试页） | Phase 4 | REQUIREMENTS.md Traceability → Phase 4 Pending |

另注（非 deferred、明确不追踪）：iOS Safari 后台冻结 visibilitychange 真机验证按 D-27 决策不追踪（逻辑完备性由 fake timers 单测覆盖）；ROADMAP research note 的真机建议留待有真机时补。

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `packages/web-sdk/src/pushhub.ts` | PushHub 类（四事件 + 生命周期 + 静态 renderMarkdown） | ✓ VERIFIED | 289 行实质 adapter；API 表面与 checkpoint 定稿一致 |
| `packages/web-sdk/src/connection-machine.ts` | 纯状态机（输入事件流→输出动作流，零平台依赖） | ✓ VERIFIED | 369 行；import 仅 @pushhub/shared 常量 + 本包纯模块；grep 证零 WebSocket/window/document（注释除外） |
| `packages/web-sdk/src/frames.ts` | parseServerFrame 接收侧 guard | ✓ VERIFIED | 153 行；版本门先行、结构深校验、未知 type 丢弃；PROTOCOL_VERSION 仅 import |
| `packages/web-sdk/src/dedup.ts` | SeqDedup 去重窗口（DEDUP_WINDOW=1000 裁剪） | ✓ VERIFIED | 47 行；seen Set + lastSeq max + 超窗裁剪 |
| `packages/web-sdk/src/render/render-markdown.ts` | D-20 可移植消毒模块 | ✓ VERIFIED | import 恰 marked+dompurify 两条；afterSanitizeAttributes 强制 target/rel（⚠ WR-01 大小写分支）；无 window 转义降级 |
| `packages/web-sdk/src/entry-iife.cts` | .cts + module.exports IIFE 入口 | ✓ VERIFIED | 恰两行实质（import + module.exports） |
| `packages/web-sdk/build.mjs` | esbuild IIFE + 复制挂载 + 体积报表 + vm 冒烟 | ✓ VERIFIED | 单次 esbuild 调用 --format=iife --global-name=PushHub；复制到 server/public；vm 加载断言 typeof function；120KB 报警线 |
| `packages/web-sdk/test/*`（9 文件）+ fixtures | 单测 + 攻击样本 | ✓ VERIFIED | render(10)/frames(11)/dedup(7)/machine-backoff/fatal/events/heartbeat/history-filter/adapter-lifecycle(合计 68)；attack-samples.json 8 类 |
| `packages/web-sdk/e2e/{tracer,reconnect,viewer}.spec.ts` | 真浏览器 E2E（6 用例） | ✓ VERIFIED | 三 spec 逐行核读，断言实质（seq 精确集、零重复、DOM 审计）；SUMMARY 记录 6/6 绿 |
| `packages/server/public/index.html` | 查看器页 + CSP | ✓ VERIFIED | 133 行；CSP script-src 'self'；/pushhub.js?v=0.1.7 + /viewer.js 外链 |
| `packages/server/public/viewer.js` | 查看器逻辑 | ✓ VERIFIED | 234 行实质（见 truth 10） |
| `packages/web-sdk/README.md` | SDK API 契约文档 | ✓ VERIFIED | 128 行；契约措辞逐项 grep 命中（本次核读确认） |
| `packages/web-sdk/scripts/chaos-sc2.mjs` | 生产混沌一次性 harness | ✓ VERIFIED | 在库且实质（admin 建频道 → Chromium → 部署子进程 → 轮询断言） |
| `DEPLOY.md` 0.1.5–0.1.8 行 | 部署记录 | ✓ VERIFIED | 四行俱全（含 Version ID、SMOKE OK 延迟、SC4/SC2 证据注记） |
| 根 `package.json` | version 0.1.8 + 链式 deploy + 双包 test | ✓ VERIFIED | 逐字核实 |
| `.gitignore` | packages/server/public/pushhub.js 条目 | ✓ VERIFIED | 第 15 行 |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|----|--------|---------|
| build.mjs 产物 | packages/server/public/pushhub.js → wrangler assets → 页面 script 标签 | 复制 + 静态分发 | ✓ WIRED | dist 与 public 字节相同（本次实测）；生产与本地字节相同（本次实测）；E2E 页面经 wrangler dev 静态资产加载（playwright webServer 配置核实） |
| src/pushhub.ts PING | chat-room.ts:44 PING_FRAME | 字节级匹配 | ✓ WIRED | 逐字符相同（本次比对）+ adapter-lifecycle 单测锁定 |
| src/frames.ts | @pushhub/shared ServerFrame + PROTOCOL_VERSION | import 单一来源 | ✓ WIRED | grep 证 src 内零 `= 1` 形式复制 |
| 根 deploy 脚本链 | web-sdk build → server deploy | pnpm run deploy | ✓ WIRED | package.json 逐字核实；DEPLOY.md 流程一致 |
| connection-machine | pushhub.ts adapter | input 事件 / apply 动作 | ✓ WIRED | dispatch/apply 双向翻译完整（8 事件 10 动作全覆盖）；adapter-lifecycle 单测驱动真实接线 |
| index.html script 引用 | /pushhub.js?v= 缓存规避 | 版本参数 | ✓ WIRED（附 CR-01 裁决项） | 引用在位；?v= 语义不一致见 Human Verification #3 |
| viewer.js click_url | scheme 白名单 | safeOpenClickUrl | ✓ WIRED | 仅 http/https 放行 + window.open noopener |
| oldest_kept_seq 分隔线 | HistoryFrame.oldest_kept_seq | maybeSeparator | ✓ WIRED | >1 下界修正（D-10 语义）；viewer.spec 三场景断言 |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|--------------|--------|-------------------|--------|
| pushhub.ts on("message") | emitMessage 载荷 | 真实 WS 帧 → parseServerFrame → shouldDeliver | 是——E2E 断言 text 与 POST 载荷逐字一致 | ✓ FLOWING |
| on("history") | emitHistory.messages | 服务端 SQLite 首拉/sync 批次 → 去重过滤 | 是——55+5 用例断言 seq 恰 1..60 | ✓ FLOWING |
| viewer appendMessage | body.innerHTML | PushHub.renderMarkdown(m.text) | 是——viewer E2E 断言 strong 元素来自真实消息 | ✓ FLOWING |
| 生产 /pushhub.js | 响应体 | 本地 dist 构建产物（esbuild bundle 真源码） | 是——81,022B 逐字节一致（本次实测） | ✓ FLOWING |

无静态返回/硬编码/mock 数据源。

### Behavioral Spot-Checks（本次独立执行）

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| web-sdk 全量单测 | `pnpm --filter @pushhub/web-sdk test` | 9 files / 68 tests passed, exit 0（1.33s） | ✓ PASS |
| server 回归基线 | `pnpm --filter @pushhub/server test` | 13 files / 60 tests passed, exit 0（4.95s，真实 workerd） | ✓ PASS |
| SC4 标记头对照（生产） | node fetch /pushhub.js、/、/viewer.js、POST /api/send（无鉴权 401 反例，零状态副作用） | 三资产 200 且无 x-ph-worker；/api/send 401 带 x-ph-worker: 1 | ✓ PASS |
| 生产字节一致（SC4 前半） | node Buffer.compare(生产体, 本地 dist) | 81,022 bytes 完全相同 | ✓ PASS |
| 消毒管道独立复现（SC3） | node 重放 marked→DOMPurify 管道（jsdom） | HTML 锚带 target/rel；SVG javascript: href 清除；**SVG 锚点不带 target/rel（WR-01 实证）**；评审 WR-02 的 `<style>` 示例经实际管道被清除（该示例不成立） | ✓ PASS（主防线）+ ⚠ WR-01 确认 |
| PING 字节契约 | 人工比对 pushhub.ts:60 与 chat-room.ts:44 | 逐字符相同 | ✓ PASS |
| E2E 套件 | 未重跑（需拉起 wrangler dev 服务，超验证约束） | tracer 2 + reconnect 3 + viewer 1 断言体逐行核读为实质断言；SUMMARY 记录 6/6 绿 | ? 记录证据（不阻断——单测 + 生产探针为等价行为证据） |

### Probe Execution

| Probe | Command | Result | Status |
|-------|---------|--------|--------|
| 生产资产探针 | node fetch × 4（见上表） | 全部符合预期 | ✓ PASS |
| 生产冒烟（smoke.mjs） | 需 PH_ADMIN_KEY 且会建频道（生产状态写入）——验证约束禁状态变更，未执行 | DEPLOY.md 记录 0.1.5/0.1.6/0.1.7/0.1.8 四次 SMOKE OK（延迟 274/368/338ms + 0.1.8） | ? 记录证据（脚本在库，Phase 1 验证已审） |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| WEB-01 | 02-01, 02-03 | 单文件分发零依赖零构建，script + new PushHub 即用 | ✓ SATISFIED | IIFE 产物 + 生产 200 字节一致（本次实测）+ tracer/viewer E2E + 查看器活样本 |
| WEB-02 | 02-01, 02-02, 02-03 | 实时接收经回调/事件暴露 | ✓ SATISFIED | on 四事件；E2E 2s 内实收 text 一致；生产 SMOKE 338ms |
| WEB-04 | 02-01, 02-02 | 断线重连（退避+jitter）+ 离线补拉，宿主无感 | ✓ SATISFIED | 68 单测（退避曲线/死线/探活/交集/去重）+ reconnect E2E 三形态 + 生产 CHAOS PASS（记录） |
| WEB-05 | 02-01, 02-03 | 渲染辅助（Markdown+DOMPurify）+ 原始数据双形态 | ✓ SATISFIED | renderMarkdown 静态方法 + 双层消毒断言 + README 双形态文档；附 WR-01/WR-02 加固裁决项 |

ORPHANED 检查：REQUIREMENTS.md 映射到 Phase 2 的 4 个 ID（WEB-01/02/04/05）与三 PLAN requirements 字段并集完全一致，无孤儿；勾选状态 [x] 与 Traceability（Complete）已同步更新。

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| src 全目录 + viewer + README | — | TBD/FIXME/XXX/TODO/PLACEHOLDER/占位短语：**零命中**（本次 grep） | — | 债务标记门通过 |
| packages/web-sdk/src/render/render-markdown.ts | 53-58 | WR-01：afterSanitizeAttributes 大小写敏感，SVG 命名空间锚点绕过 D-21 强制新窗口（**验证器已实证复现**；XSS 主防线不受影响——SVG 分支 javascript: href 仍被清除） | ⚠️ Warning（评审定级；裁决项） | D-21 加固不变量的可绕过分支；两行修复 + fixture 增补 |
| packages/server/public/index.html | 130 | CR-01：?v=0.1.7 vs 根版本 0.1.8；README 与 02-03 决策的 ?v= 语义措辞不一致；chaos-sc2.mjs:114 硬编码版本日志（当前无功能影响——SDK 字节未变，本次实测佐证） | ⚠️ Warning（评审定级 Critical；advisory 裁决项） | 未来部署机制性 stale 缓存风险 |
| render-markdown.ts | 60 | WR-02：DOMPurify 默认 profile 广度（style/form/input 等放行面）——评审具体 `<style>` 示例经实际管道验证不成立，论点降级为一般加固建议 | ⚠️ Warning | 攻击面收敛建议 |
| viewer.js | 198-199 | WR-03：localStorage 读取无异常防护（写入侧有），存储全禁环境脚本中途夭折 | ⚠️ Warning | 边缘环境页面半残 |
| pushhub.ts | 91-94 | WR-04：畸形 serverUrl 构造函数同步抛异常，查看器 UI 卡"连接中" | ⚠️ Warning | 健壮性 |

### Prohibitions 机械验证（14 条全部通过）

依赖恰 marked/dompurify/@pushhub/shared 三项（package.json 逐字核实）✓｜仅 IIFE 单格式（build.mjs 单次 esbuild 调用、dist 仅 pushhub.js）✓｜render 模块 import 恰两条 ✓｜jsdom 承载断言（render.test.ts 首行 docblock、零 happy-dom）✓｜src/ 零 innerHTML 赋值 ✓｜PING 字符串常量直发 ✓｜协议常量零复制（src 内 PROTOCOL_VERSION 仅 import）✓｜状态机零平台 API（grep 仅注释命中）✓｜SYNC_PAGE_MAX=100 + 超限 emitError（单测覆盖）✓｜宿主零重复（history-filter + E2E 双层断言）✓｜viewer renderMarkdown 唯一 DOM 入口 ✓｜viewer/index 零 /api 调用 ✓｜public/ 文件名无 api 前缀 ✓｜CSP script-src 'self' 无 unsafe-inline ✓

### 观察项（非缺口）

1. 生产 `/` 的 HTML 与本地文件有 ~1.2KB 差异：Cloudflare 边缘自动注入隐藏 `<a href=".../cdn-cgi/content?id=...">`（bot 检测类注入，`display:none`）——基础设施行为，非仓库代码差异；/pushhub.js 无注入（字节一致）。若需字节级可复现对照，可在 README 记录此现象。
2. E2E playwright 配置 `reuseExistingServer: true`（评审 IN-03）——本地迭代选择，残留 dev 服务时可能测旧产物，属测试纪律项。

### Human Verification Required

见 frontmatter `human_verification`（6 项）：

1. **Cloudflare dashboard 三角验证**（WINDOWS.md #5 唯一开放项）——DO Duration 平直、部署尖峰回落、/pushhub.js 不进 Workers 请求曲线（~1 分钟）。
2. **WR-01 裁决**——SVG 锚点 D-21 绕过（验证器已实证）：修复（两行 + fixture 增补）或明示接受。
3. **CR-01 裁决**——?v= 缓存参数约定语义统一 + 机制化（build 注入或 CI 断言）或接受"内容变更"语义。
4. **WR-02/03/04 加固批次**——可选修复或登记后续阶段。
5. **14 条 prohibitions 人工背书**——机械证据全过，按流程需确认。
6. **MVP Goal 格式差异**——/gsd mvp-phase 2 重排或接受现状。

### Gaps Summary

**阶段目标已在代码库与生产双层面达成**：四条成功标准全部有本次独立采集的证据——SC1（两行接入 E2E + 生产页面/产物实测）、SC2（68 例单测锁定机制 + 三形态混沌 E2E + 生产部署 CHAOS PASS 记录）、SC3（fixture 回归 + 真浏览器断言 + 验证器独立复现管道，XSS 主防线普遍成立）、SC4（标记头对照独立复现 + 字节一致实测）。SDK 公开 API 表面、README 移植契约、查看器、DEPLOY.md 记录全部在位且实质。无 MISSING/STUB/ORPHANED 工件，无未接线链路，无债务标记。

不阻断但需裁决的缺陷（评审 + 验证器实证）：WR-01（SVG 锚点绕过 D-21 加固，确认真实但无脚本执行路径）、CR-01（?v= 约定机制性风险，当前无功能影响）、WR-02/03/04（加固项）。两项环境/人工依赖：dashboard 三角验证（manual-only）、MVP Goal 格式差异（流程项）。

结论：**human_needed** —— 自动化可判定范围 10/10 全部通过；6 个人工项（1 项 dashboard 观察、3 项评审裁决、1 项禁令背书、1 项 MVP 格式决策）完成后阶段即可 closed。

---

_Verified: 2026-08-27T01:45:00Z_
_Verifier: Claude (gsd-verifier)_
