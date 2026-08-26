# Phase 1: User Setup

**Generated:** 2026-08-26
**Phase:** 01-server-core
**Status:** Complete

本计划涉及的全部人工步骤已在 01-01 执行中完成（下表留档，供后续环境重建参考）。

## Environment Variables

| Status | Variable | Source | Add to |
|--------|----------|--------|--------|
| [x] | `ADMIN_KEY` | 执行器 node crypto 生成（64 hex 字符），已 `wrangler secret put` 写入 Worker——值已在 01-01 执行输出中一次性展示，请记入密码管理器 | Cloudflare Worker secret（云端，非本地文件） |

## Account Setup

- [x] **Cloudflare 账号 + wrangler login**
  - 已完成 OAuth（账号 snake160220@gmail.com，2026-08-26）
  - 凭据位于本机 `C:\Users\31243\AppData\Roaming\xdg.config\.wrangler\config\default.toml`
  - 核验命令：`cd packages/server && pnpm exec wrangler whoami`

## Dashboard Configuration

- [x] **KV namespace 创建**（binding `KV`，id `ffc9065c998a4567a4a2754ede9eca8b`）——执行器经 `wrangler kv namespace create` 完成并回填 wrangler.jsonc
- [x] **ADMIN_KEY secret 写入**——执行器经 `wrangler secret put` 完成（01-05 Admin API 使用）
- [ ] **DO duration 观察（验收 3，非 setup——每次部署后的 D-15 checklist ④）**：dashboard → Workers → pushhub → Durable Objects，冒烟频道（smoketest）空闲数分钟后 duration 应无增长（SRV-04 Hibernation 生效证明）

## Verification

```bash
# 登录态
cd packages/server && pnpm exec wrangler whoami
# secret 落位
cd packages/server && pnpm exec wrangler secret list        # 应列出 ADMIN_KEY
# 生产冒烟（含 KV 种键、send、WS 实收、延迟、401 断言）
PH_SMOKE_URL=https://pushhub.snake160220.workers.dev node scripts/smoke.mjs
```

Expected: whoami 显示账号；secret list 含 ADMIN_KEY；冒烟输出 `SMOKE OK` 且延迟 < 2000ms。

---

**Once all items complete:** Mark status as "Complete" at top of file.（已完成——唯 DO duration 观察为持续性人工核对项，随每次部署执行。）
