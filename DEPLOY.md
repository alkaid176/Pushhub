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

> 网络注意：本机（中国大陆）对 `*.workers.dev` 存在间歇性乃至持续性阻断（SNI 重置 + DNS 污染——污染记录常指向 Facebook/Twitter IP 段）。冒烟遇 `UND_ERR_CONNECT_TIMEOUT` / `fetch failed` 即为此环境问题，非代码缺陷；部署本身走 `api.cloudflare.com` 不受影响。阻断持续时不要烧重试：以真实 workerd 全量测试为功能等价证据，冒烟补验登记 WINDOWS.md，待网络窗口（或经代理/换网络）重跑。每次冒烟会经 admin API 建一个新频道（3 次 KV 写），重复运行互不影响。另：`wrangler tail` 的 WebSocket 通道同样可被 DNS 污染阻断（`wrangler-tail.cloudflare.com` 解析为空/污染 IP，2026-08-26 实测 2 次；此时用响应标记头 `x-ph-worker` 对照法替代——见 0.1.8 部署记录）。

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
4. **管理 API 意外失败返回 500 server_error 信封（WR-04 兜底）**：KV/DO 瞬断、put 超额或生产 KV 同 key 1 写/秒限制触发的异常统一映射为 D-06 通用信封（非裸 500 文本）。生产约束：**同一频道两次「重置 Channel Key」间隔应 ≥1s**（`id:<channelId>` 连续重写可能触发 KV 同 key 限速；Send Key 建/吊销已迁移为单键写（CR-01），无此约束）。wrangler dev（miniflare）不强制该限制，脚本化快速连击仅在生产的此路径可见。

## 部署记录

| 版本 | 时间 (UTC) | URL | Worker Version ID | 冒烟结果 |
|------|-----------|-----|-------------------|---------|
| 0.1.0 | 2026-08-26 | https://pushhub.snake160220.workers.dev | 1104cd81-400a-40fb-85b6-0608f30ebd78 | ✅ SMOKE OK，端到端延迟 285ms（KV ns `ffc9065c998a4567a4a2754ede9eca8b`，ADMIN_KEY secret 落位，ChatRoom DO 经 exports 声明创建） |
| 0.1.1 | 2026-08-26 | https://pushhub.snake160220.workers.dev | 4c416bed-9f43-4fcf-a9fb-e22c46b3d8d1 | ✅ SMOKE OK，端到端延迟 1119ms（01-02 协议冻结：纯类型/校验层变更，生产回归确认未受损；延迟升高为本机至 workers.dev 网络波动，仍低于 2000ms 验收线） |
| 0.1.2 | 2026-08-26 | https://pushhub.snake160220.workers.dev | a937b5b4-679f-429b-ba04-e8f42f1c242d | ✅ SMOKE OK，端到端延迟 277ms（01-03 发送侧完整化：/api/send 校验链接入 + SRV-02 全字段透传 + KEY-05 限流；冒烟新增超限反例步——32769 字符 text → 413 payload_too_large 边缘即拒；429/Retry-After 生产路径由本地真实 workerd 测试覆盖，生产按低打扰口径仅验 200/401/413 三态） |
| 0.1.3 | 2026-08-26 | https://pushhub.snake160220.workers.dev | e20626bf-2dfe-4c6a-ac28-ac73af3719e2 | ⚠️ 部署成功；**生产冒烟因网络阻断未能在本窗口执行**（本机对 `*.workers.dev` 出现持续 ~75 分钟的 SNI 重置 + DNS 污染——39 轮重试、DoH 解析真实 IP + `--resolve`、干净 Cloudflare 边缘 IP 换 SNI、`wrangler dev --remote`（SQLite DO 不支持远程预览）、本地代理 127.0.0.1:30808 未监听，全部不可行）。功能等价证据：真实 workerd 全量 52/52 绿（含断线重连补拉恰 2 条、alarm 保留清理、休眠驱逐恢复——与冒烟步骤逐一对应）。**待网络恢复后重跑 `PH_SMOKE_URL=https://pushhub.snake160220.workers.dev node scripts/smoke.mjs` 补验**（01-04 Task 3 已将 D-15 ③ 断线补拉步骤固化进脚本），已记入 WINDOWS.md unrun-verify |
| 0.1.4 | 2026-08-26 | https://pushhub.snake160220.workers.dev | 9255d9d3-5e50-480a-8412-f14236c19285 | ⚠️ 部署成功（01-05 Admin API：POST/GET /api/admin/channels + 三前缀密钥写路径 + timingSafeEqual 鉴权）；**生产冒烟同一网络阻断未变**：DNS 污染实锤——`pushhub.snake160220.workers.dev` 被解析到 Facebook IPv6 段（`2a03:2880:...face:b00c`）与 Twitter IP（`199.59.148.201`），fetch 连接超时（UND_ERR_CONNECT_TIMEOUT，按既定策略仅试一轮不烧重试）。**功能等价证据**：真实 workerd 全量 60/60 绿（admin-channels 8 例：三级闭环 + 双向隔离 + 分页）；**smoke.mjs 定稿版经本地 wrangler dev（真 workerd）全绿**：SMOKE OK，延迟 11ms，补拉恰 2 条零丢失，admin 建频道/401/413 反例全过。**待网络窗口补跑生产冒烟**（命令见上，PH_ADMIN_KEY 注入），沿用 WINDOWS.md unrun-verify 追踪 |
| 0.1.5 | 2026-08-26 | https://pushhub.dyun.org（自定义域名入口） | 644fadce-ba98-4d58-9f93-e16c4f85921e | ✅ SMOKE OK，端到端延迟 274ms（02-01 Web SDK tracer：pushhub.js IIFE 单文件首次挂载为静态资产——min 78,750 / gzip 26,711 字节；`https://pushhub.dyun.org/pushhub.js` 返回 200 + text/javascript 且与本地构建逐字节一致（SC4 分发路径）；deploy 脚本改为先 web-sdk build 后 server deploy 链式，`pnpm run deploy` 命令契约不变；本轮冒烟同时补验了 0.1.3/0.1.4 积压的生产冒烟欠账——经自定义域名全链路可用） |
| 0.1.6 | 2026-08-26 | https://pushhub.dyun.org（自定义域名入口） | 936e5e7f-d8ee-4b14-8487-a3ebf3894a5f | ✅ SMOKE OK，端到端延迟 368ms（02-02 SDK 重连韧性完整化：连接生命周期抽取为纯状态机 connection-machine + full jitter 退避 cap 60s + 心跳 pong 死线 10s + visibilitychange 探活 5s 死线（D-27）+ v!==1 fatal 不重连 + has_more 翻页 SYNC_PAGE_MAX=100 硬上限；pushhub.js 更新为 min 81,022 字节、与本地构建逐字节一致；浏览器层断连混沌 E2E 三形态（意外断连补拉恰 2 条零重复、55+5 大缺口 60 条全到、被动 close 恢复）全绿——WINDOWS.md #4 浏览器层重连验证欠账就此关闭） |
| 0.1.7 | 2026-08-26 | https://pushhub.dyun.org（自定义域名入口） | 04bac4c5-d054-41b3-a12f-7377460edea3 | ✅ SMOKE OK，端到端延迟 338ms（02-03 demo 查看器上线：index.html + viewer.js 作为静态资产首次分发——CSP script-src 'self' 纵深、URL 参数接入 + localStorage 免填（D-24）、攻击样本按钮（D-22）、oldest_kept_seq 分隔线（D-10）、`/pushhub.js?v=0.1.7` 缓存规避；viewer E2E 首跑即绿（全套 6/6）；`/`、`/viewer.js`、`/pushhub.js` 生产均 200。SC4 本轮 wrangler tail 对照法因本机 DNS 污染阻断不可用（tail WebSocket 域解析为空，重试 2 次同败；`api.cloudflare.com` 正常故部署/冒烟不受影响）——按计划降级路径改用 0.1.8 的 `x-ph-worker` 标记头程序化证据 + dashboard 人工核对项（见 0.1.8 行）） |
| 0.1.8 | 2026-08-26 | https://pushhub.dyun.org（自定义域名入口） | 34b63d1b-fb11-4551-b2d2-552596ab4855 | ✅ SMOKE OK（02-03 SC2 生产部署混沌验证部署 + `x-ph-worker` 响应标记头）：①查看器保持连接期间执行本部署，status 轨迹 `reconnecting → connecting → online`、恢复耗时 10.7s，部署期间/后所发 2 条消息恰补齐零重复零丢失（事件层各恰 1 次、DOM li.msg = 基线 1 + 恰 2）——**CHAOS PASS**（一次性 harness `packages/web-sdk/scripts/chaos-sc2.mjs`，不入测试套件，D-26）；②SC4 标记头证据：`GET /`、`/pushhub.js`、`/viewer.js` 均 200 且**无** `x-ph-worker` 头（静态资产命中不触发 Worker、不计请求额度），`POST /api/send`（401 反例）带 `x-ph-worker: 1`（Worker 恰运行）——tail 不可用时的等价程序化对照；③服务端 60/60 回归绿（标记头以复制构造 Response 实现，不动冻结契约） |
| 0.1.9 | 2026-08-27 | https://pushhub.dyun.org（自定义域名入口） | db069038-aa2d-42bd-8c41-59980fab8124 | ✅ SMOKE OK，端到端延迟 890ms（02-06 gap closure 上线：G-02-2 SVG 锚点两分支判定 + WR-02 DOMPurify FORBID_TAGS 收敛 + WR-04 畸形 serverUrl WS_FAIL 容错 + G-02-3 ?v= 构建期注入首次生产生效 + WR-03 viewer 存储读取防护。字节证据：`/pushhub.js` 更新为 min 81,398 / gzip 27,693 字节（0.1.8 为 81,022——差值即修复字节上线）、与本地构建 `cmp` 逐字节一致（SC4）；`/` 引用恰一处 `pushhub.js?v=0.1.9`（注入机制生产实证）；`/pushhub.js` 与 `/viewer.js` 响应头均无 `x-ph-worker`（资产命中零计费，SC4 标记头对照法）。回归：server 60/60 + web-sdk 单测 81/81 + E2E 8/8 全绿（含畸形 serverUrl 新用例——其输入经真浏览器实证由 `not a url` 修正为截断 IPv6 字面量：WebSocket 构造器对相对引用按页面 base 解析，垃圾文本被合法化为 404 重连循环，jsdom 单测与真浏览器存在环境分歧） |
| 0.1.10 | 2026-08-27 | https://pushhub.dyun.org（自定义域名入口） | fd6128cc-2cef-4c65-bf42-6e4ec5ac768b | ✅ SMOKE OK，端到端延迟 272ms（CR-01 Critical 修复上线：消毒管道增 `FORBID_ATTR: ["style","class","id"]`——`style` 属性 position:fixed 全屏覆盖层钓鱼与 `class` 命中宿主 error-bar CSS 伪造系统横幅两条直通面闭合，WR-02 UI 伪装收敛目标就此闭合；IN-04 SVG 锚点 `xlink:href="javascript:"` 反例样本实证固化（DOMPurify 默认已剥离，非 RED 样本）。TDD：RED 834d748 恰 2 属性穿透样本失败 → GREEN 9e7cfc8 FORBID_ATTR 收敛。字节证据：`/pushhub.js` 更新为 min 81,433 / gzip 27,705 字节（0.1.9 为 81,398——+35 字节即修复字节上线）、与本地构建 `cmp` 逐字节一致（SC4）；`/` 引用恰一处 `pushhub.js?v=0.1.10`；`/pushhub.js` 与 `/viewer.js` 响应头均无 `x-ph-worker`（资产命中零计费）。回归：server 60/60 + web-sdk 单测 84/84（81 基线零回退 + CR-01 三新样本）+ E2E 8/8 全绿） |
| 0.1.11 | 2026-08-27 | https://pushhub.dyun.org（自定义域名入口） | 05b89819-f36a-4884-b96a-a02432cd1d2e | ✅ SMOKE OK，端到端延迟 384ms（Phase 3 管理页上线：/admin.html + /admin.js 静态资产首次公网分发（D-37/D-38，登录屏障/频道 CRUD/多 Send Key/重置踢连/删除/历史排障全功能）+ 五条 Admin API（send-keys POST/DELETE、reset-channel-key、DELETE 频道、messages keyset 翻页——D-35 参数化路由完结）。SC4 标记头证据：`/admin.html` 200 且无 `x-ph-worker`（资产命中零 Worker 请求）vs `/api/send` 401 反例带 `x-ph-worker: 1`（stampMarker 对照法）；`/` 与 `/admin.html` 各恰一处 `pushhub.js?v=0.1.11`（构建期注入双页生产实证）。normalize 生产实证：`GET /api/admin/channels` 列出 10 个频道全部含 sendKeys 数组结构——8 个 smoke- 前缀旧格式冒烟频道（0.1.0~0.1.10 各版遗留）经 normalizeIdRecord 兼容列出，migrate-on-write 零破坏生产证据；非 smoke 频道 2 个（uat-/chaos-sc2- 前缀）完整保留。冒烟 sendKeys[0].key 新取值路径（03-01 schema 演进联动）生产首次实跑全绿。回归：server 84/84 + web-sdk 单测 86/86 + E2E 21/21（含 D-41 全链路 journey——九步单 test 串联）全绿） |
