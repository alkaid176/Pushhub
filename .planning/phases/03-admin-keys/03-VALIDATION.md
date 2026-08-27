---
phase: 3
slug: admin-keys
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-08-27
---

# Phase 3 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> 来源：03-RESEARCH.md § Validation Architecture（任务映射从 03-{01..05}-PLAN.md 各任务 `<verify>` 提取）。

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest 4.1.11 + @cloudflare/vitest-plugin 1.1.0（server，真 workerd + 真 KV + 真 DO）；Playwright 1.62.1（E2E，真 Chromium × wrangler dev） |
| **Config file** | packages/server/vitest.config.ts（cloudflareTest + miniflare bindings 注入 TEST_ADMIN_KEY）；packages/web-sdk/playwright.config.ts |
| **Quick run command** | `pnpm --filter @pushhub/server test`（vitest run --max-workers=1 --no-isolate，60 例基线秒级） |
| **Full suite command** | `pnpm test`（server + web-sdk 单测）+ `pnpm --filter @pushhub/web-sdk e2e` |
| **Estimated runtime** | 单测 ~30-60s；E2E 全量（9 spec）~2-3 min |

---

## Sampling Rate

- **After every task commit:** Run `pnpm --filter @pushhub/server test && pnpm --filter @pushhub/server run typecheck`
- **After every plan wave:** Run `pnpm test`（含 web-sdk 单测回归——共享产物 pushhub.js 不应变）
- **Before `/gsd-verify-work`:** Full suite must be green + 生产部署版本 +1 + 冒烟 SMOKE OK（含 /admin.html 资产对照）
- **Max feedback latency:** 60 秒（单测快路径）；E2E 波次级 ~3 分钟

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 03-01-01 | 01 | 1 | KEY-02/ADM-01 | T-03-01~04 | `sk:`/`id:` 新结构只经 keys.ts 写路径；normalize 兼容读旧格式 | integration | `pnpm --filter @pushhub/server test -- admin-channels` | ✅（改） | ⬜ pending |
| 03-01-02 | 01 | 1 | ADM-01/ADM-05 | T-03-05~08 | admin.html CSP `script-src 'self'`；textContent 纪律；Admin Key 仅 localStorage | E2E 切片 | `pnpm --filter @pushhub/web-sdk e2e -- admin.spec.ts` | ❌ W0 | ⬜ pending |
| 03-01-03 | 01 | 1 | ADM-05/SC4 | T-03-09 | /admin.html 命中资产（无 x-ph-worker 头）；/api/admin/* 有头（对照） | E2E+源断言 | admin.spec.ts 内 APIRequestContext 断言 + node token 检查 | ❌ W0 | ⬜ pending |
| 03-02-01 | 02 | 2 | KEY-03/ADM-02 | T-03-10~14 | label 校验（长度/字符集，拒绝注入）；上限 10 双层防线（路由 400） | integration | `pnpm --filter @pushhub/server test -- admin-send-keys` | ❌ W0 | ⬜ pending |
| 03-02-02 | 02 | 2 | KEY-03 | T-03-15~17 | 吊销 = KV sk:/id: 删 + DO /cleanup-rate 即时清理；吊销后 POST 401 | integration | 同上（吊销 401 + 多 Key 隔离断言） | ❌ W0 | ⬜ pending |
| 03-03-01 | 03 | 3 | KEY-04 | T-03-18~19 | /kick-all 经 X-PH-Verified 内部头 only；close 1008 "channel key reset" | integration | `pnpm --filter @pushhub/server test -- admin-reset-kick` | ❌ W0 | ⬜ pending |
| 03-03-02 | 03 | 3 | KEY-02 | T-03-20~21 | /purge deleteAll+deleteAlarm 成对（getAlarm()===null 断言）；KV 先清 DO 后 purge 幂等可重试 | integration | `pnpm --filter @pushhub/server test -- admin-delete` | ❌ W0 | ⬜ pending |
| 03-03-03 | 03 | 3 | ADM-01/02 | T-03-22~23 | 逐字确认框（60s 窗口文案）；前缀匹配禁用联动 | E2E 切片 | admin.spec.ts（viewer 双页踢连观察断言离开 online） | ❌ W0 | ⬜ pending |
| 03-04-01 | 04 | 4 | ADM-03 | — | /history 经 Worker admin 鉴权后转发；limit 钳 [1,500]；keyset 无重叠 | integration | `pnpm --filter @pushhub/server test -- admin-history` | ❌ W0 | ⬜ pending |
| 03-04-02 | 04 | 4 | ADM-03 | T-03-24~25 | 历史渲染 renderMarkdown 唯一 innerHTML 管道；answered 徽标 | E2E 切片 | admin.spec.ts（消毒断言 fixture） | ❌ W0 | ⬜ pending |
| 03-05-01 | 05 | 5 | 全 7 条/D-41 | — | journey test 九步全链路单 test | E2E | `pnpm --filter @pushhub/web-sdk e2e -- admin.spec.ts` | ❌ W0 | ⬜ pending |
| 03-05-02 | 05 | 5 | 部署规约 | — | 生产 /admin.html 200 无 x-ph-worker；smoke 新结构全绿 | 冒烟 | `node scripts/smoke.mjs` + curl 头对照 + dashboard 人工（checkpoint:human-verify） | ✅（改） | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

*任务粒度说明：任务 ID 为计划任务簇级映射（每 plan 3 任务），行内命令即该 plan 全部任务的 `<verify>` 汇总入口；细化到子任务以 PLAN.md 各任务 `<verify>` 字段为准。*

---

## Wave 0 Requirements

- [ ] `packages/server/test/admin-send-keys.test.ts` — KEY-03（CRUD/label 回显/上限 11 个 400/吊销 401/多 Key 隔离）
- [ ] `packages/server/test/admin-reset-kick.test.ts` — KEY-04 + SC2 服务端侧（踢连 close 断言）
- [ ] `packages/server/test/admin-delete.test.ts` — KEY-02 删除全清理（KV 三前缀 miss + DO /history 空 + alarm 删除）
- [ ] `packages/server/test/admin-history.test.ts` — ADM-03 翻页矩阵（seed 多条消息逐页对照，无重叠无遗漏）
- [ ] `packages/web-sdk/e2e/admin.spec.ts` — ADM-01/02/05 + SC2 踢连 + D-41 全链路
- [ ] `scripts/smoke.mjs` 联动（SEND_KEY 取值路径 sendKeys[0].key）+ admin-channels.test.ts 断言 + viewer/reconnect/tracer 三 spec createChannel helper 联动
- [ ] `packages/web-sdk/build.mjs` + cache-bust-sync.test.ts 扩展（admin.html ?v= 注入恰一次断言）

*既有基础设施（vitest-pool-workers、Playwright、wrangler dev、smoke 通道）全部就位——Wave 0 仅新建测试文件，无框架安装。*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| SC4 dashboard 请求计数验证 | ADM-05 | Cloudflare dashboard 无 API，只有控制台人工读数 | 生产部署后打开 dashboard → Workers → Metrics，确认静态页请求不计入（对照 /api/admin/* 计数增长）|
| 核心用户旅程走查 | ADM-01 | D-41 保留项——真实浏览器亲手走查（登录→建频道→建 Key→发消息→历史→重置→吊销→删除） | 03-05 计划内 checkpoint:human-verify 三项验收之一 |
| 删除 dogfooding（one-way） | KEY-02 | one-way 破坏性操作由用户亲手执行（清理生产 smoke- 旧频道即首次 dogfooding） | 03-05 计划内 checkpoint:human-verify；用旧格式 smoke- 频道验证 normalize 兼容 |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies（PLAN.md 每任务 verify 字段可运行）
- [x] Sampling continuity: no 3 consecutive tasks without automated verify（每任务簇均有）
- [x] Wave 0 covers all MISSING references（上表 ❌ W0 项全部列入 Wave 0 清单）
- [x] No watch-mode flags（vitest run / playwright test，无 --watch）
- [x] Feedback latency < 60s（单测快路径）
- [ ] `nyquist_compliant: true` set in frontmatter（execute 阶段全绿后置位）

**Approval:** pending（draft seeded 2026-08-27 by plan-phase）
