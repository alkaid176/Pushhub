# Phase 4: 回复链与回调送达 - Pattern Map

**Mapped:** 2026-08-28
**Files analyzed:** 21（新增 8 / 修改 13）
**Analogs found:** 21 / 21（全部有既有代码先例；无 no-analog 文件）

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `packages/shared/src/index.ts` | model（协议类型） | — | 自身既有帧定义（MessageFrame/SyncFrame/WsErrorFrame 模式） | exact |
| `packages/shared/src/validators.ts` | utility（纯函数校验器） | transform | 自身 validateInboundFrame 的 sync 分支（validators.ts:264-290） | exact |
| `packages/shared/fixtures/reply-frame.positive.json` | test fixture | — | `sync-frame.positive.json` / `ping-frame.json`（数组正例） | exact |
| `packages/shared/fixtures/reply-frame.negative.json` | test fixture | — | `client-frame.negative.json`（`{_violation, frame}` 反例结构，RESEARCH 已核） | exact |
| `packages/shared/fixtures/answered-frame.positive.json` | test fixture | — | 服务端发射帧结构检查器锁定模式（history 帧同族，见 fixtures-contract.test.ts） | role-match |
| `packages/shared/fixtures/ws-error-frame.json` | test fixture | — | 自身（追加 already_replied/not_found 两例） | exact |
| `packages/server/src/chat-room.ts` | service（DO） | event-driven + CRUD | 自身：webSocketMessage sync 分支、alarm()、handleKickAll、handlePublish 扇出 | exact |
| `packages/server/src/keys.ts` | model/service（KV） | CRUD | 自身：SendKeyInfo 可选字段演进 + generateRandomString + normalizeIdRecord | exact |
| `packages/server/src/admin.ts` | controller | request-response | 自身：handleResetChannelKey（KV 写先 DO 转发后 + 201 完整返回）+ CHANNELS_PATH_RE | exact |
| `packages/server/src/index.ts` | route | request-response | 自身：handleWebSocket 的 X-PH-Channel-Key 内部头转发 | exact |
| `packages/server/public/test.html` | component（静态页） | request-response | `packages/server/public/index.html`（CSP + 表单 + pushhub.js?v= 注入点） | exact |
| `packages/server/public/test.js` | component（vanilla JS） | event-driven | `packages/server/public/viewer.js`（接入表单/statusDot/渲染管道/localStorage） | exact |
| `packages/web-sdk/src/pushhub.ts` | service（SDK 公开 API） | event-driven | 自身：sendSync 动作接线（apply switch）+ on() 四事件模式 | exact |
| `packages/web-sdk/src/frames.ts` | utility（帧 guard） | transform | 自身：parseServerFrame 的 message/history case + isXxxShape 深校验 | exact |
| `packages/web-sdk/src/connection-machine.ts` | service（纯状态机） | event-driven | 自身：handleFrame 的 history case → emitHistory 动作模式 | exact |
| `packages/web-sdk/build.mjs` | config（构建脚本） | batch | 自身：injectCacheBustVersion（build.mjs:58-72） | exact |
| `packages/web-sdk/e2e/test-page.spec.ts` | test（E2E） | request-response | `packages/web-sdk/e2e/viewer.spec.ts` / `admin.spec.ts` | exact |
| `packages/server/test/reply-chain.test.ts` | test（集成） | event-driven | `packages/server/test/retention-alarm.test.ts`（directPublish + nextFrame + attach-then-trigger） | exact |
| `packages/server/test/callback-delivery.test.ts` | test（集成） | event-driven | 同上 + runDurableObjectAlarm/runInDurableObject 直调模式 | exact |
| `scripts/callback-receiver.mjs` | utility（Node 脚本） | request-response | `scripts/smoke.mjs`（零依赖 Node 22 脚本骨架） | role-match |
| `scripts/smoke.mjs` | utility（冒烟脚本） | request-response | 自身（追加步骤） | exact |

## Pattern Assignments

### `packages/shared/src/index.ts`（model，协议演进）

**Analog:** 自身既有帧定义。新增 ReplyFrame/AckFrame/AnsweredFrame 照 SyncFrame（index.ts:122-127，C→S 可选字段省略语义）与 HistoryFrame（index.ts:139-145，S→C 结构帧）的注释+接口模式：

```typescript
// index.ts:122-127（C→S 帧先例：可选字段 + 冻结注释块）
export interface SyncFrame {
  v: typeof PROTOCOL_VERSION;
  type: "sync";
  since: number | null;
  limit?: number;
}
```

- ErrorCode 枚举（index.ts:70-78）追加 `"already_replied" | "not_found"`——纯加法，消费侧 code 是透明 string（frames.ts isErrorShape 只查 string）。
- 新常量 `BY_MAX = 64`（D-53 展示名上限，UTF-16 码元，与 LIMITS 同级声明并加注释）。
- ClientFrame（index.ts:130）扩为 `PingFrame | SyncFrame | ReplyFrame`；ServerFrame（index.ts:156）扩为 `... | AckFrame | AnsweredFrame`。

---

### `packages/shared/src/validators.ts`（utility，validateInboundFrame 增 reply 分支）

**Analog:** 自身 sync 分支（validators.ts:264-290）——结构层校验（恰一/类型/长度）纯函数模式：

```typescript
// validators.ts:264-273（结构字段逐项检查、违例即 invalidFrame()）
  if (frame.type === "sync") {
    const since = frame.since;
    if (
      since !== null &&
      (typeof since !== "number" ||
        !Number.isInteger(since) ||
        since < 0)
    ) {
      return invalidFrame();
    }
```

reply 分支要点：wid 必填 string；selected_option/text 恰一（同真 → invalidFrame、同假 → invalidFrame）；text ≤ LIMITS.TEXT_MAX（32768）；by 可缺省 string ≤ BY_MAX；白名单校验（options 成员判定）**留在 DO 语义层**（需读库）。阈值一律 import 自 index.ts（本文件"不出现裸数字阈值"禁令，文件头注释）。

---

### shared fixtures（4 个 JSON）

**Analog:** `ws-error-frame.json`（正例数组结构）与既有 `_violation` 反例结构。追加的 error 例照抄既有两例的字段形态（v/type/code/message 四键）。

---

### `packages/server/src/chat-room.ts`（service/DO——本期主战场）

**Analog 1 — reply 帧挂载：** webSocketMessage（chat-room.ts:626-646）的 switch 结构。校验失败回 WsErrorFrame 不断连（chat-room.ts:631-640）逐字沿用，errorFrame 构造照抄。

**Analog 2 — UPDATE 同步块纪律：** handlePublish 的 seq 分配 + INSERT 同步块（chat-room.ts:472-480）——两句 exec 之间零 await = 原子提交。reply 的 `UPDATE messages SET answered=1, ...` 必须照此在同步块完成（Pitfall 5）。

**Analog 3 — 全连接扇出：** handlePublish 扇出遍历（chat-room.ts:506-516）——answered 帧 `ws.send` + 死连接 try/catch 收集后 close(1011) 整体照抄；ack 帧只发回复者本人 `ws.send`。

**Analog 4 — meta 表落盘（signing_secret）：** handleKickAll 的代际落盘（chat-room.ts:313-320）：

```typescript
// chat-room.ts:315-319
this.ctx.storage.sql.exec(
  "INSERT INTO meta (k, v) VALUES (?1, ?2) ON CONFLICT(k) DO UPDATE SET v = ?2",
  META_KEY_GEN,
  newGen,
);
```

**Analog 5 — callbacks 表 DDL：** CREATE_RATE_SENDS_DDL（chat-room.ts:87-93）幂等构造器模式——新 DDL 字符串 + 构造器/purge 重建处各加一行 `ctx.storage.sql.exec(CREATE_CALLBACKS_DDL)`（chat-room.ts:234-236 与 369-371 两处既有调用点并列）。

**Analog 6 — alarm 重构：** 现 alarm()（chat-room.ts:713-728）的 try/catch 吞异常 + finally 重设骨架保留，但尾部无条件 `setAlarm(+24h)` 替换为 `scheduleNextAlarm()` 单点重排（RESEARCH Pattern 2）。publish 判空播种点（chat-room.ts:522-524）保留并补 retention_due meta 行。handlePurge 的 `deleteAll + deleteAlarm` 成对（chat-room.ts:357-358）不动。

**Analog 7 — /callback-failures 内部路由：** fetch 分发（chat-room.ts:253-271）追加分支，照 handleHistory 的同步游标 + JSON 200 响应模式（chat-room.ts:399-437）。

**Analog 8 — attachment 演进：** serializeAttachment（chat-room.ts:607-610）加 `displayName: by ?? null` 增量字段。

---

### `packages/server/src/keys.ts`（service/KV）

**Analog 1 — schema 演进：** SendKeyInfo 可选字段先例（keys.ts:33-37，"旧值无此键天然合法"）——ChannelKeyInfo（keys.ts:40-44）加 `signingSecret?: string`。

**Analog 2 — secret 生成：** generateRandomString 拒绝采样（keys.ts:88-99）+ generateSendKey 前缀模式（keys.ts:107-109）：

```typescript
// keys.ts:107-109
export function generateSendKey(): string {
  return SEND_KEY_PREFIX + generateRandomString(KEY_LENGTH);
}
// 照此新增：SIGNING_SECRET_PREFIX = "phsig_" + generateRandomString(32)
```

**Analog 3 — createChannel 写入：** keys.ts:218-221 的 ch: put 加 signingSecret 字段；resetChannelKey（keys.ts:458-486）重置时保 secret 不变或随重置换代（规划定稿）。

---

### `packages/server/src/admin.ts`（controller——signing-secret 端点）

**Analog 1 — 路由白名单：** CHANNELS_PATH_RE（admin.ts:53-54）sub 白名单加 `signing-secret` 段；分发照 admin.ts:173-194 的 `if (sub === ... && request.method === ...)` 链。

**Analog 2 — KV 写先 DO 转发后 + 201 完整返回：** handleResetChannelKey（admin.ts:210-237）整体结构复用——`try { DO 转发 } catch { /* 尽力语义 */ }` 后 201 返回新 secret（密钥唯一完整返回点先例，D-13 注释在文件头）。

**Analog 3 — 鉴权：** checkAdminAuth 两段式常时比较（admin.ts:74-96）不动，端点天然被 routeAdminApi 前置鉴权覆盖（admin.ts:117-120）。

---

### `packages/server/src/index.ts`（route）

**Analog:** handleWebSocket 的内部头转发（index.ts:97-104）——`resolveChannelKey` 结果在手，转发时加一行：

```typescript
// index.ts:97-103（照 X-PH-Channel-Key 同款追加 X-PH-Signing-Secret）
const forward = new Request(`${INTERNAL_ORIGIN}/ws`, request);
forward.headers.set(VERIFIED_HEADER, "1");
forward.headers.set(CHANNEL_KEY_HEADER, channelKey);
```

/callback-failures 公网路由（若采 RESEARCH Q3 推荐方案）照 routeRequest 的 wsMatch 正则 + handleSend 的 Bearer 鉴权模式（index.ts:56-65）新增分支。

---

### `packages/server/public/test.html`（component）

**Analog:** `index.html`。CSP meta 整体复制（index.html:8-11，`script-src 'self'` 禁 inline——test.js 必须独立文件）；表单 grid 样式照 connect-form（index.html:26-47）；底部 `<script src="/pushhub.js?v=0.1.12"></script>` 引用即 build.mjs 注入锚点（勿手改注释在 index.html:129）。

---

### `packages/server/public/test.js`（component）

**Analog:** `viewer.js`。照抄骨架：IIFE + "use strict"（viewer.js:22-23）、getElementById 元素句柄集中声明（viewer.js:27-35）、setStatus/showError（viewer.js:50-61）、localStorage try-catch 免填 + URL 参数预填（文件头注释 D-24）、`window.__pushhub` 调试句柄。

**渲染纪律（prohibition）：** viewer.js:91-109 的 appendMessage——title 用 textContent、text 经 `window.PushHub.renderMarkdown` 后 innerHTML。answered_content 走 renderMarkdown；answered_by/wid 走 textContent。点击回复按钮调 `hub.reply(wid, { selected_option }, by)`。

**验签器：** 浏览器无 timingSafeEqual——手写 XOR 累加（RESEARCH Code Examples 已给完整函数）。

---

### `packages/web-sdk/src/pushhub.ts`（service——reply() 方法）

**Analog:** sendSync 动作接线（pushhub.ts:170-180）——防御式 `readyState === WebSocket.OPEN` 检查后 send：

```typescript
// pushhub.ts:170-180
case "sendSync":
  if (this.ws !== null && this.ws.readyState === WebSocket.OPEN) {
    this.ws.send(
      JSON.stringify({ v: PROTOCOL_VERSION, type: "sync", since: action.since, limit: action.limit }),
    );
  }
```

reply() 直接实现（不进状态机，RESEARCH Pattern 7 定稿建议）：非 online 时 emitError(code="not_connected") fail-fast；listeners 注册表（pushhub.ts:70-78）加 `answered` 第五事件 Set；on() 重载（pushhub.ts:110-120）与 emit 重载（pushhub.ts:291-298）各加一分枝。

---

### `packages/web-sdk/src/frames.ts`（utility）

**Analog:** parseServerFrame switch（frames.ts:133-151）加 `"answered"`（isAnsweredShape 深校验，照 isMessageShape frames.ts:62-87 的逐字段检查）与 `"ack"` case；ack 只查 `{v, type, wid}` 可照 pong 的宽松直通（frames.ts:142-143）。

---

### `packages/web-sdk/src/connection-machine.ts`（service）

**Analog:** handleFrame 的 history case（connection-machine.ts:224-227）——answered 帧加 `case "answered": out.push({ kind: "emitAnswered", frame }); return;`。新动作种类 `{ kind: "emitAnswered"; ... }` 照 emitHistory（connection-machine.ts:101）加进 MachineAction 联合（connection-machine.ts:92-102）。answered 事件**不走去重**（SeqDedup 只作用于 message 帧，connection-machine.ts:209-213）。

---

### `packages/web-sdk/build.mjs`（config）

**Analog:** 自身 injectCacheBustVersion 调用清单（build.mjs:71-72）追加第三行：

```javascript
injectCacheBustVersion(resolve(pkgRoot, "../server/public/test.html"), "test.html");
```

refRe"恰命中一次"硬断言（build.mjs:60-66）自动护航；同步扩展 cache-bust-sync.test.ts。

---

### `packages/web-sdk/e2e/test-page.spec.ts`（test/E2E）

**Analog:** `packages/web-sdk/e2e/viewer.spec.ts` / `admin.spec.ts`（同 testDir、playwright.config.ts 的 wrangler dev webServer 链式 build 前置）。回调接收器子进程拉起 callback-receiver.mjs 用 beforeAll/globalSetup（非标准端口，CLAUDE.md 端口规约）。

---

### `packages/server/test/reply-chain.test.ts` 与 `callback-delivery.test.ts`（test/集成）

**Analog:** `retention-alarm.test.ts` 全套基建逐字复用：

```typescript
// retention-alarm.test.ts:22
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
// :71-81 directPublish（可信头 + Send Key 直调 DO /publish）
// :56-68 nextFrame（once 监听 + 超时 Promise——attach-then-trigger 铁律）
// :106-112 WS 连接（Upgrade 头 + X-PH-Verified + accept 后立即挂监听）
// :119-125 runInDurableObject 内 SQL 种数据（种 callbacks 行 next_attempt_at 已过期）
// :128    expect(await runDurableObjectAlarm(stub)).toBe(true) —— 直调 alarm，非 fake timers
```

隔离策略照文件头注释：`--max-workers=1 --no-isolate` + crypto.randomUUID 派生唯一频道名。签名交叉验证用 Node `node:crypto.createHmac` 重算比对。fetchMock spike（A2）先行，保底本地 node:http 服务器作 callback_url。

---

### `scripts/callback-receiver.mjs`（utility/Node）

**Analog:** `scripts/smoke.mjs` 骨架——零依赖 Node 22、`#!/usr/bin/env node`、结构化 console.log OK/FAIL、非零退出（smoke.mjs:1-49）。验签核心（时间窗 → createHmac 重算 → timingSafeEqual 两段式）RESEARCH Code Examples 已给完整实现，直接落地。

### `scripts/smoke.mjs`（扩展）

追加回复链步骤照既有步骤风格：`send()` 助手（smoke.mjs:51-57）扩 options/callback_url 字段；建频道后用本地 callback-receiver 或跳过回调断言（规划定稿）；WS reply 帧 + answered 帧断言照 ②③ 步的 console.log OK 模式。

## Shared Patterns

### Worker→DO 内部转发（可信头）
**Source:** `packages/server/src/index.ts:26-31, 97-104` 与 `chat-room.ts:51-55`（同名同值本地声明约定）+ `admin.ts:58-62`
**Apply to:** signing secret 传递（X-PH-Signing-Secret）、/callback-failures 转发、reset 端点 DO 转发
```typescript
const INTERNAL_ORIGIN = "https://do.pushhub.internal";
const VERIFIED_HEADER = "X-PH-Verified";
forward.headers.set(VERIFIED_HEADER, "1");   // DO 侧 fetch() 入口校验（chat-room.ts:248）
```

### 错误信封（D-06）
**Source:** `packages/server/src/chat-room.ts:123-128`（errorEnvelope 本地实现）与 `envelope.ts`（Worker 侧唯一实现）
**Apply to:** 所有新 HTTP 端点（signing-secret 查/重置、callback-failures）与 DO 内部路由

### 常时比较（D-13 两段式）
**Source:** `packages/server/src/admin.ts:74-96`（长度前置按 UTF-8 字节 + crypto.subtle.timingSafeEqual）
**Apply to:** signing secret 管理端点鉴权（天然复用 checkAdminAuth）；发送方侧参考实现换 node:crypto（receiver）/手写 XOR（test.js，浏览器无此 API——Pitfall 3）

### 拒绝采样随机串
**Source:** `packages/server/src/keys.ts:88-99`
**Apply to:** signing secret 生成（phsig_ + 32 字符）

### WS 帧扇出 + 死连接清理
**Source:** `packages/server/src/chat-room.ts:506-516`
**Apply to:** answered 帧全连接扇出

### 同步块零 await 纪律（DO 输入门）
**Source:** `packages/server/src/chat-room.ts:471-480`（seq+INSERT）、`:542-578`（checkRateLimit 同步方法）
**Apply to:** reply 的 answered UPDATE（Pitfall 5 竞态正确性唯一依赖）

## No Analog Found

无——全部 21 个文件均有 exact 或 role-match 先例。

## Metadata

**Analog search scope:** packages/shared/src+fixtures、packages/server/src+public+test、packages/web-sdk/src+build.mjs+e2e、scripts/
**实读文件:** 14（shared/index.ts、shared/validators.ts、ws-error-frame.json、server/chat-room.ts、keys.ts、admin.ts、index.ts、public/index.html、public/viewer.js(部分)、test/retention-alarm.test.ts、web-sdk/pushhub.ts、frames.ts、connection-machine.ts(部分)、build.mjs、scripts/smoke.mjs(部分)）
**Pattern extraction date:** 2026-08-28
