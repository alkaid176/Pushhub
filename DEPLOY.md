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
| 0.1.12 | 2026-08-28 | https://pushhub.dyun.org（自定义域名入口） | 68251efb-2d2a-4e94-9af2-1106f53475cf | ✅ SMOKE OK，端到端延迟 279ms（Phase 3 code review 修复上线：CR-01 KV `id:` 读-改-写竞态消除——`sk:` 每 Key 独立记录成权威源、吊销=删单键、`id:` 降级频道级低频写；WR-01 DO purge 后幂等重建空表（60s 缓存窗口残留流量不再裸 500）；WR-02 旧 Key 重挂窗口闭合——DO meta 表密钥代际 + WS 升级比对 + W-1 接线修复（admin.ts kick-all 转发补 `X-PH-Channel-Key`，代际机制从失活转全链路生效）；WR-03 管理页历史迟到响应对象同一性守卫；WR-04 admin 路由 try/catch 回落 D-06 500 信封；WR-05 损坏 `id:` 记录跳过。SC4 标记头证据：`/admin.html` 200 且无 `x-ph-worker` vs `/api/send` 401 带 `x-ph-worker: 1`；`/` 与 `/admin.html` 各恰一处 `pushhub.js?v=0.1.12`。CR-01 生产实证：`GET /api/admin/channels` 200 列出 10 频道全部含 sendKeys 数组（sk: 现扫 + id: 并集路径生产首跑）。回归：server 86/86（含 WR-02 代际接线回归测试——旧代际 DO 直连 401/新代际 101）+ web-sdk 单测 86/86 + E2E 21/21 全绿。4 项 Info 级 finding 留 `/gsd-secure-phase 3` 评估（03-REVIEW-FIX.md）） |
| 0.1.13 | 2026-08-28 | https://pushhub.dyun.org（自定义域名入口） | f6d3fa2b-1957-4c20-8fbb-c1aae37656db | ✅ SMOKE OK，端到端延迟 284ms（Phase 4 测试页 + 回调接收器上线：`/test.html` + `/test.js` 五区块静态资产首次公网分发（ADM-04/D-55——连接配置/构造发送/实时流回复/验签器/失败查询，viewer 轻量定位不动）；`scripts/callback-receiver.mjs` 验签参考实现（D-57——三步验签 + DUPLICATE 幂等标记 + `--json-log` JSONL 落盘）；smoke.mjs 增回复链步骤（ack + answered 帧 wid/by/content 逐字段断言）生产首跑绿。SC4 标记头证据：`/test.html` 200 且无 `x-ph-worker`（资产命中零 Worker 请求）vs `/api/send` 401 带 `x-ph-worker: 1`；`/test.html` 恰一处 `pushhub.js?v=0.1.13`（构建期注入扩展至第三页首次生产生效）；`/pushhub.js` 82593 字节与本地构建逐字节一致。SC5 人工验收 **approved**（2026-08-28）：用户经测试页发"部署完成通知"→ 人工点"确认上线" → callback-receiver 打印验签 OK 续行——"通知→确认→续行"真实自动化场景闭环（验收专用频道 sc5-acceptance，验收后可删）。回归：server 119/119 + web-sdk 单测 102/102 + E2E 26/26（含 test-page 五用例：全流程 receiver 恰一次 POST 验签 ok + D-49 五字段 / 消毒攻击样本无执行痕迹 / 失败查询空态 / 验签器三步 PASS + 篡改 FAIL / receiver 五路径缺头-超窗-伪造-合法-重复）全绿 |

## 桌面端（Windows）分发

桌面端为**本地安装包形态**（无服务器部署）：NSIS 安装器 + 便携版双形态（D-77）。版本线独立于上述服务端版本——`packages/desktop/package.json` 与 `packages/desktop/src-tauri/tauri.conf.json` 的 `version` 同步维护。

### 版本号规则（桌面端）

- 桌面端版本线自 **0.1.0** 起（与服务端 0.1.x 相互独立，不联动）。
- **每次发布桌面安装包前，补丁位 +1**（0.1.0 → 0.1.1 → …），两个文件（package.json / tauri.conf.json）同步修改。
- 每次发布在下方「桌面端发布记录」表登记一行（版本、产物、E2E 回归结果）。

### 构建命令与产物路径

```bash
cd packages/desktop
pnpm exec tauri build                 # ① NSIS 安装器 + 裸 exe（release）
node scripts/make-portable.mjs        # ② 便携版整理（exe + README → dist/portable/）
```

| 形态 | 产物路径 | 说明 |
|------|---------|------|
| NSIS 安装器 | `packages/desktop/src-tauri/target/release/bundle/nsis/PushHub_<版本>_x64-setup.exe` | 简体中文安装向导、currentUser 安装（免管理员）、无语言选择页；安装器登记 AUMID，通知开箱可用 |
| 便携版 | `packages/desktop/dist/portable/`（pushhub-desktop.exe + README-portable.txt） | 解压即用；首次运行自行注册 AUMID（app.pushhub.desktop） |

- 图标源：`packages/desktop/app-icon.png`（1024x1024，`scripts/gen-icon.mjs` 生成）；`pnpm exec tauri icon app-icon.png` 重出全套（正式全套含 icon.ico 于 `src-tauri/icons/`）。
- 首次构建会自动下载 NSIS 工具链（GitHub 网络依赖——失败时重试或配置代理）。
- release 产物无调试测试钩子：测试钩子命令未引入（invoke 面恰 12 项生产命令，无 `cfg(debug_assertions)` 门控的测试命令——源断言 grep 零命中）。

### 发布前回归（自动化）

- `cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml`（147 项，05-08 起含 TLS 分支护栏）
- `pnpm --filter @pushhub/desktop exec playwright test`（六条 E2E：tracer / render / reply-chain / reconnect / close-window / wizard）

### 安装实机人工验收清单（OS 壳层——阶段末 UAT 批量复核）

对应 `.planning/phases/05-windows-tauri-2/05-VALIDATION.md` Manual-Only 表，双形态（安装版 + 便携版）各跑一遍：

| # | 项目 | 步骤 | 关联 |
|---|------|------|------|
| ① | SC2 通知三级定位 | 向已配置频道发消息 → 观察横幅（high 带声 / normal 无声）→ 点击通知正文 → 确认窗口聚焦 + 切换到对应频道 + 滚动到消息并高亮渐隐 | SC2/WIN-02 |
| ② | answered 通知移除 | 弹通知后在窗口内回复 → 确认通知中心该条消失 | D-69 |
| ③ | 托盘行为 | 左键托盘 → 窗口显隐切换；悬停 → tooltip「N 在线 / M 重连中」；右键 → 显示/勿扰/退出三项；退出 → 进程真正结束 | WIN-01/D-74 |
| ④ | D-71 首关提示 | 首次点窗口 X → 一次性提示出现；确认后再关不重现 | D-71 |
| ⑤ | 安装/便携开箱 | NSIS：中文向导、currentUser 安装、开始菜单/卸载项正常；便携版：解压双击直接运行 | D-77 |

## 桌面端发布记录

| 版本 | 时间 (UTC) | 产物 | 回归结果 |
|------|-----------|------|---------|
| 0.1.0 | 2026-08-29 | NSIS `PushHub_0.1.0_x64-setup.exe` + `dist/portable/` | cargo test 146/146 + 桌面 E2E 6/6（tracer/render/reply-chain/reconnect/close-window/wizard）；实机人工项（上表 ①-⑤）待阶段末 UAT 批量复核 |
| 0.1.1 | 2026-08-29 | NSIS `PushHub_0.1.1_x64-setup.exe` + `dist/portable/` | cargo test 147/147（+1 TLS 分支护栏：裸 TcpListener 先收 ClientHello 再断开 → 分类 Err 不 panic）+ 桌面 E2E 6/6（含 wizard 新增 https:// 失败路径用例——TLS 分支常驻哨兵）；**G-05-5 修复**：rustls ring provider——修复前向导对 https:// 服务端地址点「验证连通」（及任何配置 https:// 服务端频道的 wss:// 主连接）rustls 无 crypto provider panic，release `panic=abort` 下全进程静默闪退；**UAT Test 5 实机复测待验**：验证连通不闪退 + D-71 首关提示 |

## 安卓端（Android）分发

安卓端为**自分发 APK 形态**（ADB 安装，不上 Play——D-77）：独立 Gradle 工程 `packages/android/`（不进 pnpm workspace，构建体系独立），版本线独立于服务端与桌面端。

### 版本号规则（安卓端）

- 安卓端版本线自 **0.1.0** 起（与服务端、桌面端均相互独立，不联动——D-77 先例沿用）。
- `packages/android/app/build.gradle.kts` 中 `versionName` 与 `versionCode` 同步维护：**versionCode 单调递增**（每次构建 +1，永不回退——覆盖安装升级的判定依据）；**每次发布前 versionName 补丁位 +1**（0.1.0 → 0.1.1 → …）。
- 每次发布在下方「安卓端发布记录」表登记一行（版本、versionCode、产物、回归结果）。

### 构建命令与产物路径

```bash
cd packages/android
gradlew.bat assembleDebug         # debug APK（spike 与日常装机载体）
gradlew.bat assembleRelease       # release APK（06-08 起经环境变量注入签名配置）
```

| 形态 | 产物路径 | 说明 |
|------|---------|------|
| debug APK | `packages/android/app/build/outputs/apk/debug/app-debug.apk` | v1 minify=false，debug/release 行为同构（Pitfall 10——06-08 release 出包复验） |
| release APK | `packages/android/app/build/outputs/apk/release/app-release.apk` | 正式分发。签名配置经三环境变量注入（`PUSHHUB_KEYSTORE` / `PUSHHUB_KEYSTORE_PASSWORD` / `PUSHHUB_KEY_PASSWORD`，keystore 在仓库外 `D:/AIworkspaces/keys/pushhub-android.jks`，alias `pushhub`）——缺失任一且构建请求 release 任务时响亮失败（列出缺失变量名，不打印值），绝不回退无签名产出（T-06-08-01） |

### 装机（adb）

```bash
adb install -r <apk 路径>          # -r 覆盖安装（保留应用数据/配置）
```

- adb 位于 Android SDK **platform-tools**（默认 `%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe`，未加入 PATH 时用全路径调用）。
- 设备需已开启「USB 调试」（开发者选项），首次连接在设备上接受调试授权弹窗；`adb devices` 能列出设备即可装机。
- release 包与 debug 包签名不同：换装 release 前需 `adb uninstall app.pushhub.android`（应用数据仅配置，重走向导即可）。

### spike 操作流程（SC1 真机存活验证——D-85 三步）

每轮 spike 按三步执行（正式启动在 06-05 向导就位后；工具链 06-02 已就绪）：

1. **建频道 + 启动发送**：管理页 https://pushhub.dyun.org/admin.html 建独立 spike 频道（如 `spike-01`，不复用业务频道——T-06-02-02 污染面隔离），取该频道 Send Key 与 Channel Key。Send Key 经环境变量传入脚本（用户密码库管理，勿入库/勿进命令历史）：
   ```bash
   PUSHHUB_SPIKE_SEND_KEY=<secret> node scripts/spike-send.mjs --hours 8
   ```
   启动即发第 0 条，此后每小时 1 条共 9 条，发送记录落 `scripts/.spike-out/send-<时间戳>.jsonl`（gitignored）。
2. **装机 + 引导 + 锁屏**：真机 `adb install -r` 装 debug APK，向导以 Channel Key 接入 spike 频道，完成下方 P11 引导核对清单后锁屏放置过夜（保持 WiFi/运营商网络连接——真实使用姿势，非实验室环境）。**装机与引导须在第 1 小时消息（启动后 60 分钟）前完成。**
3. **次日报告**：
   ```bash
   adb exec-out run-as app.pushhub.android cat files/spike-log/<yyyy-MM-dd>.jsonl > device-<name>.jsonl
   node scripts/spike-report.mjs --send-log scripts/.spike-out/send-<时间戳>.jsonl \
     --device-log huawei-mate50pro=device-huawei.jsonl --device-log xiaomi-11=device-xiaomi.jsonl \
     --out spike-01-report.md
   ```
   报告输出逐小时到达矩阵与 SC1 判定行（全到达 = PASS，可区分第几小时断线）；双设备（华为 Mate 50 Pro + 小米 11，D-84）用多个 `--device-log name=path` 传参出总表，报告按「华为系 ROM（HarmonyOS）/小米（MIUI）」口径记录。

### 引导核对清单（P11——spike 前置逐项核对并截图）

锁屏前逐项核对，每项**截图存档**随 spike 报告归档（结论污染源排除——Pitfall 11：只开白名单不核对这些开关，spike 结论会被污染）：

| # | 项目 | 核对点 |
|---|------|--------|
| ① | 通知权限 | 系统设置中 PushHub 通知权限已授权（POST_NOTIFICATIONS 运行时授权——未授权时通知静默丢弃） |
| ② | 电池优化白名单 | PushHub 已加入电池优化白名单（设置 → 应用 → PushHub → 电池 → 不受限制） |
| ③ | 小米（MIUI）专属 | 自启动已开；省电策略「无限制」；锁屏后台运行允许 |
| ④ | 华为系（HarmonyOS）专属 | 启动管理三开关全开（自启动/关联启动/后台活动）；「显示锁屏通知」「后台弹出界面」两个独立开关已核对（独立于通知权限的 ROM 级开关） |
| ⑤ | FGS 常驻 | 通知栏可见 PushHub 常驻通知（连接状态汇总文本）——常驻通知消失即 FGS 被杀的第一现场 |

> 警示信号（Pitfall 11）：锁屏无通知但解锁后通知中心有 → 独立开关未开，spike 结论无效需重跑。

### 安卓端发布记录

| 版本 | versionCode | 时间 (UTC) | 产物 | 回归结果 |
|------|------------|-----------|------|---------|
| 0.1.0 | 1 | 2026-08-30 | `app-release.apk` — 6,671,332 字节，SHA256 `1D7E1CB9FF19C48480F56AFA80327A669719FF1BE9A6C51C740B62F9380D330E`，APK Signature Scheme v2（证书 DN `CN=PushHub Android Release, OU=PushHub, O=dyun, C=CN`，cert SHA-256 `09779dce…99452b`）；正式图标套件首发（自适应前景/monochrome 像素 P + 背景 #1B1E2B + 通知图标 P 定稿） | 构建侧：assembleRelease v2 签名验证通过 + git 零密钥泄漏（06-08 Task 1）；JVM 全量回归与 debug/release 双构建 = 06-08 Task 3（见「发布前回归」）；**release 真机冒烟四步（连接/收消息/通知/回复）待 spike 真机在场执行**（Pitfall 10 同构性实证——桌面 G-05-5 教训的结构化复验） |
