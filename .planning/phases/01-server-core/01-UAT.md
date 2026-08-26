---
status: complete
phase: 01-server-core
source: [01-VERIFICATION.md]
started: 2026-08-26T20:05:00Z
updated: 2026-08-26T12:45:00Z
---

## Current Test

[testing complete]

## Tests

### 1. 观察生产 DO duration（验收 3 / SRV-04）
expected: 冒烟频道空闲数分钟后 dashboard 的 Durable Objects Duration 指标无增长（wrangler dev 不驱逐 DO，只能生产验证）
result: pass
note: 经自定义域名 pushhub.dyun.org 保持空闲 WS（12:26-12:36 UTC，30s ping 自动应答），用户在 dashboard 观察确认 duration 平直

### 2. 网络窗口恢复后重跑生产冒烟
expected: `PH_SMOKE_URL=https://pushhub.dyun.org PH_ADMIN_KEY=<新secret> node scripts/smoke.mjs` 输出 SMOKE OK 且 LATENCY < 2000ms（含 admin 建频道、断线补拉恰 2 条、401/413 反例全过；通过后同时关闭 WINDOWS.md 条目 2/3）
result: pass
note: 经自定义域名执行（workers.dev SNI 阻断，dyun.org 可达）：12 步全绿——admin 401 反例、建频道、send seq=1、WS 首拉 history、实收 seq=2 逐字一致、LATENCY 253ms、断线补拉恰 2 条（seq 3,4）零丢失零重复、401/413 反例，SMOKE OK

### 3. 裁决 CR-01（评审 Critical：admin.ts 长度前置检查用 UTF-16 码元而非字节数）
expected: 修复（TextEncoder 字节长度比较 + 补非 ASCII Bearer 反例断言 401）或明示接受为已知问题（Phase 3 管理页前修复）
result: pass
note: 用户裁决修复。已实施：admin.ts 长度前置改为 TextEncoder 字节比较；测试补"密"×64 反例断言 401；60/60 全绿 + typecheck 通过；部署 bfe5935d；生产 raw TLS 验证非 ASCII Bearer → 401（修复前会 500）、有效 key 正常 200。commit a19f3ab

### 4. 确认 4 条 judgment 级禁令验证结论
expected: 用户确认：① 服务端哑管道（text 逐字节透传）；② 密钥不落日志；③ Phase 1 不对 callback_url/click_url 发服务端 fetch；④ shared 包零 Workers 运行时依赖与 KV 前缀（自动化证据已采集，全部成立——需人工背书）
result: pass
note: 用户背书四条禁令全部成立（哑管道透传 / 零日志 / 零外连 fetch / shared 纯净性）

## Summary

total: 4
passed: 4
issues: 0
pending: 0
skipped: 0
blocked: 0

## Gaps
