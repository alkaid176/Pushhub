# PushHub 部署手册

服务端部署目标是 **Cloudflare Workers**（workers.dev），不是自有服务器。本手册固化 D-15 生产冒烟流程与版本号规约。

## 版本号规则（工作区规约）

- root `package.json` 的 `version` 为全局部署版本号。
- **每次执行生产部署测试（冒烟通过）后，补丁位 +1**：`0.1.0 → 0.1.1 → 0.1.2 …`。
- 每次部署在下方「部署记录」表登记一行（版本、URL、时间、冒烟结果）。

## 部署步骤

```bash
# 前置：已 wrangler login（OAuth，一次性）
pnpm --filter @pushhub/server deploy          # 部署到 workers.dev
PH_SMOKE_URL=https://pushhub.<subdomain>.workers.dev node scripts/smoke.mjs
```

冒烟脚本自动完成：种入 `ch:`/`sk:` 冒烟密钥（channelId `smoketest`，可重复运行）→ 发消息断言 200 → WS 实收 v:1 帧并测量端到端延迟 → 无效密钥 401 断言 → 输出 `SMOKE OK`。

> 网络注意：本机（中国大陆）直连 `*.workers.dev` 偶发 `UND_ERR_CONNECT_TIMEOUT`（间歇性阻断，非硬墙）。冒烟遇此错误直接重跑即可；若持续失败，需经代理或换网络执行冒烟。部署本身走 `api.cloudflare.com` 不受影响。

## D-15 生产冒烟五分钟 Checklist（固定流程）

每次部署后逐项执行：

| # | 步骤 | 方式 | 当前覆盖 |
|---|------|------|---------|
| ① | 建频道 + 发消息 | `scripts/smoke.mjs` 自动（kv 种键代替建频道 API） | ✅ 01-01 起（建频道 API 待 01-05 后切换） |
| ② | WS 连接收消息 | `scripts/smoke.mjs` 自动（含端到端延迟测量，验收 < 2s） | ✅ 01-01 起 |
| ③ | 断线重连 + since 补拉 | 目前仅覆盖「收消息」部分；断线补拉待 sync 帧实现 | ⏳ 01-04 补全 |
| ④ | Cloudflare dashboard 看 DO duration 与请求曲线 | 人工：Workers → pushhub → Durable Objects——冒烟频道空闲数分钟后 **duration 指标应无增长**（Hibernation API 生效，验收 3/SRV-04；wrangler dev 不驱逐 DO，只能生产验证）；同时核对请求曲线是否异常 | ⏳ 每次部署人工核对 |

## 部署记录

| 版本 | 时间 (UTC) | URL | Worker Version ID | 冒烟结果 |
|------|-----------|-----|-------------------|---------|
| 0.1.0 | 2026-08-26 | https://pushhub.snake160220.workers.dev | 1104cd81-400a-40fb-85b6-0608f30ebd78 | ✅ SMOKE OK，端到端延迟 285ms（KV ns `ffc9065c998a4567a4a2754ede9eca8b`，ADMIN_KEY secret 落位，ChatRoom DO 经 exports 声明创建） |
