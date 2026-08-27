---
phase: 03-admin-keys
reviewed: 2026-08-27T20:17:17Z
depth: standard
files_reviewed: 21
files_reviewed_list:
  - DEPLOY.md
  - package.json
  - packages/server/public/admin.html
  - packages/server/public/admin.js
  - packages/server/public/index.html
  - packages/server/src/admin.ts
  - packages/server/src/chat-room.ts
  - packages/server/src/keys.ts
  - packages/server/test/admin-channels.test.ts
  - packages/server/test/admin-delete.test.ts
  - packages/server/test/admin-history.test.ts
  - packages/server/test/admin-reset-kick.test.ts
  - packages/server/test/admin-send-keys.test.ts
  - packages/web-sdk/build.mjs
  - packages/web-sdk/e2e/admin.spec.ts
  - packages/web-sdk/e2e/reconnect.spec.ts
  - packages/web-sdk/e2e/tracer.spec.ts
  - packages/web-sdk/e2e/viewer.spec.ts
  - packages/web-sdk/scripts/chaos-sc2.mjs
  - packages/web-sdk/test/cache-bust-sync.test.ts
  - scripts/smoke.mjs
findings:
  critical: 1
  warning: 5
  info: 4
  total: 10
status: issues_found
---

# Phase 3: Code Review Report

**Reviewed:** 2026-08-27T20:17:17Z
**Depth:** standard（含对 index.ts / envelope.ts / vitest.config.ts 的交叉引用追踪）
**Files Reviewed:** 21
**Status:** issues_found

## Summary

Phase 3（管理页 + Admin API 五路由 + key schema 演进 + 静态资产缓存规避注入）整体工程质量高：鉴权两段式常时比较（含 UTF-8 字节长度前置，CR-01 前例已修）、channelId 白名单 404 防探测、KV/DO 编排顺序红线（KV 写先 DO 踢后 / DO purge 先 KV 删后）均有意识地在注释与测试中固化；admin.js 的 XSS 纪律（全文件唯一 renderMarkdown 入口 + 其余一律 textContent）执行到位；测试覆盖（集成 5 文件 + E2E journey）非常扎实。

但审查发现 **1 个 Critical**：`id:` 反向索引的全部写路径（建/吊销 Send Key、重置 Channel Key）建立在 KV 读-改-写之上，而 Workers KV 最终一致（≤60s 传播）+ 读侧默认 60s 边缘缓存使同一频道 60s 内的第二次管理写操作可能基于**过期基线**重写整条记录——Send Key 记录被静默丢失（凭据仍有效但从 UI 消失、无法吊销）或已吊销 Key 复活为幽灵行。本地 miniflare KV 强一致完全掩盖此缺陷，全部测试无法暴露；生产 E2E 流程（如连续创建两个 Key）恰好踩中该窗口。

其余为 Warning 级：purge 后 DO 内存实例表缺失导致的 60s 500 窗口、Channel Key 重置无法驱逐"60s 内立即重挂"的旧密钥连接（与 keys.ts 注释声称闭合的窗口不符）、admin.js 历史翻页的过期闭包状态使「加载更多」静默失效、admin 处理器无异常兜底信封、normalize 损坏数据兜底分支产出 `undefined channelKey` 会使管理页详情面板抛异常。

## Critical Issues

### CR-01: KV `id:` 读-改-写存在 ≤60s 过期基线窗口——Send Key 记录静默丢失 / 幽灵复活 / 删除链残留孤儿凭据

**File:** `packages/server/src/keys.ts:269-297`（createSendKeyRecord）、`packages/server/src/keys.ts:305-325`（revokeSendKeyRecord）、`packages/server/src/keys.ts:351-379`（resetChannelKey）、`packages/server/src/keys.ts:250-259`（readIdRecord，读侧无 cacheTtl → 默认 60s 边缘缓存）；联动 `packages/server/src/admin.ts:225-250`（handleDeleteChannel）

**Issue:** 四条管理写路径全部采用「读 `id:<channelId>` → 内存修改 → 整条重写」模式。Workers KV 是最终一致存储：写后跨 PoP 传播最长 60s，且 `KV.get` 默认 60s 边缘缓存（`readIdRecord` 与 `listChannels` 均未显式设置）。后果：

1. **Send Key 记录丢失**：同一频道 60s 内创建第 2 个 Send Key 时，`readIdRecord` 可能返回尚不含第 1 个新 Key 的缓存值，重写后第 1 个 Key 从 `id:` 注册表消失。其 `sk:` 凭据**仍然有效**（发送 200），但 UI 列表（数据源 `id:`）看不到它——无法从管理页吊销，形成不可管理的活跃凭据。E2E（`admin.spec.ts` D-31 用例连续 API 建 7 个 + UI 建 2 个）与 journey（连续建频道初始 Key + journey-bot）恰好是触发序列，只因 miniflare 强一致而全绿。
2. **已吊销 Key 幽灵复活**：吊销 K1 后 60s 内吊销 K2，`readIdRecord` 命中含 K1 的旧缓存 → 重写后 K1 重新出现在列表；点其「吊销」→ `resolveSendKey` miss → 404 错误条，管理页自相矛盾。
3. **重置回退**：重置后 60s 内若发生任何 Send Key 写操作，基于旧缓存的重写会把**已删除的旧 channelKey** 写回 `id:`，列表显示失效密钥。
4. **删除链孤儿凭据**：`handleDeleteChannel` 先读 `id:`，purge（DO 耗时）后用**读时快照**执行 `deleteChannelKeys`；期间新建的 Send Key 不在快照里，`sk:` 键残留——对一个已删除频道永久有效的发送凭据（且频道 `id:` 已删，无法经管理 API 清理）。

KV 无事务、无 CAS，读-改-写在最终一致存储上本质不安全；当前唯一的防线是"单管理员 + 低操作频率"这一未写进代码的假设。

**Fix:** 把 Send Key 注册表的权威数据源迁入 ChatRoom DO 的 SQLite（强一致、单线程无竞态）：DO 内建 `send_keys` 表（key/label/createdAt/revoked），`id:` 退化为可重建的列表缓存（或仅存 channelKey/name/createdAt 等低频不变字段）。短期最小缓解（不改架构）：
- `readIdRecord` 读后校验：写回前重新 `get` 一次对比（仍不能闭合跨 PoP 窗口，仅缩窄）；
- `handleDeleteChannel` 在 `deleteChannelKeys` 前**重读** `id:` 取最新 sendKeys 快照（配合 WR-04 的错误信封）；
- 在 DEPLOY.md/运维手册明确固化操作纪律：同一频道两次密钥管理操作间隔 ≥60s——并承认这是约束而非修复。

```typescript
// 最小缓解示例（admin.ts handleDeleteChannel）：
const purgeOk = await this.forwardPurge(env, channelId);
if (!purgeOk) return errorEnvelope(500, "server_error", "Internal server error.");
// 重读最新快照，缩窄 TOCTOU 窗口（purge 期间新建的 Key 也能被清）
const fresh = await readChannelRecord(env, channelId);
await deleteChannelKeys(env, fresh ?? record);
```

## Warnings

### WR-01: DO purge 后内存实例表缺失——60s KV 缓存窗口内残留流量命中 "no such table" 未捕获异常 → 裸 500

**File:** `packages/server/src/chat-room.ts:313-329`（handlePurge：deleteAll 清整库但构造器 DDL 不会重跑）、`packages/server/src/chat-room.ts:214-226`（DDL 仅在构造器执行）、`packages/server/src/chat-room.ts:424-427`（handlePublish 立即 SELECT messages）、`packages/server/src/chat-room.ts:597-600`（sendHistory 立即 SELECT MIN(seq)）

**Issue:** `handlePurge` 执行 `deleteAll()` 后，驻留内存的 DO 实例**不会重跑构造器**（DDL 仅在构造器执行），`messages`/`rate_sends` 表在实例被驱逐前不存在。而 KV 侧 `sk:`/`ch:` 删除有 ≤60s 边缘缓存窗口（本项目文档化行为）：窗口内发送方（`resolveSendKey` 命中缓存）与客户端（`resolveChannelKey` 命中缓存）仍会被 Worker 转发到该 DO——`handlePublish` 的 `SELECT COALESCE(MAX(seq)...)` 与 WS 升级的 `SELECT MIN(seq)` 直接抛 "no such table" 异常，未被捕获 → `index.ts handleSend` 亦无兜底 → 客户端收到裸 500（而非缓存过期后的干净 401），WS 客户端进入异常重试循环。`admin-delete.test.ts` 的 `readDoState` catch 分支注释实际上已经观察到了"表不存在"这一状态。

**Fix:** purge 末尾重建空表（DDL 本就是 `CREATE TABLE IF NOT EXISTS`，幂等），使残留流量得到"空频道"的干净行为而不是异常：

```typescript
private async handlePurge(): Promise<Response> {
  // ...踢连 + deleteAll + deleteAlarm（现状不变）...
  await this.ctx.storage.deleteAll();
  await this.ctx.storage.deleteAlarm();
  // 重建空表：覆盖 ≤60s KV 缓存窗口内的残留 publish/ws 流量，
  // 使其得到空频道行为（或由 Worker 层 401）而非 "no such table" 500。
  this.ctx.storage.sql.exec(CREATE_MESSAGES_DDL);
  this.ctx.storage.sql.exec(CREATE_RATE_SENDS_DDL);
  return new Response(JSON.stringify({ kicked }), { ... });
}
```

### WR-02: Channel Key 重置无法驱逐"缓存窗口内立即重挂"的旧密钥连接——keys.ts 注释声称闭合的窗口实际仍开放

**File:** `packages/server/src/keys.ts:344-349`（顺序红线条目）、`packages/server/src/admin.ts:191-212`（handleResetChannelKey）、`packages/server/src/chat-room.ts:286-300`（handleKickAll）

**Issue:** 注释断言"KV 写先 DO 踢后"可避免"被踢客户端立即以边缘缓存的旧 ch: 值重连成功后再无人踢它"的无限重挂窗口。但 `ch:<旧>` 的 **delete 同样受 ≤60s 边缘缓存/最终一致窗口约束**：被踢客户端（含 SDK 自动重连，退避首跳 <1s）在窗口内重连时 `resolveChannelKey(ch:旧)` 仍命中缓存值 → Worker 照常转发 → DO 无任何密钥代际概念，照常 accept——旧密钥持有者重挂成功后**连接可无限期存活**（此后无人再踢）。前序确实闭合了"60s 后仍可重挂"，但"窗口内重挂后长存"未闭合。对 KEY-04 威胁模型（Channel Key 泄露后重置止损）而言，攻击者恰恰会立刻重连并持续收消息。UI 确认框文案"所有已连接的客户端将立即被断开"只在此刻为真。

**Fix:** 给 DO 引入密钥代际（generation）：`resetChannelKey` 成功后由 Worker 在 `/ws` 转发头上附加当前 `channelKey` 的短哈希；DO 持久化当前代际（storage 一行），`handleWebSocketUpgrade` 校验代际不匹配即拒绝（401 信封）。这样即使 KV 缓存放行旧 Key，DO 侧也会拒绝重挂，窗口彻底闭合。

### WR-03: admin.js loadHistory 过期闭包状态——切走再切回后「加载更多」按钮静默失效

**File:** `packages/server/public/admin.js:877-949`（loadHistory，`state` 于 879 行闭包捕获；迟到响应守卫 922-925 仅比对 channelId）、`packages/server/public/admin.js:850-861`（加载更多 click 处理器）、`packages/server/public/admin.js:732-737`（ensureHistoryState 会**new 出新 state 对象**替换模块级 historyState）

**Issue:** 交错序列：选中 A 并展开历史（首页请求在途）→ 切到 B → 切回 A。切回时 `ensureHistoryState(A)` 检测到 channelId 不匹配（当前是 B）→ `resetHistoryState(A)` **新建** state 对象（A2）替换模块级 `historyState`；`renderDetail` 重建的 details/more 按钮闭包捕获 A2（`loaded:false, messages:[]`）。随后 A 的首页迟到响应到达：守卫 `historyState.channelId !== channelId` 判定通过（A===A），但代码继续操作**闭包捕获的旧对象 A1**（`state.loaded=true; state.messages=concat(...)`）并用 A1 渲染当前 DOM——「加载更多」按钮按 A1 的 `hasMore` 显示出来；点击它走的是 A2 闭包：`state.messages` 为空 → `minSeq === null` → `return` 静默无操作。用户必须手动收起再展开 details 才能恢复。守卫校验的是 channelId 而非对象同一性，是根因。

**Fix:** 迟到响应守卫改为对象同一性判定（覆盖"切走后切回导致 state 被重建"的全体情形）：

```javascript
.then(function (r) {
  state.loading = false;
  ...
  // 频道已切换或 state 已被重建（切走再切回）：迟到响应一并丢弃。
  if (historyState === null || historyState !== state) {
    return;
  }
  ...
})
```

同时 `.catch` 分支的 `state.loading = false` 保持现状即可（对孤儿对象复位无害）。

### WR-04: admin 处理器无异常兜底——KV/DO 意外失败返回裸 500，违背 D-06 统一信封；生产 KV 同 key 1 写/秒限制无处理

**File:** `packages/server/src/admin.ts:97-178`（handleAdminApi 全体处理器无 try/catch）、`packages/server/src/keys.ts:283-296`（createSendKeyRecord 两次 put 无错误处理）、`packages/server/src/index.ts:100-128`（fetch 入口同样无兜底）

**Issue:** `checkAdminAuth` 对 `ADMIN_KEY` 缺失精心映射为 500 信封，但其余一切意外失败（KV put 超额/瞬断、DO fetch 网络异常、CR-01 提到的同 key 写入过频）会让异常穿透 `handleAdminApi` → Workers 运行时返回**非信封**的裸 500 文本，破坏"发送方脚本程序化消费 code"的冻结契约。另注意：生产 KV 对**同一 key** 有 1 写/秒限制，而 `createSendKeyRecord`/`revokeSendKeyRecord`/`resetChannelKey` 每次调用都重写同一 `id:<channelId>`——脚本化快速连续操作（<1s 间隔）在生产会触发 KV 429/失败 → 裸 500。E2E 的循环建 Key 用例只在 wrangler dev（miniflare，不强制该限制）通过。

**Fix:** `handleAdminApi` 顶层包一层 try/catch，映射为通用 500 信封（不泄漏内部细节，与 D-13 最小信息量原则一致）：

```typescript
export async function handleAdminApi(request: Request, env: Env): Promise<Response> {
  try {
    // ...现有全部路由分发...
  } catch {
    return errorEnvelope(500, "server_error", "Internal server error.");
  }
}
```

`index.ts` fetch 入口建议同款兜底（越界文件，另行跟进）。运维文档应记录"同频道密钥操作间隔 ≥1s"的生产约束。

### WR-05: normalizeIdRecord 损坏数据兜底分支产出 `undefined channelKey`——管理页详情面板渲染即抛 TypeError

**File:** `packages/server/src/keys.ts:160-168`（corrupt 分支直接取 `legacy.channelKey`，若存储值无此字段则为 undefined）、`packages/server/public/admin.js:282-292` + `217-219`（buildKeyRow → maskKey 直接 `key.slice`）

**Issue:** 兜底分支注释声称"消费方 sendKeys 遍历零异常"，但只保证了 sendKeys 数组形态；若 KV 值损坏缺 `channelKey` 字段（手工种键/半写损坏），`listChannels` 会把 `channelKey: undefined` 的记录返回给管理页，`renderDetail` → `buildKeyRow(undefined)` → `maskKey` 的 `key.slice(0,7)` 抛 TypeError → 整个详情面板渲染中断（白屏于该面板），且每频道每次选中必现。

**Fix:** 损坏记录在 `listChannels` 处直接跳过（或 normalize 返回 null 由调用方过滤），不要带病出库：

```typescript
// listChannels 循环内：
if (stored !== null) {
  const normalized = normalizeIdRecord(stored);
  if (typeof normalized.channelKey !== "string" || normalized.channelKey === "") {
    continue; // 损坏记录不进列表（详情面板不可达即不可崩）
  }
  records.push({ channelId: key.name.slice(KEY_PREFIX_ID.length), ...normalized });
}
```

## Info

### IN-01: /api/admin/* 鉴权无速率限制——ADMIN_KEY 可无限暴力尝试

**File:** `packages/server/src/admin.ts:72-94`（checkAdminAuth）

**Issue:** `/api/send` 有按 Send Key 的限流，但 Admin 鉴权失败无任何节流：攻击者可持续轰击 Bearer 猜测（仅受每日 10 万请求额度约束，额度耗尽会殃及正常业务——本身即一种 DoS 面）。缓解项已到位：常时比较 + 长度前置 + 同码同文案。风险最终取决于 ADMIN_KEY 熵值（用户设置）。
**Fix:** 低成本方案：对 401 失败按 IP/全局计数（KV 或专用 DO），超阈值后短窗内直接 401 不做比较；或在部署文档强制 ADMIN_KEY 最小长度（如 ≥32 随机字符）。

### IN-02: admin.html CSP 从 viewer 原样复制——connect-src 放开全域，管理页可收紧未收紧

**File:** `packages/server/public/admin.html:8-11`

**Issue:** viewer 需要连任意服务端地址（`connect-src 'self' ws: wss: http: https:` 合理），但 admin.js 只发同源相对路径请求——管理页 CSP 可收紧为 `connect-src 'self'`，消除"一旦有脚本注入（script-src 已挡，纵深假设失守时）即可外发 Admin Key 到任意域"的残余面。
**Fix:** admin.html 的 CSP 单独收紧：`connect-src 'self' ws: wss:`（如未来无跨源需求则 `'self'` 即可）。

### IN-03: generateWid 存在取模偏差（57 字符表，256 % 57 = 28）

**File:** `packages/server/src/chat-room.ts:93-103`

**Issue:** `bytes[i] % 57` 使 wid 字符分布不均（keys.ts 的密钥生成因是凭据而做了拒绝采样，wid 未做）。wid 仅为对外展示 ID，seq 才是游标，碰撞后果极轻——但同一文件内两套随机串生成纪律不一致，易被后人复制错对象。
**Fix:** 照 keys.ts 同款拒绝采样（`>= 228` 丢弃），或注释显式说明"wid 非凭据、偏差可接受"以防模式被误复制到凭据场景。

### IN-04: handleDeleteChannel 的 TOCTOU——purge 与 deleteChannelKeys 之间新建的 Send Key 成为永久孤儿凭据（与 CR-01 第 4 点同根，机制独立）

**File:** `packages/server/src/admin.ts:225-250`（record 在 purge 前读取，purge 后才消费）

**Issue:** 即使 KV 强一致，"读快照 → purge（网络往返）→ 按快照删键"之间创建的 Send Key 也不在快照内，`sk:` 残留且对应频道 `id:` 已删——该凭据持续授权 /api/send 直到 DO 缓存窗口过期后转向 500（见 WR-01），且无任何管理路径可清理。当前操作序列（管理员自己刚建 Key 又立刻删频道）概率低，但脚本化编排可能踩中。
**Fix:** 采用 CR-01 最小缓解中的"purge 后重读快照再删键"，并在 keys.ts 的顺序红线条目补充该已知窗口的文档说明。

---

_Reviewed: 2026-08-27T20:17:17Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
