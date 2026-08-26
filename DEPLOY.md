# PushHub 部署手册

服务端部署目标是 **Cloudflare Workers**（workers.dev），不是自有服务器。本手册固化 D-15 生产冒烟流程与版本号规约。

## 版本号规则（工作区规约）

- root `package.json` 的 `version` 为全局部署版本号。
- **每次部署前，补丁位 +1**：`0.1.0 → 0.1.1 → 0.1.2 …`（先定版本号，再 deploy → 冒烟 → 登记——部署记录里的版本即本次代码的版本）。
- 每次部署在下方「部署记录」表登记一行（版本、URL、Worker Version ID、冒烟结果）。

## 部署步骤

```bash
# 前置：已 wrangler login（OAuth，一次性）；ADMIN_KEY secret 已 wrangler secret put 写入
# ① root package.json version 补丁位 +1
# ② 部署（注意：必须带 run——pnpm 会把裸 deploy 拦截为自己的内置命令）
pnpm run deploy                                   # = pnpm --filter @pushhub/server run deploy
# ③ 生产冒烟（ADMIN_KEY 为用户密码库中的 secret 明文，勿入库）
PH_SMOKE_URL=https://pushhub.snake160220.workers.dev PH_ADMIN_KEY=<secret> node scripts/smoke.mjs
```

冒烟脚本自动完成（D-15 ①②③④ 全自动部分，01-05 定稿）：**经 admin API 建临时冒烟频道**（频道名含时间戳，可重复运行不冲突；先验错误 Admin Key 401 反例）→ 用返回的 Send Key 发消息断言 200 → Channel Key WS 实收 v:1 帧并测端到端延迟（验收 < 2000ms）→ 断线重连 sync 补拉恰补断线期间消息 → 无效密钥 401 / 超限载荷 413 反例 → 输出 `SMOKE OK`。

> 网络注意：本机（中国大陆）对 `*.workers.dev` 存在间歇性乃至持续性阻断（SNI 重置 + DNS 污染——污染记录常指向 Facebook/Twitter IP 段）。冒烟遇 `UND_ERR_CONNECT_TIMEOUT` / `fetch failed` 即为此环境问题，非代码缺陷；部署本身走 `api.cloudflare.com` 不受影响。阻断持续时不要烧重试：以真实 workerd 全量测试为功能等价证据，冒烟补验登记 WINDOWS.md，待网络窗口（或经代理/换网络）重跑。每次冒烟会经 admin API 建一个新频道（3 次 KV 写），重复运行互不影响。

## D-15 生产冒烟五分钟 Checklist（固定流程）

每次部署后逐项执行：

| # | 步骤 | 方式 | 当前覆盖 |
|---|------|------|---------|
| ① | 建频道 + 发消息 | `scripts/smoke.mjs` 自动：POST /api/admin/channels（Bearer ADMIN_KEY）建临时频道拿三件套，返回的 Send Key 立即发消息断言 200（生产路径全真实，01-05 起替代 kv 种键；含错误 Admin Key 401 反例） | ✅ 01-05 起 |
| ② | WS 连接收消息 | `scripts/smoke.mjs` 自动：返回的 Channel Key 立即连 WS，断言首拉 history 帧 + 实收 v:1 message 帧 + 端到端延迟（验收 < 2s） | ✅ 01-01 起（01-05 起用 admin 建的频道） |
| ③ | 断线重连 + since 补拉 | `scripts/smoke.mjs` 自动（断开→再发 2 条→重连→sync since 断言恰补 2 条且 seq 连续零丢失零重复） | ✅ 01-04 起 |
| ④ | Cloudflare dashboard 看 DO duration 与请求曲线 | 人工：dashboard.cloudflare.com → Workers & Pages → **pushhub** → 左侧 **Durable Objects** 标签 → 看 **Duration** 指标与请求曲线。**预期现象**：冒烟频道空闲挂 WS 连接数分钟后 duration 平直不增（Hibernation API 生效，验收 3/SRV-04；wrangler dev 不驱逐 DO，只能生产验证）；部署刚完成时可看到 WS 重连尖峰（部署断开全部连接、客户端重连——属预期），尖峰后应回落平直 | ⏳ 每次部署人工核对 |

## 常见排障

1. **`compatibility_date` 不识别（部署报 "Unrecognized compatibility date"）**：本机 wrangler 版本较生产 runtime 旧。将 `packages/server/wrangler.jsonc` 的 `compatibility_date` 回退一天重试；vitest 配置经 `configPath` 自动同步，无需另改。
2. **KV namespace id 未回填 / 绑定报错（"Couldn't find binding KV"）**：`packages/server/wrangler.jsonc` 的 `kv_namespaces[0].id` 必须是真实 namespace id（当前 `ffc9065c998a4567a4a2754ede9eca8b`）。丢失时 `npx wrangler kv namespace create KV` 重建，把输出 id 回填 wrangler.jsonc，并重跑 `pnpm --filter @pushhub/server run cf-typegen` 同步类型。
3. **ADMIN_KEY secret 缺失 / 需轮换（/api/admin/* 一律 500 server_error）**：`cd packages/server && npx wrangler secret put ADMIN_KEY` 重写（交互粘贴新值，立即生效于新部署）；轮换后旧值立即失效。secret 只经此命令写入——绝不进仓库、不进 `.dev.vars`（已 gitignore）、不进任何提交文件。

## 部署记录

| 版本 | 时间 (UTC) | URL | Worker Version ID | 冒烟结果 |
|------|-----------|-----|-------------------|---------|
| 0.1.0 | 2026-08-26 | https://pushhub.snake160220.workers.dev | 1104cd81-400a-40fb-85b6-0608f30ebd78 | ✅ SMOKE OK，端到端延迟 285ms（KV ns `ffc9065c998a4567a4a2754ede9eca8b`，ADMIN_KEY secret 落位，ChatRoom DO 经 exports 声明创建） |
| 0.1.1 | 2026-08-26 | https://pushhub.snake160220.workers.dev | 4c416bed-9f43-4fcf-a9fb-e22c46b3d8d1 | ✅ SMOKE OK，端到端延迟 1119ms（01-02 协议冻结：纯类型/校验层变更，生产回归确认未受损；延迟升高为本机至 workers.dev 网络波动，仍低于 2000ms 验收线） |
| 0.1.2 | 2026-08-26 | https://pushhub.snake160220.workers.dev | a937b5b4-679f-429b-ba04-e8f42f1c242d | ✅ SMOKE OK，端到端延迟 277ms（01-03 发送侧完整化：/api/send 校验链接入 + SRV-02 全字段透传 + KEY-05 限流；冒烟新增超限反例步——32769 字符 text → 413 payload_too_large 边缘即拒；429/Retry-After 生产路径由本地真实 workerd 测试覆盖，生产按低打扰口径仅验 200/401/413 三态） |
| 0.1.3 | 2026-08-26 | https://pushhub.snake160220.workers.dev | e20626bf-2dfe-4c6a-ac28-ac73af3719e2 | ⚠️ 部署成功；**生产冒烟因网络阻断未能在本窗口执行**（本机对 `*.workers.dev` 出现持续 ~75 分钟的 SNI 重置 + DNS 污染——39 轮重试、DoH 解析真实 IP + `--resolve`、干净 Cloudflare 边缘 IP 换 SNI、`wrangler dev --remote`（SQLite DO 不支持远程预览）、本地代理 127.0.0.1:30808 未监听，全部不可行）。功能等价证据：真实 workerd 全量 52/52 绿（含断线重连补拉恰 2 条、alarm 保留清理、休眠驱逐恢复——与冒烟步骤逐一对应）。**待网络恢复后重跑 `PH_SMOKE_URL=https://pushhub.snake160220.workers.dev node scripts/smoke.mjs` 补验**（01-04 Task 3 已将 D-15 ③ 断线补拉步骤固化进脚本），已记入 WINDOWS.md unrun-verify |
| 0.1.4 | 2026-08-26 | https://pushhub.snake160220.workers.dev | 9255d9d3-5e50-480a-8412-f14236c19285 | ⚠️ 部署成功（01-05 Admin API：POST/GET /api/admin/channels + 三前缀密钥写路径 + timingSafeEqual 鉴权）；**生产冒烟同一网络阻断未变**：DNS 污染实锤——`pushhub.snake160220.workers.dev` 被解析到 Facebook IPv6 段（`2a03:2880:...face:b00c`）与 Twitter IP（`199.59.148.201`），fetch 连接超时（UND_ERR_CONNECT_TIMEOUT，按既定策略仅试一轮不烧重试）。**功能等价证据**：真实 workerd 全量 60/60 绿（admin-channels 8 例：三级闭环 + 双向隔离 + 分页）；**smoke.mjs 定稿版经本地 wrangler dev（真 workerd）全绿**：SMOKE OK，延迟 11ms，补拉恰 2 条零丢失，admin 建频道/401/413 反例全过。**待网络窗口补跑生产冒烟**（命令见上，PH_ADMIN_KEY 注入），沿用 WINDOWS.md unrun-verify 追踪 |
| 0.1.5 | 2026-08-26 | https://pushhub.dyun.org（自定义域名入口） | 644fadce-ba98-4d58-9f93-e16c4f85921e | ✅ SMOKE OK，端到端延迟 274ms（02-01 Web SDK tracer：pushhub.js IIFE 单文件首次挂载为静态资产——min 78,750 / gzip 26,711 字节；`https://pushhub.dyun.org/pushhub.js` 返回 200 + text/javascript 且与本地构建逐字节一致（SC4 分发路径）；deploy 脚本改为先 web-sdk build 后 server deploy 链式，`pnpm run deploy` 命令契约不变；本轮冒烟同时补验了 0.1.3/0.1.4 积压的生产冒烟欠账——经自定义域名全链路可用） |
