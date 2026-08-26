# Walking Skeleton — PushHub

**Phase:** 1
**Generated:** 2026-08-26

## Capability Proven End-to-End

一条真实通知打穿全栈：外部脚本以 Send Key 调 POST /api/send，同频道所有在线 WebSocket 客户端在生产 workers.dev 上 2 秒内收到该消息（含 SQLite 落库、seq 分配、Hibernation WS 扇出、KV 密钥预检）。

## Architectural Decisions

| Decision | Choice | Rationale |
|---|---|---|
| 运行时 | Cloudflare Workers（TypeScript，禁 Node 专有 API） | 零成本约束：全部依赖免费额度（100k 请求/天、13,000 GB-s DO 时长、100k SQLite 行写/天） |
| 实时分发 | Durable Objects（class `ChatRoom`，SQLite-backed，wrangler `exports` 声明） | 一群一实例 = 扇出中心 + 单线程 seq 原子性；Free 计划强制 sqlite backend；类名部署即定型（不可改名，删除即数据永久丢失） |
| WS 生命周期 | Hibernation API（`ctx.acceptWebSocket` + `serializeAttachment` + `setWebSocketAutoResponse` 构造器重设） | 空闲连接不计 DO duration（验收 3 的唯一手段）；ping/pong 自动应答零计费零唤醒 |
| 密钥体系 | 三级 bearer 密钥（Admin=Worker secret / Send+Channel=KV `ch:`/`sk:` 前缀解析 / `id:` 反向索引） | 密钥即身份（无账号体系）；读多写少完美匹配 KV 免费额度（写仅 1,000/天） |
| 部署目标 | workers.dev（`wrangler deploy`，每 PLAN 完成即部署冒烟 D-14） | 本地 wrangler dev 掩盖三大生产差异（限额/KV 一致性/DO 驱逐）；免费且 CI 零配置 |
| 目录布局 | pnpm workspace：`packages/shared`（协议，internal-package 无构建）+ `packages/server`（Worker）+ `scripts/`（冒烟） | shared 是四端唯一契约源（TS 端 workspace import；Phase 5/6 Rust/Kotlin 直接读仓库内 fixtures JSON） |
| 线协议 | v:1 帧顶层版本字段 + golden fixtures（正反例逐字节冻结） | 三端移植零漂移（SRV-07）；演进规则：只加字段不改语义、未知字段忽略、v 不识别即断连 |
| 测试 | vitest 4 + @cloudflare/vitest-plugin（真 workerd：真 DO/KV/WS/SQLite），`--max-workers=1 --no-isolate`，每文件 `crypto.randomUUID()` 唯一频道名 | WS+DO 不支持按文件隔离（官方 known-issues）；真运行时才能暴露额度与休眠边界行为 |

## Stack Touched in Phase 1

- [x] Project scaffold（pnpm workspace、tsconfig.base、wrangler.jsonc、vitest 接线、cf-typegen）
- [x] Routing — POST /api/send、GET /api/ws/:channelKey、POST/GET /api/admin/channels（至少一条真实路由打穿 DO）
- [x] Database — DO SQLite messages 表真实读写（publish 写 + sync keyset 读）+ rate_sends 限流表
- [x] "UI" — WS 客户端实时收帧（Phase 1 无 Web UI，静态资产仅占位 public/index.html；WS 帧即本阶段的用户可见面）
- [x] Deployment — workers.dev 生产部署 + scripts/smoke.mjs 五分钟冒烟（D-15 checklist 固化）

## Out of Scope (Deferred to Later Slices)

- 管理页/测试页 UI（Phase 3/4——本期仅 Admin API 最小集，管理页直接复用）
- 回复链与回调送达（Phase 4——answered 字段集已冻结但恒 null，只加逻辑不改 schema）
- 任何客户端（Phase 2 Web SDK / Phase 5 Tauri / Phase 6 Android）
- 消息渲染与消毒（服务端是哑管道，渲染责任全在客户端）
- 删除/重置/吊销频道的管理 API 全集（Phase 3 随管理页）
- KV 重置双活窗口（≤60s）的 DO 内强一致裁决（Phase 3 kick-all 模式；本期文档化为已知行为）

## Subsequent Slice Plan

每个后续阶段在此骨架上加一条垂直切片，不改动其架构决策：

- Phase 2: 网页 SDK 参考客户端（单文件 pushhub.js：重连 + 补拉 + 消毒渲染——直接消费本阶段冻结的 v:1 协议与 fixtures）
- Phase 3: 管理页与密钥生命周期（复用 /api/admin/* API 面；分级重置 + 消息历史排障）
- Phase 4: 回复链与回调送达（消费已冻结的 answered 字段集与 callback_url；签名回调 POST + 重试）
- Phase 5: Windows 桌面客户端（Tauri 2，Rust 持有 WS 连接；读 packages/shared/fixtures 做契约测试）
- Phase 6: 安卓客户端（原生 Kotlin，specialUse 前台服务；同样以 fixtures 为契约基线）
