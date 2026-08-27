# Phase 3: 管理页与密钥生命周期 - Research

**Researched:** 2026-08-27
**Domain:** Cloudflare Workers Admin API 扩展（KV schema 演进 + DO kickAll/history 内部路由）+ vanilla 静态资产管理页 + Playwright E2E
**Confidence:** HIGH（既有代码全量精读 + Cloudflare 官方文档逐页核对 + 本地依赖源码实证；零新外部依赖）

## Summary

本阶段是在**已充分理解的既有代码上做增量扩展**，不是新领域开拓。全部六个研究重点（KV schema 演进、DO kickAll、DO /history、vanilla 管理页、Playwright E2E、测试策略）都有明确的既有模式可循：Admin API 路由在 `admin.ts` 扩展、DO 内部路由在 `chat-room.ts` fetch 分支扩展、Worker→DO 转发复用 `INTERNAL_ORIGIN + X-PH-Verified` 模式、管理页照 viewer 的 HTML+JS 双文件模式、E2E 挂进 web-sdk 既有 playwright config。核心风险不在"怎么写"，而在**四个交叉联动点**：① `id:` 反向索引 schema 演进必须带生产兼容读取（生产已有 10+ 个旧格式冒烟频道）；② 频道删除的 DO 清理必须 `deleteAll() + deleteAlarm()` 成对调用（官方文档明示 deleteAll 不删 alarm，漏掉即制造每日唤醒的僵尸 DO）；③ `smoke.mjs` 与 `admin-channels.test.ts` 消费旧响应结构，必须同版本联动改；④ `build.mjs` 的 `?v=` 注入只处理 index.html 且硬断言"恰命中一次"，admin.html 引用 pushhub.js 必须扩展 build.mjs。

额度侧结论明确：KV 免费层 **delete 是独立额度线（1,000 删/天，与 1,000 写/天分开计）**，且 1 写/秒限制是**同 key** 限制——删除一个频道最多 12 次删除操作（3 前缀 + ≤10 个 sk:）无需任何分批/限速。测试侧有一个高价值实证：**本地 miniflare KV 不实现边缘缓存**（源码核实 cacheTtl 只校验不生效），因此"吊销后立即 401""重置后旧 key 立即失效"在 vitest 里是确定性可断言的；60s 双活窗口是纯生产行为，测试不覆盖（UI 文案提示 + 文档化即可，SC2 已如此定义）。

**Primary recommendation:** 按既有模式纯增量扩展——`keys.ts` 加 normalize 兼容层（读旧写新）、`admin.ts` 加 5 条 REST 路由、`chat-room.ts` 加 2-3 个内部路由（kick-all、history、purge=deleteAll+deleteAlarm+踢连）、`public/admin.html + admin.js` 照 viewer 模式、E2E 新增 `admin.spec.ts` 挂既有 playwright config；四个联动点（smoke.mjs、admin 测试、build.mjs ?v=、生产旧数据兼容）各设独立任务不可省。

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions（D-28 ~ D-41，14 条）

- **D-28:** Admin Key 存 localStorage 长期持有（同 viewer D-24 模式），登出按钮手动清除；不引入服务端会话（零 KV 写成本）。管理页 CSP 沿用 viewer 纵深防御模式（`script-src 'self'`）
- **D-29:** 频道密钥管理页默认**掩码显示**（前缀+后缀），点眼睛按钮单条揭示，复制按钮一键拷贝。列表 API 响应即含完整密钥（掩码是纯前端渲染行为，API 不做掩码裁剪）
- **D-30:** 创建 Send Key 时**可选填标签**，列表按标签展示。标签进 KV `sk:` 值结构（`{channelId, label?}`），同频道标签不强制唯一 — *costly：KV 值结构变更需迁移既有 `sk:` 键*
- **D-31:** 每频道 Send Key **上限 10 个**，超出返回 400
- **D-32:** 吊销 Send Key = KV 删 `sk:` 键 + DO `rate_sends` 表对应清理；正在使用的脚本下次 POST 即 401（≤60s 边缘缓存窗口，已文档化行为）。不踢 WS，不做 DO 审计日志行
- **D-33:** 重置 Channel Key = KV 删旧 `ch:` 键写新键 + **同步调 DO 新增 kickAll 内部路由踢出全部现有 WS 连接** + `id:` 反向索引同步更新。≤60s KV 边缘缓存双活窗口在管理页 UI 上文案提示 — *costly：kickAll 路由进 DO fetch 契约*
- **D-34:** 频道删除复用同一 kickAll 路由：删除 = 踢全部连接 + KV 三前缀键清理 + DO 存储删除（messages/rate_sends 表全清）。**硬删不可恢复**；确认交互为**输入频道名前缀匹配才允许删** — *one-way*
- **D-35:** 新增管理 API 沿用 **REST 资源化风格**：`DELETE /api/admin/channels/:channelId`、`POST /api/admin/channels/:channelId/send-keys`（body 含可选 label）、`DELETE /api/admin/channels/:channelId/send-keys/:key`、`POST /api/admin/channels/:channelId/reset-channel-key`、`GET /api/admin/channels/:channelId/messages`（seq 游标翻页）。全部 Bearer Admin Key 鉴权（复用两段式常时比较）；错误响应沿用 D-06 信封。`id:` 记录从单 sendKey 演进为 sendKeys 列表——`GET /api/admin/channels` 响应结构同步演进（向后不兼容变更可接受：唯一消费方是本期新建的管理页与 smoke 脚本，同版本内联动更新） — *costly*
- **D-36:** 消息历史查询走 **DO 新增内部 `/history` 路由**（Worker 层 admin 鉴权后经 X-PH-Verified 内部头转发）：seq 游标 keyset 翻页直查 messages 表，复用既有查询逻辑与行映射（含 answered 字段集）。不属 D-11 约束。数据留 DO，不导出 KV — *costly*
- **D-37:** 管理页**vanilla 单文件**（手写 HTML+CSS+JS，放 `packages/server/public/`，零构建零依赖静态资产托管，SC4 asset-first 命中不触发 Worker）
- **D-38:** 信息架构**单页列表+详情**：频道列表+创建表单在上方/左侧，选中频道展开详情面板（Channel Key 管理、Send Key 列表、历史入口、删除入口）
- **D-39:** 创建频道/创建 Send Key 成功后展示**可直接复制的接入片段**：webhook URL + curl 示例（含 Bearer Send Key 头）、服务端地址 + Channel Key、viewer 页直达链接
- **D-40:** 历史排障视图：管理页内嵌渲染历史列表（经 `<script src="/pushhub.js">` 用 `PushHub.renderMarkdown`，不重复实现），按 seq 倒序翻页，显示 answered 状态徽标
- **D-41:** 管理页验收用 **Playwright 真浏览器 E2E**（本地 wrangler dev 起真服务，沿用 D-26 模式）：登录→建频道→建 Send Key→展示接入片段→发消息→查历史→重置 Channel Key（踢连）→吊销 Send Key→删除频道全链路自动化；SC4 生产 dashboard 请求计数验证

### Claude's Discretion

- 管理页视觉风格（与 viewer 一致的 system-ui 极简风即可）
- 历史翻页的每页条数与"加载更多"交互细节
- 掩码显示的具体格式
- Send Key 标签输入的长度上限与字符集校验细节（对齐 CHANNEL_NAME_MAX_LENGTH 模式即可）
- kickAll 后客户端收到的 WS close code/reason 具体值（复用协议已有约定或选标准码，涉及客户端展示则记入决策）
- 接入片段的具体文案与格式
- admin history API 的查询参数命名与响应信封细节（对齐 D-06/D-12 既有风格）
- E2E 测试文件组织（沿用 Phase 2 e2e/ 目录模式）

### Deferred Ideas (OUT OF SCOPE)

None — discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| KEY-02 | Web 管理页（Admin Key 登录）可创建/删除/重置频道及其密钥 | admin.ts REST 路由扩展模式（§Pattern 1）；DELETE 语义与操作顺序（§Pattern 4）；E2E admin.spec 全链路（§Validation） |
| KEY-03 | 每频道可创建多个 Send Key，可单独吊销 | id: schema 演进 + normalize 兼容层（§Pattern 2）；KV 写/删额度核算（§Don't Hand-Roll 下额度表）；上限 10 的检查点设计 |
| KEY-04 | 任一级密钥可单独重置，重置后旧密钥立即失效（Channel Key 重置不丢频道历史） | KV-first-then-kick 顺序设计（§Pattern 3）；DO 内强一致踢连 + 消息保留（messages 表不动）；miniflare 强一致使测试可确定性断言 |
| ADM-01 | 管理页：Admin Key 登录，频道列表/创建/删除 | vanilla 页架构（§Pattern 5）；localStorage 持有模式（viewer.js 同款）；删除确认交互（前缀匹配） |
| ADM-02 | 管理页：密钥管理（查看/重置/吊销 Send Key、重置 Channel Key） | 掩码+揭示+复制的前端模式（§Pattern 5）；D-29 API 返回全量密钥、前端掩码 |
| ADM-03 | 管理页：频道消息历史查看（排障用） | DO /history keyset 倒序翻页（§Pattern 4）；PushHub.renderMarkdown 复用（零重复实现） |
| ADM-05 | 管理页与测试页由 Worker 静态资源托管（免费、不占请求额度） | asset-first 已验证；x-ph-worker 标记头程序化对照（0.1.8 起既有机制）；build.mjs ?v= 注入扩展点 |
</phase_requirements>

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Admin 鉴权（Bearer + 常时比较） | Worker（admin.ts checkAdminAuth） | — | 既有两段式比较复用；鉴权先于路由判定（不暴露路径存在性） |
| 频道/密钥元数据 CRUD | Worker（admin.ts 路由）+ KV（keys.ts） | — | 密钥元数据读多写少天然归 KV；写路径收敛在 keys.ts |
| `id:` schema 演进与兼容读取 | Worker（keys.ts normalize） | — | 三前缀键表唯一事实源在 keys.ts，演进不外泄 |
| 踢连接（kick-all） | DO（ChatRoom 内部路由） | Worker（触发入口） | 连接句柄只存在于 DO（getWebSockets）；DO 内单线程强一致 |
| 频道数据清除（deleteAll + deleteAlarm） | DO（purge 内部路由） | Worker（编排顺序） | SQLite 存储与 alarm 归 DO；编排顺序决定重试安全性 |
| 消息历史查询（任意深度翻页） | DO（/history 内部路由） | Worker（鉴权后转发） | 数据在 DO SQLite，单群单库直查；admin 排障不受 D-11 WS 补拉约束（D-36 已裁定） |
| rate_sends 清理（吊销联动） | DO（清理路由或每日 alarm 自然清扫） | — | 表在 DO；两条路径均已论证（§Open Questions Q1） |
| 管理页 UI（登录/列表/详情/掩码/历史） | 静态资产（public/admin.html + admin.js） | — | SC4 asset-first 零 Worker 请求；复杂度与 viewer 同量级（D-37） |
| Markdown 消毒渲染（历史视图） | web-sdk 产物（PushHub.renderMarkdown） | — | D-40 直接 script 引入复用，禁双管道漂移 |
| E2E 全链路验证 | Playwright（web-sdk e2e/ 目录） | wrangler dev（真 workerd） | D-41 沿用 D-26 模式 |

## Standard Stack

### Core（本阶段零新增包——全部复用既有）

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| wrangler | 4.126.0（已装） | dev/deploy/静态资产托管 | 既有；无配置改动（无新 binding） |
| @cloudflare/vitest-plugin | 1.1.0（已装） | 服务端测试（真 workerd + miniflare） | 既有；新路由测试沿用 |
| @playwright/test | 1.62.1（已装） | 管理页 E2E 真浏览器 | D-41 沿用 D-26 模式 |
| TypeScript | 7.0.2（已装） | 类型（worker-configuration.d.ts 无需重生成——无新 binding） | 既有 |
| PushHub.renderMarkdown | 构建产物 `/pushhub.js`（?v=0.1.10） | 历史视图消毒渲染 | D-40 指定复用，零重复实现 |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| 手写 admin.js | 任何前端框架 | D-37 已锁 vanilla；管理页复杂度（表单+列表+状态）与 viewer 同量级，框架是负资产 |
| DO 内部路由 /history | Worker 侧 DO RPC（直接调方法） | 既有模式是 fetch 路由 + X-PH-Verified；混入 RPC 会造第二种 Worker↔DO 契约形态，统一性优先 |
| KV 兼容读取（normalize） | 一次性迁移脚本（wrangler kv 重写生产键） | <20 条记录且全是冒烟频道；脚本需 CF API token、直改生产键空间，风险大于收益（详见 §Pattern 2） |

**Installation:** 无 —— 本阶段不安装任何新包。

## Package Legitimacy Audit

| Package | Registry | Age | Downloads | Source Repo | Verdict | Disposition |
|---------|----------|-----|-----------|-------------|---------|-------------|
| （无新包） | — | — | — | — | — | — |

**Packages removed due to [SLOP] verdict:** none
**Packages flagged as suspicious [SUS]:** none

本阶段全部能力由既有依赖 + 平台运行时内置 API（getWebSockets/deleteAll/deleteAlarm/KV delete）提供，零供应链增量。

## Architecture Patterns

### System Architecture Diagram

```
管理员浏览器
   │ ① GET /admin.html (+admin.js+pushhub.js)     ← 静态资产直出，零 Worker 请求（SC4）
   ▼
┌────────────────────────── Worker（无状态） ──────────────────────────┐
│ /api/admin/* 前缀 → checkAdminAuth（两段式常时比较）→ admin.ts 路由   │
│   ├─ POST   /channels                     → keys.ts createChannel   │
│   ├─ GET    /channels                     → listChannels(normalize) │──┐
│   ├─ DELETE /channels/:id   ──编排──┐      │                          │
│   ├─ POST   /channels/:id/send-keys │      │                          │
│   ├─ DELETE /channels/:id/send-keys/:key   │                          │
│   ├─ POST   /channels/:id/reset-channel-key│                          │
│   └─ GET    /channels/:id/messages  │      │                          │
│                                      ▼      ▼                          │
│                          KV（三前缀键表，keys.ts 唯一写入口）           │
│                          ch:<key> / sk:<key>{channelId,label?} /        │
│                          id:<id>{channelKey, sendKeys[], name, ...}     │
└──────────────────────────────┬───────────────────────────────────────┘
                               │ ② X-PH-Verified: 1 内部转发
                               │    （INTERNAL_ORIGIN + 可信头，仅经 binding 可达）
                               ▼
                    ┌─── ChatRoom DO（每频道一个）───┐
                    │ /kick-all   踢全部 WS（强一致）│←─ 重置/删除共用（D-33/D-34）
                    │ /history    keyset 倒序翻页    │←─ admin 排障（D-36）
                    │ /purge      deleteAll+deleteAlarm+踢连 │←─ 频道删除（推荐合并路由）
                    │ (现有 /publish /ws 不动)        │
                    └────────────────────────────────┘
决策点：删除频道顺序 = DO purge 先 → KV 键删后（重试安全，见 Pattern 4）
      重置 Channel Key 顺序 = KV 写先 → DO kick 后（双活窗口已文档化，见 Pattern 3）
```

### Recommended Project Structure（改动落点）

```
packages/server/src/
├── admin.ts          # +5 条 REST 路由（正则路径参数解析）；路由匹配保持鉴权后
├── keys.ts           # id: schema 演进 + normalize() 兼容层 + 多 Key 写路径
├── chat-room.ts      # +kick-all /history (/purge) 内部路由分支
└── (index.ts 大概率零改动——/api/admin/ 前缀分发已存在)
packages/server/test/
├── admin-channels.test.ts   # 既有响应结构断言联动更新
├── admin-send-keys.test.ts  # 新：多 Key CRUD + 上限 + 吊销 401
├── admin-reset-kick.test.ts # 新：重置踢连 + 历史保留
├── admin-delete.test.ts     # 新：删除全清理 + 前缀确认语义（API 侧）
└── admin-history.test.ts    # 新：keyset 翻页
packages/server/public/
├── admin.html        # 新：CSP 同 viewer；引 /pushhub.js?v= + /admin.js
└── admin.js          # 新：登录/列表/详情/掩码/复制/历史/删除确认
packages/web-sdk/
├── build.mjs         # ?v= 注入扩展到 admin.html（每文件恰一次断言）
└── e2e/admin.spec.ts # 新：D-41 全链路
scripts/smoke.mjs     # 联动更新（sendKey → sendKeys[0].key）
```

### Pattern 1: Admin REST 路由扩展（admin.ts）

**What:** 既有 admin.ts 是精确 pathname 匹配；新资源路径需要正则捕获段。
**When to use:** D-35 的 5 条新路由全部如此。

现状骨架 [VERIFIED: packages/server/src/admin.ts:65-69]（鉴权在路由判定**之前**——不鉴权不暴露路径存在性）：

```typescript
  const pathname = new URL(request.url).pathname;
  if (pathname !== "/api/admin/channels") {
    return errorEnvelope(404, "not_found", "The requested resource was not found.");
  }
```

扩展形态（保持"未知路径一律 404 not_found 信封"策略；channelId 段用既有生成器口径校验——`generateChannelId` 产出 16 字符 base62 [VERIFIED: packages/server/src/keys.ts:95-98 `generateChannelId` + `CHANNEL_ID_LENGTH = 16`]）：

```typescript
// 建议路由表形态（先精确后参数化，全部在 checkAdminAuth 之后）：
const m = pathname.split("/"); // [ "", "api", "admin", "channels", ...]
// POST/GET /api/admin/channels            —— 现有
// DELETE /api/admin/channels/:channelId   —— /^\/api\/admin\/channels\/([0-9A-Za-z]{16})$/
// POST   …/send-keys、DELETE …/send-keys/:key、POST …/reset-channel-key、GET …/messages
```

要点：
- **404 与 401 语义不变**：未知方法/路径 → `errorEnvelope(404, "not_found", "The requested resource was not found.")`（原样沿用）；channelId 不存在 → 同 404 not_found（不区分"格式错"与"不存在"，防探测）。
- **错误码面**：D-06 信封形态复用；code 是小写 snake_case 字符串。既有先例：admin.ts 已用 `"not_found"`——它不在 shared `ErrorCode` 联合内（那是线协议帧错误码域）[VERIFIED: packages/server/src/envelope.ts:7-12 `errorEnvelope(status: number, code: string, ...)` 接受任意 string；shared/src/index.ts:70-78 ErrorCode 枚举无 not_found]。**建议**：admin 域新增码（如 send key 超限）走同形态字符串，不扩 shared 冻结枚举。
- **标签校验**（Discretion）：对齐 CHANNEL_NAME_MAX_LENGTH 模式 [VERIFIED: packages/server/src/admin.ts:25-26 `export const CHANNEL_NAME_MAX_LENGTH = 64;`]——建议 label 可选 string、≤64 UTF-16 码元、超限 400 invalid_body、null/缺省视为无标签。

### Pattern 2: id: schema 演进 + normalize 兼容层（keys.ts）

**What:** `id:` 值从单 sendKey 演进为 sendKeys 列表；生产已有旧格式数据（每次冒烟建一个频道，0.1.0~0.1.10 共 10+ 个）[VERIFIED: DEPLOY.md 部署记录 + scripts/smoke.mjs:71-84 每次运行以时间戳名建新频道]。
**When to use:** 一切读写 `id:` 的路径。

现状值结构 [VERIFIED: packages/server/src/keys.ts:100-107]：

```typescript
/** id:<channelId> 反向索引的值结构（GET /api/admin/channels 列表数据源）。 */
export interface ChannelRecord {
  channelId: string;
  channelKey: string;
  sendKey: string;
  name: string;
  createdAt: number;
}
```

目标形态（D-30/D-35）与兼容策略：

```typescript
// sk: 值：{channelId} → {channelId, label?} —— 纯增量，旧值天然合法
// （现结构 [VERIFIED: packages/server/src/keys.ts:18-21]:
//   export interface SendKeyInfo { channelId: string; }）

// id: 值：sendKey: string → sendKeys: SendKeyRecord[] —— 需兼容读取
export interface SendKeyRecord {
  key: string;        // phs_ + 32 字符（generateSendKey 复用）
  label: string | null;
  createdAt: number;
}

// normalize：读路径统一出口（listChannels 与一切 id: 消费点）
// 旧格式 {sendKey: "phs_…"} → {sendKeys: [{key: old.sendKey, label: null, createdAt: old.createdAt}]}
// 新格式 {sendKeys: [...]} 原样通过；写路径（建频道/建 Key/吊销/重置）恒写新格式
// （= migrate-on-write：任何被管理操作触碰的频道即升级为新模式）
```

**为什么不写迁移脚本**：① 生产 `id:` 记录全部是冒烟频道（DEPLOY.md 每版本冒烟都建频道）；② 这些频道本身就是垃圾数据，**用本期新做的删除功能清掉它们 = D-34 的首次真实 dogfooding**；③ 迁移脚本需要 CF API token 直改生产键空间 + 单独验证轮次，成本高于价值。normalize 分支是 ≤10 行的永久防御，也保护"漏删的旧频道"。
**额度核算（每操作 KV 写/删次数，全部远低于 1,000/天）**：

| 操作 | KV writes | KV deletes |
|------|-----------|------------|
| 建频道（不变） | 3（ch/sk/id） | 0 |
| 建 Send Key | 2（sk put + id 重写） | 0 |
| 吊销 Send Key | 1（id 重写） | 1（sk:） |
| 重置 Channel Key | 2（ch:new + id 重写） | 1（ch:old） |
| 删除频道（10 Key 最坏） | 0 | 12（ch + id + 10×sk） |

依据 [CITED: developers.cloudflare.com/kv/platform/pricing/]（免费层逐类型限额表：100,000 读/天、**1,000 写/天、1,000 删/天（独立额度线）**、1,000 list/天、1GB 存储）；1 写/秒限制是**同 key** 限制（"maximum of 1 write to the same key per second"）[CITED: developers.cloudflare.com/kv/api/write-key-value-pairs/]——三前缀 + N 个 sk: 互为不同 key，**顺序 await 依次删即可，无需分批限速**。KV binding delete 对不存在的 key 也返回成功（幂等）[CITED: developers.cloudflare.com/kv/api/delete-key-value-pairs/]，使删除流程天然可重试。
另注意：`listChannels` 每次调用消耗 list 额度（1+ 次 list + N 次 get）[VERIFIED: packages/server/src/keys.ts:143-170 KV.list 前缀枚举循环]——管理页个人工具刷新频率下无压力，但 list 1,000/天是独立额度线，管理页不宜做自动轮询刷新。

### Pattern 3: kickAll 内部路由 + 重置编排顺序（chat-room.ts / index.ts）

**What:** DO 内遍历连接句柄踢出；Worker 侧编排"先写 KV 再踢"。
**When to use:** D-33（重置）/ D-34（删除）共用。

DO fetch 路由挂载点现状 [VERIFIED: packages/server/src/chat-room.ts:197-211]：

```typescript
  async fetch(request: Request): Promise<Response> {
    // 仅信 Worker 转发的内部请求（Pattern 8）。
    if (request.headers.get("X-PH-Verified") !== "1") {
      return errorEnvelope(401, "invalid_key", "Missing or invalid credentials.");
    }

    const url = new URL(request.url);
    if (url.pathname === "/publish" && request.method === "POST") {
      return this.handlePublish(request);
    }
    if (url.pathname === "/ws" && request.headers.get("Upgrade") === "websocket") {
      return this.handleWebSocketUpgrade();
    }
    return errorEnvelope(404, "not_found", "Unknown internal route.");
  }
```

kickAll 实现（新分支，如 `POST /kick-all`）：

```typescript
private handleKickAll(): Response {
  const sockets = this.ctx.getWebSockets();  // 含休眠中连接（publish 扇出同款遍历）
  let kicked = 0;
  for (const ws of sockets) {
    try { ws.close(1008, "channel key reset"); kicked++; } catch { /* 已死连接 */ }
  }
  return new Response(JSON.stringify({ kicked }), {
    status: 200, headers: { "content-type": "application/json; charset=utf-8" },
  });
}
```

依据与先例：
- `getWebSockets()` 返回 attached WebSocket 数组（含休眠连接）[CITED: developers.cloudflare.com/durable-objects/api/state/ — "returns an Array<WebSocket> which is the set of WebSockets attached to the Durable Object"]；`acceptWebSocket` 后 send/close 可用 [CITED: 同页 — "After calling acceptWebSocket, the WebSocket is accepted and its send and close methods can be used"]。
- **服务端主动 close(code, reason) 在本代码库已是验证过的模式**：publish 死连接清理 `ws.close(1011, "send failed")` [VERIFIED: packages/server/src/chat-room.ts:295-297]、webSocketClose 处理器 `ws.close(code, reason)` [VERIFIED: packages/server/src/chat-room.ts:464-466]。
- close code 选择（Discretion 裁定建议）：**1008（policy violation）+ reason "channel key reset"**。语义正确（连接因策略被终止，非正常关闭非协议错误）；web SDK 不区分 close code——`ws.onclose` 一律翻译为 WS_CLOSE [VERIFIED: packages/web-sdk/src/pushhub.ts:263-267]：

```typescript
    ws.onclose = () => {
      if (this.ws !== ws) return; // 已被新连接取代
      this.ws = null;
      this.dispatch({ kind: "WS_CLOSE" });
    };
```

状态机对意外 close 的处理是退避重连（不是 fatal）[VERIFIED: packages/web-sdk/src/connection-machine.ts:308-311]：

```typescript
          // 意外断开（部署断连/网络闪断/握手失败）→ full jitter 退避重连。
          enter("reconnecting", out);
          armTimer("reconnect", backoffDelay(attempt), out);
          attempt += 1;
```

即：被踢客户端会带旧 key 重连 → 生产环境 60s 缓存窗口内可能重挂（文档化双活窗口）、窗口后握手 401 → 持续退避重连循环（cap 60s）。**这是既定 SDK 行为，不是本期缺陷**；E2E 断言"status 离开 online"即可，不要断言"进入 offline"。此 close code 值建议按 CONTEXT.md Discretion 要求记入决策（涉及 Phase 5/6 客户端展示时可细化 reason）。
- compat 旗标注意：`web_socket_auto_reply_to_close`（compat date ≥ 2026-04-07，本项目 `2026-08-25` 已越线 [VERIFIED: packages/server/wrangler.jsonc `"compatibility_date": "2026-08-25"`]）下运行时自动回应 Close 帧，服务端再调 close() 安全但非必需 [CITED: developers.cloudflare.com/durable-objects/best-practices/websockets/]——不影响 kickAll 主动 close 的正确性。

**重置编排顺序（关键设计）**：**先写 KV（删 ch:old、写 ch:new、重写 id:）→ 再调 DO kick-all**。
- 反序（先踢后写）的错误窗口：被踢客户端立刻重连，Worker 用**边缘缓存的旧 ch: 值**（cacheTtl 60 [VERIFIED: packages/server/src/keys.ts:46-48 `cacheTtl: 60` 显式标注]）放行 → DO /ws 重新 accept → 该连接此后**再无人踢它**（kick 只发生一次），旧 key 客户端无限期挂着。
- 正序的窗口：踢完之后 60s 内旧 key 重连可能被缓存放行重挂——但窗口一过即 401；这就是 SC2 与 D-33 已文档化的"≤60s 边缘缓存双活窗口"（UI 确认框文案注明），语义自洽。

### Pattern 4: 频道删除 = DO purge 先 + KV 清理后；DO /history keyset 翻页

**What:** D-34 删除流程的顺序决定重试安全性；/history 复用既有查询内核。
**When to use:** DELETE /channels/:id 与 GET /channels/:id/messages。

**删除顺序（推荐 DO 先、KV 后）**：
1. 读 `id:` 拿 sendKeys 列表（清理清单）；
2. DO `POST /purge`（一个内部路由做三件事：kick-all → `deleteAll()` → `deleteAlarm()`）；
3. KV 依次 delete：`ch:<old>`、`id:<channelId>`、每个 `sk:<key>`。

为什么 DO 先：若 KV 删完而 DO purge 失败，频道从列表消失但 DO 数据成"不可达孤儿"（无键指向它），管理页无法重试。DO 先做则部分失败时频道仍在列表，**重试幂等**（KV delete 幂等 [CITED: KV delete docs]；purge 对已清空 DO 是 no-op——deleteAll 清库后构造器会在下次唤醒重建空表，再 purge 一次无害）。

**`deleteAll()` 语义（官方核实，本阶段最高价值事实）** [CITED: developers.cloudflare.com/durable-objects/api/storage-api/]：
- SQLite-backed DO：`deleteAll()` 删除**整个**私有 SQLite 库内容——**含 SQL 表数据与 KV 型数据**（"removes the entire contents of a Durable Object's private SQLite database, including both SQL data and key-value data"）；原子、无部分删除问题。
- **关键坑：`deleteAll()` 不会删除 alarm**（"does not proactively delete alarms. Use deleteAlarm() to delete an alarm"）。本项目 retention alarm 由 alarm 处理器尾部无条件重设 [VERIFIED: packages/server/src/chat-room.ts:491-493 `} finally { await this.ctx.storage.setAlarm(Date.now() + RETENTION_INTERVAL_MS); }`]——只 deleteAll 不 deleteAlarm 的后果：alarm 次日照常触发 → DO 唤醒 → 构造器重跑 `CREATE TABLE IF NOT EXISTS` 重建空表 → alarm() 删空表 + 重设下一天 → **僵尸 DO 永久每日唤醒**（烧 DO 请求额度 + 无意义计时长）。**deleteAlarm() 必须与 deleteAll() 成对出现在 purge 路由内**。

**DO /history（admin 排障翻页）**：
- 挂载：fetch 路由新增 `GET /history` 分支（X-PH-Verified 前置校验沿用）。
- 查询：`WHERE seq < ?before ORDER BY seq DESC LIMIT ?n+1`（keyset 倒序；首页无 before 取最新 n 条；多取 1 条判 has_more——与既有 sendHistory 的"LIMIT n+1"技巧同式 [VERIFIED: packages/server/src/chat-room.ts:425-462]）。
- 行映射**直接复用** `MESSAGE_COLUMNS` + `rowToMessageFrame`（模块内私有，同文件零成本复用）[VERIFIED: packages/server/src/chat-room.ts:113-115 与 139-160]：

```typescript
const MESSAGE_COLUMNS =
  "seq, wid, title, text, options, callback_url, click_url, priority, " +
  "answered, answered_by, answered_at, answered_content, created_at";
```

rowToMessageFrame 产出的就是含 answered 四字段的 MessageFrame 形态——SC3"含回复状态"零额外映射。响应建议 `{messages, has_more, oldest_kept_seq}`（oldest_kept_seq = MIN(seq) 复用 D-10 语义，管理页历史底部显示"更早消息已清理"边界）。
- limit 语义（Discretion 建议）：缺省 50、钳制 [1, 500]（对齐 shared `SYNC_LIMIT_DEFAULT=200 / SYNC_LIMIT_MAX=500` 的钳制思路但 admin 独立定义；不必导出私有的 clampSyncLimit，10 行小函数或提为共享私有工具均可——查参数名建议 `before` 与 `limit`）。
- Worker 侧：admin 鉴权 → `env.CHANNELS.getByName(channelId).fetch(...)` 转发——转发模式与 index.ts 既有代码一致 [VERIFIED: packages/server/src/index.ts:26-27 `const INTERNAL_ORIGIN = "https://do.pushhub.internal"; const VERIFIED_HEADER = "X-PH-Verified";` 与 81/95-97 两处转发]。channelId → DO 名映射经 KV `id:` 读取得来（404 语义：id: miss → not_found，不触 DO）。

### Pattern 5: 管理页 vanilla 资产（admin.html + admin.js）

**What:** D-37"vanilla 单文件"的工程落地 = **HTML + 独立 JS 两个物理文件**（同 viewer 形态），零构建零依赖。
**关键约束（易误解点）**：D-28 锁定的 CSP `script-src 'self'` **禁止一切 inline `<script>`**——"单文件"只能理解为"单页无构建"，物理上脚本必须外链。viewer 已为此把脚本独立成 viewer.js，CSP 原文 [VERIFIED: packages/server/public/index.html:9-11]：

```
content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss: http: https:; img-src * data:; base-uri 'self'; form-action 'self'"
```

管理页 admin.html 原样复制该 CSP meta（connect-src 已含 http/https，管理页 fetch 同源 `/api/...` 无障碍）。

- **Admin Key 持有**：localStorage 模式照 viewer [VERIFIED: packages/server/public/viewer.js:24-25 `var LS_SERVER = "pushhub.server"; var LS_KEY = "pushhub.key";`]——admin 建议独立键名（如 `pushhub.admin`，不与 viewer 混用；读取侧 try/catch 对齐 WR-03 防护先例）。
- **fetch + Bearer**：全部 API 调用同源相对路径 + `Authorization: Bearer <key>` 头（无 CORS 面；Bearer 头方案无 CSRF 面——不依赖 cookie）。
- **掩码（D-29）**：纯前端渲染——API 返回全量密钥，渲染时 `key.slice(0,7) + "…" + key.slice(-4)`（`phs_` 前缀 4 字符 + 3 字符可见 + 后 4 字符，具体格式 Discretion）；揭示 = 点击眼睛按钮把 textContent 换全量（**绝不 innerHTML**——密钥是 ASCII 安全字符串，但统一 textContent 纪律防漂移）。
- **复制按钮**：`navigator.clipboard.writeText`——wrangler dev 的 `http://127.0.0.1` 与生产 https 均为 secure context，clipboard API 可用 [ASSUMED: 浏览器 secure context 规范常识，未本会话验证；E2E 侧需 `grantPermissions` 见 Validation 节]。
- **接入片段（D-39）**：创建成功的 201 响应即含全部素材，前端拼装：`curl -X POST <origin>/api/send -H "Authorization: Bearer <sendKey>" …` 代码块 + Channel Key + viewer 链接 `/?server=<origin>&key=<channelKey>`（viewer 已支持 URL 参数自动连接 [VERIFIED: packages/server/public/viewer.js:193-208]）。
- **历史视图（D-40）**：`<script src="/pushhub.js?v=…">` 后 `PushHub.renderMarkdown(m.text)` 渲染消息体（viewer appendMessage 同款唯一管道 [VERIFIED: packages/server/public/viewer.js:109 `body.innerHTML = window.PushHub.renderMarkdown(m.text);`]）；title/label/频道名一律 textContent；"加载更多"按钮带 before 游标递归取页。
- **删除确认（D-34）**：输入框 + 按钮禁用态联动——输入是频道名**前缀**时启用（`channel.name.startsWith(input) && input.length > 0`；GitHub 模式的宽松变体，Discretion 精化）。

### Pattern 6: build.mjs ?v= 注入扩展（不可漏的联动点）

现状：`?v=` 构建期注入**只处理 index.html 且硬断言恰命中一次** [VERIFIED: packages/web-sdk/build.mjs:57-66]：

```javascript
const hits = indexHtml.match(refRe) ?? [];
if (hits.length !== 1) {
  console.error(
    `INJECT FAIL: index.html pushhub.js?v= 引用期望恰 1 处，实际 ${hits.length} 处…`);
  process.exit(1);
}
writeFileSync(indexPath, indexHtml.replace(refRe, `pushhub.js?v=${rootVersion}`));
```

admin.html 引用 `/pushhub.js`（renderMarkdown）若直接写 `?v=` 不会被更新（脚本只读 index.html）；若不写 `?v=` 则 SDK 字节更新后管理页可能吃 stale 缓存。**必须**扩展 build.mjs 对 admin.html 做同样的"读—恰一次断言—替换"（两文件各自恰一次），cache-bust-sync.test.ts 同步扩展。这是独立任务，漏掉不报错（构建绿）但线上管理页可能永远拿旧 SDK——**静默失效型集成点**。

### Anti-Patterns to Avoid

- **在 admin 路由匹配前做任何业务逻辑**：鉴权必须最先（既有结构已如此，扩展时别破坏）。
- **频道删除只调 deleteAll()**：漏 deleteAlarm() = 僵尸 DO 永久每日唤醒（官方文档明示语义）。
- **删除/重置先操作 KV 再 purge DO（删除场景）或先踢再写 KV（重置场景）**：两种反序都制造"无法重试/旧键重挂"窗口（Pattern 3/4 已论证正序）。
- **管理页用 innerHTML 写频道名/标签/密钥**：频道名与标签是用户可控字符串——textContent 纪律（消息体是唯一经 renderMarkdown 的 innerHTML 入口）。
- **给 GET /api/admin/channels 加自动轮询**：每次轮询消耗 KV list 额度（独立 1,000/天线）；手动刷新按钮足够。
- **绕过 keys.ts 直写 KV**：三前缀键表写路径唯一入口是 keys.ts 的纪律（threat model 键空间红线 [VERIFIED: packages/server/src/keys.ts:115-117 注释]），新写路径全部收敛进该文件。
- **测试里"吊销前先发一条消息再断言 401"**：本地 miniflare 无缓存所以其实可行（见 Pitfall 2），但**生产**同款序列存在 60s 窗口——测试注释里写明"生产语义见双活窗口文档"，防后人误把测试行为当生产行为。

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Markdown 消毒渲染（历史视图） | 自写 renderer/二次消毒 | `PushHub.renderMarkdown`（/pushhub.js） | D-40 指定；双管道必然漂移，消毒是安全关键路径 |
| Admin 鉴权 | 新鉴权中间件 | `checkAdminAuth`（admin.ts 既有） | 两段式常时比较已过 CR-01 修复与完整测试 |
| 密钥/channelId 生成 | 新生成器 | `generateChannelKey/generateSendKey/generateChannelId` | 拒绝采样消除取模偏差，已冻结 |
| keyset 翻页技巧 | 新分页方案（OFFSET） | 复用 sendHistory 的 `LIMIT n+1` 判 has_more 模式 | OFFSET 深翻页性能崩塌且本项目从未用过 |
| 行→消息形态映射 | 新映射函数 | `rowToMessageFrame`（同文件复用） | 与扇出帧逐字段同构，含 answered 字段集 |
| 连接句柄管理 | 自维护连接清单 | `this.ctx.getWebSockets()` | 休眠唤醒后内存字段全清空，运行时句柄表是唯一真相 |
| KV 键清理的批处理/限速 | 分批队列/退避循环 | 顺序 await 逐键 delete | 额度核算已证无需（不同 key 无 1/s 限制、12 删/次远低于 1,000/天） |
| E2E 服务编排 | 新 webServer 配置 | web-sdk 既有 playwright.config.ts webServer | 已含构建链 + wrangler dev + ADMIN_KEY 注入 + 127.0.0.1 就绪判定 |

**Key insight:** 本阶段的"复杂度预算"应全部花在**编排顺序与联动点**（KV/DO 操作顺序、四个跨文件联动）上，而不是任何新基础设施——每一块积木都已存在且被测试覆盖。

## Runtime State Inventory

> 本阶段含数据 schema 演进（`id:` 值结构变更），按迁移类阶段盘点运行时状态。

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data（生产 KV） | 旧格式 `id:` 记录 10+ 条（0.1.0~0.1.10 每次冒烟建一个频道，时间戳命名）[VERIFIED: DEPLOY.md 部署记录逐行"建临时冒烟频道"+ smoke.mjs:71-84] | keys.ts normalize 兼容读取（读旧写新）；建议后续用管理页删除功能清理冒烟频道（dogfooding） |
| Stored data（生产 DO） | 各冒烟频道 DO 内 messages/rate_sends 表数据 | 无直接动作；频道删除上线后随删除流程清（deleteAll+deleteAlarm） |
| Live service config | 无外部服务配置存于 git 之外（KV 即全部运行时状态；ADMIN_KEY 是 Worker secret，不受 schema 演进影响）[VERIFIED: wrangler.jsonc 仅 KV/DO/ASSETS 三 binding] | None — verified by wrangler.jsonc 全文读取 |
| OS-registered state | 无（纯 Cloudflare 托管，无本机注册项） | None — verified by 项目性质（serverless） |
| Secrets/env vars | `ADMIN_KEY`（wrangler secret）；`.dev.vars` 本地值；E2E `--var ADMIN_KEY:e2e-admin-key` | 不变——本期不动鉴权机制 |
| Build artifacts | `packages/server/public/pushhub.js`（构建产物）；`?v=0.1.10` 已注入 index.html | admin.html 上线时 build.mjs 扩展注入（Pattern 6）；部署版本 +1 规约照旧 [VERIFIED: DEPLOY.md 版本号规则] |

## Common Pitfalls

### Pitfall 1: deleteAll() 不删 alarm → 僵尸 DO
**What goes wrong:** 频道删除只调 `deleteAll()`，retention alarm 次日触发唤醒已"删除"的 DO，构造器重建空表，alarm 尾部无条件重设 → 永久每日唤醒循环。
**Why:** 官方文档明示 deleteAll 不清理 alarm；本项目 alarm 是自愈式重设（finally 无条件 setAlarm）。
**How to avoid:** purge 路由内 `deleteAll()` 与 `deleteAlarm()` 成对调用；E2E/集成测试覆盖"删除后 alarm 不再触发"（可通过 `ctx.storage.getAlarm()` 断言 null——经 runInDurableObject 或暴露在 purge 响应中）。
**Warning signs:** 删除频道后 dashboard DO 请求曲线仍每日出现尖峰。

### Pitfall 2: 混淆本地 miniflare 与生产 KV 的一致性语义
**What goes wrong:** 期望测试复现 60s 双活窗口（测不出），或误以为生产删除即时生效（文档说 ≤60s）。
**Why:** 本地 miniflare KV **无缓存层**——`cacheTtl` 只做合法性校验（≥60）后直接 `storage.get()` [VERIFIED: node_modules/.pnpm/miniflare@5.20260825.0-alpha/node_modules/miniflare/dist/src/workers/kv/namespace.worker.js:244-247 —— `validateGetOptions(key, { cacheTtl }); let entry = await this.storage.get(key);` 无任何缓存插层]。vitest-plugin 测试完全本地化（README："Runs tests fully-locally using Miniflare" + "Implements isolated per-test storage"）[VERIFIED: node_modules/@cloudflare/vitest-plugin@1.1.0 README.md:8-9]，不触生产额度。
**How to avoid:** 测试大胆断言"删后立即可见"（确定性成立）；60s 窗口只以文档 + UI 文案形式交付（SC2 本就如此定义）。
**Warning signs:** 有人提议在测试里 sleep 60s 或 mock 缓存——都不需要。

### Pitfall 3: CSP 下"单文件"误解 → inline script 直接被浏览器拦截
**What goes wrong:** 把 D-37 理解为 HTML 里内嵌 `<script>`，CSP `script-src 'self'` 使脚本一行不执行。
**Why:** viewer 当初独立出 viewer.js 正是为满足该约束（index.html 注释 T-02-09 明示）。
**How to avoid:** admin.html + admin.js 两文件；本地打开页面先看 console 无 CSP 违规。
**Warning signs:** 页面渲染但零交互。

### Pitfall 4: 响应结构演进的四个联动点漏改
**What goes wrong:** `sendKey → sendKeys[]` 后：smoke.mjs 取 `channel.sendKey` 变 undefined → 冒烟第 ② 步 401 假红；admin-channels.test.ts 的 `phs_` 正则与 `toEqual` 断言全红；web-sdk e2e 三个 spec 的 `createChannel` helper 同步红。
**Why:** [VERIFIED: scripts/smoke.mjs:88-89 `const CHANNEL_KEY = channel.channelKey; const SEND_KEY = channel.sendKey;`]；[VERIFIED: packages/server/test/admin-channels.test.ts:155-162 正则断言 + 201-209 toEqual]；[VERIFIED: packages/web-sdk/e2e/viewer.spec.ts:28-42 / reconnect.spec.ts:33-42 同型 helper]。
**How to avoid:** 计划里把"响应结构变更"与"四个消费方更新"放同一任务或同一 wave 强约束；D-35 已裁定向后不兼容可接受、同版本联动。
**Warning signs:** 任何一处绿着合入——必然漏改了另一个消费方。

### Pitfall 5: kick 断言写成"进入 offline"
**What goes wrong:** E2E 等待 viewer 被踢后显示"已断开"，实际它进的是"重连中"（退避重连循环），断言超时。
**Why:** SDK 对意外 close 一律退避重连（connection-machine WS_CLOSE 分支）；握手 401 在浏览器表现为 error+close（无 open），仍走重连循环，永不 fatal。
**How to avoid:** 断言"status 离开 online"（dot 类名不再是 dot-online）或 Node 侧直连 WS 断言 close 事件 code/reason。
**Warning signs:** E2E 卡 15s 超时在 status 断言上。

### Pitfall 6: Playwright clipboard 断言权限
**What goes wrong:** E2E 点复制按钮后读 `navigator.clipboard.readText()` 被拒。
**Why:** Chromium 剪贴板读取需授予权限。
**How to avoid:** `await page.context().grantPermissions(["clipboard-read", "clipboard-write"])`，或降级断言按钮态/`data-copied` 属性（writeText 在 secure context 聚焦页通常无需授权即可写）[ASSUMED: Playwright/Chromium 权限模型常识，未本会话验证]。
**Warning signs:** 本地手跑通过、CI/无头环境红。

### Pitfall 7: id: 读-改-写竞态
**What goes wrong:** 并发两个建 Send Key 请求各自读到 N 个 key、各写回 N+1，后写覆盖前写——丢一个 sk: 键的索引记录（sk: 键本身仍在、能发消息，但列表不显示、删频道清不掉）。
**Why:** KV 是 last-write-wins，无事务。
**How to avoid:** v1 接受（单管理员个人工具，D-31 上限 10 使竞争面极小）；文档记录该已知限制。不做 KV CAS 重试（过度工程）。
**Warning signs:** 极少出现；出现时该 sk: 键成为孤儿（可经 wrangler kv 手工清）。

### Pitfall 8: DO 内部路由越权面
**What goes wrong:** 新内部路由（/history 等）忘记 X-PH-Verified 前置检查或检查放在路由分支内漏掉某分支。
**Why:** DO 仅经 binding 可达，但内部头是双重防线（既有代码把校验放在 fetch 最顶部）。
**How to avoid:** 新分支全部加在既有校验**之后**（结构上继承防护）；E2E 不需要专门测 DO 直连（binding 外不可达），集成测试经 Worker 全路径覆盖。
**Warning signs:** code review 发现路由分支在校验之前。

## Code Examples

### Example 1: admin.ts 参数化路由（建议形态，对齐既有 404 策略）

```typescript
// Source: 既有 admin.ts 结构 + D-35 路由清单（形态建议，具体以计划为准）
// 全部在 checkAdminAuth 通过后执行；channelId 校验失败与"不存在"同走 404。
const CHANNEL_ID_RE = /^[0-9A-Za-z]{16}$/;  // 与 generateChannelId 产出同口径
const m = /^\/api\/admin\/channels\/([^/]+)(?:\/(send-keys|reset-channel-key|messages))?(?:\/(.+))?$/.exec(pathname);
if (m === null) return notFound();
const [, channelId, sub, tail] = m;
if (!CHANNEL_ID_RE.test(channelId)) return notFound();
// DELETE /channels/:id —— sub === undefined && method === "DELETE"
// POST   /channels/:id/send-keys —— sub === "send-keys" && method === "POST" && !tail
// DELETE /channels/:id/send-keys/:key —— sub === "send-keys" && tail
// POST   /channels/:id/reset-channel-key —— sub === "reset-channel-key"
// GET    /channels/:id/messages —— sub === "messages"
```

### Example 2: DO /history keyset 倒序（复用既有查询内核）

```typescript
// Source: chat-room.ts sendHistory 同式技巧（LIMIT n+1 判 has_more），方向改倒序
private handleAdminHistory(url: URL): Response {
  const before = url.searchParams.get("before");  // null = 首页（最新 n 条）
  const limit = clamp(url.searchParams.get("limit")); // 缺省 50，钳 [1,500]
  const oldest = this.ctx.storage.sql
    .exec("SELECT MIN(seq) AS m FROM messages").one() as { m: number | null };
  const rows = before === null
    ? this.ctx.storage.sql.exec(
        `SELECT ${MESSAGE_COLUMNS} FROM messages ORDER BY seq DESC LIMIT ?1`, limit + 1)
      .toArray()
    : this.ctx.storage.sql.exec(
        `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE seq < ?1 ORDER BY seq DESC LIMIT ?2`,
        Number(before), limit + 1).toArray();
  const hasMore = rows.length > limit;
  return json({ messages: (hasMore ? rows.slice(0, limit) : rows).map(rowToMessageFrame),
                has_more: hasMore, oldest_kept_seq: oldest.m ?? 0 });
}
```

### Example 3: purge 路由（deleteAll + deleteAlarm 成对）

```typescript
// Source: 官方 storage-api 文档 deleteAll 语义（不删 alarm）+ 本项目 alarm 自愈重设
private async handlePurge(): Promise<Response> {
  let kicked = 0;
  for (const ws of this.ctx.getWebSockets()) {
    try { ws.close(1008, "channel deleted"); kicked++; } catch { /* 已死 */ }
  }
  await this.ctx.storage.deleteAll();     // 清 SQL 表 + KV 型数据（原子）
  await this.ctx.storage.deleteAlarm();   // 必须显式——deleteAll 不清 alarm
  return json({ kicked });
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `@cloudflare/workers-types` 手动装 | `wrangler types` 生成 worker-configuration.d.ts | 既有（01 期已落地） | 本期无新 binding，无需重生成 |
| Close 帧需服务端手动回 close | `web_socket_auto_reply_to_close`（compat ≥ 2026-04-07）运行时自动回应 | 2026-04-07 | 本项目 compat 2026-08-25 已启用；kickAll 主动 close 不受影响 |
| CLAUDE.md 记 attachment 上限 2048 字节 | 官方现文档为 16,384 字节 | 文档现行值 | chat-room.ts 注释已是 16,384 [VERIFIED: chat-room.ts:372]，无行动项 |

**Deprecated/outdated:** 无新增——本期不引入任何过期 API。

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `navigator.clipboard.writeText` 在 127.0.0.1 dev 与生产 https 均可用；E2E 读剪贴板需 grantPermissions | Pattern 5 / Pitfall 6 | 复制按钮降级为选中提示；E2E 改断言按钮态——影响小 |
| A2 | 响应信封建议形态（`sendKeys:[{key,label,createdAt}]`、`{messages,has_more,oldest_kept_seq}`、204 等） | Pattern 1/2/4 | 纯建议——planner/discretion 可调，唯一硬约束是 D-35 路由路径与 D-06 信封形态 |
| A3 | kick close code 1008 + reason "channel key reset"/"channel deleted" | Pattern 3 | SDK 不读 code（已实证），仅影响未来客户端语义——按 Discretion 要求记入决策即可 |
| A4 | 生产旧 `id:` 记录全部/绝大部分是冒烟频道（10+ 条），无用户自建频道 | Runtime State Inventory | normalize 兼容层保证任何旧格式频道照常可用，只是停留在单 Key 形态直到被管理操作触碰——零破坏 |
| A5 | DO 内部路由命名（/kick-all、/history、/purge）与组合方式 | Pattern 3/4 | 纯实现细节，planner 可拆并（如 kick-all 独立于 purge） |

## Open Questions (RESOLVED)

1. **rate_sends 清理的落点（D-32 字面 vs 每日 alarm 自然清扫）**
   - What we know: 吊销后该 sk: 键的 rate_sends 行无害（键名永不复用、36 字符随机）；每日 alarm 已清扫 `window_start` 早于 24h 的桶 [VERIFIED: packages/server/src/chat-room.ts:485-488]。
   - What's unclear: D-32 字面要求"对应清理"是否必须即时。
   - Recommendation: 加一个极小内部路由（或并入既有转发）即时 DELETE 一行——决策忠实度高、实现 <10 行；若 planner 判断过度，注释引用 alarm 清扫语义并记录偏差亦可接受。
   - **RESOLVED:** 采纳即时清理——03-02-PLAN Task 1f 实现 DO `/cleanup-rate` 内部路由，吊销时即时 DELETE 对应行（planner 裁量记入决策）。
2. **管理页路由路径（/admin.html vs /admin/index.html）**
   - What we know: assets 精确路径匹配；`public/` 文件不得以 api 前缀开头 [VERIFIED: wrangler.jsonc assets 注释]。
   - Recommendation: `/admin.html` 最简单（零嵌套）；若要 `/admin` 需目录 `admin/index.html`——planner 酌情，无技术风险。
   - **RESOLVED:** 定为 `/admin.html`——03-01-PLAN 管理页骨架任务按 `packages/server/public/admin.html` 落位（零嵌套最简路径）。
3. **E2E 组织位置**
   - What we know: web-sdk playwright.config 已含完整 webServer 编排；server 包无 playwright 依赖。
   - Recommendation: `packages/web-sdk/e2e/admin.spec.ts` 沿用（D-41"沿用 Phase 2 e2e/ 目录模式"字面一致）；不迁移配置（迁移是纯摩擦）。
   - **RESOLVED:** 定为 `packages/web-sdk/e2e/admin.spec.ts`——03-01~03-05 各切片 E2E 均落此文件，复用既有 playwright.config webServer 编排。

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | 全部 | ✓ | 22（既有链路） | — |
| pnpm | workspace | ✓ | 10.33.0 [VERIFIED: root package.json packageManager] | — |
| wrangler dev | 本地测试/E2E | ✓ | 4.126.0（SQLite DO 本地支持已验证） | — |
| Playwright Chromium | E2E | ✓ | 1.62.1（Phase 2 已跑 8 spec） | — |
| 生产部署通道 | 冒烟 | ✓ | pushhub.dyun.org（workers.dev 有 SNI 阻断，DEPLOY.md 已记录） | 等网络窗口补跑（既有惯例） |

**Missing dependencies with no fallback:** 无
**Missing dependencies with fallback:** 无

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | vitest 4.1.11 + @cloudflare/vitest-plugin 1.1.0（server，真 workerd）；Playwright 1.62.1（E2E，真浏览器 × wrangler dev） |
| Config file | packages/server/vitest.config.ts（cloudflareTest + miniflare bindings 注入 TEST_ADMIN_KEY）/ packages/web-sdk/playwright.config.ts |
| Quick run command | `pnpm --filter @pushhub/server test`（vitest run --max-workers=1 --no-isolate，60 例基线 ~秒级） |
| Full suite command | `pnpm test`（server + web-sdk 单测）+ `pnpm --filter @pushhub/web-sdk e2e` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| KEY-02 | 建频道 201（新结构三件套）；删除 204 后三前缀键全清 + id: miss + DO 表清空 + alarm 删除 | integration | `pnpm --filter @pushhub/server test -- admin-channels admin-delete` | admin-channels ✅（需改）；admin-delete ❌ Wave 0 |
| KEY-03 | 建 Send Key 201（label 回显）；上限第 11 个 400；吊销后新 POST 401（本地强一致确定性断言）；同频道多 Key 各自可发互不影响 | integration | `pnpm --filter @pushhub/server test -- admin-send-keys` | ❌ Wave 0 |
| KEY-04 | 重置返回新 Channel Key；旧 key 新连 401 / WS 握手拒；已连接 socket 收 close 事件；重置前后 messages 全量保留（/history 对照） | integration | `pnpm --filter @pushhub/server test -- admin-reset-kick` | ❌ Wave 0 |
| ADM-03 | /history 首页最新 n 条倒序；before 游标翻页无重叠无遗漏；has_more 恰界；空频道 {messages:[], oldest_kept_seq:0}；answered 字段在位 | integration | `pnpm --filter @pushhub/server test -- admin-history` | ❌ Wave 0 |
| ADM-01/02 | 登录（错 key 401 提示）；建频道→详情；掩码默认遮蔽/点眼揭示；复制；建 Key/吊销/重置按钮态与文案（60s 窗口提示在位） | E2E | `pnpm --filter @pushhub/web-sdk e2e -- admin.spec.ts` | ❌ Wave 0 |
| ADM-01 删除交互 | 前缀不匹配按钮禁用 / 匹配启用 / 点击后频道从列表消失 | E2E | 同上（同 spec 内独立 test） | ❌ Wave 0 |
| SC2 踢连端到端 | viewer 页连接 → API 重置 → status 离开 online（断言 dot-online 消失，非 offline——见 Pitfall 5） | E2E | 同上 | ❌ Wave 0 |
| ADM-05/SC4 | /admin.html 响应 200 且**无** x-ph-worker 头；/api/admin/* 有该头（程序化对照既有机制） | E2E + 冒烟 | E2E 内 APIRequestContext 断言响应头；生产 curl 对照 + dashboard 人工（D-41） | 机制 ✅（stampMarker [VERIFIED: packages/server/src/index.ts:131-144]）|
| D-41 全链路 | 登录→建频道→建 Send Key→接入片段在位→发消息→历史可见→重置（踢连）→吊销（401）→删除 | E2E | 同 admin.spec.ts 串联（或分 test 保独立性） | ❌ Wave 0 |
| 生产冒烟 | smoke.mjs 联动新响应结构全绿 + /admin.html 生产 200 无 x-ph-worker | 冒烟脚本 | `PH_SMOKE_URL=https://pushhub.dyun.org PH_ADMIN_KEY=… node scripts/smoke.mjs` | ✅（需联动改） |

**采样率说明（2× Nyquist 意义）**：每条需求至少两个独立采样点——server 集成测试（协议/数据语义）+ E2E 或冒烟（用户旅程/生产形态）；SC4 额外有程序化标记头与 dashboard 人工双证据（D-41 保留项）。

### Sampling Rate
- **Per task commit:** `pnpm --filter @pushhub/server test && pnpm --filter @pushhub/server run typecheck`
- **Per wave merge:** `pnpm test`（含 web-sdk 单测回归——共享产物 pushhub.js 不应变）
- **Phase gate:** 全量 `pnpm test` + `pnpm --filter @pushhub/web-sdk e2e` 全绿 + 生产部署版本 +1 + 冒烟 SMOKE OK（含 /admin.html 资产对照）后才 `/gsd-verify-work`

### Wave 0 Gaps
- [ ] `packages/server/test/admin-send-keys.test.ts` — KEY-03（CRUD/上限/吊销 401/隔离）
- [ ] `packages/server/test/admin-reset-kick.test.ts` — KEY-04 + SC2 服务端侧（踢连 close 断言用 nextMessage 同式 helper 的 close 变体）
- [ ] `packages/server/test/admin-delete.test.ts` — KEY-02 删除全清理（KV 三前缀断言经 listChannels/resolve* miss + DO 经 /history 空）
- [ ] `packages/server/test/admin-history.test.ts` — ADM-03 翻页矩阵（seed 多条消息后逐页对照）
- [ ] `packages/web-sdk/e2e/admin.spec.ts` — ADM-01/02/05 + SC2 踢连 + D-41 全链路
- [ ] `scripts/smoke.mjs` 联动更新（SEND_KEY 取值路径）+ admin-channels.test.ts / viewer|reconnect|tracer spec 的 createChannel helper 联动
- [ ] `packages/web-sdk/build.mjs` + `cache-bust-sync.test.ts` 扩展（admin.html ?v= 注入）

## Security Domain

（security_enforcement: true，ASVS Level 1）

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes | Bearer Admin Key + 两段式常时比较（checkAdminAuth 复用，UTF-8 字节长度前置 + timingSafeEqual——CR-01 修复后形态 [VERIFIED: packages/server/src/admin.ts:34-56]） |
| V3 Session Management | no（无服务端会话——D-28 明确 localStorage 长期持有 + 手动登出，密钥即身份） | — |
| V4 Access Control | yes | 鉴权先于路由判定（404 不暴露路径存在性）；DO 仅信 X-PH-Verified 内部头（新分支置于校验之后） |
| V5 Input Validation | yes | label 校验（≤64/类型/null 归一）；channelId 路径段 16 字符 base62 白名单正则；/history 的 before/limit 数值钳制；一切 SQL 经绑定参数（sql.exec ?n 占位，既有纪律） |
| V6 Cryptography | yes（复用） | 密钥生成拒绝采样 crypto.getRandomValues（keys.ts 既有）；不新增强原语 |
| V12 CSRF | no | Bearer 头方案无 cookie 面（天然免疫经典 CSRF）；管理页 fetch 同源 |

### Known Threat Patterns for Cloudflare Workers + vanilla 管理页

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| 存储型 XSS 经消息体进管理页历史视图 | Tampering/Elevation | PushHub.renderMarkdown（marked+DOMPurify，FORBID_ATTR 收敛版）唯一渲染管道 + CSP `script-src 'self'`（双纵深，viewer 已验证同款） |
| XSS 经频道名/标签（用户可控短字符串） | Tampering | 全部 textContent 写入，禁 innerHTML（管理页纪律） |
| Admin Key 泄露面扩大 | Disclosure | 掩码默认遮蔽（防肩窥/截屏，D-29）；API 不打日志（既有 Prohibition：密钥不落日志）；localStorage 持有为已接受取舍（D-28） |
| 路径枚举探测新资源路由 | Information Disclosure | 404 统一文案统一信封；channelId 格式错与不存在同响应 |
| DO 内部路由直连伪造 | Spoofing | X-PH-Verified 双重防线（binding 可达性 + 内部头），新路由继承 |
| 删除接口误触/恶意调用 | Denial of Service | 前缀确认交互（UI 层）+ Bearer 鉴权（API 层）；硬删语义已在 D-34 明示接受 |
| 公网脚本 bug 循环建 Key 烧 KV 写额度 | DoS（资源耗尽） | D-31 上限 10 硬检查（读 id: 计数，超限 400） |

## Sources

### Primary (HIGH confidence)
- 既有代码全量精读（本会话 Read）：packages/shared/src/{index,validators}.ts、packages/server/src/{admin,keys,index,chat-room,envelope}.ts、packages/server/public/{index.html,viewer.js}、packages/web-sdk/src/{pushhub,connection-machine}.ts、packages/web-sdk/build.mjs、scripts/smoke.mjs、DEPLOY.md、wrangler.jsonc、vitest.config.ts、playwright.config.ts、e2e/{viewer,reconnect}.spec.ts、test/admin-channels.test.ts
- 本地依赖源码实证：miniflare 5.20260825.0-alpha KV worker（cacheTtl 无缓存层）、@cloudflare/vitest-plugin@1.1.0 README（fully-local + isolated storage）

### Secondary (MEDIUM confidence)
- [Cloudflare KV Pricing](https://developers.cloudflare.com/kv/platform/pricing/) — 免费层逐类型限额表（读/写/删/list 独立额度线）
- [Cloudflare KV Write](https://developers.cloudflare.com/kv/api/write-key-value-pairs/) — 1 写/秒为同 key 限制；60s 跨区可见性；binding 不支持 bulk
- [Cloudflare KV Delete](https://developers.cloudflare.com/kv/api/delete-key-value-pairs/) — 不存在键删除幂等成功
- [Durable Objects Storage API](https://developers.cloudflare.com/durable-objects/api/storage-api/) — deleteAll 对 SQLite-backed 清整库含 SQL 数据、原子；**不删 alarm 需显式 deleteAlarm**
- [Durable Objects State API](https://developers.cloudflare.com/durable-objects/api/state/) — getWebSockets/acceptWebSocket 语义、32,768 连接上限
- [Use WebSockets (Hibernation)](https://developers.cloudflare.com/durable-objects/best-practices/websockets/) — web_socket_auto_reply_to_close（compat ≥ 2026-04-07）、休眠语义
- [DO Troubleshooting](https://developers.cloudflare.com/durable-objects/observability/troubleshooting/) — deleteAll 时间限与重试安全（KV-backed 语境，SQLite-backed 原子无此问题）

### Tertiary (LOW confidence)
- navigator.clipboard 127.0.0.1 secure context 与 Playwright grantPermissions 行为（Pitfall 6 标注 [ASSUMED]，E2E 编写时一验即知）

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — 零新依赖，全部既有且被两个 phase 验证
- Architecture（KV 演进/DO 路由/顺序设计）: HIGH — 官方文档逐页核对 + 代码库模式直接复用 + 额度数字来自官方定价表
- Pitfalls: HIGH — 四个联动点均以行级代码引用定位；deleteAll/alarm 语义为官方原文
- 测试策略: HIGH — miniflare 无缓存行为经本地源码实证，测试矩阵全部可确定性执行

**Research date:** 2026-08-27
**Valid until:** 2026-09-26（平台文档语义稳定；若 Cloudflare 改 KV 免费额度口径需复核额度表）
