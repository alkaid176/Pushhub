---
phase: 01-server-core
reviewed: 2026-08-26T11:40:01Z
depth: standard
files_reviewed: 11
files_reviewed_list:
  - packages/server/src/index.ts
  - packages/server/src/chat-room.ts
  - packages/server/src/keys.ts
  - packages/server/src/admin.ts
  - packages/server/src/envelope.ts
  - packages/server/src/env.d.ts
  - packages/shared/src/index.ts
  - packages/shared/src/validators.ts
  - packages/server/vitest.config.ts
  - packages/server/wrangler.jsonc
  - scripts/smoke.mjs
findings:
  critical: 1
  warning: 2
  info: 6
  total: 9
status: issues_found
---

# Phase 01: Code Review Report

**Reviewed:** 2026-08-26T11:40:01Z
**Depth:** standard
**Files Reviewed:** 11
**Status:** issues_found

## Summary

Cloudflare Workers + SQLite-backed Durable Object + KV 的服务端核心切片。整体实现质量较高：10 条关键不变量中 8 条经逐行核实成立——

- WS Hibernation 三件套正确接线（`acceptWebSocket` / `serializeAttachment` / 构造器重设 `setWebSocketAutoResponse`，全代码无 `ws.accept()`）；PING/PONG 字面量与 `setWebSocketAutoResponse` 字节精确匹配。
- seq 分配原子性成立：`COALESCE(MAX)+1` SELECT 与 INSERT 之间零 await（chat-room.ts:253-261 同步块），DO 单线程下无交错点。
- 限流先行：`checkRateLimit` 在校验与 seq 分配之前，30/min 固定窗口语义正确（第 31 条 429），`Retry-After` 恒为 >= 1 整数；读写间零 await。
- 保留清理正确：`DELETE seq <= MAX-500` 永不触 max 行、空表条件恒假；构造器无 `setAlarm`；`alarm()` 自 catch + `finally` 无条件重设。
- 哑管道成立：text/options/双 URL 存储与扇出逐字透传，无解析无截断。
- 服务端零 Node API（src 全目录 grep `node:` / `require(` 零命中；smoke.mjs 的 Node 用法属工具链，已文档化豁免）。
- 校验器：UTF-16 `string.length` 判长、枚举匹配、未知字段容忍、空 options 归一省略。
- 密钥安全：src 内无任何日志语句，无密钥落日志路径；401 统一码。

发现 1 个 Critical：Admin Key 两段式常时比较的长度前置分支按 **UTF-16 码元数**而非**字节长度**比较，非 ASCII Bearer 凭据可在等长前提下使 `crypto.subtle.timingSafeEqual` 抛出未捕获异常（无鉴权即可触发 500，破坏 D-06 冻结信封契约）。另有 2 个 Warning（请求体尺寸无前置防护、错误信封实现三处漂移）与 6 个 Info。

## Critical Issues

### CR-01: 常时比较长度前置检查用 UTF-16 长度，非 ASCII Bearer 令牌触发未捕获异常（无鉴权可打）

**File:** `packages/server/src/admin.ts:44-49`
**Issue:** 两段式比较的第一段是 `provided.length !== expected.length`——这是 UTF-16 码元数，不是 UTF-8 字节数。两串码元数相等不代表 `TextEncoder().encode()` 后字节长度相等：例如 `expected` 为 31 个 ASCII 字符（31 字节），攻击者发送 `Authorization: Bearer ` + 31 个 `é`（U+00E9，每字符 1 个 UTF-16 码元、2 个 UTF-8 字节）——码元长度检查通过，编码后 `a.byteLength === 62 !== b.byteLength === 31`，而 Workers 运行时的 `crypto.subtle.timingSafeEqual` 在两缓冲区长度不等时**抛异常**（这正是本函数做长度前置检查的原因，见 admin.ts:10-12 注释自述）。异常穿透 `handleAdminApi` → Worker fetch 拒绝 → 运行时 500（非 JSON 信封）。

影响：(1) 无鉴权攻击者可用构造头稳定触发异常路径（每个含多字节字符的探测请求都变成异常 + 非 D-06 信封的 500），污染错误日志并可能触发告警噪声掩盖真实攻击；(2) 违反冻结契约 D-06（所有错误路径必须返回 `{"error":{"code","message"}}` 信封）与 D-13 设计意图（两段式比较本应保证 `timingSafeEqual` 永不因长度不等抛错）。现有测试（admin-channels.test.ts:114-131）只覆盖 ASCII 长度不匹配分支，未覆盖此路径。

**Fix:**

```ts
const provided = auth.slice("Bearer ".length);
const a = new TextEncoder().encode(provided);
const b = new TextEncoder().encode(expected);
if (a.byteLength !== b.byteLength) {
  return INVALID_KEY();
}
if (!crypto.subtle.timingSafeEqual(a, b)) {
  return INVALID_KEY();
}
```

先编码、再按**字节长度**比较（字节不等长直接 401，不泄漏额外时序信息），保证 `timingSafeEqual` 只在等长缓冲区上调用。

## Warnings

### WR-01: /api/send 无请求体尺寸前置防护，合法 Send Key 可烧尽单次 10ms CPU 并破坏 413 契约

**File:** `packages/server/src/index.ts:57`
**Issue:** `validateSendBody(await request.text())` 在读入并 `JSON.parse` **整个请求体**之后才做长度检查。攻击面：持有效 Send Key 者（或密钥泄露后）可反复 POST 接近平台上限（~100MB）的载荷——Worker 侧 KV 预检通过（无鉴权者不会走到这里，这点是对的），随后全量 parse 消耗远超 10ms CPU → Worker 被运行时杀掉返回 1102 类错误而非 413 `payload_too_large` 信封，破坏 D-02 契约；且 DO 内限流发生在 Worker 转发**之后**，边缘 parse 完全不受 30/min 窗口约束。合法载荷最大约 37KB（text 32K + title 256 + 4×64 + 2×2048 + JSON 开销），无理由读入超过 ~64KB 的体。

**Fix:** 在 `request.text()` 之前检查 `Content-Length`（并容忍 chunked 缺失头的情形走原路径）：

```ts
const contentLength = Number(request.headers.get("content-length") ?? "0");
if (Number.isFinite(contentLength) && contentLength > 64 * 1024) {
  return errorEnvelope(413, "payload_too_large", "Request body exceeds the maximum allowed size.");
}
const validation = validateSendBody(await request.text());
```

### WR-02: 错误信封存在三处平行实现，违反 envelope.ts 自述的"唯一实现"设计

**File:** `packages/server/src/chat-room.ts:104-109` 与 `packages/server/src/chat-room.ts:338-352`
**Issue:** envelope.ts:4-5 明文约定信封"两处各写一份必然漂移——收敛到单点"，index.ts 与 admin.ts 均正确引用；但 chat-room.ts 又写了一份本地 `errorEnvelope`（104-109），且 429 `rate_limited` 响应（338-352）第三次手工拼 JSON 信封（该形态需与 `fixtures/error-envelope.rate-limited.json` 逐字节一致——`"Too many requests. Please retry later."` 一旦在 envelope 层统一改文案，这两处会静默漂移，而 fixtures 契约测试只覆盖其中一条路径）。同一冻结契约三处实现是明确的维护性缺陷。

**Fix:** envelope.ts 的 `errorEnvelope` 增加可选 headers 参数（或新增 `errorEnvelopeWithHeaders`），chat-room.ts 删除本地副本并复用：

```ts
// envelope.ts
export function errorEnvelope(
  status: number, code: string, message: string,
  extraHeaders?: Record<string, string>,
): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extraHeaders },
  });
}

// chat-room.ts checkRateLimit 内
return errorEnvelope(429, "rate_limited", "Too many requests. Please retry later.",
  { "Retry-After": String(retryAfterSec) });
```

## Info

### IN-01: serializeAttachment 上限注释与官方文档/项目 CLAUDE.md 不符

**File:** `packages/server/src/chat-room.ts:372`
**Issue:** 注释称 attachment 上限 "16,384 字节"；CF 官方文档与项目 CLAUDE.md 均为 **2048 字节**。当前 attachment（UUID + 时间戳）远小于两者，无功能影响，但注释会误导后续在此结构上加字段的开发者（若按 16KB 规划则会运行时溢出报错）。
**Fix:** 改注释为 2048 字节，或在注释中注明超限字段应放 SQLite。

### IN-02: sync 帧 `since` 无上界，极大整数可能在 SQL 绑定层抛错杀死连接

**File:** `packages/shared/src/validators.ts:264-273`
**Issue:** `since` 只校验"非负整数"，`1e19`（超 SQLite int64 范围）通过校验后作为绑定参数进入 `WHERE seq > ?1`——超范围数值在绑定层的行为（抛错/降级浮点）未定义；若抛错则异常穿透 `webSocketMessage` 导致该连接被 1011 关闭。仅持有效 Channel Key 者可自伤触发，影响有限。
**Fix:** 校验器加安全上界：`since > Number.MAX_SAFE_INTEGER` 时返回 `invalidFrame()`（seq 游标永远不会超过 2^53）。

### IN-03: Upgrade 头大小写敏感比较 + 非升级 GET 泄漏内部路由文案

**File:** `packages/server/src/chat-room.ts:207`、`packages/server/src/index.ts:105-115`
**Issue:** DO 侧 `request.headers.get("Upgrade") === "websocket"` 严格小写匹配（RFC 7230 中 token 大小写不敏感；浏览器恒发小写，但非浏览器客户端如 Go/某些 HTTP 库默认首字母大写 `WebSocket`，会得到 404 而非升级）。另外 Worker 对 `/api/ws/:key` 的任何 GET（含无 Upgrade 头的普通请求）都转发 DO，无 Upgrade 时客户端收到 `"Unknown internal route."`——对外暴露内部路由措辞。
**Fix:** Worker 层对 `/api/ws/:key` 先判 `Upgrade` 头存在（`request.headers.get("Upgrade")?.toLowerCase() === "websocket"`）再转发，否则回 404 `not_found` 通用文案；DO 侧同步改为 lower-case 比较。

### IN-04: 单连接 sync 帧无节流，持 Channel Key 者可烧 SQLite 读额度

**File:** `packages/server/src/chat-room.ts:392-412`
**Issue:** `webSocketMessage` 对 sync 帧无频率约束：每次 sync 触发 2 条 SQL（MIN + LIMIT 501 行查询）。入站 WS 消息计 DO 请求额度、查询行数计 SQLite 读额度（5M 行/天）——持有效 Channel Key 的客户端狂发 `{"v":1,"type":"sync","since":0,"limit":500}` 可低成本消耗全天读额度，影响同频道其他成员的补拉。属额度滥用加固项（性能/额度边界，非正确性缺陷）。
**Fix:** 最小做法：连续 sync 之间加最小间隔（如 attachment 或内存 Map 记上次 sync 时间戳，间隔内直接回当前 history 或忽略）；或对同一 since 值做结果缓存短路。

### IN-05: INVALID_KEY 工厂在 index.ts 与 admin.ts 重复定义

**File:** `packages/server/src/index.ts:32`、`packages/server/src/admin.ts:28`
**Issue:** 同一 401 信封构造器两处各写一份。与 WR-02 同源的收敛缺失（幅度更小）。
**Fix:** 移入 envelope.ts 导出（`export const invalidKeyEnvelope = () => ...`），两处引用。

### IN-06: 冒烟脚本创建的频道永不回收

**File:** `scripts/smoke.mjs:59-85`
**Issue:** 每次运行都经 Admin API 建临时频道（`smoke-<timestamp>`），而删除/重置 API 要到 Phase 3 才有——KV 中 `ch:`/`sk:`/`id:` 三键随运行次数永久累积，`GET /api/admin/channels` 列表会被冒烟频道逐渐刷屏。
**Fix:** 可接受现状（KV 5GB 上限内无害），但在脚本头注释标注"频道需 Phase 3 删除 API 上线后清理"，或在 Phase 3 计划中登记清理项。

---

_Reviewed: 2026-08-26T11:40:01Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
