---
status: testing
phase: 01-server-core
source: [01-VERIFICATION.md]
started: 2026-08-26T20:05:00Z
updated: 2026-08-26T20:05:00Z
---

## Current Test

number: 1
name: 观察生产 DO duration（验收 3 / SRV-04）
expected: |
  在 https://pushhub.snake160220.workers.dev 上保持一条 WS 连接（wss://…/api/ws/<channelKey>），空闲 5-10 分钟后打开
  Cloudflare dashboard → Workers & Pages → pushhub → Durable Objects → Duration 指标：空闲期间 duration 曲线平直不增长
  （部署后的 WS 重连尖峰回落为平直属预期）。
awaiting: user response

## Tests

### 1. 观察生产 DO duration（验收 3 / SRV-04）
expected: 冒烟频道空闲数分钟后 dashboard 的 Durable Objects Duration 指标无增长（wrangler dev 不驱逐 DO，只能生产验证）
result: [pending]

### 2. 网络窗口恢复后重跑生产冒烟
expected: `PH_SMOKE_URL=https://pushhub.snake160220.workers.dev PH_ADMIN_KEY=<secret> node scripts/smoke.mjs` 输出 SMOKE OK 且 LATENCY < 2000ms（含 admin 建频道、断线补拉恰 2 条、401/413 反例全过；通过后同时关闭 WINDOWS.md 条目 2/3）
result: [pending]

### 3. 裁决 CR-01（评审 Critical：admin.ts 长度前置检查用 UTF-16 码元而非字节数）
expected: 修复（TextEncoder 字节长度比较 + 补非 ASCII Bearer 反例断言 401）或明示接受为已知问题（Phase 3 管理页前修复）
result: [pending]

### 4. 确认 4 条 judgment 级禁令验证结论
expected: 用户确认：① 服务端哑管道（text 逐字节透传）；② 密钥不落日志；③ Phase 1 不对 callback_url/click_url 发服务端 fetch；④ shared 包零 Workers 运行时依赖与 KV 前缀（自动化证据已采集，全部成立——需人工背书）
result: [pending]

## Summary

total: 4
passed: 0
issues: 0
pending: 4
skipped: 0
blocked: 0

## Gaps
