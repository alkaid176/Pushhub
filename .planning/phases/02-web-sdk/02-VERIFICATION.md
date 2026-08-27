---
phase: 02-web-sdk
verified: 2026-08-27T14:20:00Z
status: passed
score: 12/12 must-haves verified
behavior_unverified: 0 # 全部行为依赖型 truth 均有本次独立重跑的通过测试或生产字节直测证据
overrides_applied: 0
re_verification:
  previous_status: human_needed
  previous_score: 10/10
  gaps_closed:
    - "G-02-2：SVG 命名空间锚点两分支判定（02-04，df81d41）"
    - "G-02-3：build.mjs 构建期版本注入（02-05，d4c0c63）"
    - "G-02-4：WR-02 FORBID_TAGS + WR-03 localStorage 读防护 + WR-04 WS_FAIL（02-04/02-05）"
    - "CR-01（gap-closure 评审 Critical）：FORBID_ATTR style/class/id（9e7cfc8，上线 0.1.10）"
    - "先前 6 项 human_verification 经 02-UAT.md 全部裁决通过（dashboard 三角验证 pass / prohibitions 背书 pass）"
  gaps_remaining: []
  regressions: []
deferred: # 信息性——REQUIREMENTS 追溯表属 Phase 4 的既定拆分，非本阶段遗留
  - truth: "WEB-03：SDK 支持宿主页面发起回复（快捷选项或自定义文本）"
    addressed_in: "Phase 4"
    evidence: "REQUIREMENTS.md Traceability：WEB-03 → Phase 4 Pending（RPL 双向通信阶段，路线图既定拆分）"
  - truth: "ADM-04：测试页（可视化发消息/看消息流/发起回复）"
    addressed_in: "Phase 4"
    evidence: "REQUIREMENTS.md Traceability：ADM-04 → Phase 4 Pending（查看器 D-22 边界已明示'回复属 Phase 4'）"
---

# Phase 2: Web SDK 参考客户端 Verification Report（Gap Closure 后重验）

**Phase Goal:** 任何网页引入单文件 pushhub.js 即可实时接收频道消息并安全渲染；SDK 同时是后续 Tauri/Android 移植的参考实现，以及最廉价的端到端协议验证器
**Verified:** 2026-08-27T14:20:00Z
**Status:** passed
**Re-verification:** Yes — 先前 human_needed（2026-08-27T01:45）的 6 项人工裁决经 02-UAT.md 全部通过，G-02-2/3/4 由 02-04/05/06 闭合，gap-closure 评审 CR-01 由 0.1.10 批次闭合

## 验证方法

不信任 SUMMARY 陈述，全部独立采集：通读修复后的 `render-markdown.ts` / `connection-machine.ts` / `pushhub.ts` / `build.mjs` / `viewer.js` / `index.html` 关键段与全部 15 条 attack-samples fixture；**独立重跑** `pnpm test`（server 60/60 + web-sdk 84/84）、`typecheck`（exit 0）、`e2e`（8/8）；**独立探测生产** https://pushhub.dyun.org（字节比对 / ?v= 引用 / x-ph-worker 标记头对照）；**用生产 81,433 字节产物在 jsdom 直测全部安全主张**（style/class/id 剥离、SVG 锚点 target/rel、SVG javascript: href 剥离、表单标签移除）；核对 CR-01 四提交（834d748/9e7cfc8/ef354ab/6b1a4c9）与 DEPLOY.md 0.1.9/0.1.10 两行；债务标记门与 prohibitions 抽查复跑。

## Goal Achievement（四条 SC 逐条裁决）

| # | SC | Status | Evidence（本次独立采集） |
|---|----|--------|------------------------|
| 1 | SC1：空白页两行接入即收实时消息，零依赖零构建 | ✓ VERIFIED | tracer E2E "两行接入 → 2s 内实收" 本次重跑绿（实测延迟 46ms < 2000ms 验收线）；生产 /pushhub.js 200 + text/javascript + 81,433 字节与本地构建 `cmp` 逐字节一致；生产 / 引用恰一处 `pushhub.js?v=0.1.10`；DEPLOY.md 0.1.10 记录 SMOKE OK 272ms |
| 2 | SC2：部署断连后指数退避 + full jitter（cap 60s）自动重连并补拉，宿主无感 | ✓ VERIFIED | 本次重跑 reconnect E2E 三形态全绿（意外断连恰补 2 条 seq 精确匹配 / 55+5 大缺口补齐 60 条零重复 / 被动 close 恢复）；BACKOFF_CAP_MS = 60_000 源码在位（connection-machine.ts:57），退避曲线/心跳死线单测在 84/84 内；生产部署混沌 CHAOS PASS（0.1.8，Version 34b63d1b，10.7s 恢复恰补 2 条零重复）为该 SC 的生产形态记录，其后 0.1.9/0.1.10 部署未触碰连接层逻辑（9e7cfc8 仅改 render-markdown.ts，git show --stat 核实），机制由 E2E 锁定无回退 |
| 3 | SC3：攻击样本经渲染辅助输出安全 HTML，fixture 回归通过；宿主也可只用原始数据 | ✓ VERIFIED | attack-samples.json 15 条样本（8 基线 + svg-anchor/style-tag/form-controls/task-list + attr-style-overlay/attr-class-forgery/svg-anchor-javascript）由 render.test.ts 逐条断言，在本次 84/84 绿内；**生产字节直测（jsdom，本次执行）**：`<div style="position:fixed...">` → `<div>`（属性剥离）、`class="error-bar"` → 剥离、`id="app"` → 剥离、SVG 锚点带 target=_blank + rel=noopener noreferrer、SVG `xlink:href="javascript:"` → href 剥离、form/input/button 全消失、`<script>` 剥离、`<img onerror>` 剥离；README 记载双形态（renderMarkdown 或仅原始数据） |
| 4 | SC4：pushhub.js 由静态资产分发，不产生 Worker 请求计费 | ✓ VERIFIED | 本次标记头对照：/pushhub.js、/viewer.js、/ 三资产均 200 且响应头无 x-ph-worker（Worker 未运行）；POST /api/send（无鉴权 401 反例，零状态副作用）带 `x-ph-worker: 1`（Worker 恰运行）——对照成立证明资产命中不触发 Worker；dashboard 三角验证已经 02-UAT.md Test 1 用户执行通过 |

**Score:** 4/4 SC verified

## Gap Closure Confirmation（逐项确认）

### G-02-2：SVG 锚点两分支判定 — CLOSED

- **代码**：render-markdown.ts:60 `if (node.tagName === "A" || node.tagName === "a")` —— HTML 命名空间大写 / SVG 命名空间小写两分支同等设 target=_blank + rel=noopener noreferrer
- **测试锁定**：fixture `svg-anchor` 样本 expected 含 target/rel（render.test.ts 逐字断言，84/84 内）
- **生产实证（本次）**：线上 0.1.10 字节 jsdom 直测 SVG 锚点输出 `<a xlink:href="https://ok.example" target="_blank" rel="noopener noreferrer">` ✓
- 提交对：02bf14a（RED）/ df81d41（GREEN），git log 核实在库

### G-02-3：build.mjs 构建期版本注入 — CLOSED

- **代码**：build.mjs:47-67 —— 读根 package.json version，scoped 正则替换 index.html `pushhub.js?v=`，**恰命中一次硬断言**（0/多命中即 console.error + exit 1）
- **测试锁定**：cache-bust-sync.test.ts 两用例（?v= === 根 version 且引用恰一次；真实构建后断言仍成立/幂等），84/84 内
- **生产实证（本次）**：生产 / 引用 `pushhub.js?v=0.1.10`（grep 计数恰 1）=== 根 package.json version `0.1.10` —— 机制经两次真实部署（0.1.9、0.1.10）连续生效
- chaos-sc2.mjs:114 日志已改 `${EXPECT_VERSION}` 插值（grep 证实仅剩 :20 usage 示例残留，见 Issues）
- 提交对：e778955（RED）/ d4c0c63（GREEN）

### G-02-4：三项加固 — CLOSED

| 项 | 代码 | 测试 | 生产/行为证据 |
|----|------|------|--------------|
| WR-02 FORBID_TAGS | render-markdown.ts:75（style/form/input/button/select/textarea/label/option） | style-tag/form-controls/task-list 三 fixture 断言 | 生产字节直测：form/input/button 全消失 ✓（本次） |
| WR-03 viewer localStorage 读防护 | viewer.js:198-205 读取 try/catch（server 回退 origin、key 留空，优先级链与写入侧对齐） | E2E "WR-03：localStorage 全禁环境查看器正常加载" 本次重跑绿（157ms） | — |
| WR-04 畸形 serverUrl 容错 | pushhub.ts openSocket try/catch + setTimeout(0) 延迟派发；connection-machine.ts:316 WS_FAIL case（仅 connecting 态消费，fatal 不复活零定时器） | machine-fatal 6 用例 + adapter-lifecycle 1 用例（84/84 内）+ E2E "WR-04：畸形 serverUrl 查看器呈现 error 态" 本次重跑绿（173ms） | — |

### CR-01（gap-closure 评审 Critical）— RESOLVED

- **代码**：render-markdown.ts:76 `FORBID_ATTR: ["style", "class", "id"]` —— 关闭评审实证的 style 全屏覆盖层钓鱼与 class 命中宿主 error-bar 伪造系统横幅两条直通面
- **fixture**：attr-style-overlay / attr-class-forgery / svg-anchor-javascript（IN-04 的 SVG 危险 scheme 反例样本一并落地）三条新样本，15 条全量在 84/84 绿内
- **TDD 提交**：834d748（RED，恰 2 属性穿透样本失败）→ 9e7cfc8（GREEN，FORBID_ATTR；git show --stat 核实仅改 render-markdown.ts）→ ef354ab（版本 0.1.10）→ 6b1a4c9（部署）
- **生产实证（本次，决定性证据）**：线上 https://pushhub.dyun.org 的 81,433 字节产物 jsdom 直测——`style`/`class`/`id` 三属性全部剥离，输出 `<div>fake-overlay</div>` / `<div>fake-error-banner</div>` / `<div>id-spoof</div>`；产物与本地构建 cmp 逐字节一致
- DEPLOY.md 0.1.10 行完整（Version fd6128cc-2cef-4c65-bf42-6e4ec5ac768b，SMOKE OK 272ms，字节 81,433/27,705）

注：02-06 的 must_haves 以 0.1.9 写就（当时已交付并验证，DEPLOY.md 行在案）；CR-01 批次随后部署 0.1.10，为超集演进——当前生产状态按 0.1.10 验证，全部 truth 以更强证据成立。

## Requirement ID Accounting

| Requirement | Source Plans | Status | Evidence |
|-------------|--------------|--------|----------|
| WEB-01 | 02-01/02-03/02-04/02-05/02-06 | ✓ SATISFIED | IIFE 单文件（dist 仅 pushhub.js）、生产 200 字节一致、?v= 机制生产连续生效、tracer E2E |
| WEB-02 | 02-01/02-02 | ✓ SATISFIED | on() 四事件；E2E 2s 内实收（实测 46ms）；SMOKE OK 272ms |
| WEB-04 | 02-01/02-02/02-06 | ✓ SATISFIED | 退避/死线/交集/去重单测 + reconnect E2E 三形态（本次全绿）+ 生产 CHAOS PASS 记录 |
| WEB-05 | 02-01/02-03/02-04 | ✓ SATISFIED | renderMarkdown + 15 条 fixture 回归 + **生产字节直测全部攻击向量无害** + README 双形态 |

ORPHANED 检查：REQUIREMENTS.md 映射到 Phase 2 的恰为 WEB-01/02/04/05，与全部 PLAN requirements 字段并集一致，无孤儿；四条勾选 [x] 与 Traceability（Complete）已同步。WEB-03/ADM-04 属 Phase 4 既定拆分（见 Deferred）。

## Behavioral Spot-Checks（本次独立执行）

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| 全量单测 | `pnpm test` | server 13 files/60 tests + web-sdk 10 files/84 tests 全绿，exit 0 | ✓ PASS |
| 类型检查 | `pnpm --filter @pushhub/web-sdk run typecheck` | exit 0 | ✓ PASS |
| E2E 套件 | `pnpm --filter @pushhub/web-sdk e2e` | 8/8 passed（1.1m；SC1 延迟 46ms、WR-03 157ms、WR-04 173ms） | ✓ PASS |
| 生产字节一致 | curl 生产 /pushhub.js → cmp 本地 | 81,433 = 81,433 逐字节相同 | ✓ PASS |
| 生产 ?v= 注入 | curl / \| grep -c 'pushhub.js?v=' | 恰 1 处，值为 0.1.10 === 根 version | ✓ PASS |
| SC4 标记头对照 | curl -sI 三资产 + POST /api/send | 三资产 200 无 x-ph-worker；401 反例带 x-ph-worker: 1 | ✓ PASS |
| **生产字节安全直测** | 生产产物 jsdom 执行 renderMarkdown × 8 攻击向量 | style/class/id 剥离、SVG 锚点 target/rel、SVG javascript: href 剥离、表单移除、script/img-onerror 移除——全部无害 | ✓ PASS |
| PING 字节契约 | pushhub.ts:63 ≡ chat-room.ts:44 | `'{"v":1,"type":"ping"}'` 逐字符相同 | ✓ PASS |

## Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| （债务标记门） | — | TBD/FIXME/XXX/TODO/HACK/PLACEHOLDER 于 src/、build.mjs、viewer.js、index.html：**零命中**（本次 grep） | — | 通过 |
| （prohibitions 抽查） | — | 依赖恰 marked/dompurify/@pushhub/shared；dist 仅 pushhub.js；src/ 零 innerHTML；状态机零平台 API；CSP script-src 'self' 无 unsafe-inline | — | 全部通过（UAT Test 5 已人工背书） |

## Issues（遗留 Warning/Info——不阻断阶段目标，均已登记）

1. **[Warning] `.claude/admin.key` 仍无 gitignore 防护**（gap-closure 评审 WR-01；deferred-items.md #1 状态 open）。本次 `git check-ignore .claude/admin.key` 实证 NOT-IGNORED——生产 Admin Key 明文文件仅靠"未被 add"保安全，一次 `git add -A` 即入历史。评审建议归 /gsd-quick 一行修复；建议在 Phase 3 开始前处理并轮换该 Key。
2. **[Warning] README:122-127 仍教授已被机制废除的手工 ?v= 约定**（评审 WR-02），示例值停在 0.1.7，与 build.mjs 注入机制及 index.html"勿手改"注释直接矛盾——第三方照抄会与下次构建注入打架。
3. **[Warning] ?v= 机制保证"与根 version 同步"但不保证"字节变更必然伴随版本 bump"**（评审 WR-03）——改源码忘 bump 时 cache-bust 两断言一致地绿、命中 stale 缓存；可考虑内容哈希或部署前置校验（加固项）。
4. **[Warning] cache-bust-sync Test 2 构建副作用**（评审 WR-04）——真实构建修复 index.html 使 Test 1 失败本地不可复现；评审已给 try/finally 快照还原方案（测试纪律项）。
5. **[Info] IN-01 chaos-sc2.mjs:20 usage 示例硬编码 0.1.8；IN-02 cache-bust 测试注释 0.1.8 过期；IN-03 pushhub.ts:242 catch 注释与实现微偏（行为无害，误导维护）**；IN-05 CSP unsafe-inline 残余暴露面经 CR-01 后仅剩页面自有样式（评审判定可维持现状）。
6. **[流程残留] MVP Goal 格式**：02-UAT Test 6 裁决"重排（/gsd mvp-phase 2）"未执行——ROADMAP Phase 2 Goal 仍为原文（非 User Story 格式，Mode: mvp）。不影响任何 SC 的真实性（本次按四条 SC 完成裁决）；如需格式合规可随时补跑，属 ROADMAP 编辑，无代码影响。
7. **[观察] 生产 `/` HTML 含 Cloudflare 边缘自动注入的隐藏 cdn-cgi 元素**（~1.2KB，bot 检测类）——基础设施行为，/pushhub.js 无注入（字节一致已证）。

## Human Verification Required

无——先前验证的 6 项人工项已经 02-UAT.md 全部裁决通过（dashboard 三角验证、prohibitions 背书、四项裁决均执行落地）；本次未产生新的目标相关人工项。

## Gaps Summary

**阶段目标已达成且经 gap closure 后以更强证据复验**：四条 SC 全部有本次独立采集的行为证据——SC1（E2E 重跑 + 生产字节一致 + ?v= 机制连续两次部署生效）、SC2（三形态 E2E 重跑 + 机制单测 + 生产混沌记录，连接层自 0.1.8 后仅增 WS_FAIL 且有测试锁定）、SC3（15 条 fixture 回归 + **线上字节直测全部攻击向量无害**）、SC4（标记头对照独立复现）。三个 UAT gap（G-02-2/3/4）与评审 Critical CR-01 全部闭合且修复字节已上线生产 0.1.10（cmp 逐字节一致）。无 MISSING/STUB/ORPHANED 工件，无未接线链路，无债务标记，84+60 单测与 8 E2E 本次全绿零回退。

遗留 7 项 Warning/Info（见 Issues，均不属阶段 must-have，已由 deferred-items.md / 评审报告登记跟踪，其中 admin.key 卫生项建议尽快 /gsd-quick 处理）。

结论：**passed** —— 12/12 must-haves（4 SC + G-02-2 + G-02-3 + G-02-4 三子项 + CR-01 + 生产交付 + 回归零回退）全部验证通过。Phase 02 可关闭，进入 Phase 03。

---

_Verified: 2026-08-27T14:20:00Z_
_Verifier: Claude (gsd-verifier)_
