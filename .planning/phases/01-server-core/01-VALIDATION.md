---
phase: 1
slug: server-core
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-08-26
---

# Phase 1 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest 4.1.11 + `@cloudflare/vitest-plugin` 1.1.0（跑在真实 workerd：真 DO/KV/WS/SQLite） |
| **Config file** | `packages/server/vitest.config.ts`（Wave 0 创建；`cloudflareTest({wrangler:{configPath:"./wrangler.jsonc"}})`） |
| **Quick run command** | `pnpm --filter @pushhub/server test` |
| **Full suite command** | `pnpm --filter @pushhub/server test`（单套件，`vitest run --max-workers=1 --no-isolate`） |
| **Estimated runtime** | ~30-60 seconds |

**测试组织铁律（研究结论）**：WS+DO 不支持按文件隔离 → 整套件 `--max-workers=1 --no-isolate` 共享存储 → 每测试文件以 `crypto.randomUUID()` 派生唯一频道名/key 前缀做文件间隔离。

---

## Sampling Rate

- **After every task commit:** Run `pnpm --filter @pushhub/server test`
- **After every plan wave:** Run `pnpm --filter @pushhub/server test` 全量 + `wrangler deploy` 生产冒烟（D-14：每 PLAN 完成即部署）
- **Before `/gsd-verify-work`:** Full suite must be green + D-15 五分钟生产 checklist 完成
- **Max feedback latency:** 60 seconds

---

## Per-Task Verification Map

> 任务 ID 在 PLAN.md 产出后由 validate-phase 对齐填充；下表先按 req→test 映射冻结契约。

| Req ID | Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-------------|--------|
| SRV-01 | /api/send 鉴权+落库+响应（含 401/无效 key） | integration | `pnpm --filter @pushhub/server test -- test/send-basic.test.ts` | ❌ W0 | ⬜ pending |
| SRV-01/D-02/D-04/D-06 | 载荷校验（超限 413/枚举 400/错误信封） | integration | `… test/send-validation.test.ts` | ❌ W0 | ⬜ pending |
| SRV-02 | options/callback_url 随消息分发 | integration | `… test/send-payload-fields.test.ts` | ❌ W0 | ⬜ pending |
| SRV-03 | WS 连接 + 扇出到多客户端 | integration | `… test/ws-fanout.test.ts` | ❌ W0 | ⬜ pending |
| SRV-04 | 休眠模式接线正确（acceptWebSocket/auto-response） | integration | `… test/ws-hibernation-wiring.test.ts` | ❌ W0 | ⬜ pending |
| SRV-05/D-09/D-10/D-11 | since 补拉/首拉 50 条/翻页 has_more/oldest_kept_seq | integration | `… test/sync-catchup.test.ts` | ❌ W0 | ⬜ pending |
| SRV-05 | seq 单调 + 幂等去重语义 | integration | `… test/seq-monotonic.test.ts` | ❌ W0 | ⬜ pending |
| SRV-06 | 多客户端互通、断开重连零丢失 | integration | `… test/group-semantics.test.ts` | ❌ W0 | ⬜ pending |
| SRV-07/D-06 | golden fixtures 正反例逐字节契约 | unit（fixtures 静态 import） | `… test/fixtures-contract.test.ts` | ❌ W0 | ⬜ pending |
| KEY-01/D-12/D-13 | 三级密钥 + Admin API 创建/列表 | integration | `… test/admin-channels.test.ts` | ❌ W0 | ⬜ pending |
| KEY-05 | 30/min 限流 429 + Retry-After | integration | `… test/rate-limit.test.ts` | ❌ W0 | ⬜ pending |
| D-08 | 保留清理 alarm（500 条窗口） | integration | `… test/retention-alarm.test.ts` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `packages/server/vitest.config.ts` — cloudflareTest 接线（含 `--max-workers=1 --no-isolate` npm script）
- [ ] `packages/server/test/send-basic.test.ts` — SRV-01
- [ ] `packages/server/test/fixtures-contract.test.ts` — SRV-07（依赖 packages/shared/fixtures/ 首批 JSON）
- [ ] `packages/server/test/ws-fanout.test.ts` — SRV-03/06
- [ ] `packages/server/test/sync-catchup.test.ts` — SRV-05
- [ ] 框架安装：wrangler 4.126.0 / typescript 7.0.2 / vitest 4.1.11 / @cloudflare/vitest-plugin 1.1.0（全新仓库，无既有测试设施）

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| 空闲频道 DO duration 不增长 | 验收 3 / SRV-04 | wrangler dev 不驱逐 DO，本地不可测；仅生产 dashboard 可验证 | D-15 生产冒烟 checklist ④：频道有挂起 WS 连接但无消息流量，观察 Cloudflare dashboard 的 Durable Objects duration 指标不随空闲时间增长 |
| 端到端延迟 < 2 秒 | 验收 1 | 本地环境不代生产网络路径 | D-15 生产冒烟 checklist ②：workers.dev 上 WS 客户端实测 POST → 收到消息的时间差 |
| `wrangler login` / `wrangler secret put ADMIN_KEY` | D-13/D-14 | 交互式认证，需用户配合一次 | 首个部署计划时用户在终端完成交互式登录与 secret 写入 |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 60s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
