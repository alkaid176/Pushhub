---
phase: 2
slug: web-sdk
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-08-26
---

# Phase 2 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest（SDK 单测用 jsdom/happy-dom 浏览器环境池；E2E 用 Playwright） |
| **Config file** | `packages/web-sdk/vitest.config.ts`（Wave 0 创建；环境池与 Phase 1 服务端 vitest-pool-workers 隔离） |
| **Quick run command** | `pnpm --filter @pushhub/web-sdk test` |
| **Full suite command** | `pnpm -r test` + `pnpm --filter @pushhub/web-sdk test:e2e` |
| **Estimated runtime** | 单测 ~5 秒；E2E（含 wrangler dev 启动）~60-120 秒 |

---

## Sampling Rate

- **After every task commit:** Run `pnpm --filter @pushhub/web-sdk test`
- **After every plan wave:** Run `pnpm -r test`（全 workspace）
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 10 秒（单测层）

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 02-01-01 | 01 | 0 | WEB-01 | — | N/A | unit (Wave 0 stubs) | `pnpm --filter @pushhub/web-sdk test` | ❌ W0 | ⬜ pending |
| 02-01-02 | 01 | 1 | WEB-01 | — | N/A | build check | `pnpm --filter @pushhub/web-sdk build` | ❌ W0 | ⬜ pending |
| 02-01-03 | 01 | 1 | WEB-05 | T-02-XSS | renderMarkdown 消毒输出无 `<script>`/on* 属性/javascript: URL | unit (jsdom + 攻击样本 fixture) | `pnpm --filter @pushhub/web-sdk test` | ❌ W0 | ⬜ pending |
| 02-01-04 | 01 | 1 | WEB-04 | — | N/A | unit (mock WS 重连状态机) | `pnpm --filter @pushhub/web-sdk test` | ❌ W0 | ⬜ pending |
| 02-02-xx | 02 | 2 | WEB-02 | — | N/A | E2E (Playwright + wrangler dev) | `pnpm --filter @pushhub/web-sdk test:e2e` | ❌ W0 | ⬜ pending |

> 注：Task ID 在 PLAN.md 定稿后由 validate-phase 对齐更新；本表为种子行，规划器产出任务后须回填。

---

## Wave 0 Requirements

- [ ] `packages/web-sdk/vitest.config.ts` — 浏览器环境测试池配置
- [ ] `packages/web-sdk/test/` — 重连状态机、seq 去重、消毒管道测试桩
- [ ] `packages/web-sdk/test/fixtures/attack-samples.ts` — 攻击样本 fixture（`<script>` / `<img onerror>` / `javascript:` 等）
- [ ] `packages/web-sdk/package.json` — vitest + jsdom + Playwright devDependencies 安装（安装前过包合法性检查）

*If none: "Existing infrastructure covers all phase requirements."*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| 生产域名分发不触发 Worker 计费（SC4） | WEB-02 | dashboard 请求计数需登录 Cloudflare 控制台观察 | 部署后访问 https://pushhub.dyun.org/pushhub.js 与 demo 页，检查 Cloudflare dashboard Workers 请求计数是否只增 API/WS 请求、不增静态资产请求 |
| iOS Safari 后台冻结恢复 | — | D-27 已裁决：真机验证后置，不追踪 | （后置，有真实 iOS 使用反馈时验证） |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 10s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
