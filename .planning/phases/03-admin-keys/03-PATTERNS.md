# Phase 3: 管理页与密钥生命周期 - Pattern Map

**Mapped:** 2026-08-27
**Files analyzed:** 11（4 修改服务端 src + 2 新建静态资产 + 5 测试/脚本/文档联动）
**Analogs found:** 11 / 11（全部有强 analog——本阶段为既有代码纯增量扩展）

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `packages/server/src/admin.ts` | controller（route） | request-response / CRUD | 自身既有路由 + `index.ts` 的 `wsMatch` 正则路由 | exact |
| `packages/server/src/keys.ts` | model（KV 数据层） | CRUD | 自身 `createChannel`/`listChannels` 写读路径 | exact |
| `packages/server/src/chat-room.ts` | service（DO 内部路由） | request-response / event-driven | 自身 `fetch()` 路由表 + `sendHistory` keyset 翻页 | exact |
| `packages/server/src/index.ts` | controller（分发） | request-response | 自身 `/api/admin/` 前缀分发（大概率零改动） | exact |
| `packages/server/public/admin.html`（新） | component（静态页面） | — | `packages/server/public/index.html` | exact |
| `packages/server/public/admin.js`（新） | component（vanilla 前端逻辑） | request-response | `packages/server/public/viewer.js` | exact |
| `packages/server/test/admin-{send-keys,reset-kick,delete,history}.test.ts`（新×4） | test | request-response | `packages/server/test/admin-channels.test.ts` | exact |
| `packages/web-sdk/e2e/admin.spec.ts`（新） | test（E2E） | request-response | `packages/web-sdk/e2e/viewer.spec.ts` | exact |
| `packages/server/test/admin-channels.test.ts`（改） | test | request-response | 自身（响应结构断言联动） | exact |
| `packages/web-sdk/build.mjs`（改） | utility（构建） | transform | 自身 index.html `?v=` 注入段 | exact |
| `scripts/smoke.mjs`（改） | utility（冒烟脚本） | request-response | 自身 `createChannel`/`send` 段 | exact |
| `DEPLOY.md` / `WINDOWS.md`（改） | config（文档登记） | — | 既有登记段落 | role-match |

## Pattern Assignments

### `packages/server/src/admin.ts`（controller，新增 5 条 REST 路由）

**Analog:** 自身既有结构 + `index.ts:112` 的正则路由捕获

**鉴权模式（零改动复用，lines 59-63）**——新路由全部置于 `checkAdminAuth` 之后：

```typescript
export async function handleAdminApi(request: Request, env: Env): Promise<Response> {
  const denied = checkAdminAuth(request, env);
  if (denied !== null) {
    return denied;
  }
```

**参数化路由模式**（现有精确匹配 lines 65-69 改为正则；`index.ts:112` 已有先例 `/^\/api\/ws\/([^/]+)$/`）：

```typescript
const pathname = new URL(request.url).pathname;
if (pathname !== "/api/admin/channels") {
  return errorEnvelope(404, "not_found", "The requested resource was not found.");
}
```

**Body 校验模式（lines 71-88）**——label 校验直接照此三段式（typeof 检查 → 长度检查 → `errorEnvelope(400, "invalid_body", ...)`）：

```typescript
let body: unknown;
try {
  body = await request.json();
} catch {
  return errorEnvelope(400, "invalid_json", "Request body must be valid JSON.");
}
const name = (body as { name?: unknown } | null)?.name;
if (typeof name !== "string") {
  return errorEnvelope(400, "invalid_body", "Field 'name' is required and must be a string.");
}
if (name.length > CHANNEL_NAME_MAX_LENGTH) { ... }
```

**成功响应模式（lines 90-93）**：`new Response(JSON.stringify(...), { status: 201, headers: { "content-type": "application/json; charset=utf-8" } })`——注意 201 是密钥唯一完整返回点（T-01-04），新建 Send Key 同样 201 返回全量。

**关键约束：**
- channelId 校验与"不存在"同走 404 not_found（防探测，不区分格式错与不存在）
- 频道删除顺序：DO purge **先** → KV 键删**后**（重试幂等）；重置顺序：KV 写**先** → DO kick **后**（RESEARCH Pattern 3/4 已论证）
- Worker→DO 转发照 `index.ts:72-81` 模式：`new Request(INTERNAL_ORIGIN + "/kick-all", { headers: { [VERIFIED_HEADER]: "1" } })` 后 `env.CHANNELS.getByName(channelId).fetch(forward)`

---

### `packages/server/src/keys.ts`（model，KV 三前缀演进 + 多 Key CRUD）

**Analog:** 自身 `createChannel`（lines 119-136）与 `listChannels`（lines 143-170）

**写路径模式（lines 125-133）**——新写路径（建 Send Key / 吊销 / 重置 / 删除）全部照此形态，且必须收敛在本文件（键空间红线，lines 115-117 注释）：

```typescript
await env.KV.put(
  KEY_PREFIX_CH + channelKey,
  JSON.stringify({ channelId, name, createdAt }),
);
await env.KV.put(KEY_PREFIX_SEND + sendKey, JSON.stringify({ channelId }));
await env.KV.put(
  KEY_PREFIX_ID + channelId,
  JSON.stringify({ channelKey, sendKey, name, createdAt }),
);
```

**读路径模式（lines 35-39）**——cacheTtl 60 显式标注：

```typescript
const info = await env.KV.get<SendKeyInfo>(KEY_PREFIX_SEND + key, {
  type: "json",
  cacheTtl: 60,
});
return info ?? null;
```

**listChannels 读点（lines 156-163）**——`id:` schema 演进（sendKey → sendKeys[]）的 normalize 兼容层加在此 get 之后：旧格式 `{sendKey}` 映射为 `{sendKeys: [{key: old.sendKey, label: null, createdAt: old.createdAt}]}`，写路径恒写新格式（migrate-on-write）。

**复用生成器（lines 86-98）**：`generateSendKey()`/`generateChannelKey()`/`generateChannelId()` 直接复用——拒绝采样已冻结，勿新写。上限检查（D-31）在写前读 `id:` 计数，≥10 返回 400。

---

### `packages/server/src/chat-room.ts`（service，DO 新增 kick-all / history / purge 内部路由）

**Analog:** 自身 `fetch()` 路由表（lines 197-211）+ `sendHistory` keyset 翻页（lines 425-462）

**路由挂载模式（lines 197-211）**——新分支全部加在 X-PH-Verified 校验**之后**（结构上继承防护，Pitfall 8）：

```typescript
async fetch(request: Request): Promise<Response> {
  if (request.headers.get("X-PH-Verified") !== "1") {
    return errorEnvelope(401, "invalid_key", "Missing or invalid credentials.");
  }
  const url = new URL(request.url);
  if (url.pathname === "/publish" && request.method === "POST") {
    return this.handlePublish(request);
  }
  // 新增：/kick-all、/history、/purge 分支
  return errorEnvelope(404, "not_found", "Unknown internal route.");
}
```

**连接遍历 + close 模式（lines 287-297，publish 扇出同款）**——kickAll 直接照此：

```typescript
const dead: WebSocket[] = [];
for (const ws of this.ctx.getWebSockets()) {
  try {
    ws.send(frameJson);
  } catch {
    dead.push(ws);
  }
}
for (const ws of dead) {
  ws.close(1011, "send failed");
}
```

**keyset 翻页模式（lines 425-452）**——`/history` 倒序版复用同技巧（`LIMIT n+1` 判 has_more + `MESSAGE_COLUMNS` + `rowToMessageFrame` 同文件复用，含 answered 字段集）：

```typescript
const fetched = this.ctx.storage.sql
  .exec(
    `SELECT ${MESSAGE_COLUMNS} FROM messages ORDER BY seq DESC LIMIT ?1`,
    INITIAL_FETCH + 1,
  )
  .toArray() as unknown as MessageRow[];
hasMore = fetched.length > INITIAL_FETCH;
rows = (hasMore ? fetched.slice(0, INITIAL_FETCH) : fetched).reverse();
```

`/history` 改为 `WHERE seq < ?1 ORDER BY seq DESC LIMIT ?2` + `MIN(seq)` 求 `oldest_kept_seq`（lines 426-428 同款 `.one() as { m: number | null }`）。

**purge 关键约束**：`deleteAll()` 与 `deleteAlarm()` 必须成对（deleteAll 不删 alarm——漏掉即僵尸 DO 每日唤醒；alarm 自愈重设点在 lines 491-493 `finally { await this.ctx.storage.setAlarm(...) }`）。

**同步纪律**：SQL 查询全程同步、游标 `.toArray()/.one()` 即收，不跨 await 持有（Pitfall 9，既有代码一致遵守）。

---

### `packages/server/public/admin.html`（新，静态页面）

**Analog:** `packages/server/public/index.html`

**CSP meta 原样复制（index.html:8-11）**：

```html
<meta
  http-equiv="Content-Security-Policy"
  content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss: http: https:; img-src * data:; base-uri 'self'; form-action 'self'"
/>
```

**样式基调（index.html:13-92）**：`:root { color-scheme: light dark; }` + system-ui 字体 + `border: 1px solid canvastext; border-radius: 8px` 卡片式面板 + 语义色（`#2e9e5b` 绿 / `#c0392b` 红 / `#9a9a9a` 禁用 / `#d9a300` 过渡）——具体 token 见 03-UI-SPEC.md（间距归一 4/8/16/24/32、4 字号 2 字重）。

**脚本引入形态（index.html:129-131）**——admin.html 同款两条外链（CSP 禁 inline script）：

```html
<script src="/pushhub.js?v=0.1.10"></script>
<script src="/admin.js"></script>
```

注意：`?v=` 值由 build.mjs 注入（勿手写死版本）——admin.html 落地时先写占位 `?v=`，同步扩展 build.mjs。

---

### `packages/server/public/admin.js`（新，vanilla 前端逻辑）

**Analog:** `packages/server/public/viewer.js`

**localStorage 模式（viewer.js:24-25, 170-175, 198-205）**——admin 用独立键 `pushhub.admin`，读写均 try/catch（WR-03 防护先例）：

```javascript
var LS_SERVER = "pushhub.server";
var LS_KEY = "pushhub.key";
// ...
try {
  window.localStorage.setItem(LS_SERVER, serverUrl);
} catch (e) {
  // localStorage 不可用（隐私模式等）——免填功能降级
}
```

**textContent 纪律（viewer.js:98-104）**——频道名/标签/密钥/错误消息一律 textContent；全页唯一 innerHTML 入口是消息体（viewer.js:109）：

```javascript
body.innerHTML = window.PushHub.renderMarkdown(m.text);
```

**消息渲染（viewer.js:91-123）**——admin 历史视图逐条照此（时间 mono + title 加粗 textContent + body renderMarkdown + seq/answered 徽标）。

**错误展示（viewer.js:55-61）**——admin 错误条照此 + D-06 信封 code/message 透传（401 特例：清 localStorage 回登录屏障）。

**API 调用形态**：全部同源相对路径 + `Authorization: Bearer <adminKey>` 头（无 CORS/CSRF 面）。掩码 = 纯前端渲染 `key.slice(0,7) + "…" + key.slice(-4)`（UI-SPEC 已锁定）。

---

### `packages/server/test/admin-{send-keys,reset-kick,delete,history}.test.ts`（新，集成测试）

**Analog:** `packages/server/test/admin-channels.test.ts`

**测试骨架（admin-channels.test.ts:21-48）**——四个新文件照此复制（imports、TEST_ADMIN_KEY、`adminRequest`/`sendRequest`/`wsRequest`/`nextMessage`/`expectErrorEnvelope` helper 全部同型）：

```typescript
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const TEST_ADMIN_KEY = "test-admin-key-0123456789abcdef"; // 与 vitest.config.ts miniflare.bindings 一致

function adminRequest(method, body?, key = TEST_ADMIN_KEY, path = "/api/admin/channels"): Promise<Response> {
  // 经 exports.default.fetch 走真实 Worker 入口（覆盖路由 + 处理器）
}
```

**WS 帧监听铁律（lines 75-87）**：`socket.accept()` 后 `await nextMessage(socket)` 模式（首拉帧仍在发送缓冲）；踢连断言用 close 事件变体（或 E2E 侧断言"status 离开 online"）。

**信封断言（lines 89-97）**：`expectErrorEnvelope(resp, status, code)` 统一形态。

**本地 miniflare 强一致（RESEARCH Pitfall 2）**：可确定性断言"吊销后立即 401"——无需 sleep/mock 缓存；测试注释注明生产 60s 双活窗口语义。

---

### `packages/web-sdk/e2e/admin.spec.ts`（新，Playwright E2E）

**Analog:** `packages/web-sdk/e2e/viewer.spec.ts`

**Spec 骨架（viewer.spec.ts:17-66）**——BASE/ADMIN_KEY 常量、`createChannel`/`sendMessage` helper、`waitForFunction` 轮询断言全部同型；挂进既有 `packages/web-sdk/playwright.config.ts` webServer（含构建链 + wrangler dev + `--var ADMIN_KEY:e2e-admin-key`，零新配置）：

```typescript
const BASE = "http://127.0.0.1:4911";
const ADMIN_KEY = "e2e-admin-key";

async function createChannel(request: APIRequestContext): Promise<ChannelInfo> { ... }
```

**注意（Pitfall 5）**：踢连断言写"dot 类名不再是 dot-online"，勿断言进入 offline（SDK 退避重连永不 fatal）。剪贴板断言前 `await page.context().grantPermissions(["clipboard-read", "clipboard-write"])`。

**联动**：`viewer.spec.ts:28-42`、`reconnect.spec.ts:33-42` 的 `createChannel` helper 消费旧响应结构——`sendKey → sendKeys[]` 后必须同版本更新（返回类型 `ChannelInfo.sendKey` 改为取 `sendKeys[0].key` 或全量列表）。

---

### `packages/web-sdk/build.mjs`（改，?v= 注入扩展）

**Analog:** 自身 index.html 注入段（lines 47-67）

```javascript
const refRe = /pushhub\.js\?v=[0-9A-Za-z.-]+/g;
const hits = indexHtml.match(refRe) ?? [];
if (hits.length !== 1) { console.error(...); process.exit(1); }
writeFileSync(indexPath, indexHtml.replace(refRe, `pushhub.js?v=${rootVersion}`));
```

扩展形态：对 `../server/public/admin.html` 做同样的"读—恰一次断言—替换"（两文件各自恰一次）；`cache-bust-sync.test.ts` 同步扩展。这是**静默失效型集成点**——漏掉构建仍绿，但线上管理页吃 stale SDK。

---

### `scripts/smoke.mjs`（改，响应结构联动）

**Analog:** 自身 lines 79-89

```javascript
const channel = await resp.json();
if (!/^phs_[0-9A-Za-z]{32}$/.test(channel.sendKey)) fail(...);
// ...
const SEND_KEY = channel.sendKey;
```

联动改法：`channel.sendKey` → `channel.sendKeys[0].key`（正则断言同步）；可选新增 `/admin.html` 生产 200 且无 `x-ph-worker` 头的对照步骤（SC4，D-41）。

---

## Shared Patterns

### Admin 鉴权（两段式常时比较）
**Source:** `packages/server/src/admin.ts:34-56`（`checkAdminAuth`）
**Apply to:** 全部 5 条新路由——零新写，`handleAdminApi` 入口已有调用，新路由分支置于其后即可。

### 错误信封（D-06）
**Source:** `packages/server/src/envelope.ts`（`errorEnvelope(status, code, message)`；chat-room.ts:104-109 有同形私有实现）
**Apply to:** 所有服务端新路由与 DO 新分支。code 是小写 snake_case 任意字符串（admin 域 `"not_found"` 先例不在 shared ErrorCode 枚举内）——新码（如 send key 超限）走同形态字符串，不扩 shared 冻结枚举。

### Worker→DO 内部转发
**Source:** `packages/server/src/index.ts:26-27, 72-81`
**Apply to:** kick-all / history / purge 全部触发路径。`INTERNAL_ORIGIN = "https://do.pushhub.internal"` + `X-PH-Verified: 1` 头 + `env.CHANNELS.getByName(info.channelId).fetch(forward)`；channelId → DO 名经 KV `id:` 读取（miss → 404，不触 DO）。

### SC4 标记头
**Source:** `packages/server/src/index.ts:131-144`（`stampMarker`）
**Apply to:** E2E/冒烟的资产对照断言——`/admin.html` 响应 200 且**无** `x-ph-worker` 头；`/api/admin/*` 有该头。

### textContent 纪律（前端安全）
**Source:** `viewer.js:98-104`（title 走 textContent）vs `viewer.js:109`（唯一 innerHTML 入口 = renderMarkdown）
**Apply to:** admin.js 全部动态内容——频道名/标签/密钥/错误一律 textContent；唯一 innerHTML 是历史消息体的 `PushHub.renderMarkdown(m.text)`。

### SQL 纪律（DO 内）
**Source:** `chat-room.ts` 全文件
**Apply to:** `/history`、`/purge` 新查询——显式列名（`MESSAGE_COLUMNS`，禁 SELECT *）、绑定参数（`?n` 占位）、同步 `.toArray()/.one()` 即收不跨 await、禁 OFFSET 分页（keyset + `LIMIT n+1` 判 has_more）。

## No Analog Found

无——本阶段全部文件在代码库内有 exact 级 analog（见上表）。RESEARCH.md 的 Code Examples（参数化路由正则、/history 倒序查询、purge 成对清理）可作为无先例细节的补充模板。

## Metadata

**Analog search scope:** `packages/server/src/`、`packages/server/public/`、`packages/server/test/`、`packages/web-sdk/{build.mjs,e2e/}`、`scripts/`
**Files scanned:** 11 个 analog 全文精读
**Pattern extraction date:** 2026-08-27
**上游输入:** 03-CONTEXT.md（D-28~D-41）、03-RESEARCH.md（Pattern 1-6 + Pitfall 1-8）、03-UI-SPEC.md（视觉/交互契约）
