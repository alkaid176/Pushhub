# Phase 2: Web SDK 参考客户端 - Pattern Map

**Mapped:** 2026-08-26
**Files analyzed:** 15（新建/修改文件）
**Analogs found:** 13 / 15（其余 2 项按 RESEARCH.md 实证模式落地，见"No Analog Found"）

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `packages/web-sdk/package.json` | config | — | `packages/shared/package.json` | exact |
| `packages/web-sdk/tsconfig.json` | config | — | `packages/shared/tsconfig.json` | exact |
| `packages/web-sdk/vitest.config.ts` | config | — | `packages/server/vitest.config.ts`（仅结构参考，池不同） | role-match |
| `packages/web-sdk/playwright.config.ts` | config | request-response | 无（新测试层；RESEARCH Pattern 4 实证模板） | none |
| `packages/web-sdk/build.mjs` | utility | transform | `scripts/smoke.mjs`（Node 脚本组织风格） | partial |
| `packages/web-sdk/src/pushhub.ts` | component（公开 API 类） | event-driven | `packages/server/src/chat-room.ts`（连接生命周期对照面） | role-match |
| `packages/web-sdk/src/connection-machine.ts` | service（纯状态机） | event-driven | 无直接类比；`packages/shared/src/validators.ts` 纯函数风格 | flow-match |
| `packages/web-sdk/src/dedup.ts` | utility | transform | `packages/shared/src/validators.ts` | role-match |
| `packages/web-sdk/src/frames.ts` | utility（接收侧 guard） | transform | `packages/shared/src/validators.ts`（`validateInboundFrame` 镜像方向） | exact（方向相反） |
| `packages/web-sdk/src/render/render-markdown.ts` | service（可移植纯 TS 模块） | transform | `packages/shared/src/validators.ts`（纯函数 + 无环境假设） | role-match |
| `packages/web-sdk/src/entry-iife.cts` | config（打包入口） | — | 无（RESEARCH Pattern 1 实证模板） | none |
| `packages/web-sdk/test/*.test.ts` + `test/fixtures/attack-samples.json` | test | — | `packages/server/test/fixtures-contract.test.ts` | exact |
| `packages/web-sdk/e2e/*.spec.ts` | test（E2E） | request-response | `scripts/smoke.mjs`（admin 建频道 + 断连补拉流程对照） | role-match |
| `packages/server/public/index.html`（修改：占位页 → demo 查看器） | component（静态页） | event-driven | 自身现状（仅占位）；smoke.mjs 的 WS 编排作行为参考 | partial |
| 根 `package.json` / `.gitignore`（修改） | config | — | 根 `package.json` 现有 scripts 结构 | exact |

## Pattern Assignments

### `packages/web-sdk/package.json`（config）

**Analog:** `packages/shared/package.json`

照抄结构要点（`packages/shared/package.json:1-18`）：`private: true` + `"type": "module"`（注意：**正是 type:module 使 `.ts` 里写 `module.exports` 变成运行时炸弹——IIFE 入口必须 `.cts`**，RESEARCH Pitfall 2）；依赖声明 `"@pushhub/shared": "workspace:*"`（见 `packages/server/package.json:13`）；scripts 命名对齐 server 包：`typecheck` / `test` / `build` / `e2e`（server 已有 `dev`/`deploy`/`typecheck` 先例，`packages/server/package.json:5-11`）。

```json
{
  "name": "@pushhub/shared",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts",
    "./validators": "./src/validators.ts",
    "./fixtures/*": "./fixtures/*"
  },
  "scripts": {
    "typecheck": "tsc -p tsconfig.json"
  }
}
```

（web-sdk 不需要 exports 暴露——产物是 IIFE 文件；但 `test` script 沿用 server 的直接命令式风格 `"test": "vitest run"`，不加 `--max-workers=1 --no-isolate`——那是 server 池的 WS+DO 隔离需求，SDK 单测不需要。）

### `packages/web-sdk/tsconfig.json`（config）

**Analog:** `packages/shared/tsconfig.json:1-7`

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "types": []
  },
  "include": ["src/**/*.ts", "src/**/*.cts", "test/**/*.ts", "fixtures/**/*.json"]
}
```

要点：继承 base（strict/ESNext/moduleResolution:bundler/resolveJsonModule——`tsconfig.base.json:1-15`，resolveJsonModule 是 fixtures 静态 import 的前提）；`types: []` 防 Node 类型泄漏进 SDK 源码（可移植性禁令）。注意 include 需加 `.cts` 与 test/（shared 的 include 只含 src+fixtures，web-sdk 要扩）。

### `packages/web-sdk/src/frames.ts`（帧接收侧 guard）

**Analog（方向镜像）:** `packages/shared/src/validators.ts` 的 `validateInboundFrame` + 结果判别联合模式

必须复刻的模式——**判别联合结果类型**（`validators.ts:43-49`）：

```typescript
export type InboundFrameValidation =
  | { ok: true; frame: ClientFrame }
  | {
      ok: false;
      code: "invalid_frame" | "invalid_version";
      message: string;
    };
```

SDK 侧 `parseServerFrame` 采用同构形状（RESEARCH Code Examples 已给出完整实现，含 `{ ok: false, fatal: boolean, message }` 三态：unparseable/未知 type 非致命丢弃，`v !== PROTOCOL_VERSION` 致命断连不重连——对应服务端"宽容忽略坏帧、客户端严格断连"的方向约定，`chat-room.ts:386-388` 注释原文确认）。

**常量与类型 import 单一来源**（照抄 `chat-room.ts:20-40` 的 import 模式）：

```typescript
import {
  PROTOCOL_VERSION,
  type ServerFrame,
} from "@pushhub/shared";
```

禁止在本包重复定义任何帧类型/常量（冻结契约，复制即漂移）。

### `packages/web-sdk/src/render/render-markdown.ts`（可移植纯 TS 模块，D-20）

**Analog（文件级风格）:** `packages/shared/src/validators.ts`

复刻要点：(1) 文件头注释声明职责边界与环境约束（validators.ts:1-13 的写法——"零运行时依赖，可被 server 与未来 SDK 复用"直接对应 D-20 的"可被 pushhub.js 与 Tauri 前端复用"）；(2) 无裸数字阈值、常量从单一来源引用；(3) 禁 window/document 之外的环境假设。实现体照抄 RESEARCH Pattern 2 实证代码（marked 18 `parse()` + DOMPurify 工厂 + `afterSanitizeAttributes` hook，hook 断言基线为 RESEARCH 实证输出表，固化为 `test/fixtures/attack-samples.json`）。

### `packages/web-sdk/src/connection-machine.ts` + `src/pushhub.ts`（状态机 + API 类）

**行为锚点 Analog:** `packages/server/src/chat-room.ts`——SDK 必须对齐的服务端行为（全部已逐行核实）：

1. **心跳帧逐字节匹配**（`chat-room.ts:44-45`）：
```typescript
const PING_FRAME = '{"v":1,"type":"ping"}';
const PONG_FRAME = '{"v":1,"type":"pong"}';
```
SDK 侧必须字符串常量直发 `{"v":1,"type":"ping"}`，禁 `JSON.stringify({type:"ping",v:1})`（键序反 → auto-response 失配 → 烧额度，Pitfall 4）。

2. **accept 即推首拉**（`chat-room.ts:377`，`handleWebSocketUpgrade` 内 `this.sendHistory(server, null, undefined);`）——SDK 每次 WS_OPEN 必收最近 50 条 history，去重（D-17）消化交叠，随后发 sync since=last_seq。

3. **sync 语义**（`chat-room.ts:425-462`）：`WHERE seq > since ORDER BY seq ASC LIMIT n+1`，多取 1 条判 `has_more`；`oldest_kept_seq = MIN(seq)`（空频道 0）；`since < oldest_kept_seq` 是诚实缺口不报错。SDK 的补拉翻页循环以 `has_more` + 本批最大 seq 为新 since。

4. **WS URL 构造**（`packages/server/src/index.ts:105-113`）：服务端逐段 `decodeURIComponent` + try/catch——SDK 侧必须 `encodeURIComponent(key)`；路径模式 `/api/ws/<channelKey>`。

5. **扇出帧即首拉帧形态**（`chat-room.ts:139-160` `rowToMessageFrame` 注释："history 帧内消息与实时扇出消息形态完全一致——客户端单条渲染路径"）——SDK 渲染管线单条路径，实时/补拉共用。

### `packages/web-sdk/test/*`（单测 + 攻击样本 fixtures）

**Analog:** `packages/server/test/fixtures-contract.test.ts`

复刻的测试纪律（该文件头注释 1-15 行明文规定）：

- **一场景一测试文件**（server/test 目录 13 个文件全部如此命名：`send-basic` / `sync-catchup` / `ws-fanout` / `rate-limit` 等——web-sdk 对应 `machine-backoff` / `machine-fatal` / `machine-events` / `dedup` / `frames` / `render`）。
- **golden fixtures 静态 import**（fixtures-contract.test.ts:29-40 模式）：
```typescript
import historyFramePositive from "@pushhub/shared/fixtures/history-frame.positive.json";
import wsErrorFrame from "@pushhub/shared/fixtures/ws-error-frame.json";
```
SDK 的 `frames.test.ts` 直接吃这 12 个 shared fixtures 作契约输入（`package.json:10` 的 `"./fixtures/*": "./fixtures/*"` exports 已映射）。
- **全键断言禁宽松匹配**：排序后 `Object.keys(...).sort()` toEqual 期望数组 + 逐字段精确断言（fixtures-contract.test.ts:138-163 范式）；反例 `_violation` 元数据尾段 "-> code" 解析驱动（fixtures-contract.test.ts:132-135）。
- **render 消毒测试**：`// @vitest-environment jsdom` docblock 只给 render 测试切环境，其余保持 node（RESEARCH Pitfall 3/Pitfall 8——禁 happy-dom 承载消毒断言）。

### `packages/web-sdk/e2e/*.spec.ts`（Playwright E2E）

**Analog（流程对照）:** `scripts/smoke.mjs`

E2E 的业务流程与断言直接映射 smoke.mjs 已验证的编排：

- **建临时频道**（smoke.mjs:60-85）：`POST /api/admin/channels` Bearer ADMIN_KEY，频道名含时间戳可重复跑；channelKey 格式 `/^phc_[0-9A-Za-z]{32}$/`。E2E setup 同样走 admin API（wrangler dev `--var ADMIN_KEY:e2e-admin-key`）。
- **断连补拉验证**（smoke.mjs:155-210）：记录 last_seq → 断开 → 发 2 条 → 重连 → sync → 断言"恰补 2 条且 seq 连续、零重复"。E2E 用 `context.setOffline` 替代主动 close（A1 待 Wave 0 spike，备选 demo 页 `window.__pushhub` 调试句柄）。
- **首帧监听预挂**（smoke.mjs:105-113 注释："open 前预挂 message 监听——open 回调后再挂监听会丢即发即弃的首帧"）——E2E 页面侧断言时序同理。
- **Node 侧 fetch 发消息**（smoke.mjs:51-57）：`context.setOffline(true)` 后 Playwright 的 Node 侧 request 不受浏览器离线影响，断连期间补发消息用 `playwright.request` 或独立 fetch。

### `packages/server/public/index.html`（修改：demo 查看器）

**Analog:** 自身（占位页）+ `scripts/smoke.mjs`（行为参照）

现有占位页（`index.html:1-13`，zh-CN / utf-8 / viewport meta 头三行保留）。demo 页关键结构约束：`<script src="/pushhub.js?v=<version>"></script>` + `new PushHub(serverUrl, channelKey)`（D-23 存在即 SC1 证明）；接入配置存 localStorage（D-24）；注意 wrangler.jsonc 注释约束（`wrangler.jsonc:33-34`）："public/ 内文件路径不得以 api 前缀开头（asset-first 遮蔽风险）"——demo 页文件名避开 `api*`。CSP meta 可选加固（`default-src 'self'`）。

### 根 `package.json` / `.gitignore`（修改）

**Analog:** 根 `package.json:6-9` 现有链式 scripts 模式：

```json
"scripts": {
  "test": "pnpm --filter @pushhub/server test",
  "deploy": "pnpm --filter @pushhub/server run deploy"
}
```

扩展为链式（`pnpm run deploy` 命令契约不变，DEPLOY.md 版本 +1 流程不受影响）：

```json
"test": "pnpm --filter @pushhub/server test && pnpm --filter @pushhub/web-sdk test",
"deploy": "pnpm --filter @pushhub/web-sdk run build && pnpm --filter @pushhub/server run deploy"
```

`.gitignore` 增 `packages/web-sdk/dist/` 与 `packages/server/public/pushhub.js`（产物不进 git，RESEARCH Pattern 5 推荐方案 A）。

## Shared Patterns

### 协议类型与常量单一来源

**Source:** `packages/shared/src/index.ts`（冻结，01-02 one-way 门）
**Apply to:** web-sdk 全部 src 文件

```typescript
import { PROTOCOL_VERSION, INITIAL_FETCH, type ServerFrame, type MessageFrame } from "@pushhub/shared";
```

`PROTOCOL_VERSION`(L18) / `INITIAL_FETCH=50`(L41) / `SYNC_LIMIT_DEFAULT=200`(L44) / `SYNC_LIMIT_MAX=500`(L47) / `RETENTION_KEEP=500`(L38) 全部 import，禁复制。esbuild 已实证可解析 workspace `.ts` main（RESEARCH）。

### 判别联合结果类型（ok/code/message）

**Source:** `packages/shared/src/validators.ts:33-49`
**Apply to:** `frames.ts` guard、状态机输出动作流、dedup

所有校验/解析函数返回 `{ ok: true, ... } | { ok: false, code, message }` 判别联合——本仓库统一错误传递风格（`errorEnvelope` 也是同构信封，`chat-room.ts:104-109`）。

### 文件头职责注释 + 决策编号引用

**Source:** 全部 Phase 1 文件（如 `chat-room.ts:1-19`、`validators.ts:1-13`、`smoke.mjs:1-24`）
**Apply to:** web-sdk 全部新文件

每个文件头注释声明：职责边界、对应决策编号（D-16~D-27）、关键 Pitfall 提示。这是本仓库最强的文档惯例。

### 密钥不进日志/错误

**Source:** `packages/server/src/index.ts:14-15` 注释（"结构化日志不打印完整 URL query 与任何密钥——密钥即身份"）
**Apply to:** SDK error 事件载荷、demo 页 console——Channel Key 不得出现在任何 SDK 错误消息里（RESEARCH Security Domain）。

### 一场景一测试文件 + vitest 独立 config

**Source:** `packages/server/test/`（13 文件）+ `packages/server/vitest.config.ts`（每包一套 config，池隔离）
**Apply to:** web-sdk test 组织；但 **不复制** `--max-workers=1 --no-isolate` 与 cloudflareTest 池（那是 server DO/WS 隔离需求；SDK 用默认隔离 + docblock 切 jsdom）。

## No Analog Found

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| `packages/web-sdk/playwright.config.ts` | config | request-response | 仓库无 Playwright；照抄 RESEARCH Pattern 4 实证模板（webServer 拉起 wrangler dev `--port 4911 --ip 127.0.0.1 --var ADMIN_KEY:...`，baseURL 用 127.0.0.1 禁 localhost） |
| `packages/web-sdk/src/entry-iife.cts` | 打包入口 | — | 新形态；照抄 RESEARCH Pattern 1 实证两行模板（`import { PushHub } from "./pushhub"; module.exports = PushHub;`，`.cts` 扩展名是硬约束） |

（`connection-machine.ts` 无同类先例但属"纯函数 + 判别联合"既有风格的延伸，RESEARCH Pattern 3 已给完整设计，不列为 gap。）

## Metadata

**Analog search scope:** `packages/shared/`、`packages/server/src/`、`packages/server/test/`、`packages/server/public/`、`scripts/`、根配置文件
**Files scanned:** ~22（含 12 个 golden fixtures 目录清单）
**Pattern extraction date:** 2026-08-26
