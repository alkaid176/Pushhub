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
| ③ | 断线重连 + since 补拉 | `scripts/smoke.mjs` 自动（断开→再发 2 条→重连→sync since 断言恰补 2 条且 seq 连续） | ✅ 01-04 起 |
| ④ | Cloudflare dashboard 看 DO duration 与请求曲线 | 人工：Workers → pushhub → Durable Objects——冒烟频道空闲数分钟后 **duration 指标应无增长**（Hibernation API 生效，验收 3/SRV-04；wrangler dev 不驱逐 DO，只能生产验证）；同时核对请求曲线是否异常 | ⏳ 每次部署人工核对 |

## 部署记录

| 版本 | 时间 (UTC) | URL | Worker Version ID | 冒烟结果 |
|------|-----------|-----|-------------------|---------|
| 0.1.0 | 2026-08-26 | https://pushhub.snake160220.workers.dev | 1104cd81-400a-40fb-85b6-0608f30ebd78 | ✅ SMOKE OK，端到端延迟 285ms（KV ns `ffc9065c998a4567a4a2754ede9eca8b`，ADMIN_KEY secret 落位，ChatRoom DO 经 exports 声明创建） |
| 0.1.1 | 2026-08-26 | https://pushhub.snake160220.workers.dev | 4c416bed-9f43-4fcf-a9fb-e22c46b3d8d1 | ✅ SMOKE OK，端到端延迟 1119ms（01-02 协议冻结：纯类型/校验层变更，生产回归确认未受损；延迟升高为本机至 workers.dev 网络波动，仍低于 2000ms 验收线） |
| 0.1.2 | 2026-08-26 | https://pushhub.snake160220.workers.dev | a937b5b4-679f-429c-ba04-e8f42f1c242d | ✅ SMOKE OK，端到端延迟 277ms（01-03 发送侧完整化：/api/send 校验链接入 + SRV-02 全字段透传 + KEY-05 限流；冒烟新增超限反例步——32769 字符 text → 413 payload_too_large 边缘即拒；429/Retry-After 生产路径由本地真实 workerd 测试覆盖，生产按低打扰口径仅验 200/401/413 三态） |
| 0.1.3 | 2026-08-26 | https://pushhub.snake160220.workers.dev | e20626bf-2dfe-4c6a-ac28-ac73af3719e2 | ⚠️ 部署成功；**生产冒烟因网络阻断未能在本窗口执行**（本机对 `*.workers.dev` 出现持续 ~75 分钟的 SNI 重置 + DNS 污染——39 轮重试、DoH 解析真实 IP + `--resolve`、干净 Cloudflare 边缘 IP 换 SNI、`wrangler dev --remote`（SQLite DO 不支持远程预览）、本地代理 127.0.0.1:30808 未监听，全部不可行）。功能等价证据：真实 workerd 全量 52/52 绿（含断线重连补拉恰 2 条、alarm 保留清理、休眠驱逐恢复——与冒烟步骤逐一对应）。**待网络恢复后重跑 `PH_SMOKE_URL=https://pushhub.snake160220.workers.dev node scripts/smoke.mjs` 补验**（01-04 Task 3 已将 D-15 ③ 断线补拉步骤固化进脚本），已记入 WINDOWS.md unrun-verify |
