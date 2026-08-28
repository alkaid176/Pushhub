---
phase: 4
slug: reply-callback
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-08-28
---

# Phase 4 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest 4.1.11 + @cloudflare/vitest-plugin 1.1.0（server，真 workerd）；vitest node 环境（web-sdk 单测）；@playwright/test 1.62.1（E2E） |
| **Config file** | packages/server/vitest.config.ts / packages/web-sdk/vitest.config.ts / packages/web-sdk/playwright.config.ts |
| **Quick run command** | `pnpm --filter @pushhub/server exec vitest run test/reply-chain.test.ts --max-workers=1 --no-isolate`（单文件） |
| **Full suite command** | `pnpm test`（server + web-sdk 单测）+ `pnpm --filter @pushhub/web-sdk run e2e` |
| **Estimated runtime** | ~30 秒（单测全量）/ ~2 分钟（含 E2E） |

---

## Sampling Rate

- **After every task commit:** Run 对应单文件 quick run（见 Per-Task Verification Map）
- **After every plan wave:** Run `pnpm test`（server + web-sdk 单测全量）
- **Before `/gsd-verify-work`:** Full suite must be green（含 e2e + 生产部署冒烟）
- **Max feedback latency:** ~60 秒

---

## Per-Task Verification Map

> 任务 ID 在 PLAN.md 定稿后回填；下表按计划的验证需求预置。

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 04-01-01 | 01 | 1 | RPL-01/RPL-05 | T-4-6 | reply 帧恰一/白名单/by≤64 校验 | unit（shared fixtures 契约） | `pnpm --filter @pushhub/server exec vitest run test/fixtures-contract.test.ts --max-workers=1 --no-isolate` | ✅ 扩展 | ⬜ pending |
| 04-01-02 | 01 | 1 | RPL-01/RPL-05 | — | reply→ack/error→answered 扇出链 | integration | `pnpm --filter @pushhub/server exec vitest run test/reply-chain.test.ts --max-workers=1 --no-isolate` | ❌ W0 | ⬜ pending |
| 04-01-03 | 01 | 1 | RPL-05（D-42/D-44） | — | 二次 reply 拒绝 + not_found 区分 + 双客户端竞态 | integration | 同上（同文件 describe） | ❌ W0 | ⬜ pending |
| 04-02-01 | 02 | 1 | KEY-06 | T-4-1/T-4-2 | HMAC 三头 + Node createHmac 交叉验证 | integration | `pnpm --filter @pushhub/server exec vitest run test/callback-delivery.test.ts --max-workers=1 --no-isolate` | ❌ W0 | ⬜ pending |
| 04-02-02 | 02 | 1 | RPL-04 | — | alarm 重试档位/封顶/failed 记录/保留清理并存 | integration | 同上（runDurableObjectAlarm 直调） | ❌ W0 | ⬜ pending |
| 04-03-01 | 03 | 2 | WEB-03 | — | SDK reply()/answered 事件/frames 守卫 | unit | `pnpm --filter @pushhub/web-sdk exec vitest run test/frames.test.ts test/adapter-lifecycle.test.ts` | ✅ 扩展 | ⬜ pending |
| 04-04-01 | 04 | 2 | ADM-04/SC1/SC4 | T-4-7 | 测试页全交互（构造→发送→流→回复→冻结→验签→失败查询） | e2e | `pnpm --filter @pushhub/web-sdk run e2e --grep test-page` | ❌ W0 | ⬜ pending |
| 04-04-02 | 04 | 2 | SC5 | T-4-1 | callback-receiver.mjs 完整验签 | smoke/manual | `PH_SMOKE_URL=https://pushhub.dyun.org node scripts/smoke.mjs`（扩展步） | ✅ 扩展 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `packages/server/test/reply-chain.test.ts` — RPL-01/02/05、D-42/D-44 竞态（attach-then-trigger 铁律）
- [ ] `packages/server/test/callback-delivery.test.ts` — RPL-03/04、KEY-06（含 alarm 重试与并存回归）
- [ ] fetchMock 可用性 spike（A2）——callback-delivery 测试前置（保底本地 node:http 接收器）
- [ ] `packages/web-sdk/e2e/test-page.spec.ts` — ADM-04、SC1/SC4 页面侧
- [ ] `cache-bust-sync.test.ts` 扩展 test.html

*既有基础设施（vitest-plugin / playwright / fixtures-contract / smoke.mjs）覆盖其余依赖，无需新增框架。*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| SC5 真实自动化脚本场景端到端 | SC5 | 生产环境 + 真人点击确认 | 部署后：跑 callback-receiver.mjs → 测试页发"部署完成通知"（带 callback_url）→ 人工点确认 → receiver 打印验签结果与续行日志 |
| 生产 dashboard 频道计数核对 | ADM-04 辅助 | Cloudflare dashboard 人工界面 | 部署后在 dashboard 对照测试产生的频道数变化 |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 60s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
