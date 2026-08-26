# Phase 1: 服务端核心与协议冻结 - Pattern Map

**Mapped:** 2026-08-26
**Files analyzed:** 24（新建 24 / 修改 0）
**Analogs found:** 0 / 24 — **绿地项目**（仓库仅含 `.planning/` 与 `.claude/`，零源码）。所有"analog"以 RESEARCH.md 中逐字引用的官方文档/官方 fixture 模式替代（Pattern 1-8、Code Examples 1-5）。Planner 应将下述外部规范模式视为"既有代码"，逐字复制后按 PushHub 命名适配。

## File Classification

| New/Modified File | Role | Data Flow | External Analog（RESEARCH.md 出处） | Match Quality |
|-------------------|------|-----------|-------------------------------------|---------------|
| `pnpm-workspace.yaml` | config | — | pnpm Workspaces 官方文档（RESEARCH §Recommended Project Structure / A6） | 文档模式 |
| `package.json`（root） | config | — | 同上（`packageManager: "pnpm@10.33.0"`） | 文档模式 |
| `tsconfig.base.json` | config | — | 同上（strict / ESNext / resolveJsonModule — fixtures 静态 import 前提） | 文档模式 |
| `.gitignore` | config | — | 标准模板（须含 `.dev.vars`、`node_modules`、`.wrangler`） | 文档模式 |
| `packages/shared/package.json` | config | — | pnpm internal-package 模式（exports 指向 src/*.ts，无构建步，A6） | 文档模式 |
| `packages/shared/README.md` | doc | — | D-07 协议演进规则（只加字段不改语义/未知字段必须忽略/v 不识别即断连） | 决策推导 |
| `packages/shared/src/index.ts` | model/types | — | D-01~D-07 冻结 schema（TS 类型 + PROTOCOL_VERSION=1 + 上限常量 + 错误码枚举） | 决策推导 |
| `packages/shared/src/validators.ts` | utility | transform | RESEARCH §Security V5：纯函数校验（D-02 上限 / D-04 枚举 / options 数量项长 / URL 长度） | 文档模式 |
| `packages/shared/fixtures/*.json` | test-fixture | — | RESEARCH Pitfall 10：每帧类型至少 1 正 1 反；error-envelope 逐 code 一例 | 文档模式 |
| `packages/server/package.json` | config | — | RESEARCH §Standard Stack Installation 命令 | 文档模式 |
| `packages/server/wrangler.jsonc` | config | — | **Pattern 1**（exports 声明 DO 类）+ **Pattern 7**（assets asset-first）+ kv_namespaces | 官方逐字 |
| `packages/server/vitest.config.ts` | config/test | — | **Code Example 4**（cloudflareTest + wrangler.configPath，官方逐字） | 官方逐字 |
| `packages/server/src/index.ts` | controller（Worker 入口） | request-response | **Pattern 8**（WS 鉴权路由：Worker KV 预检 → DO 可信转发）+ **Pattern 6**（KV 三前缀 + timingSafeEqual） | 官方逐字 |
| `packages/server/src/chat-room.ts` | service（Durable Object） | event-driven（WS 扇出）+ CRUD（SQLite） | **Pattern 2**（Hibernation 三件套）+ **Pattern 3**（显式 seq）+ **Pattern 4**（表结构 + alarm）+ **Pattern 5**（限流表）+ **Code Example 1** | 官方逐字 |
| `packages/server/src/keys.ts` | service/utility | CRUD（KV） | **Pattern 6**（ch:/sk:/id: 键表 + crypto.getRandomValues 派生 base62） | 官方逐字 |
| `packages/server/src/admin.ts` | controller | CRUD（request-response） | **Pattern 6** + D-12/D-13（Admin Key secret + timingSafeEqual + KV id: list） | 文档模式 |
| `packages/server/public/index.html` | static | — | **Pattern 7**（占位资产；禁止与 /api/ 路径同名 — Pitfall 6） | 官方逐字 |
| `packages/server/test/*.test.ts`（12 个文件） | test | 见验证映射 | **Code Example 3**（官方 workers-sdk WS-over-DO fixture，逐字） | 官方逐字 |

## Pattern Assignments

### `packages/server/wrangler.jsonc` (config)

**Analog:** RESEARCH.md Pattern 1（官方 exports 声明，逐字）+ Pattern 7（assets）

```jsonc
// 逐字复制 Pattern 1，适配命名：binding=CHANNELS, class=ChatRoom
{
  "durable_objects": { "bindings": [{ "name": "CHANNELS", "class_name": "ChatRoom" }] },
  "exports": { "ChatRoom": { "type": "durable-object", "storage": "sqlite" } }
}
// Pattern 7:
{
  "assets": { "directory": "./public", "binding": "ASSETS", "not_found_handling": "none" }
  // 不设 run_worker_first（默认 asset-first）；可加 "run_worker_first": ["/api/*"] 作保险
}
```

要点：`exports` 与 `migrations` 互斥且不可回退（Pitfall 2）；`compatibility_date` 取 "2026-08-25"（A4）；加 `kv_namespaces`（id 非敏感可进仓库）。**禁止** legacy `new_sqlite_classes` 写法作首版（退路除外）。

---

### `packages/server/src/chat-room.ts` (service / Durable Object — 核心文件)

**Analog:** RESEARCH.md Pattern 2 + Code Example 1（官方 Hibernation 逐字示例）

```ts
import { DurableObject, WebSocketRequestResponsePair } from "cloudflare:workers";

export class ChatRoom extends DurableObject {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS messages(...)`);  // 幂等 DDL，每次唤醒重跑
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}')  // 构造器必须重设（Pitfall 3）
    );
  }
  async fetch(request: Request) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);        // 禁止 server.accept()
    server.serializeAttachment({ clientId: crypto.randomUUID(), /* name, last_seq */ });
    return new Response(null, { status: 101, webSocket: client });
  }
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const state = ws.deserializeAttachment();  // 跨休眠恢复
    // sync 帧 → keyset 查询 → history 帧（D-10/D-11：oldest_kept_seq + has_more + limit）
  }
  async webSocketClose(ws, code, reason, wasClean) { ws.close(code, reason); }
}
```

**扇出（publish 内）** — Pattern 2 扇出段（workers-chat-demo 模式）：
```ts
const dead: WebSocket[] = [];
for (const ws of this.ctx.getWebSockets()) {
  try { ws.send(frame); } catch { dead.push(ws); }
}
for (const ws of dead) ws.close(1011, "send failed");
```

**seq 赋值** — Pattern 3（逐字）：同步块内 `SELECT COALESCE(MAX(seq),0)+1` → 显式 INSERT（两句 exec 之间零 await = 自动原子提交）。**禁 AUTOINCREMENT**（日写入容量减半）。游标同步 `.one()`/`.toArray()` 收完（Pitfall 9）。

**表结构** — Pattern 4（逐字冻结）：`messages(seq INTEGER PRIMARY KEY, wid TEXT, title, text, options JSON 串, callback_url, click_url, priority, answered, answered_by, answered_at, answered_content, created_at)`。**不建二级索引**（每行索引更新计 1 行写）。补拉：`WHERE seq > ?1 ORDER BY seq ASC LIMIT ?2`。

**限流** — Pattern 5（逐字）：`rate_sends(send_key PRIMARY KEY, window_start, count)` 固定 60s 窗口 × 30 条，超限 429 + D-06 错误信封 + `Retry-After` 头。

**alarm** — Pattern 4：每日 `DELETE FROM messages WHERE seq <= (SELECT MAX(seq)-500 FROM messages)` + 限流桶清理；alarm 处理器自 catch 并重设下一天；**构造器不 setAlarm**（Pitfall 7，只在 publish/alarm 尾部 `getAlarm()` 判空后 set）。

---

### `packages/server/src/index.ts` (controller / Worker 入口)

**Analog:** RESEARCH.md Pattern 8（Worker 预检 → DO 可信转发）+ Pattern 6 鉴权

- Send Key：`env.KV.get("sk:"+key, {type:"json", cacheTtl: 60})` → miss 即 401（不创建 DO stub，防 DoS）。
- Admin Key：先比长度再 `crypto.subtle.timingSafeEqual(a, b)`（Workers 非标准扩展）。
- Channel Key（WS）：`GET /api/ws/:channelKey` 路径段携带；KV `ch:` 预检通过 → `env.CHANNELS.getByName(channelId).fetch(重写内部 URL + X-PH-Verified: 1 可信头)`；DO 不重复鉴权。
- 错误统一 D-06 信封：`{"error":{"code":"...","message":"..."}}`，401 `invalid_key` / 413 `payload_too_large` / 429 `rate_limited` / 400 校验错。
- 校验调用 shared `validators.ts`（Worker 层入口即拒，10ms CPU 预算）。

---

### `packages/server/src/keys.ts` (service / KV 封装)

**Analog:** RESEARCH.md Pattern 6（KV 键表，逐字）

| KV 键 | 值 | 写入时机 |
|---|---|---|
| `ch:<channel_key>` | `{channelId, name, createdAt}` | 建频道/重置 |
| `sk:<send_key>` | `{channelId}` | 建频道/重置 |
| `id:<channelId>` | `{channelKey, sendKey, name, createdAt}` | 建频道/重置（list/清理用） |

密钥生成：`crypto.getRandomValues` 派生 base62（`phc_`/`phs_` + 32 字符），channelId 16 字符——**不引 nanoid 依赖**。读路径 cacheTtl 用默认 60。

---

### `packages/server/src/admin.ts` (controller)

**Analog:** Pattern 6 + D-12/D-13。`POST /api/admin/channels`（Admin Key → 生成 channelId + 2 类密钥 + 3 次 KV 写 → 返回 Channel Key + Send Key）；`GET /api/admin/channels`（KV `id:` 前缀 list）。Admin Key 来自 `env.ADMIN_KEY`（wrangler secret）。

---

### `packages/shared/src/index.ts` + `validators.ts` + `fixtures/` (model/types + utility + fixture)

**Analog:** CONTEXT 决策 D-01~D-11（schema 冻结的唯一依据）

- 类型：消息帧含 `v:1`（顶层）、`wid`（m_xxx 16 字符）、`seq`、`title?`、`text`、`options?`、`callback_url?`、`click_url?`、`priority(low|normal|high)`、`answered/answered_by/answered_at/answered_content`。
- 常量：`PROTOCOL_VERSION=1`、上限表（text 32,768 / title 256 / options 4×64 / URL 2,048）、保留窗口 500、首拉 50、sync limit 默认 200 上限 500、限流 30/min。
- fixtures：每帧类型 1 正 1 反；error-envelope 逐 code 一例；断言用 `toEqual` 逐字节（禁 `toMatchObject`）。

---

### `packages/server/vitest.config.ts` (config/test)

**Analog:** RESEARCH.md Code Example 4（官方逐字）

```ts
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
});
```

npm script 必须含 `vitest run --max-workers=1 --no-isolate`（WS+DO 不支持按文件隔离——Pitfall 1）。**任务前置 checkpoint:human-verify**（vitest-plugin 1.1.0 仅 6 天龄，A1；退路 `@cloudflare/vitest-pool-workers` 0.22.0 + `defineWorkersConfig`）。

---

### `packages/server/test/*.test.ts` (test — 12 个文件)

**Analog:** RESEARCH.md Code Example 3（官方 workers-sdk fixture 逐字）

```ts
import { env } from "cloudflare:workers";
const id = env.CHANNELS.idFromName(`test-${crypto.randomUUID()}`);  // 每测试唯一频道名——no-isolate 隔离手段
const stub = env.CHANNELS.get(id);
const response = await stub.fetch("https://example.com/ws", { headers: { Upgrade: "websocket" } });
const socket = response.webSocket; socket.accept();  // workerd 客户端侧需 accept
```

一场景一文件；文件 ↔ 验证映射见下节（来自 01-VALIDATION.md）。

## Shared Patterns（跨切面，适用所有 server 文件）

### 鉴权（三级密钥）
**Source:** Pattern 6 / Pattern 8。Worker 层 KV 预检（cacheTtl 60）+ `crypto.subtle.timingSafeEqual`（Admin，先比长度）；DO 只信 Worker 内部头 `X-PH-Verified: 1`；无效密钥不创建 DO stub。

### 错误处理（D-06 信封）
**Source:** D-06。所有错误路径统一 `{"error":{"code":"...","message":"..."}}` + 401/413/429/400；message 不含堆栈/内部键名。

### 校验（shared validators）
**Source:** V5。纯函数、入口即拒、413/400 映射错误码；不引 zod。

### 零 Node 依赖（评审硬检查）
**Source:** Pitfall 4。服务端代码禁 `node:` import 与 `process.`/`Buffer` 等 Node 全局（vitest 自动注入 nodejs_compat 会掩盖违规，D-14 生产部署冒烟兜底）。

### 反模式清单（实现时逐条对照）
`ws.accept()` / DO 字段存业务态不重建 / exports+migrations 并存 / 消息表二级索引 / 跨 await 持 cursor / DO 内 setTimeout/setInterval / fixture 宽松匹配 —— 全部来自 RESEARCH §Anti-Patterns。

## Verification Map（文件 ↔ 01-VALIDATION.md）

| 新文件 | 验证（test 文件 / 方式） |
|---|---|
| src/index.ts + keys.ts | `test/send-basic.test.ts`、`test/send-validation.test.ts`、`test/admin-channels.test.ts` |
| src/chat-room.ts（publish/扇出） | `test/ws-fanout.test.ts`、`test/send-payload-fields.test.ts`、`test/seq-monotonic.test.ts`、`test/rate-limit.test.ts` |
| src/chat-room.ts（WS/sync） | `test/sync-catchup.test.ts`、`test/group-semantics.test.ts`、`test/ws-hibernation-wiring.test.ts` |
| src/chat-room.ts（alarm） | `test/retention-alarm.test.ts` |
| shared/fixtures/ | `test/fixtures-contract.test.ts`（逐字节） |
| wrangler.jsonc + 部署 | D-15 生产冒烟 checklist（manual）；验收 3（DO duration 不增）manual-only |

## No Analog Found

无代码库内 analog（绿地）。全部以 RESEARCH.md 官方逐字模式 + CONTEXT 决策 D-01~D-15 作为规范来源；无需额外外部研究。

## Metadata

**Analog search scope:** 仓库全量（仅 `.planning/`、`.claude/`，零源码）；规范来源为 `01-RESEARCH.md` Pattern 1-8 / Code Examples 1-5 及 `.planning/research/{STACK,ARCHITECTURE,PITFALLS}.md`
**Files scanned:** 0（无源码）
**Pattern extraction date:** 2026-08-26
