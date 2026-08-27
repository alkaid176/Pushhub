---
schema_version: 1
open_count: 4
waived_count: 0
fixed_count: 4
total_count: 8
last_updated: 2026-08-27T17:18:49.702Z
---

# Broken Windows Ledger

> Cross-phase defect register. With `workflow.windows_enforce` enabled, `/gsd-ship` blocks while `open_count > 0`.
> Waive with `gsd-tools windows waive <id> "<reason>"` (reason required).
> Mark fixed with `gsd-tools windows fixed <id>`.

| id | phase | kind | file | line | description | status | reason | recorded_at | resolved_at |
|----|-------|------|------|------|-------------|--------|--------|-------------|-------------|
| 1 | 1 | unrun-verify | .planning/phases/01-server-core/01-01-SUMMARY.md |  | 验收3/SRV-04：冒烟频道(smoketest)空闲后 Cloudflare dashboard DO duration 不增长——manual-only 人工核对待用户执行（SUMMARY D6 + USER-SETUP 已记录） | fixed |  | 2026-08-26T06:30:12.276Z | 2026-08-26T12:28:16.222Z |
| 2 | 01 | unrun-verify | scripts/smoke.mjs |  | v0.1.3 production smoke unrun: workers.dev SNI-blocked ~75min (deploy e20626bf succeeded; rerun PH_SMOKE_URL=https://pushhub.snake160220.workers.dev node scripts/smoke.mjs when network recovers) | fixed |  | 2026-08-26T09:12:44.865Z | 2026-08-26T12:28:16.657Z |
| 3 | 01 | unrun-verify | scripts/smoke.mjs |  | v0.1.4 production smoke unrun (2nd window): DNS pollution resolves workers.dev to Facebook/Twitter IPs; smoke.mjs final version validated locally on real workerd (SMOKE OK, 11ms latency, catch-up exactly 2); rerun PH_SMOKE_URL=https://pushhub.snake160220.workers.dev PH_ADMIN_KEY=<secret> node scripts/smoke.mjs when network recovers — passing also closes entry 2 (v0.1.3, same worker superset) | fixed |  | 2026-08-26T11:28:34.271Z | 2026-08-26T12:28:17.095Z |
| 4 | 2 | unrun-verify | packages/web-sdk/e2e/tracer.spec.ts |  | 浏览器层 SDK 意外断连→自动重连未在 E2E 观察（A1 spike：setOffline 不关 WS；重连逻辑已有单测+服务端冒烟覆盖，02-02 需调试句柄/CDP 替代手段补浏览器层验证） | fixed |  | 2026-08-26T15:19:01.056Z | 2026-08-26T16:24:46.710Z |
| 5 | 2 | unrun-verify | Cloudflare dashboard |  | D-15④ dashboard Duration 空闲平直 + 部署尖峰回落 + /pushhub.js 不进 Workers 请求曲线（SC4 dashboard 终验；标记头对照已给程序化等价证据，02-03-SUMMARY Human-Check Items） | open |  | 2026-08-26T17:06:39.477Z |  |
| 6 | 03 | unrun-verify | Cloudflare dashboard |  | Phase 3 人工验收①（03-05 Task 3）：SC4 dashboard 请求计数核对——浏览器多次刷新 https://pushhub.dyun.org/admin.html，Workers 请求计数无相应增长（静态资产命中不计请求；与账本 entry 5 D-15④ 同批执行可一并勾销） | open |  | 2026-08-27T17:18:48.927Z |  |
| 7 | 03 | unrun-verify | packages/server/public/admin.html |  | Phase 3 人工验收②（03-05 Task 3）：管理页核心旅程浏览器走查——登录→建频道→复制接入片段→curl 以 Send Key 发消息→历史区可见→重置 Channel Key 观察客户端被踢→（可选）吊销一个 Key | open |  | 2026-08-27T17:18:49.321Z |  |
| 8 | 03 | unrun-verify | packages/server/public/admin.js |  | Phase 3 人工验收③（03-05 Task 3，one-way 用户亲手执行）：D-34 dogfooding——管理页选中 smoke- 前缀旧冒烟频道→删除确认框输入频道名前缀→确认删除→频道从列表消失（生产现存 8 个 smoke- 频道；uat-/chaos-sc2- 前缀频道不得删除） | open |  | 2026-08-27T17:18:49.702Z |  |

````json
[
  {
    "id": 1,
    "kind": "unrun-verify",
    "phase": "1",
    "file": ".planning/phases/01-server-core/01-01-SUMMARY.md",
    "line": null,
    "description": "验收3/SRV-04：冒烟频道(smoketest)空闲后 Cloudflare dashboard DO duration 不增长——manual-only 人工核对待用户执行（SUMMARY D6 + USER-SETUP 已记录）",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-08-26T06:30:12.276Z",
    "resolved_at": "2026-08-26T12:28:16.222Z"
  },
  {
    "id": 2,
    "kind": "unrun-verify",
    "phase": "01",
    "file": "scripts/smoke.mjs",
    "line": null,
    "description": "v0.1.3 production smoke unrun: workers.dev SNI-blocked ~75min (deploy e20626bf succeeded; rerun PH_SMOKE_URL=https://pushhub.snake160220.workers.dev node scripts/smoke.mjs when network recovers)",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-08-26T09:12:44.865Z",
    "resolved_at": "2026-08-26T12:28:16.657Z"
  },
  {
    "id": 3,
    "kind": "unrun-verify",
    "phase": "01",
    "file": "scripts/smoke.mjs",
    "line": null,
    "description": "v0.1.4 production smoke unrun (2nd window): DNS pollution resolves workers.dev to Facebook/Twitter IPs; smoke.mjs final version validated locally on real workerd (SMOKE OK, 11ms latency, catch-up exactly 2); rerun PH_SMOKE_URL=https://pushhub.snake160220.workers.dev PH_ADMIN_KEY=<secret> node scripts/smoke.mjs when network recovers — passing also closes entry 2 (v0.1.3, same worker superset)",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-08-26T11:28:34.271Z",
    "resolved_at": "2026-08-26T12:28:17.095Z"
  },
  {
    "id": 4,
    "kind": "unrun-verify",
    "phase": "2",
    "file": "packages/web-sdk/e2e/tracer.spec.ts",
    "line": null,
    "description": "浏览器层 SDK 意外断连→自动重连未在 E2E 观察（A1 spike：setOffline 不关 WS；重连逻辑已有单测+服务端冒烟覆盖，02-02 需调试句柄/CDP 替代手段补浏览器层验证）",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-08-26T15:19:01.056Z",
    "resolved_at": "2026-08-26T16:24:46.710Z"
  },
  {
    "id": 5,
    "kind": "unrun-verify",
    "phase": "2",
    "file": "Cloudflare dashboard",
    "line": null,
    "description": "D-15④ dashboard Duration 空闲平直 + 部署尖峰回落 + /pushhub.js 不进 Workers 请求曲线（SC4 dashboard 终验；标记头对照已给程序化等价证据，02-03-SUMMARY Human-Check Items）",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-08-26T17:06:39.477Z",
    "resolved_at": null
  },
  {
    "id": 6,
    "kind": "unrun-verify",
    "phase": "03",
    "file": "Cloudflare dashboard",
    "line": null,
    "description": "Phase 3 人工验收①（03-05 Task 3）：SC4 dashboard 请求计数核对——浏览器多次刷新 https://pushhub.dyun.org/admin.html，Workers 请求计数无相应增长（静态资产命中不计请求；与账本 entry 5 D-15④ 同批执行可一并勾销）",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-08-27T17:18:48.927Z",
    "resolved_at": null
  },
  {
    "id": 7,
    "kind": "unrun-verify",
    "phase": "03",
    "file": "packages/server/public/admin.html",
    "line": null,
    "description": "Phase 3 人工验收②（03-05 Task 3）：管理页核心旅程浏览器走查——登录→建频道→复制接入片段→curl 以 Send Key 发消息→历史区可见→重置 Channel Key 观察客户端被踢→（可选）吊销一个 Key",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-08-27T17:18:49.321Z",
    "resolved_at": null
  },
  {
    "id": 8,
    "kind": "unrun-verify",
    "phase": "03",
    "file": "packages/server/public/admin.js",
    "line": null,
    "description": "Phase 3 人工验收③（03-05 Task 3，one-way 用户亲手执行）：D-34 dogfooding——管理页选中 smoke- 前缀旧冒烟频道→删除确认框输入频道名前缀→确认删除→频道从列表消失（生产现存 8 个 smoke- 频道；uat-/chaos-sc2- 前缀频道不得删除）",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-08-27T17:18:49.702Z",
    "resolved_at": null
  }
]
````
