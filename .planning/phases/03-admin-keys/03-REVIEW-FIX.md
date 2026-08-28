---
status: all_fixed
phase: 03-admin-keys
source: 03-REVIEW.md
fix_scope: critical_warning
findings_in_scope: 6
fixed: 6
skipped: 0
iteration: 1
fixed_at: 2026-08-28
---

# Code Review Fix Report — Phase 03

Fix scope: Critical + Warning（6 项全部修复；4 项 Info 按范围约定不修）。
执行方式：gsd-code-fixer 于隔离 worktree `rf-03-104`（分支 `gsd-reviewfix/03-104`）逐项原子提交；WR-02 提交与 WR-03 修复由 orchestrator 接续被中断的 fixer 会话完成（接续点：WR-02 diff 已完整、测试已绿）。

## 修复明细

| ID | 严重度 | 提交 | 修复内容 |
|----|--------|------|----------|
| CR-01 | Critical | `6ca0502` | KV `id:` 读-改-写竞态消除：`sk:` 每 Key 独立记录成为权威源，吊销 = 删单键记录，不再整条重写 `id:`；`id:` 降级为频道级数据（channelKey/name/createdAt），写频回到低频路径 |
| WR-05 | Warning | `fb7abcd` | `listChannels` 跳过缺 `channelKey` 的损坏 `id:` 记录（normalize 兜底不再产出 `undefined` 直达 `maskKey` 崩 UI） |
| WR-04 | Warning | `9c5b567` | admin 路由 + fetch 入口整体 try/catch，意外异常回落 D-06 500 信封（不再裸 500 破坏错误契约） |
| WR-01 | Warning | `b10d72a` | DO purge `deleteAll` 后幂等重建空表（messages/rate_sends/meta）——60s KV 缓存窗口内残留 publish/WS 流量得到空频道行为而非 "no such table" 裸 500 |
| WR-02 | Warning | `fdb4165` | DO 密钥代际校验：meta 表单行存当前 Channel Key（kick-all 随请求同步落盘），WS 升级路径比对 Worker 转发的 `X-PH-Channel-Key`（ch: 解析值）——重置后 ≤60s 缓存窗口内旧 Key 重挂即 401，重挂缺口彻底闭合；purge 重建空 meta（删除场景语义不变，文档化） |
| WR-03 | Warning | `438ca99` | 历史迟到响应守卫改对象同一性（`isStaleHistoryState`）：切走再切回（同 channelId、state 已重建）也能判过期；toggle/click 闭包经判定重取最新 state——「加载更多」按钮不再静默无操作 |

## 验证链（全绿）

- server 85/85（含 fixer 新增 CR-01 回归测试）+ typecheck 零错误
- web-sdk 单测 86/86；build 双页 `?v=0.1.11` 注入正常
- Playwright E2E 21/21（admin 13 含历史切片零回归）

## 附带修正

- `retention-alarm.test.ts` 显式 30s 超时：600-publish 测试在机器高负载时踩 5s 默认线（本机实测连续超时、master 同代码复现——负载敏感 flake 非回归）；断言语义不变

## Info 项处置（不修，按 fix_scope 约定）

- Admin 鉴权速率限制 / CSP `connect-src` 收紧 / `generateWid` 取模偏差 / 删除链 TOCTOU——已在 03-REVIEW.md 记录，留待后续阶段或 ship 前安全复查（`/gsd-secure-phase 3` 时一并评估）

## 部署注意

生产 0.1.11 尚未包含本批修复。按项目版本规则，合入 master 后需版本 +1（0.1.12）部署方为修复上线。
