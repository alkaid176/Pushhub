---
schema_version: 1
open_count: 0
waived_count: 0
fixed_count: 4
total_count: 4
last_updated: 2026-08-26T16:24:46.710Z
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
  }
]
````
