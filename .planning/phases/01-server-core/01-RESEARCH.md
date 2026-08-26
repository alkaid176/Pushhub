# Phase 1: 服务端核心与协议冻结 - Research

**Researched:** 2026-08-26
**Domain:** Cloudflare Workers + Durable Objects (Hibernation WebSocket + SQLite) + KV 协议后端 / 线协议冻结
**Confidence:** HIGH（平台事实全部来自本会话直接读取的官方文档页 + 官方 fixture 源码；测试栈选型含 1 个 6 天龄新包，已显式降级标注）

## Summary

本次研究在项目级研究（STACK/ARCHITECTURE/PITFALLS，2026-08-26）之上深挖了 10 个实现级问题，全部通过直接读取当前官方文档（多页 2026-06~08 更新）与官方 workers-sdk fixture 源码回答。最重要的发现集中在四个领域：**(1) DO 类生命周期声明已换代**——官方文档现在主推 wrangler.json 里的声明式 `exports` 字段（`{"ChatRoom": {"type": "durable-object", "storage": "sqlite"}}`），旧的 `new_sqlite_classes` migrations 数组成为 legacy；两者互斥，一旦用 `exports` 部署就不能回退。**(2) 测试栈已换代**——文档全面迁移到 `@cloudflare/vitest-plugin`（`cloudflareTest()` Vite 插件），`@cloudflare/vitest-pool-workers` 仍在发布但已是旧路径；且官方 known-issues（2026-08-20 版）明确：**WebSocket + DO 测试不支持按文件存储隔离，必须 `--max-workers=1 --no-isolate` 共享存储运行**——这直接改变测试组织策略。**(3) `wrangler types` 兼容性问题（issue #8802）已关闭**，当前官方模板方案是 `wrangler types --include-runtime=false` 只生成 Env 接口（不重复声明运行时全局类型，避开 vitest 的 @types/node 冲突）。**(4) 若干项目文档记录的限额数字已过时**：serializeAttachment 上限现为 16,384 字节（原记 2,048）、入站 WS 消息上限 32 MiB（原记 1 MiB）、KV cacheTtl 最小 30s（原记 60s，默认仍 60）、Free 计划单 DO 存储 1 GB（FAQ 口径；10 GB 是 Paid）。

其余关键落地结论：入站 WS 消息对免费层 100k/日请求限额按 20:1 折算（文档口径 "for billing purposes"；免费层限额即计费配额，故大概率适用，但文档未逐字写明免费层强制执行口径——影响极小，保守 1:1 规划仍是安全的）；seq 生成推荐"同步块内 `SELECT COALESCE(MAX(seq),0)+1` + 显式 INSERT"（1 行写/消息，比 AUTOINCREMENT 省 1 行，保留策略不删 max 行保证单调）；限流推荐 ChatRoom DO 内 SQLite 固定窗口计数表（Send Key 天然单频道归属，无需独立 RateLimiter DO）；静态资产默认 asset-first 路由恰好免费满足需求（`/api/*` 无资产可命中自然落到 Worker）；Admin Key 常时比较用 Workers 运行时内置的非标准扩展 `crypto.subtle.timingSafeEqual`。

**Primary recommendation:** 全新项目直接采用 `exports` 声明 + `@cloudflare/vitest-plugin`（vitest 4.1.11）+ `wrangler types --include-runtime=false`，测试套件整体以 `--max-workers=1 --no-isolate` 运行并强制每测试文件用 `crypto.randomUUID()` 生成唯一频道名；ChatRoom DO 用"构造器建表 + 显式 seq 赋值 + setWebSocketAutoResponse 构造器重设"三件套。

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **D-01:** `click_url` 进 v1 协议（可选 string，≤2048 字符）——三端客户端点击消息标题/卡片即跳转。竞品 table stakes（ntfy Click / Bark url / Server酱 short），成本近零，避免上线后立刻加字段 — **Reversibility:** one-way
- **D-02:** 消息体大小上限取宽松档：`text` ≤ 32KB（32,768 字符）、`title` ≤ 256 字符、`options` ≤ 4 项 × 每项 64 字符、`callback_url` ≤ 2048 字符、`click_url` ≤ 2048 字符。超限返回 413 + 明确错误码 — **Reversibility:** costly
- **D-03:** answered 状态字段集 Phase 1 一次定全（`answered`/`answered_by`/`answered_at`/`answered_content`，初始 null）——Phase 4 只加 reply 处理逻辑和回调，不改 schema 不改表 — **Reversibility:** one-way
- **D-04:** `priority` 三档枚举 `low`/`normal`/`high`，默认 `normal`。服务端校验枚举（非自由字符串） — **Reversibility:** costly
- **D-05:** 消息对外 ID（wid）用 nanoid 形如 `m_xxx`（16 字符，前缀 m_ 表消息，URL 安全不可猜测），与 seq（频道内单调游标，SQLite rowid）职责分离 — **Reversibility:** one-way
- **D-06:** API 错误响应统一 `{"error":{"code":"...","message":"..."}}`——HTTP 状态码（401/413/429/400）+ 机器可读 code 枚举（如 `rate_limited`/`payload_too_large`/`invalid_key`）。golden fixtures 同时冻结正反例 — **Reversibility:** costly
- **D-07:** 协议版本字段：所有 WS 帧顶层带 `v:1`（整数递增）。演进规则写进 shared/ 包 README：只加字段不改语义、未知字段必须忽略（Rust serde 禁用 `deny_unknown_fields`）。客户端不识别的 v 即断连报错 — **Reversibility:** one-way
- **D-08:** 每频道保留最近 500 条消息，alarm 每日批量清理一次（`DELETE WHERE seq <= max(seq)-500`） — **Reversibility:** reversible
- **D-09:** 新客户端首次连接（`since: null`）默认拉最近 50 条——首屏轻快；更早历史通过 WS 内翻页按需拉取 — **Reversibility:** reversible
- **D-10:** 保留窗口缺口语义：补拉响应带 `oldest_kept_seq`；客户端发现请求的 `since` < `oldest_kept_seq` 时呈现"更早消息已清理"分隔线，不报错不断连 — **Reversibility:** costly
- **D-11:** 大窗口补拉走 WS 内翻页：`sync` 请求带 `limit`（默认 200，上限 500），一次拉不完响应标 `has_more: true`。不另开 HTTP 历史接口——补拉全部走 WS — **Reversibility:** costly
- **D-12:** Phase 1 实现 Admin API 最小集：`POST /api/admin/channels`（Admin Key 鉴权，创建频道 → 返回 Channel Key + Send Key）+ `GET /api/admin/channels`（列表） — **Reversibility:** costly
- **D-13:** Admin Key 本期走 Worker secret（`wrangler secret put ADMIN_KEY`）+ 常时比较鉴权；删除/重置/吊销等全套管理 API 不预建 — **Reversibility:** reversible
- **D-14:** 每计划（PLAN）完成后即 `wrangler deploy` 到 workers.dev 做生产冒烟，通过才算计划完成 — **Reversibility:** reversible
- **D-15:** 生产冒烟用固定 5 分钟 checklist，固化进部署脚本/文档：① curl 建频道 + 发消息 ② WS 连接收消息 ③ 断连重连 + since 补拉 ④ dashboard 看 DO duration 与请求曲线 — **Reversibility:** reversible

### Claude's Discretion
- monorepo 目录结构细节（pnpm workspace 布局、shared/ 包内部组织）
- 限流桶实现细节（令牌桶表结构、清理策略）——目标行为已定（每 Send Key 每分钟 30 条、429），实现方式自由
- KV 键前缀具体命名（`ch:`/`sk:`/`id:` 为研究推荐值，可微调）
- golden fixtures 的组织方式（按帧类型分文件 vs 单文件多例）
- 测试文件划分粒度（遵循一场景一文件的既定规范即可）

### Deferred Ideas (OUT OF SCOPE)
None — discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| SRV-01 | POST /send 发通知（Send Key 鉴权，title/Markdown body/可选 priority） | Worker 入口 KV `sk:` 预检（cacheTtl 60）→ DO publish；错误信封 D-06；大小上限 D-02 校验表；priority 枚举 D-04 |
| SRV-02 | 载荷可带 options[]（≤4）与 callback_url 随消息分发 | 消息 schema（shared 类型 + fixtures）；SQL 参数化存储 options JSON 串；callback_url 仅存储转发（Phase 4 才回调） |
| SRV-03 | WS 连频道（Channel Key 鉴权），同频道实时扇出 | Hibernation API 完整模式（acceptWebSocket/getWebSockets 扇出/quitters 清理）；Worker 层 KV `ch:` 预检 + DO 内可信内部头 |
| SRV-04 | WS 用 Hibernation API（ctx.acceptWebSocket），空闲不计时长 | 休眠计费语义已核实（idle 且 eligible 不计 duration）；auto-response 零计费；验收=生产 dashboard duration 不增（D-14 冒烟） |
| SRV-05 | 消息持久化 DO SQLite，频道内单调 seq；since 补拉 | 显式 seq 赋值模式（COALESCE(MAX)+1）；keyset 分页查询；oldest_kept_seq（D-10）+ limit/has_more 翻页（D-11） |
| SRV-06 | 群聊语义：多客户端互通、成员变更不丢消息 | 游标对账模型（write-ahead 先写库再扇出 + 客户端 seq 幂等去重）；getWebSockets 全量扇出；连接状态走 attachment |
| SRV-07 | 协议含版本字段，三端实现不漂移 | `v:1` 顶层字段 + golden fixtures（正反例）+ 演进规则 README；fixtures 静态 import 进测试 |
| KEY-01 | 三级密钥：Admin（管理）/ Send（只发）/ Channel（接收+回复） | KV 三前缀键表 + ADMIN_KEY Worker secret + timingSafeEqual；键生成用 crypto.getRandomValues |
| KEY-05 | 每 Send Key 每分钟限发 30 条（可配置），超限 429 | 推荐：ChatRoom DO 内 SQLite 固定窗口计数表（分析见"架构模式 Pattern 5"）；429 + `rate_limited` code |
</phase_requirements>

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| HTTP 入口路由 + 密钥预检 | Worker（无状态入口） | — | 每请求 1 KV 读（边缘缓存）+ 1 DO stub fetch；无效密钥在 Worker 层拒绝，不创建/唤醒 DO（省额度 + 防 DoS） |
| Send Key / Channel Key → channelId 解析 | Workers KV（`sk:`/`ch:` 前缀） | — | 读多写少完美匹配 KV 免费额度；重置密钥=改 KV 指针，DO 与历史不动 |
| Admin Key 校验 | Worker（secret） | — | 不进 KV；timingSafeEqual 常时比较 |
| 频道列表/创建 | Worker `/api/admin/*` | KV（`id:` 反向索引） | 列表来自 `id:` 前缀 KV list；创建=channelId 生成 + 3 次 KV 写 |
| WS 终结 + 扇出 + 会话状态 | ChatRoom DO（Hibernation） | — | acceptWebSocket + serializeAttachment（每连接状态跨休眠） |
| 消息持久化 + seq 分配 + 补拉 | ChatRoom DO SQLite | — | 单线程无竞态；显式 seq 同步块赋值原子 |
| 限流（30/min/Send Key） | ChatRoom DO SQLite | — | Send Key 单频道归属 → 计数器天然单 DO 内，无需协调 |
| 保留期清理 | ChatRoom DO alarm | — | 每日一次批量 DELETE；alarm 至少一次执行保证 |
| 协议契约（类型+fixtures） | packages/shared（npm workspace） | — | 四端唯一事实源；Rust/Kotlin 直接读仓库内 JSON 文件 |
| 静态资产占位（public/） | Workers Static Assets | — | asset-first 免费不限量；Phase 2/3 挂 pushhub.js 与管理页 |

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| wrangler | 4.126.0（npm 实查 2026-08-25 发布） | 构建/部署/本地 dev/类型生成 | CF 官方 CLI；支持 `exports` 声明（config schema 已含） |
| typescript | 7.0.2（npm 实查 2026-07-08） | 类型系统 | STACK.md 既定（若工具链摩擦退 5.9.x） |
| `@cloudflare/vitest-plugin` | 1.1.0（npm 实查；**包创建于 2026-08-20，仅 6 天龄**） | workerd 真运行时测试（真 DO/KV/WS） | 当前官方文档唯一路径（`cloudflareTest()`）；wrangler.configPath 自动读 compat/bindings。**[WARNING: flagged as suspicious — 包龄 6 天，planner 需在测试基建任务加 checkpoint:human-verify]** |
| vitest | 4.1.11（npm 实查 2026-08-18） | 测试框架 | vitest-plugin 的 peer（^4.1.0） |
| Workers 运行时内置 API | 运行时内置（零依赖） | DO/Hibernation/SQLite/KV/alarm/crypto | 全部平台内置，不装任何 @cloudflare/* 运行时包 |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `@cloudflare/vitest-pool-workers` | 0.22.0（npm 实查 2026-08-18，仍在发布） | vitest-plugin 的退路（`defineWorkersConfig` 旧 API） | 仅当 6 天龄的 vitest-plugin 在 Phase 1 实测遇阻时切换（已知问题集相同——known-issues 页同时服务两者） |
| pnpm | 本机 10.33.0（registry 最新 11.24.0） | workspace monorepo 包管理 | workspace 特性跨 10/11 稳定；本机版本即可，root `packageManager` 字段固定 10.33.0 |
| wrangler types（`--include-runtime=false`） | wrangler 内置 | 生成 Env-only `worker-configuration.d.ts` | 官方模板现行方案，避开 issue #8802 的 @types/node 冲突 |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `exports` 声明字段 | legacy `migrations` 数组（`new_sqlite_classes`） | 两者都合法且互斥；新项目按当前文档主推用 `exports`；`migrations` 是维护老 Worker 的路径 |
| `@cloudflare/vitest-plugin` | `@cloudflare/vitest-pool-workers` 0.22.0 | 后者成熟（2.5M 周下载）但文档已迁移走；前者 6 天龄。同仓同团队同 known-issues，切换成本低 |
| 显式 seq 赋值（COALESCE(MAX)+1） | `INTEGER PRIMARY KEY AUTOINCREMENT` | AUTOINCREMENT 每条消息多写 1 行（sqlite_sequence），日容量减半；显式赋值 1 行/消息但依赖"不删 max 行"不变量（保留策略天然满足） |
| DO 内限流表 | 独立 RateLimiter DO / KV 计数 | 独立 DO 每发 1 条多 1 次 DO 请求 + 多 1 个类；KV 写额度（1,000/天）直接排除 |
| 手写校验（长度/枚举/结构） | zod | STACK 既定不引入（消息体字段少，省包体）；错误码映射手写更直接 |

**Installation（server 包内）:**
```bash
# 仓库根（workspace 已 init 后）
pnpm --filter @pushhub/server add -D wrangler@4.126.0 typescript@7.0.2 \
  vitest@4.1.11 @cloudflare/vitest-plugin@1.1.0
```

**Version verification（本会话 npm 实查）:**
```
wrangler 4.126.0（published 2026-08-25，周下载 19.4M）
typescript 7.0.2（published 2026-07-08，周下载 273M）
vitest 4.1.11（published 2026-08-18，周下载 95M）
@cloudflare/vitest-plugin 1.1.0（time.created 2026-08-20，周下载 29k）
@cloudflare/vitest-pool-workers 0.22.0（published 2026-08-18，周下载 2.5M）
pnpm registry latest 11.24.0；本机安装 10.33.0
```

## Package Legitimacy Audit

> Package Legitimacy Gate 已执行（seam `package-legitimacy check --ecosystem npm`）。

| Package | Registry | Age | Downloads | Source Repo | Verdict | Disposition |
|---------|----------|-----|-----------|-------------|---------|-------------|
| wrangler | npm | 持续周更（last 2026-08-25） | 19.4M/wk | github.com/cloudflare/workers-sdk | SUS（仅 "too-new" 启发式） | Approved — 旗舰包周更是常态，官方文档确认 |
| typescript | npm | 多年（last 2026-07-08） | 273M/wk | github.com/microsoft/TypeScript | OK | Approved |
| vitest | npm | 持续周更（last 2026-08-18） | 95M/wk | github.com/vitest-dev/vitest | SUS（仅 "too-new" 启发式） | Approved — 同上，周更旗舰 |
| @cloudflare/vitest-plugin | npm | **6 天（created 2026-08-20）** | 29k/wk | github.com/cloudflare/workers-sdk | SUS（too-new，真实新包） | Flagged — planner 须在测试基建任务前加 `checkpoint:human-verify`（官方仓库+官方文档引用，合法但确实新；备选 vitest-pool-workers 就绪） |
| @cloudflare/vitest-pool-workers | npm | 成熟（last 2026-08-18） | 2.5M/wk | github.com/cloudflare/workers-sdk | SUS（仅 "too-new" 启发式） | Approved — 备选项，随时可切 |
| pnpm | npm | 持续周更（last 2026-08-24） | 172M/wk | github.com/pnpm/pnpm | SUS（仅 "too-new" 启发式） | Approved |

**Packages removed due to [SLOP] verdict:** none
**Packages flagged as suspicious [SUS]:** `@cloudflare/vitest-plugin`（唯一真实"新"包；其余为周更启发式误报，下载量/官方仓库佐证）

*说明：seam 的 "too-new" 启发式对"最近 7 天有发布"一律标 SUS——对周更的旗舰包（wrangler/vitest/pnpm）是误报；对 2026-08-20 才创建的 `@cloudflare/vitest-plugin` 是真实信号，已按协议加 checkpoint。所有包均无 postinstall 脚本（signals.postinstall: null），无网络/文件系统副作用。*

## Architecture Patterns

### System Architecture Diagram

```
 Webhook 发送方                管理脚本/curl                    客户端（浏览器 WS，Phase 2+ SDK；测试期任意 WS 客户端）
      │ POST /api/send             │ POST/GET /api/admin/*         │ GET /api/ws/:channelKey（Upgrade: websocket）
      │ Authorization: Bearer sk   │ Authorization: Bearer ADMIN    │
      ▼                            ▼                                ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ Worker（无状态入口，10ms CPU 预算）                                          │
│ 1. Send Key:  KV get "sk:<key>" {cacheTtl 60} ──miss──▶ 401 invalid_key     │
│ 2. Admin Key: crypto.subtle.timingSafeEqual(secret) ──不等──▶ 401           │
│ 3. Channel Key: KV get "ch:<key>" ──miss──▶ 401（不创建 DO stub，防 DoS）   │
│ 4. 通过 → CHANNELS.getByName(channelId).fetch(内部 URL + 可信头)             │
│    （静态资产 asset-first：/、/pushhub.js 命中资产则 Worker 不运行）         │
└───────────────┬──────────────────────────────┬──────────────────────────────┘
                │ DO stub fetch（publish）      │ DO stub fetch（WS upgrade 转发）
                ▼                              ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ ChatRoom DO（一群一实例，id=getByName(channelId)，SQLite-backed）            │
│ 构造器: CREATE TABLE IF NOT EXISTS …(幂等 DDL) + setWebSocketAutoResponse    │
│                                                                             │
│ publish 内部请求:                                                           │
│   a. 固定窗口限流检查（rate_sends 表）──超 30/min──▶ 429 rate_limited       │
│   b. 同步块: seq=COALESCE(MAX(seq),0)+1 → INSERT messages（1 行写）         │
│      （write-ahead：先落库，原子性由"无 await 间隔的写序列自动提交"保证）   │
│   c. for ws of ctx.getWebSockets(): ws.send(frame)（try/catch 清理死连接） │
│   d. 返回 200 {id: wid, seq} → Worker → 发送方                              │
│                                                                             │
│ WS 升级: WebSocketPair → ctx.acceptWebSocket(server) → serializeAttachment  │
│ webSocketMessage: {"type":"sync",since,limit} → keyset 查询 → history 帧    │
│                   {"type":"ping"} → auto-response 零唤醒回 pong             │
│ alarm()（每日）: DELETE WHERE seq <= max(seq)-500 + 限流桶清理              │
└─────────────────────────────────────────────────────────────────────────────┘
```

数据流追踪（主用例）：发送方 POST → Worker KV 预检（1 读，边缘缓存）→ DO stub fetch → DO 限流检查 → SQLite INSERT（seq 分配）→ 全连接扇出 → 各客户端收 `message` 帧 → 离线客户端重连后发 `sync since=last_seq` → DO keyset 查询回 `history` 帧 → 客户端按 seq 幂等去重。全程每次调用子请求数：Worker 侧 2（KV 读 + stub fetch），DO 侧 0 外呼。

### Recommended Project Structure

```
PushHub/
├── pnpm-workspace.yaml        # packages: ["packages/*"]
├── package.json               # root: private, packageManager: "pnpm@10.33.0", 公共 scripts
├── tsconfig.base.json         # 根基础 TS 配置（strict, ESNext, resolveJsonModule）
├── .gitignore
├── packages/
│   ├── shared/                # @pushhub/shared — 冻结的线协议（四端契约）
│   │   ├── package.json       # exports 指向 src/*.ts（internal-package 模式，无构建步）
│   │   ├── README.md          # 协议演进规则：只加字段不改语义；未知字段必须忽略；v 不识别即断连
│   │   ├── src/
│   │   │   ├── index.ts       # 全部 TS 类型 + 常量（PROTOCOL_VERSION=1、上限值、错误码枚举）
│   │   │   └── validators.ts  # 纯函数校验（长度/枚举/结构）——server 与未来 SDK 共用
│   │   └── fixtures/          # golden JSON fixtures（正例+反例，按帧类型分文件）
│   │       ├── message-frame.positive.json
│   │       ├── message-frame.negative.json   # 超长 text / priority 非法 / options>4
│   │       ├── sync-frame.*.json
│   │       ├── history-frame.*.json          # 含 oldest_kept_seq / has_more 语义例
│   │       ├── error-envelope.*.json         # 401/413/429/400 各 code 正反例
│   │       └── …
│   └── server/                # @pushhub/server — Worker + ChatRoom DO
│       ├── wrangler.jsonc     # exports 声明 ChatRoom；kv_namespaces；assets
│       ├── package.json
│       ├── vitest.config.ts   # cloudflareTest({wrangler:{configPath:"./wrangler.jsonc"}})
│       ├── src/
│       │   ├── index.ts       # Worker 入口：路由 + 三级密钥预检 + DO 转发
│       │   ├── chat-room.ts   # ChatRoom DO（publish/WS/sync/alarm）
│       │   ├── keys.ts        # KV 读写封装（ch:/sk:/id: 三前缀）+ key 生成
│       │   └── admin.ts       # Admin API（创建/列表）
│       ├── public/            # 静态资产目录（Phase 1 放占位 index.html；
│       │                      #   Phase 2 pushhub.js、Phase 3 管理页挂入此处）
│       └── test/              # 一场景一文件（见 Validation Architecture）
└── .planning/…
```

Rust（Phase 5）/Kotlin（Phase 6）后续直接以仓库相对路径 `packages/shared/fixtures/*.json` 读 fixtures（不经 npm），TS 两端经 `workspace:*` 静态 import JSON（需 `resolveJsonModule`）。

### Pattern 1: wrangler.jsonc——DO 类声明（exports 字段，greenfield 首选）

**What:** 用声明式 `exports` 字段声明 ChatRoom 类，替代 legacy `new_sqlite_classes` migrations 数组。
**When to use:** 本项目首版即用（一旦用 `exports` 部署，不能回退 `migrations`——两者互斥，且 greenfield 无历史包袱）。

```jsonc
// Source: https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/（逐字引用官方示例）
{
  "durable_objects": {
    "bindings": [
      {
        "name": "MY_DURABLE_OBJECT",
        "class_name": "MyDurableObject"
      }
    ]
  },
  "exports": {
    "MyDurableObject": {
      "type": "durable-object",
      "storage": "sqlite"
    }
  }
}
```

对应 PushHub：binding 名 `CHANNELS`，class_name `ChatRoom`。legacy 等价写法（退路，逐字）：

```jsonc
// Source: 同上页"Migrate from the legacy migrations flow"小节
{
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["ChatRoom"] }
  ]
}
```

**类名约束（不可轻改的理由）[VERIFIED: 官方 exports 文档，2026-07-15 版]**："Deleting a class removes its namespace and **all of its stored data permanently**"；重命名需 `{"state": "renamed", "renamed_to": "NewName"}` 墓碑 + 新名 live 条目，且官方建议三段式部署（先别名导出 → 应用墓碑 → 删别名）避免滚动窗口报错；回滚不能跨越生命周期变更。Free 计划强制 sqlite（错误码 `free_tier_requires_sqlite`）。**ChatRoom 类名在首版部署时即定型。**

### Pattern 2: Hibernation WebSocket 三件套（accept + attachment + auto-response）

**What:** 休眠 WS 的完整接法——构造器重建设施 + 升级处理 + 事件处理器。
**When to use:** ChatRoom DO 的 WS 全生命周期。

```ts
// Source: 官方 best-practices/websockets 页（2026-06-19 版）示例 + state API 页签名综合
import { DurableObject } from "cloudflare:workers";
import { WebSocketRequestResponsePair } from "cloudflare:workers";

export class ChatRoom extends DurableObject {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // 幂等 DDL：构造器在每次唤醒时重跑（官方 SQLite storage 示例即此模式）
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS messages(...)`);
    // auto-response 必须在构造器重设——休眠唤醒后实例状态清空
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(
        '{"type":"ping"}',            // request 与 response 各限 2,048 字符
        '{"type":"pong"}'
      )
    );
  }

  async fetch(request: Request): Promise<Response> {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);          // 禁止 server.accept()
    server.serializeAttachment({               // 每连接状态，上限 16,384 字节（见 State of the Art 修正）
      clientId: crypto.randomUUID(),
      name: new URL(request.url).searchParams.get("name") ?? "anon",
    });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const state = ws.deserializeAttachment();  // 跨休眠恢复
    // …处理 sync/ping 之外的业务帧…
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean) {
    ws.close(code, reason); // compat date >= 2026-04-07 时运行时自动回应 Close，close() 可省但安全
  }
}
```

扇出（publish 内）：

```ts
// Source: 官方 workers-chat-demo 模式（项目级 ARCHITECTURE.md 已锚定）+ getWebSockets 语义
const dead: WebSocket[] = [];
for (const ws of this.ctx.getWebSockets()) {   // 含休眠中连接的句柄
  try { ws.send(frame); } catch { dead.push(ws); }
}
for (const ws of dead) ws.close(1011, "send failed");
```

**协议层 ping/pong 由运行时自动应答且不唤醒 DO；`webSocketMessage` 不会收到控制帧 [VERIFIED: 官方 websockets 页 "Automatic ping/pong handling"]。** acceptWebSocket 标签参数：每 tag ≤256 字符、至多 10 个（当前场景不需要 tag，attachment 足够）。

### Pattern 3: 显式 seq 赋值（替代 AUTOINCREMENT）

**What:** 同一个同步代码块内"读 max+1 → 显式 INSERT"，利用 DO 单线程 + "无 await 间隔的写序列自动原子提交"语义。
**When to use:** 每次 publish。**不要**用 `AUTOINCREMENT`（每条消息多写一行 sqlite_sequence，日写入容量减半）；**不要**用 `lastRowid`（当前 SQLite storage 文档未提供该 API）。

```ts
// 依据 [VERIFIED: sqlite-storage-api 页]："Any series of write operations with no
// intervening await will automatically be submitted atomically"——两句 exec 之间零 await 即事务。
const next = this.ctx.storage.sql
  .exec("SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM messages")
  .one().n as number;                    // 1 行读（读额度 5M/天，无压力）
this.ctx.storage.sql.exec(
  "INSERT INTO messages (seq, wid, title, text, options, callback_url, click_url, priority, answered, answered_by, answered_at, answered_content, created_at) " +
  "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, NULL, NULL, NULL, ?9)",
  next, wid, title, text, optionsJson, callbackUrl, clickUrl, priority, Date.now()
);                                       // 1 行写；随后同块内扇出
```

单调性不变量：保留清理只删 `seq <= max(seq)-500`，永不删当前 max 行 → rowid 语义下的自动赋值等价于 max+1，无重用风险。若未来出现"删光"场景（不会：≤500 条不清理），显式赋值也在同步块内自洽。游标（cursor）必须同步消费完（`.one()`/`.toArray()`）再进入下一个 await——跨 await 的 cursor 无快照隔离 [VERIFIED: sqlite-storage-api 页 "Consume cursors synchronously"]。

### Pattern 4: 消息表 + 保留清理（alarm）

```sql
-- Phase 1 冻结版 schema（D-03 answered 字段一次定全；D-05 wid 与 seq 分离）
CREATE TABLE IF NOT EXISTS messages (
  seq             INTEGER PRIMARY KEY,      -- 频道内单调游标（显式赋值）
  wid             TEXT NOT NULL,            -- m_xxx 16 字符对外 ID
  title           TEXT,                     -- ≤256 字符
  text            TEXT NOT NULL,            -- Markdown 原文 ≤32,768 字符
  options         TEXT,                     -- JSON 数组串或 NULL（≤4 项×64 字符）
  callback_url    TEXT,                     -- ≤2048，Phase 4 才消费
  click_url       TEXT,                     -- ≤2048，D-01
  priority        TEXT NOT NULL DEFAULT 'normal',  -- low|normal|high
  answered        INTEGER NOT NULL DEFAULT 0,
  answered_by     TEXT, answered_at INTEGER, answered_content TEXT,  -- Phase 1 恒 NULL
  created_at      INTEGER NOT NULL
);
-- 不建二级索引：每行索引更新计 1 行写入 [VERIFIED: sqlite-storage-api 页]；
-- 补拉查询走 seq 主键天然高效（keyset: WHERE seq > ?1 ORDER BY seq ASC LIMIT ?2）
```

alarm 清理（D-08）：每日一次 `DELETE FROM messages WHERE seq <= (SELECT MAX(seq) - 500 FROM messages)`。**删除也计行写入 [VERIFIED: pricing 页 footnote "Deletes are counted as rows written"]——一天一次足够**。alarm 处理器内 catch 异常并重设下一天 alarm（官方建议：异常只自动重试 6 次就放弃，自 catch 才能无限重试）；构造器内若需 setAlarm 必须先 `getAlarm()` 判空（构造器在 alarm 处理器之前重跑，直接 set 会覆盖未触发的 alarm）[VERIFIED: alarms API 页]。

### Pattern 5: 限流——ChatRoom DO 内固定窗口计数表

**What:** `rate_sends(send_key TEXT PRIMARY KEY, window_start INTEGER NOT NULL, count INTEGER NOT NULL)`，60 秒固定窗口，30 条/窗口（可配置常量进 shared）。
**Why this wins [分析，基于已核实额度]**：
- KV 排除：KV 写 1,000 次/天，限流计数每条消息 1 写即爆。
- 独立 RateLimiter DO（workers-chat-demo 模式）排除：每发 1 条多 1 次 DO 请求（额度×2 消耗）+ 多 1 个 DO 类，v1 无收益——**Send Key 单频道归属（`sk:<key> → channelId`）使计数天然落在同一 ChatRoom DO 内，单线程无竞态**。
- 成本：每条消息 +1 行读 +1 行写（写序列无 await 间隔自动合并提交）。

```ts
const now = Date.now();
const row = this.sql.exec("SELECT window_start, count FROM rate_sends WHERE send_key = ?1", sk).toArray()[0];
if (!row || now - row.window_start >= 60_000) {
  this.sql.exec("INSERT INTO rate_sends (send_key, window_start, count) VALUES (?1, ?2, 1) " +
               "ON CONFLICT(send_key) DO UPDATE SET window_start = ?2, count = 1", sk, now);
} else if (row.count >= LIMIT_PER_MIN) {
  return new Response(JSON.stringify({error:{code:"rate_limited", message:"..."}}),
                      {status: 429, headers:{"Retry-After": String(60 - Math.ceil((now-row.window_start)/1000))}});
} else {
  this.sql.exec("UPDATE rate_sends SET count = count + 1 WHERE send_key = ?1", sk);
}
```

固定窗口边界允许瞬时 2× 突发（59s 处 30 条 + 新窗口 30 条）——对 KEY-05 "30 条/分钟、超限 429" 语义可接受；如需更平滑可改 30s 窗口×15 条（同一张表，常量调整）。过期桶行随每日 alarm 一并清理。

### Pattern 6: 三级密钥与 KV 键表

| KV 键 | 值（JSON 串，`get` 用 `type:"json"` 解析） | 写入时机 |
|---|---|---|
| `ch:<channel_key>` | `{channelId, name, createdAt}` | 建频道/重置 |
| `sk:<send_key>` | `{channelId}` | 建频道/重置 |
| `id:<channelId>` | `{channelKey, sendKey, name, createdAt}` | 建频道/重置（反向索引，供 `GET /api/admin/channels` list 与重置清理旧键） |

- 读路径 `cacheTtl` 用默认 60（最小 30，默认 60 [VERIFIED: KV read-key-value-pairs 页]）；负查询（不存在的 key）同样进边缘缓存——无效密钥轰击也大多命中缓存。
- **重置双活窗口**：写入会重验证 KV 内部区域/中心缓存层，但其他边缘的 cacheTtl 缓存仍可能供旧值至 TTL 到期——≤60s 双活是文档化行为（PITFALLS 1.4 成立，且本地 wrangler dev 即时一致掩盖此差异）。
- 密钥生成：`crypto.getRandomValues` 派生 base62（如 `phc_`+32 字符 / `phs_`+32 字符），**不引 nanoid 依赖**（D-05 只要求 nanoid 形态；5 行手写 + crypto RNG 即达不可猜测性）。channelId 同法 16 字符（`idFromName`/`getByName` 均吃任意字符串名，短名无碍）。
- Admin Key：`wrangler secret put ADMIN_KEY`；比较用 `crypto.subtle.timingSafeEqual(a, b)`——Workers 运行时对 Web Crypto 的非标准扩展，参数 ArrayBuffer/TypedArray [VERIFIED: Web Crypto runtime API 页]。注意先比长度再调用（长度不同直接 false，避免抛错泄漏时序）。

### Pattern 7: 静态资产目录（asset-first）

```jsonc
// Source: wrangler configuration 页（逐字段核实）+ static-assets/routing/worker-script 页
{
  "assets": {
    "directory": "./public",
    "binding": "ASSETS",
    "not_found_handling": "none"        // v1 占位阶段无需 SPA fallback；Phase 3 再评估
    // 不设 run_worker_first：默认 asset-first，/api/* 无资产可命中自然落 Worker
  }
}
```

**默认语义 [VERIFIED: worker-script 页，2026-08-18 版]**："Cloudflare will first attempt to serve static assets if one matches the incoming request… If an appropriate static asset is not found, Cloudflare will invoke your Worker script."——资产命中不触发 Worker 运行=免费不限量。风险防线：`public/` 内不得放与 `/api/` 路径同名的文件（会遮蔽 API）；如需保险可加 `"run_worker_first": ["/api/*"]`（数组式只对匹配路径 Worker 优先，静态路径仍 asset-first，免费性不受影响）。注意：`ctx.access` 在有静态资产的 Worker 里不可用（本项目不用 Cloudflare Access，无碍）。

### Pattern 8: WS 鉴权路由（Worker 预检 → DO 可信转发）

浏览器 WS 无法带 Authorization 头（项目研究已定论）→ Channel Key 走路径段 `/api/ws/:channelKey`。Worker 层：KV `ch:` 预检（无效 → 401，**不创建 DO stub**，防未鉴权连接烧 DO 请求）；通过 → `CHANNELS.getByName(channelId).fetch(重写后的内部 URL + X-PH-Verified: 1 内部头)`。DO 只经 Worker binding 可达，内部头可信。DO 升级处理不重复鉴权（可选留 debug 断言）。

### Anti-Patterns to Avoid

- **`server.accept()` / `ws.accept()` 代替 `ctx.acceptWebSocket()`** — DO 常驻计时长，一个 24/7 群烧 83% 日预算（PITFALLS 1.1；CLAUDE.md Do-NOT-use）。
- **DO 类字段存业务状态且不从三源重建** — 休眠唤醒即丢（PITFALLS 2.2）。内存=缓存，可从 getWebSockets/attachment/SQLite 重建。
- **`exports` 与 `migrations` 同时出现在 wrangler.jsonc** — 校验直接拒绝（互斥）。
- **消息表建二级索引** — 每行索引更新多计 1 行写入；keyset 查询走主键已够。
- **跨 `await` 持有 SQL cursor** — 无快照隔离，可能读到未提交数据；`.toArray()` 同步收完。
- **`setTimeout`/`setInterval` 在 DO 内做定时** — 阻止休眠，持续计时长；一律 alarm。
- **服务端 import Node API** — vitest 插件自动注入 `nodejs_compat`，本地/测试全绿但部署失败或生产报错（known-issues 明示）；服务端代码零 Node 依赖（CLAUDE.md 约束）。
- **fixture 断言写成"结构宽松匹配"** — golden fixtures 的意义在逐字节冻结；断言用 `toEqual`/快照，不用 `toMatchObject`。

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| WS 保活/心跳应答 | 逐条 ping 处理逻辑 | `setWebSocketAutoResponse` + 协议层 ping/pong 自动应答 | 零计费零唤醒 [VERIFIED: pricing footnote 3]；自写会唤醒 DO 烧时长 |
| 连接状态跨休眠 | 自建会话表/内存 Map | `serializeAttachment`/`deserializeAttachment` | 平台内置，16KB 上限内免 SQLite 行写 |
| 单调 ID 生成 | UUID/时间戳/雪花 | SQLite 主键显式 max+1 赋值 | rowid 主键即游标；keyset 分页天然支持；零额外写入 |
| 定时清理调度 | cron 触发 Worker 再转 DO | DO alarm | 至少一次执行保证 + 重试语义；Cron Triggers 需 dashboard 配置且粒度粗 |
| 常时比较 | `===` 比密钥 | `crypto.subtle.timingSafeEqual` | 运行时内置非标准扩展，防时序攻击 |
| 密钥/ID 不可猜测性 | 自定义随机算法 | `crypto.getRandomValues` | CSPRNG 平台内置 |
| DO 类生命周期管理 | 手写迁移脚本 | `exports` 声明 + wrangler deploy reconciliation | 控制面对账，结构化错误码；手写必错 |
| 类型生成 | 手抄 Env interface（首选）/手装 workers-types | `wrangler types --include-runtime=false` + `cf-typegen` script | 官方模板现行方案；手抄仅作 #8802 式冲突时的退路 |

**Key insight:** 这个领域里"看起来简单"的东西（保活、单调 ID、常时比较、幂等 alarm）全部有平台内置原语——自建的每一版都会在额度、正确性或安全上付出隐性代价。Phase 1 的工程量应该几乎全部花在协议与扇出逻辑本身。

## Common Pitfalls

### Pitfall 1: WS+DO 测试在按文件隔离模式下直接失败
**What goes wrong:** 含 WebSocket 的 DO 测试报隔离栈错误或不稳定。
**Why:** 官方 known-issues（2026-08-20）："Using WebSockets with Durable Objects is not supported with per-file storage isolation."
**How to avoid:** 测试命令整体带 `--max-workers=1 --no-isolate`（写进 npm script）；代价是文件间共享存储 → **每测试文件用 `crypto.randomUUID()` 生成唯一频道/key 名**（官方 fixture 同款做法，见 Code Examples 3）。
**Warning signs:** 偶发 "Failed to pop isolated storage stack"；测试结果随执行顺序变化。

### Pitfall 2: `exports` 部署后想退回 `migrations` 数组
**What goes wrong:** 配置校验拒绝；或误删类导致数据永久丢失。
**Why:** 两者互斥且单向；`deleted` 墓碑无回收站。
**How to avoid:** 首版 wrangler.jsonc 就用 `exports` 并接受不可回退；类名 `ChatRoom` 评审为冻结项；永不手改部署过的生命周期字段（改删/改名走墓碑语义 + 三段式部署）。
**Warning signs:** PR 试图重命名 ChatRoom 或调换声明方式。

### Pitfall 3: auto-response 配置在休眠唤醒后"消失"
**What goes wrong:** 客户端 ping 收不到 pong，判定死线频繁重连。
**Why:** `setWebSocketAutoResponse` 是实例级运行时状态，休眠唤醒后构造器重跑前的旧实例状态不复活。
**How to avoid:** 在构造器里无条件重设（幂等）；测试断言唤醒后 ping 仍被自动应答。
**Warning signs:** 生产环境客户端重连频率远高于心跳周期。

### Pitfall 4: vitest 自动注入 nodejs_compat 掩盖 Node 依赖
**What goes wrong:** 测试全绿，`wrangler deploy` 报错或生产运行时炸。
**Why:** 插件为让 vitest 跑通自动注入 `nodejs_compat`——Node API 在测试可用、生产不可用。
**How to avoid:** 服务端代码禁 `node:` import 与 Node 全局（评审硬检查项）；D-14 的每计划生产部署冒烟是最终防线。
**Warning signs:** 代码出现 `process.`、`Buffer`、`node:path`。

### Pitfall 5: 保留清理删掉了 max 行 / 清理过频
**What goes wrong:** seq 重用（客户端 last_seq 永远追不上）或行写额度翻倍消耗。
**Why:** SQLite 自动 rowid 在 max 行被删后可能重用；每次 DELETE 都计行写入。
**How to avoid:** 清理条件恒为 `seq <= max(seq)-500`（严格小于 max）；每日一次；显式 seq 赋值模式下"删光"分支也不可能出现重用。
**Warning signs:** dashboard rows_written 与消息量比例异常；客户端补拉死循环。

### Pitfall 6: asset-first 路径遮蔽 API
**What goes wrong:** `public/` 里某文件路径恰与 API 路由同名，请求被资产层吃掉。
**Why:** 默认 asset-first：资产命中就不进 Worker。
**How to avoid:** public/ 文件名约定不含 `api` 前缀路径；或加 `"run_worker_first": ["/api/*"]` 保险。
**Warning signs:** API 路由偶发返回静态文件内容。

### Pitfall 7: 构造器内 setAlarm 覆盖未触发的 alarm
**What goes wrong:** 每日清理 alarm 被构造器重置，永不触发或反复延后。
**Why:** DO 唤醒时构造器先于 alarm 处理器执行。
**How to avoid:** 构造器不 setAlarm；只在 publish/初始化路径与 alarm 处理器尾部 `getAlarm()` 判空后 setAlarm。
**Warning signs:** 消息堆积超过 500 条不清理；storage 用量缓涨。

### Pitfall 8: KV 读返回旧密钥映射（重置后 ≤60s 双活）
**What goes wrong:** 生产环境重置密钥后旧密钥仍可用约 1 分钟；本地测试却即时生效。
**Why:** KV 边缘缓存 cacheTtl（默认 60s）+ 最终一致。
**How to avoid:** 文档化为已知行为（v1 威胁模型可接受）；测试断言用唯一 key 规避时序而非依赖即时生效；未来敏感操作在 DO 内强一致裁决（Phase 3 kick-all 模式）。
**Warning signs:** 仅在生产出现的"重置了还能连"。

### Pitfall 9: cursor 未同步消费导致脏读
**What goes wrong:** 补拉查询结果混入并发写入甚至回滚数据。
**Why:** SQL cursor 跨 await 无快照隔离。
**How to avoid:** 查询即 `.toArray()`；扇出前完成所有读取。
**Warning signs:** 偶发 history 帧含"未来"消息或重复 seq。

### Pitfall 10: golden fixtures 只写正例
**What goes wrong:** 反例（超限/非法枚举/错误码）未冻结，三端各自发明校验行为。
**Why:** 协议冻结的价值一半在错误契约（D-06 明确正反例都要进 fixtures）。
**How to avoid:** 每帧类型至少 1 正 1 反；413/429/401/400 错误信封逐 code 一例；fixtures 契约测试逐字节断言。
**Warning signs:** fixtures 目录只有 happy-path JSON。

## Code Examples

以下模式 1-2、4-5 逐字/逐字段引自本会话读取的官方文档；示例 3 引自官方 workers-sdk fixture 源码。

### 1. 官方 Hibernation 最小示例（DO 侧）

```js
// Source: https://developers.cloudflare.com/durable-objects/best-practices/websockets/（逐字）
import { DurableObject } from "cloudflare:workers";

export class WebSocketHibernationServer extends DurableObject {
  async fetch(request) {
    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);
    this.ctx.acceptWebSocket(server);
    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  async webSocketMessage(ws, message) {
    ws.send(
      `[Durable Object] message: ${message}, connections: ${this.ctx.getWebSockets().length}`,
    );
  }

  async webSocketClose(ws, code, reason, wasClean) {
    ws.close(code, reason);
  }
}
```

### 2. 官方 exports 配置（逐字，含 legacy 等价）

见 "Pattern 1"。关键引用：`"exports": { "ChatRoom": { "type": "durable-object", "storage": "sqlite" } }` ⇔ `"migrations": [{ "tag": "v1", "new_sqlite_classes": ["ChatRoom"] }]`。

### 3. 官方 WS-over-DO 测试模式（fixture 源码逐字）

```ts
// Source: cloudflare/workers-sdk fixtures/vitest-plugin-examples/durable-objects/test/websockets.test.ts
import { env } from "cloudflare:workers";
import { it } from "vitest";

function getResponseWebSocket(response: Response) {
  const socket = response.webSocket;
  if (socket === null || socket === undefined) {
    throw new TypeError("Expected WebSocket response");
  }
  return socket;
}

it("preserves hibernatable WebSocket message order", async ({ expect }) => {
  const id = env.COUNTER.idFromName(
    `websocket-ordering-${crypto.randomUUID()}-${attempt}`,   // 每测试唯一名——no-isolate 模式的隔离手段
  );
  const stub = env.COUNTER.get(id);
  const response = await stub.fetch("https://example.com/websocket-order", {
    headers: { Upgrade: "websocket" },                        // 测试端扮演 WS 客户端
  });
  const socket = getResponseWebSocket(response);
  socket.accept();                                            // workerd 内客户端侧需 accept
  // …socket.send() / addEventListener("message") 收集断言…
});
```

### 4. vitest 配置（官方配置页逐字）

```ts
// Source: https://developers.cloudflare.com/workers/testing/vitest-integration/configuration/
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: "./wrangler.jsonc",   // main/compatibility_date/bindings 全部从 wrangler 配置读
      },
    }),
  ],
});
```

`wrangler.configPath` 自动同步 compatibility_date——旧路径"手抄日期导致漂移"的坑（PITFALLS 7.2④）就此消除。npm test script：`vitest run --max-workers=1 --no-isolate`（WS+DO 必须，见 Pitfall 1）。

### 5. 类型生成（官方模板现行方案）

```jsonc
// package.json scripts（Source: issue #8802 内嵌官方模板 worker-configuration.d.ts 头注释）
"cf-typegen": "wrangler types --include-runtime=false"
// 生成物仅含 Env 接口声明（declare namespace Cloudflare { interface Env {...} }），
// 不重复声明 Request 等运行时全局 → 与 vitest 的 @types/node 无冲突。
```

## State of the Art（对本项目既有文档的修正与换代记录）

| 旧认识（项目文档记录） | 当前事实（本会话官方文档核实） | 变更影响 |
|---|---|---|
| serializeAttachment ≤ 2,048 字节 | **≤ 16,384 字节**（websockets 页，2026-06-19 版："Maximum serialized size is 16,384 bytes"） | 每连接状态容量×8；仍建议精简（client name + 时间戳远够） |
| 入站 WS 消息上限 1 MiB | **32 MiB（仅接收方向）**（DO limits 页，2026-06-01 版） | 协议上限 32KB text 远低于两者，设计不受影响；仅修正认知 |
| KV cacheTtl 最小 60s | **最小 30s，默认 60s**（KV read API 页，2026-06-22 版） | 无操作变化（用默认 60 即可）；文档同步 |
| 单 DO 存储 10 GB | **Free 计划单 DO 1 GB、账户共 5 GB**（limits 页 FAQ："10 GB on Workers Paid, or 1 GB on the Free plan"）；10 GB 为 Paid | 500 条×32KB 上限 ≈ 单频道峰值 ~16MB+，距 1GB 仍远 |
| DO 每调用 CPU 10ms | **Worker 免费层入口 10ms CPU；DO 每调用默认 30s CPU**（limits 页 "CPU per request 30 seconds (default)"），每条入站 HTTP/WS 消息重置 | 哑管道设计不变；DO 侧 CPU 余量比认知大得多 |
| DO 类迁移用 `new_sqlite_classes` | **声明式 `exports` 字段为主推**（2026-07-15 文档；migrations 数组标 legacy）；互斥、单向 | wrangler.jsonc 首版用 exports |
| 测试用 `@cloudflare/vitest-pool-workers` + `defineWorkersConfig` | **文档全面迁移到 `@cloudflare/vitest-plugin` + `cloudflareTest()`**（known-issues/configuration 页 2026-08-20 版）；vitest-pool-workers 0.22.0 仍发布 | 测试基建选型变更（见 Stack） |
| `wrangler types` 与 vitest 不兼容（issue #8802 待复查） | **issue #8802 已关闭**（项目状态 Done）；官方模板 `--include-runtime=false` 生成 Env-only 类型 | STACK.md Gap #4 结案；退路（手写 Env）保留 |
| 免费层入站 WS 是否 20:1 折算——未明确 | **文档口径**："For compute requests **billing-only**, a 20:1 ratio is applied to incoming WebSocket messages… 100 WebSocket incoming messages would be charged as 5 requests. The 20:1 ratio does not affect Durable Object metrics and analytics"（pricing 页 footnote 2） | 免费层限额即计费配额（超限即报错）→ 20:1 大概率同样作用于免费层日限额；但文档未逐字写明"免费层强制执行按折算后计"——**保留 1:1 保守规划**（个人/小团队消息量下两者都无虞） |
| 静态资产需配置才不占请求额度 | **默认即 asset-first**：资产命中不触发 Worker（worker-script 页） | 无需额外配置；防路径遮蔽即可 |

**Deprecated/outdated（本阶段不再采用）：**
- `migrations` 数组（legacy；仅维护旧 Worker 用）
- `defineWorkersConfig` / `@cloudflare/vitest-pool-workers` 文档路径（包仍在，作退路）
- 手动安装 `@cloudflare/workers-types`（已被 `wrangler types` 流程取代，CLAUDE.md 已禁）
- `wrangler types`（不带参数）全量生成（与 vitest @types/node 冲突的根源；用 `--include-runtime=false`）

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `@cloudflare/vitest-plugin` 1.1.0（6 天龄）在 Phase 1 场景（WS+DO+KV+SQLite）稳定可用 | Standard Stack | 中——若遇阻切换 `@cloudflare/vitest-pool-workers` 0.22.0（同仓同 known-issues，切换成本一次配置）；checkpoint:human-verify 已要求 |
| A2 | wrangler 4.126.0 对 `exports` 字段的 deploy 校验与本会话所读文档一致（config schema 已含 exports，docs 页 2026-07-15 更新早于 wrangler 发布线） | Pattern 1 | 低——若校验拒绝，legacy `new_sqlite_classes` 写法即退路（官方文档双轨支持） |
| A3 | vitest 4 的 `--max-workers=1 --no-isolate` CLI 标志名与 CF 文档所写一致可直接用于 `vitest run` | Validation | 低——flags 直引官方 known-issues 页原文；若版本差异报 unknown option，等价配置为 vitest config 的 `maxWorkers:1, isolate:false`（vitest 4 配置键，未本会话验证） |
| A4 | compatibility_date 取 "2026-08-25"（wrangler 4.126.0 发布日，确保运行时认识该日期；≥2026-04-07 即含 web_socket_auto_reply_to_close） | 多处 | 低——日期过新会 deploy 报错，往前调一天即可 |
| A5 | 消息 50 条首拉（D-09）与翻页 limit 默认 200/上限 500 的响应体尺寸在单帧内可承受（200×~1KB≈200KB < 1MB 级 WS 出站，且 DO 无出站计费） | Pattern 4 | 低——如遇帧过大问题可下调默认 limit（协议字段不变） |
| A6 | pnpm 10.33.0（本机）+ workspace:* + internal-package（shared 直接导出 TS 源）与 wrangler 打包/vitest 转换兼容（两者都原生处理 TS 依赖） | Project Structure | 低——若 wrangler esbuild 不跟 workspace 符号链接，退路是 shared 加极薄构建步（tsc 出 dist） |
| A7 | 用户具备 Cloudflare 账号并可完成 `wrangler login`/`wrangler secret put ADMIN_KEY`（项目 CLAUDE.md 已定义部署工作流，未在本会话验证登录态） | Environment | 中——阻塞 D-14 生产冒烟；需用户在首个部署计划时配合 |

**其余所有平台/API 事实均标注 [VERIFIED: …]（本会话官方文档直读）或 [CITED: …]。**

## Open Questions

1. **`@cloudflare/vitest-plugin` 实际成熟度**（A1）
   - What we know: 官方仓库、官方文档全面采用、peer 精确匹配 vitest ^4.1.0、vitest-plugin-examples 含 durable-objects/kv-r2-caches 等完整 fixture。
   - What's unclear: 6 天龄在边角（alarm 隔离、WS no-isolate 组合）的实战表现。
   - Recommendation: 测试基建任务置于 Wave 0，加 checkpoint:human-verify；首个测试文件即覆盖 WS+DO 路径作为冒烟。
2. **20:1 折算是否作用于免费层强制限额**（见 State of the Art 表）
   - What we know: 文档明确 "billing-only" 口径 + 免费层超限即报错。
   - What's unclear: 免费层限额检查是否用折算后计数（文档未逐字）。
   - Recommendation: 维持 1:1 保守规划不动摇；上线后对照 dashboard 实际计数即可 empirically 确认，无前置动作。
3. **固定窗口 vs 滑动窗口限流的产品语义**
   - What we know: CONTEXT 把实现定为自由裁量；固定窗口边界可 2× 突发。
   - Recommendation: 默认固定 60s 窗口；若 discuss 阶段用户在意边界突发，改 30s×15 即可（同表结构）。

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | 构建/测试/wrangler | ✓ | v22.19.0 | — |
| pnpm | workspace 包管理 | ✓ | 10.33.0（registry 最新 11.24.0） | 无需升级；root packageManager 钉 10.33.0 |
| git | 版本控制 | ✓ | 2.52.0.windows.1 | — |
| npm registry 网络 | 依赖安装 | ✓（本会话 npm view 全通） | — | 镜像源 |
| Cloudflare 账号 + `wrangler login` | D-14 生产部署冒烟 | 未验证（A7） | — | 无——首个部署计划需用户配合一次交互式登录 |
| Cloudflare dashboard 访问 | 验收 3（DO duration 观察） | 未验证 | — | 无——人工步骤，写进部署 checklist |

**Missing dependencies with no fallback:** 无阻塞性缺失。Cloudflare 登录与 dashboard 为人工步骤而非环境缺失。
**Missing dependencies with fallback:** 无。

## Validation Architecture

> nyquist_validation 已启用（.planning/config.json）。

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest 4.1.11 + `@cloudflare/vitest-plugin` 1.1.0（跑在真实 workerd：真 DO/KV/WS/SQLite） |
| Config file | `packages/server/vitest.config.ts`（Wave 0 创建；`cloudflareTest({wrangler:{configPath:"./wrangler.jsonc"}})`） |
| Quick run command | `pnpm --filter @pushhub/server test`（= `vitest run --max-workers=1 --no-isolate`） |
| Full suite command | 同上（单套件；WS 场景与 HTTP 场景共用 no-isolate 配置） |

**测试组织铁律（研究结论）**：因 WS+DO 不支持按文件隔离 → 整套件 `--max-workers=1 --no-isolate` 共享存储 → **每测试文件以 `crypto.randomUUID()` 派生唯一频道名/key 前缀**做文件间隔离；alarm 相关测试在文件内 await 全部 alarm 完成后再断言。

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| SRV-01 | /api/send 鉴权+落库+响应（含 401/无效 key） | integration | `pnpm --filter @pushhub/server test -- test/send-basic.test.ts` | ❌ Wave 0 |
| SRV-01/D-02/D-04/D-06 | 载荷校验（超限 413/枚举 400/错误信封） | integration | `… test/send-validation.test.ts` | ❌ Wave 0 |
| SRV-02 | options/callback_url 随消息分发 | integration | `… test/send-payload-fields.test.ts` | ❌ Wave 0 |
| SRV-03 | WS 连接 + 扇出到多客户端 | integration | `… test/ws-fanout.test.ts` | ❌ Wave 0 |
| SRV-04 | 休眠模式接线正确（acceptWebSocket/auto-response；本地不驱逐但事件可达） | integration | `… test/ws-hibernation-wiring.test.ts` | ❌ Wave 0 |
| SRV-05/D-09/D-10/D-11 | since 补拉/首拉 50 条/翻页 has_more/oldest_kept_seq | integration | `… test/sync-catchup.test.ts` | ❌ Wave 0 |
| SRV-05 | seq 单调 + 幂等去重语义（重复推送客户端侧去重模型） | integration | `… test/seq-monotonic.test.ts` | ❌ Wave 0 |
| SRV-06 | 多客户端互通、断开重连零丢失 | integration | `… test/group-semantics.test.ts` | ❌ Wave 0 |
| SRV-07/D-06 | golden fixtures 正反例逐字节契约 | unit（fixtures 静态 import） | `… test/fixtures-contract.test.ts` | ❌ Wave 0 |
| KEY-01/D-12/D-13 | 三级密钥 + Admin API 创建/列表 | integration | `… test/admin-channels.test.ts` | ❌ Wave 0 |
| KEY-05 | 30/min 限流 429 + Retry-After | integration | `… test/rate-limit.test.ts` | ❌ Wave 0 |
| D-08 | 保留清理 alarm（500 条窗口） | integration | `… test/retention-alarm.test.ts` | ❌ Wave 0 |
| 验收 3 | 空闲 DO duration 不增长 | **manual-only** | 生产 dashboard 观察（D-15 checklist ④） | n/a（wrangler dev 不驱逐 DO，本地不可测——PITFALLS 7.1） |
| 验收 1 | 端到端延迟 < 2s | **manual-only** | D-15 生产冒烟（WS 客户端实测） | n/a（本地不代生产） |

### Sampling Rate
- **Per task commit:** `pnpm --filter @pushhub/server test`
- **Per wave merge:** 同上全量 + `pnpm -r typecheck`（若配） + `wrangler deploy` 生产冒烟（D-14：每 PLAN 完成即部署）
- **Phase gate:** 全量绿 + fixtures 契约全过 + D-15 五分钟生产 checklist 完成

### Wave 0 Gaps
- [ ] `packages/server/vitest.config.ts` — cloudflareTest 接线（REQ-全）
- [ ] `packages/server/test/send-basic.test.ts` — SRV-01
- [ ] `packages/server/test/fixtures-contract.test.ts` — SRV-07（依赖 packages/shared/fixtures/ 首批 JSON）
- [ ] `packages/server/test/ws-fanout.test.ts` — SRV-03/06
- [ ] `packages/server/test/sync-catchup.test.ts` — SRV-05
- [ ] 框架安装：见 Standard Stack Installation（全新仓库，无既有测试设施）

## Security Domain

> security_enforcement: true，ASVS Level 1。

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes（密钥即身份，无用户体系） | Send/Channel Key：256-bit 级随机 base62（crypto.getRandomValues）经 KV 解析；Admin Key：Worker secret + `crypto.subtle.timingSafeEqual` 常时比较（先长度检查后比较） |
| V3 Session Management | yes（WS 会话） | 鉴权在握手期一次完成（Worker 层 KV 预检 + DO 只信 Worker 转发的内部头）；会话无 cookie/token 续期；连接身份存 attachment |
| V4 Access Control | yes | 三级密钥权限隔离（Send 只发/Channel 只收+回复/Admin 管理）；KV 前缀分域（ch:/sk:/id:）；DO 内部端点仅经 binding 可达；限流（KEY-05）防开放中继 |
| V5 Input Validation | yes | shared/validators.ts 纯函数：D-02 全部上限、D-04 枚举、options 数量/项长、URL 长度与 scheme（callback_url/click_url 仅 https 为 Phase 4 议题，Phase 1 先存原样但校验长度）；超限 413/400 + D-06 错误码 |
| V6 Cryptography | yes（不自研） | 密钥/ID 生成仅用平台 crypto.getRandomValues；比较仅用 timingSafeEqual；无自造哈希/加密 |
| V12 File/Config | partial | ADMIN_KEY 走 `wrangler secret put`（不进仓库）；wrangler.jsonc 含 KV namespace id（非敏感）；.dev.vars 进 .gitignore |

### Known Threat Patterns for Cloudflare Workers + WS

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| 开放中继（泄露 Send Key 轰炸） | Abuse/Elevation | 每 Send Key 30/min 限流（KEY-05）+ 429 + 消息体上限（D-02）+ 独立重置（KV sk: 键） |
| 未鉴权 WS 握手烧 DO 额度 | DoS | Worker 层 KV 预检先于 DO stub 创建（PITFALLS 5.3 分层鉴权） |
| Admin Key 时序侧信道 | Information Disclosure | crypto.subtle.timingSafeEqual 常时比较 |
| Channel Key 泄露进服务端日志（路径段携带） | Information Disclosure | 已文档化取舍（自有日志面 + 密钥可独立重置兜底）；结构化日志不打印完整 URL query |
| 超大载荷 DoS（CPU/存储） | DoS | 入口即拒（413 payload_too_large）：text 32KB/title 256/options 4×64/URL 2048；WS 帧业务上限远低于平台 32MiB |
| 错误信息泄漏内部细节 | Information Disclosure | D-06 错误信封只含 code+通用 message，不含堆栈/内部键名 |

## Project Constraints (from CLAUDE.md)

来源：`D:\AIworkspaces\PushHub\.claude\CLAUDE.md`（项目级）+ `D:\AIworkspaces\CLAUDE.md`（工作区级）+ 用户全局 CLAUDE.md。Planner 逐条核对：

1. **服务端 TypeScript + Cloudflare Workers Runtime，不用 Node 专有 API**（服务端代码零 `node:` import / Node 全局——vitest 自动注入 nodejs_compat 会掩盖违规，评审硬检查）。
2. **零成本**：全部依赖免费额度，不引入付费服务。
3. **免费额度硬数据为容量规划依据**（Workers 10 万请求/天、DO 13,000 GB-s/天、DO SQLite 10 万行写/天、KV 1,000 写/天、静态资产免费不限量）——本研究的修正表见 State of the Art，规划以修正后数字为准。
4. **Do NOT use（Server）清单全部生效**：不用 `@cloudflare/workers-types` 手装（用 `wrangler types --include-runtime=false`）、不用 Pub/Sub/D1/R2/Queues、不用 KV-backed DO、不用 `ws.accept()`、不自建轮询/SSE、不用 Node API。
5. **消息端到端延迟 < 2 秒**（性能约束，进验收）。
6. **密钥分级可独立重置**（架构已内置）。
7. **每次部署测试后版本号 +1；部署冒烟 checklist 固化**（D-14/D-15 与工作区 CLAUDE.md 第 5 条一致）。
8. **全中文与用户交流**（过程性沟通；代码/文档主体语言由 planner 决定，协议字段名英文）。
9. **需要浏览器自动化时用 Playwright 技能**（Phase 1 无 Web UI，管理页阶段才适用；WS 冒烟若需浏览器客户端也走 Playwright）。
10. **GSD 工作流强制**：本阶段经 `/gsd-plan-phase` 进入，后续编辑在 GSD 流程内。

## Sources

### Primary (HIGH confidence — 本会话直接读取)
- [Durable Objects Pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)（2026-08-25 版）— 免费层超限即错/00:00 UTC 重置、20:1 WS 计费口径、auto-response 不计时长、休眠资格即免 duration、setAlarm=1 行写、删除计行写、outbound WS 15 分钟保活
- [DO class exports（新迁移系统）](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/)（2026-07-15 版）— exports 全语法/墓碑/三段式改名/互斥与不可回退/free_tier_requires_sqlite
- [DO class migrations (legacy)](https://developers.cloudflare.com/durable-objects/reference/durable-object-class-migrations-legacy/) — new_sqlite_classes 旧写法
- [Use WebSockets / Hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)（2026-06-19 版）— hibernation 示例、attachment 16,384 字节、自动 ping/pong、批帧建议、部署断连、出站 WS 不休眠
- [SQLite-backed DO Storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)（2026-05-27 版）— exec/cursor 同步消费/无 await 写序列自动原子/transactionSync/索引行计费/同步 KV API/alarm 语义
- [Durable Object State API](https://developers.cloudflare.com/durable-objects/api/state/)（2026-06-03 版）— acceptWebSocket(tags)/getWebSockets/setWebSocketAutoResponse(2048 字符)/blockConcurrencyWhile 构造器建议/waitUntil 无效/abort 本地不可用
- [Alarms API](https://developers.cloudflare.com/durable-objects/api/alarms/)（2026-04-21 版）— 单 alarm/至少一次/6 次重试后放弃/构造器 setAlarm 干扰/alarmInfo
- [DO Limits](https://developers.cloudflare.com/durable-objects/platform/limits/)（2026-06-01 版）— WS 消息 32MiB、Free 单 DO 1GB/账户 5GB/100 类、SQL 限额（2MB 行/100KB 语句/100 参数）、CPU 30s 默认、alarm 15 分钟墙钟
- [Vitest integration Known issues](https://developers.cloudflare.com/workers/testing/vitest-integration/known-issues/)（2026-08-20 版）— **WS+DO 不支持按文件隔离 → --max-workers=1 --no-isolate**、nodejs_compat 自动注入、动态 import 限制
- [Vitest integration Configuration](https://developers.cloudflare.com/workers/testing/vitest-integration/configuration/)（2026-08-20 版）— cloudflareTest/wrangler.configPath/CloudflareTestOptions
- [Isolation and concurrency](https://developers.cloudflare.com/workers/testing/vitest-integration/isolation-and-concurrency/)（2026-08-20 版）— 按文件隔离/共享存储开关/nodejs_compat 警示
- [KV Read key-value pairs](https://developers.cloudflare.com/kv/api/read-key-value-pairs/)（2026-06-22 版）— cacheTtl 最小 30 默认 60/陈旧读 60s/负查询缓存/写重验证内部层
- [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/) — exports 字段（schema 级确认）、assets 全字段（run_worker_first 数组式）、kv_namespaces、durable_objects.bindings
- [Static assets: Worker script routing](https://developers.cloudflare.com/workers/static-assets/routing/worker-script/)（2026-08-18 版）— 默认 asset-first 语义/run_worker_first 用法/ctx.access 限制
- [Web Crypto API (Workers)](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/) — crypto.subtle.timingSafeEqual 非标准扩展
- [DO Namespace API](https://developers.cloudflare.com/durable-objects/api/namespace/) — getByName/idFromName
- [workers-sdk fixture: durable-objects/test/websockets.test.ts](https://github.com/cloudflare/workers-sdk/tree/main/fixtures/vitest-plugin-examples/durable-objects) — 官方 WS-over-DO 测试模式（stub.fetch Upgrade + response.webSocket + 唯一 idFromName）

### Secondary (MEDIUM confidence)
- [Issue #8802: Wrangler types is recommended but hard to actually use in production](https://github.com/cloudflare/workers-sdk/issues/8802) — 已关闭（project: Done）；内嵌官方模板 `--include-runtime=false` 方案
- [pnpm Workspaces 官方文档](https://pnpm.io/workspaces) — workspace.yaml/`workspace:*` 协议/内部包模式
- npm registry 元数据实查（wrangler/typescript/vitest/vitest-plugin/vitest-pool-workers/pnpm 的版本、发布时间、周下载、仓库、postinstall）

### Tertiary (LOW confidence — 已进 Assumptions Log)
- A1-A7（见 Assumptions Log）

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — 版本 npm 实查；测试插件 6 天龄已降级标注并配 checkpoint + 成熟退路
- Architecture（exports 声明/休眠三件套/seq 赋值/限流/资产路由）: HIGH — 全部官方文档本会话直读，关键代码逐字引用
- Pitfalls: HIGH — WS+DO 隔离限制、nodejs_compat 注入等来自 2026-08-20 版官方 known-issues
- 协议细节（fixtures 内容组织）: MEDIUM — 由 CONTEXT 决策推导，具体 JSON 形态待 planner/spec 细化

**Research date:** 2026-08-26
**Valid until:** 2026-09-25（平台文档稳定；`@cloudflare/vitest-plugin` 处快速演进期，执行期如隔周可复查其 changelog）
