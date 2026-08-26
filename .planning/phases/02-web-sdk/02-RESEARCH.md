# Phase 2: Web SDK 参考客户端 - Research

**Researched:** 2026-08-26
**Domain:** 浏览器端 WebSocket 客户端 SDK（TypeScript + esbuild IIFE 单文件 + marked/DOMPurify 渲染消毒 + vitest/jsdom 单测 + Playwright E2E 连 wrangler dev）
**Confidence:** HIGH（核心机制全部经本机实证：esbuild IIFE 行为、DOMPurify 消毒管道、bundle 体积、wrangler dev CLI 旗标）

## Summary

本阶段交付单文件 `pushhub.js`（IIFE，全局 `PushHub`）与轻量查看器 demo 页。技术选型在 STACK.md 已定（esbuild 0.28.2 / marked 18.0.11 / DOMPurify 3.4.14），本研究把选型落到**可直接照抄的实现级事实**：(1) esbuild `--global-name` 与 ESM `export default` 组合会产生 `{default: X}` 全局对象导致 `new PushHub()` 失败，且 `"type": "module"` 包内 `.ts` 文件写 `module.exports` 会运行时抛 `module is not defined`——正确写法是 **`.cts` 入口文件 + `module.exports = PushHub`**（本机 esbuild 0.28.1 实证，含 workspace `.ts` 源码包解析）；(2) 渲染管道实测：marked 18.0.11 `parse()` 同步返回 string，DOMPurify 3.4.14 `afterSanitizeAttributes` hook 强制 `target=_blank + rel=noopener noreferrer` 生效，真实 bundle 体积 **72,841 bytes min / 24,426 bytes gzip**（与预算表吻合）；(3) **本研究最重要发现：happy-dom 20.11.6 下 DOMPurify 消毒双向失真**（一种配置下 `<script>` 幸存、`onclick`/`javascript:` URL 幸存；另一种配置下误删合法 `a`/`img` 元素）——**消毒回归测试必须跑在 jsdom 或真浏览器**，jsdom 29.x 下同样攻击样本全部正确消毒。这推翻了 D-25 字面上的 "happy-dom" 选名（该决策标记为 reversible），建议以 jsdom 承载 DOM 单测。

服务端集成点全部读源确认：WS 入口 `wss://<server>/api/ws/<channelKey>`（路径段密钥）；**每次 accept 无条件推送首拉 history（since:null，最近 50 条）**——重连后 SDK 必然收到与断线前交叠的消息，seq 去重（D-17）正是消化这个交叠；补拉需 SDK 主动发 `sync since=last_seq`（首拉只覆盖最近 50 条，更大缺口靠 sync 翻页）；心跳 ping 帧必须**逐字节**等于 `{"v":1,"type":"ping"}`（服务端 auto-response 按字节匹配，v 在前 type 在后）。测试编排：SDK 单测独立于 server 的 vitest-pool-workers（每包一套 vitest config，互不干扰）；Playwright E2E 经 `webServer` 拉起本地 `wrangler dev`（真 DO/真 KV/真 WS），用 admin API 建临时频道，`context.setOffline` 模拟断连验证重连续补拉。

**Primary recommendation:** `packages/web-sdk` 采用四层内聚（protocol 复用 @pushhub/shared → core 纯状态机 → render 可移植纯 TS 模块 → iife .cts 入口），单测环境 node（core）+ jsdom（render），消毒回归 fixtures 化；Playwright E2E 测**构建产物** pushhub.js 而非源码；构建产物不进 git，root `deploy` 脚本链式先 build 再 deploy。

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

- **D-16:** 事件枚举四事件：`on("message")`（实时帧逐条）、`on("history")`（补拉批次——首拉与增量统一，含 `oldest_kept_seq`/`has_more`，宿主可感知"更早消息已清理"分隔线时机）、`on("status")`（连接状态变化）、`on("error")`（错误）。SDK 不展开 history 批次进 message 事件——语义与冻结协议帧一一对应，无 SDK 私有加工 — **Reversibility:** one-way
- **D-17:** seq 幂等去重归 SDK：内部维护 last_seq + 已见 seq 窗口，实时帧与补拉帧交叠时自动去重，宿主回调永不见重复消息——服务端承诺零丢失零重复（SC2），SDK 是第二道防线（防部署断连窗口的边界交叠） — **Reversibility:** costly
- **D-18:** 连接生命周期三方法：`new PushHub(serverUrl, channelKey)` 构造即自动连接（SC1 两行接入体验）；`disconnect()` 主动断开并停止重连（可再 connect 恢复）；`destroy()` = disconnect + 移除全部监听 + 释放资源（SPA 卸载内存安全） — **Reversibility:** one-way
- **D-19:** 渲染辅助为纯函数：`PushHub.renderMarkdown(text) → string`（安全 HTML），宿主自己拼 DOM；SDK 不含消息列表 UI、不拥有 DOM 结构 — **Reversibility:** costly
- **D-20:** 渲染核心（marked 配置 + DOMPurify 消毒管道）写成可移植纯 TS 模块：pushhub.js 打包它，Phase 5 Tauri 前端直接 import 同一模块——模块禁止 window/document 之外的环境假设（DOMPurify 原生支持多环境）。这是"四端消毒逻辑不漂移、XSS 防线一致"的组织保障 — **Reversibility:** costly
- **D-21:** 消毒后链接统一强制 `target=_blank + rel=noopener noreferrer`（DOMPurify hook 实现）——Webhook 消息链接不可信，防反向 tabnabbing；click_url 跳转同理 — **Reversibility:** reversible
- **D-22:** demo 页为轻量消息查看器：接入表单（服务端地址 + Channel Key）+ 消息流列表（Markdown 渲染 + 时间戳）+ 连接状态指示 + 攻击样本按钮（验 SC3 消毒，含 `<script>`/`<img onerror>` 样本）。不构造消息、不回复 — **Reversibility:** reversible
- **D-23:** 查看器即 SC1 验证：它本身用 `<script src="/pushhub.js">` + `new PushHub()` 零构建接入——其存在即 SC1 证明，不另建 blank.html — **Reversibility:** reversible
- **D-24:** 查看器含排障细节：接入配置存 localStorage（下次免填）；部署断连后自动重连续补拉是 SC2 观察点；"更早消息已清理"分隔线渲染（D-10 oldest_kept_seq 语义可视化） — **Reversibility:** reversible
- **D-25:** SDK 测试两层：happy-dom 单测（重连状态机、seq 去重、渲染消毒纯逻辑，mock WebSocket）+ Playwright 真浏览器 E2E（真服务端连真频道收真消息、断线重连补拉、攻击样本渲染验证）。不加 SDK 级 vitest-pool-workers 集成层 — **Reversibility:** reversible — 测试栈组织可调（本研究据实证建议 happy-dom → jsdom，见 Pitfall 3）
- **D-26:** Playwright E2E 服务端用本地 `wrangler dev`（真 DO/真 KV/真 WS，localhost）——快、可重复、无网络依赖、不耗生产额度；生产域名验证沿用 Phase 1 D-14/D-15 部署后冒烟节奏，不在自动化测试里连生产 — **Reversibility:** reversible
- **D-27:** iOS Safari 不做专项测试，但 `visibilitychange` 探活逻辑写进 SDK（页面回前台主动探活，死线即重连续补拉）；iOS 真机验证不追踪不记 WINDOWS.md，风险后置 — **Reversibility:** reversible

### Claude's Discretion

- status 事件的枚举具体值（connecting/online/offline/reconnecting 之类）与 error 事件载荷结构——规划阶段随 API 细化定
- marked 配置细节（语法子集、sanitize 钩子顺序）与渲染模块文件组织
- 重连退避参数（base/cap/jitter 具体数值——上限 60s 已锁）、心跳周期与死线判定阈值
- packages/web-sdk 包的内部目录结构与 npm scripts 组织
- 攻击样本 fixture 的具体内容集（覆盖 `<script>`/`<img onerror>`/`javascript:` 等，够回归即可）
- 查看器页面布局风格

### Deferred Ideas (OUT OF SCOPE)

None — discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| WEB-01 | pushhub.js 单文件分发（零依赖零构建），`<script>` 引入后 `new PushHub(serverUrl, channelKey)` 即可使用 | esbuild `.cts` 入口 IIFE 打包模式（实证）；`.gitignore` 产物 + 链式 build/deploy 流水线；demo 页即活证（D-23） |
| WEB-02 | SDK 实时接收频道消息并通过回调/事件暴露给宿主页面 | 四事件 API 表面（D-16）+ 帧解析 guard（v 校验 + type 枚举）+ ServerFrame 类型复用 @pushhub/shared |
| WEB-04 | SDK 内置断线重连（指数退避+jitter）与离线补拉，宿主无感 | 纯状态机设计（full jitter 公式 + cap 60s）+ seq 去重窗口 + sync since 翻页循环 + visibilitychange 探活；服务端"accept 即推首拉"行为的消化策略 |
| WEB-05 | SDK 提供消息渲染辅助（Markdown 渲染 + DOMPurify 消毒），也可仅暴露原始数据由宿主自行渲染 | `renderMarkdown` 静态方法（D-19）+ D-21 hook（实证代码与预期输出表）+ 攻击样本 fixtures + **jsdom 而非 happy-dom 承载消毒断言（实证）** |
</phase_requirements>

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| WS 连接/重连/心跳/补拉/去重 | Browser / Client（SDK） | — | 连接生命周期归浏览器页面进程；服务端只做扇出与游标补拉（Phase 1 已定） |
| Markdown 渲染 + 消毒 | Browser / Client（SDK render 模块） | — | 服务端是哑管道（SRV-02 Prohibitions）；消毒必须在最终渲染端（存储型 XSS 防线） |
| 帧协议类型与常量 | 共享包 @pushhub/shared | — | 唯一事实源已冻结；SDK import 复用，禁止重复定义（CONTEXT Reusable Assets） |
| 密钥鉴权/历史存储/扇出 | API / Backend（Worker + DO，Phase 1 已交付） | — | 本阶段零服务端改动（除静态资产文件落位） |
| pushhub.js 与 demo 页分发 | CDN / Static（Worker assets） | — | `/pushhub.js` 直接命中资产不触发 Worker（SC4）；`packages/server/public/` 是挂载点 |
| E2E 测试编排 | Browser / Client（Playwright） | API / Backend（wrangler dev 本地起真 Worker） | D-26：localhost 真 DO/真 KV/真 WS |

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| esbuild | 0.28.2（registry 实查；0.28.1 已在 lockfile 为 vitest 传递依赖） | 单文件 IIFE 打包 | 一条命令出零依赖产物；本机实证 `.cts` 入口模式可行 [WARNING: flagged as suspicious — verify before using.] |
| marked | 18.0.11（registry 实查，CLAUDE.md §Web SDK 锁定） | Markdown → HTML（string→string 纯变换） | 实证 `parse()` 同步返回 string；gfm/breaks 可配 [WARNING: flagged as suspicious — verify before using.] |
| dompurify | 3.4.14（registry 实查，CLAUDE.md §Web SDK 锁定） | HTML 消毒（XSS 防线核心） | 实证 hook 生效、攻击样本全消；多环境工厂形式支持 D-20 可移植 [WARNING: flagged as suspicious — verify before using.] |
| @playwright/test | 1.62.1（registry 实查） | 真浏览器 E2E | `webServer` 编排 wrangler dev；无 postinstall（浏览器二进制显式安装） [WARNING: flagged as suspicious — verify before using.] |
| vitest | 4.1.11（已在仓库） | SDK 单测框架 | 与 server 同框架不同 config，workspace 内天然隔离 |
| jsdom | 30.0.1（registry 实查；spike 实测 29.1.1 行为一致） | render 层单测 DOM 宿主 | **happy-dom 实证不可靠（见 Pitfall 3）**；jsdom 是 DOMPurify 官方 CI 环境且本机实证消毒全对 [WARNING: flagged as suspicious — verify before using.] |
| @pushhub/shared | workspace:* | 帧类型 + 常量 + golden fixtures | 协议唯一事实源（冻结），SDK 直接 import TS 源码（实证 esbuild 可解析 .ts main） |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| happy-dom | 20.11.6 | （候补）demo 页 DOM 测试 | **不用于消毒断言**；若 demo 页需要 DOM 单测可用，但建议统一 jsdom 减一个依赖 [WARNING: flagged as suspicious — verify before using.] |
| typescript | 7.0.2（已在仓库） | 类型检查 | web-sdk 包继承 tsconfig.base.json |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| jsdom（render 单测） | happy-dom | happy-dom 更轻更快，但 DOMPurify 行为失真（实证）——安全断言不可委托；不建议 |
| jsdom（render 单测） | 仅 Playwright 真浏览器 | 保真最高但慢（需起 wrangler dev + 浏览器），快速回归层缺失；两层分工更优 |
| marked | markdown-it 15 / snarkdown 2 | CLAUDE.md Do-NOT-use 清单已排除（体积/停更） |
| 手写重连（~50 行） | reconnecting-websocket 等库 | CLAUDE.md 明令手写：seq 补拉/退避上限/visibility 联动必须自控 |

**Installation:**

```bash
pnpm --filter @pushhub/web-sdk add marked dompurify
pnpm --filter @pushhub/web-sdk add -D esbuild jsdom vitest typescript @playwright/test
pnpm --filter @pushhub/web-sdk exec playwright install chromium
```

**Version verification:**（2026-08-26 本机 `npm view` 实查）marked `18.0.11` / dompurify `3.4.14` / happy-dom `20.11.6` / @playwright/test `1.62.1` / esbuild `0.28.2` / jsdom `30.0.1` / vitest `4.1.11`。与 CLAUDE.md §Web SDK 锁定版本一致（esbuild 0.28.1→0.28.2 为 patch 前进）。

## Package Legitimacy Audit

> Package Legitimacy Gate 已执行（2026-08-26，`gsd-tools query package-legitimacy check`）。

| Package | Registry | Age（最近发布） | Downloads | Source Repo | Verdict | Disposition |
|---------|----------|-----|-----------|-------------|---------|-------------|
| marked | npm | 2026-08-24 | 69,881,392/wk | github.com/markedjs/marked | SUS（too-new） | Flagged — planner 须在安装前加 checkpoint:human-verify |
| dompurify | npm | 2026-08-19 | 62,293,819/wk | github.com/cure53/DOMPurify | SUS（too-new） | Flagged — 同上 |
| happy-dom | npm | 2026-08-19 | 15,201,508/wk | github.com/capricorn86/happy-dom | SUS（too-new） | Flagged — 同上（且本研究建议不用） |
| @playwright/test | npm | 2026-07-30 | 56,970,888/wk | github.com/microsoft/playwright | SUS（too-new） | Flagged — 同上 |
| esbuild | npm | 2026-08-08 | 271,867,617/wk | github.com/evanw/esbuild | SUS（too-new） | Flagged — 同上 |
| jsdom | npm | 2026-07-29 | 97,132,568/wk | github.com/jsdom/jsdom | SUS（too-new） | Flagged — 同上 |

**Packages removed due to [SLOP] verdict:** none

**Packages flagged as suspicious [SUS]:** 全部 6 个——均为 "too-new"（最近 30 天内有发布）。**判读**：这是高频发布主流包的典型假阳性模式（周下载量 1500 万～2.7 亿、官方 canonical repo、无废弃、无恶意 postinstall）；"新"的是 patch 版本而非包本身。其中 marked/dompurify/esbuild 是 CLAUDE.md 技术栈约束锁定的既有选择。按协议，planner 仍须在每个安装步骤前放 `checkpoint:human-verify`。

**postinstall 审计**：`@playwright/test` 与 `playwright` 的 scripts 为空 `{}`（registry 实查）——浏览器二进制仅经显式 `npx playwright install` 下载。`esbuild` 的 postinstall 为 `node install.js`（平台二进制落位的标准脚本；esbuild 已在 root `package.json` 的 `onlyBuiltDependencies` 白名单内 [VERIFIED: package.json:10-15]，白名单原文：`"onlyBuiltDependencies": ["esbuild", "workerd"]`）。marked/dompurify/jsdom/happy-dom 无 postinstall。

## Architecture Patterns

### System Architecture Diagram

```
宿主页面 / demo 查看器（packages/server/public/）
  │  <script src="/pushhub.js">        ← Worker 静态资产直接命中（不触发 Worker，SC4）
  │  new PushHub(serverUrl, channelKey)
  ▼
┌─ pushhub.js（IIFE 全局 PushHub）─────────────────────────────┐
│  entry-iife.cts（module.exports = PushHub）                   │
│   ├─ protocol：帧解析 guard（v===1 / type 枚举 / 结构）        │
│   │    └─ import @pushhub/shared（类型 + PROTOCOL_VERSION）    │
│   ├─ core：连接状态机（纯逻辑，无 DOM）                        │
│   │    输入: ws_open/ws_close/frame/visibility/timer           │
│   │    输出: create_socket/send{ping,sync}/emit{4 事件}/backoff │
│   │    └─ seq 去重（last_seq + seen 窗口）                     │
│   ├─ render：renderMarkdown（可移植纯 TS，D-20）               │
│   │    marked.parse → DOMPurify.sanitize + D-21 hook           │
│   └─ adapter：真 WebSocket 接线 + visibilitychange 监听        │
└──────────────────────────────────────────────────────────────┘
  │ wss://<server>/api/ws/<channelKey>（路径段密钥）
  │ 出站: {"v":1,"type":"ping"}（逐字节匹配服务端 auto-response）
  │       {"v":1,"type":"sync","since":n,"limit":m}
  ▼
Cloudflare Worker（Phase 1，零改动）
  ├─ GET /api/ws/:key → KV 预检 → ChatRoom DO
  │    accept → 立即推首拉 history（最近 50，since:null）
  │    ping → auto-response 零唤醒回 pong
  │    sync → keyset 补拉（has_more 翻页，oldest_kept_seq）
  └─ 静态资产 /pushhub.js、/（demo 页）

测试编排：
  vitest(node)  → core/protocol 纯逻辑（mock WebSocket 注入）
  vitest(jsdom) → render 消毒（攻击样本 fixtures 断言）
  Playwright    → webServer 拉起 wrangler dev → 真 DOM + 真 DO
                  → admin API 建临时频道 → setOffline 断连混沌
```

### Recommended Project Structure

```
packages/web-sdk/
├── package.json          # @pushhub/web-sdk；type:module；scripts: build/test/typecheck/e2e
├── tsconfig.json         # 继承 base；include src + test
├── src/
│   ├── pushhub.ts        # PushHub 类（公开 API：4 事件 + 3 生命周期方法 + 静态 renderMarkdown）
│   ├── connection-machine.ts  # 纯状态机（无 DOM 无 WebSocket——输入事件流输出动作流）
│   ├── dedup.ts          # seq 去重窗口（last_seq + Set）
│   ├── frames.ts         # ServerFrame 接收侧 guard（v/type/结构；未知字段忽略 D-07）
│   ├── render/
│   │   └── render-markdown.ts  # D-20 可移植纯 TS 模块（marked 配置 + DOMPurify + hook）
│   └── entry-iife.cts    # IIFE 打包入口：import PushHub; module.exports = PushHub
├── test/
│   ├── machine-*.test.ts     # 状态机（node 环境；fake timers）
│   ├── dedup.test.ts         # 去重窗口
│   ├── frames.test.ts        # 帧解析契约（吃 shared/fixtures golden 样本）
│   ├── render.test.ts        # @vitest-environment jsdom；攻击样本 fixtures 断言
│   └── fixtures/attack-samples.json   # 攻击样本 + 预期输出
├── playwright.config.ts   # webServer=wrangler dev；tests 在 e2e/ 下
├── e2e/
│   ├── viewer.spec.ts     # SC1/SC3：demo 页接入、攻击样本渲染
│   └── reconnect.spec.ts  # SC2：setOffline → 重连 → 补拉
└── build.mjs              # esbuild 打包 + 复制到 packages/server/public/ + 体积报表

packages/server/public/    # 现有 index.html（占位）→ 替换为 demo 查看器；pushhub.js 构建时落位
```

### Pattern 1: esbuild IIFE 单文件打包（实证）

**What:** `.cts` 入口 + `module.exports = PushHub` → 全局 `PushHub` 即类本身。
**When to use:** 唯一的浏览器分发构建。

```javascript
// src/entry-iife.cts（完整内容就这两行）
import { PushHub } from "./pushhub";
module.exports = PushHub;
```

```bash
esbuild src/entry-iife.cts --bundle --minify --format=iife \
  --global-name=PushHub --outfile=dist/pushhub.js
```

实证结论（esbuild 0.28.1，本机，2026-08-26）：

| 入口写法 | 全局 PushHub 实际形态 | `new PushHub()` |
|---|---|---|
| ESM `export default PushHub` | `{ default: class }` | **失败**（not a constructor） |
| ESM 具名 `export { PushHub }` | `{ PushHub: class }` | **失败** |
| `.ts` 内 `module.exports = PushHub`（type:module 包内） | 构建通过但运行时抛 **`module is not defined`** | **失败** |
| **`.cts` 内 `module.exports = PushHub`** | **class 本身**（含静态方法） | **成功** |

[VERIFIED: 本机实证 esbuild 0.28.1；与 esbuild issues #869/#3740 一致]

**Why `.cts`：** esbuild 按 `"type": "module"` 把 `.ts` 判为 ESM，`module` 被当全局变量（构建期 WARNING + 运行期 ReferenceError）；`.cts` 显式声明 CommonJS。注意：混合写法（`.ts` 里 import + module.exports）同样中招——**入口必须 `.cts`**。

**体积实测**（marked 18.0.11 + dompurify 3.4.14 + 胶水，min IIFE）：**72,841 bytes min / 24,426 bytes gzip** [VERIFIED: 本机实证]。加 SDK 连接逻辑（预算 6-10KB）预估 ~80KB min / ~27KB gzip——预算表成立。测量命令：

```bash
node -e "const z=require('zlib'),f=require('fs');const b=f.readFileSync('dist/pushhub.js');console.log('min:',b.length,'gzip:',z.gzipSync(b).length)"
```

### Pattern 2: D-20 可移植渲染模块 + D-21 hook（实证）

```typescript
// src/render/render-markdown.ts —— 禁止 window/document 之外的环境假设（D-20）
import { marked } from "marked";
import createDOMPurify from "dompurify";   // 默认导出即工厂：createDOMPurify(window)

marked.use({ gfm: true, breaks: true });    // 聊天语义：GFM 表格/任务列表 + 单换行成 <br>

let purify: ReturnType<typeof createDOMPurify> | null = null;

export function renderMarkdown(text: string): string {
  if (purify === null) {
    purify = createDOMPurify(globalThis.window ?? globalThis);
    // D-21：消毒后链接统一强制新窗口 + 防反向 tabnabbing
    purify.addHook("afterSanitizeAttributes", (node) => {
      if (node.tagName === "A") {
        node.setAttribute("target", "_blank");
        node.setAttribute("rel", "noopener noreferrer");
      }
    });
  }
  return purify.sanitize(marked.parse(text));
}
```

[VERIFIED: 本机实证（jsdom 29.1.1 + dompurify 3.4.14 + marked 18.0.11，2026-08-26）——hook 模式另见 cure53/DOMPurify issue #317 官方回复]

**实证预期输出表（攻击样本回归的断言基线）：**

| 输入（Markdown 混 raw HTML） | 消毒后输出 |
|---|---|
| `<script>alert(1)</script>after` | `after` |
| `<img src=x onerror=alert(1)>` | `<img src="x">` |
| `[click](javascript:alert(1))` | `<p><a target="_blank" rel="noopener noreferrer">click</a></p>`（href 被剥） |
| `[click](data:text/html;base64,...)` | 同上（href 被剥） |
| `<a href="https://ok.example" onclick="alert(1)">safe</a>` | `<p><a href="https://ok.example" target="_blank" rel="noopener noreferrer">safe</a></p>` |
| `<svg onload=alert(1)>` | `<svg></svg>` |
| `<iframe src="https://evil.example"></iframe>` | ``（空） |
| `normal **md** [link](https://example.com)` | `<p>normal <strong>md</strong> <a href="https://example.com" target="_blank" rel="noopener noreferrer">link</a></p>` |

**关键环境结论：上表在 jsdom 下逐条成立；在 happy-dom 下不成立**（详见 Pitfall 3）——此表应固化为 `test/fixtures/attack-samples.json` 的期望值。`renderMarkdown` 以类静态方法暴露（`PushHub.renderMarkdown`，D-19）。

### Pattern 3: 重连状态机（纯逻辑，可脱离 DOM 全覆盖）

**What:** 连接生命周期 = 纯函数状态机：输入事件流 → 输出动作流；WebSocket/定时器/DOM 全部在 adapter 层注入。与 CLAUDE.md §Testing Desktop 的"重连状态机写成纯逻辑"同构（Phase 5 Tauri 移植同一思路）。

```
输入事件:  CONNECT | DISCONNECT | DESTROY | WS_OPEN | WS_CLOSE(code) | FRAME(type,payload)
          | VISIBILITY(visible|hidden) | TIMER(kind) | PONG_RECEIVED
输出动作:  createSocket(url) | closeSocket() | sendPing() | sendSync(since)
          | schedule(kind, delayMs) | cancel(kind) | emitStatus(s) | emitError(e)
状态:      idle → connecting → online ⇄ reconnecting（退避中）→ offline（主动）
```

**Full jitter 退避（cap 60s 已锁，其余为建议值——Claude's Discretion）：**

```typescript
const BACKOFF_BASE_MS = 500;     // 建议值
const BACKOFF_CAP_MS = 60_000;   // D-SC2 锁定
// full jitter（AWS Exponential Backoff and Jitter 标准形）：
function backoffDelay(attempt: number): number {
  return Math.random() * Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt);
}
```

**心跳（ping 必须逐字节等于服务端 auto-response 匹配串）：**

服务端字面量 [VERIFIED: packages/server/src/chat-room.ts:44-45，原文 `const PING_FRAME = '{"v":1,"type":"ping"}';` 与 `const PONG_FRAME = '{"v":1,"type":"pong"}';`]——`v` 在前 `type` 在后。**SDK 侧用字符串常量直发，不用 `JSON.stringify({type:"ping",v:1})`**（对象字面量键序反转即失配，ping 会落到 DO 唤醒路径）。建议参数（Discretion）：每 30s 一 ping；pong 死线 10s；`visibilitychange → visible` 时立即补一发 ping 探活（死线 5s），超时判死线 → 强制重连 + sync 补拉（D-27，iOS 冻结恢复路径）。

**seq 去重窗口（D-17）：**

```typescript
// 规则：见过即丢（seen Set）；last_seq = max(seen)；窗口按 RETENTION_KEEP 对齐裁剪
// 服务端保留窗口 500（RETENTION_KEEP）+ 首拉 50，交叠上界 ~550，窗口取 1000 冗余
private seen = new Set<number>();
private lastSeq = 0;
shouldDeliver(seq: number): boolean {
  if (this.seen.has(seq)) return false;
  this.seen.add(seq);
  this.lastSeq = Math.max(this.lastSeq, seq);
  for (const s of this.seen) if (s < this.lastSeq - 1000) this.seen.delete(s);
  return true;
}
```

**重连续补拉的确定序列（消化"accept 即推首拉"交叠）：**

1. `WS_OPEN` → 服务端无条件推首拉 history（最近 50，[VERIFIED: packages/server/src/chat-room.ts:377 原文 `this.sendHistory(server, null, undefined);`]）→ history 事件照发（D-16），messages 数组经 `shouldDeliver` 过滤后再交给宿主（D-17 宿主永见重复——两决策的交集语义，见 Open Questions #2）；
2. 首拉处理完 → **无条件发** `{"v":1,"type":"sync","since":lastSeq}`（首拉只覆盖最近 50；缺口更大时靠 sync；若已连续 sync 返回空数组，代价仅 1 条入站消息）；
3. 收到 history 且 `has_more === true` → 以本批最大 seq 为新 since 续翻；`has_more === false` → 追平；循环上限（如 100 次）防服务端异常时死循环。

**v 校验（D-07 客户端侧职责）：** 帧顶层 `v !== 1` → emit error（fatal）+ 断连 + **不重连**（服务端比客户端新，重连无意义）。对照：服务端收到坏帧只回 WsErrorFrame 不断连（[VERIFIED: packages/shared/src/validators.ts:218-220 注释原文"服务端收到 v 不匹配的业务帧时回 WsErrorFrame 并忽略该帧、不断连——'不识别的 v 即断连'是客户端侧职责（D-07 原文）"]）。

### Pattern 4: Playwright E2E 编排（webServer 拉 wrangler dev）

```typescript
// playwright.config.ts（packages/web-sdk/）
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  use: { baseURL: "http://127.0.0.1:4911" },   // 用 127.0.0.1 不用 localhost（IPv4/IPv6 解析不一致坑）
  webServer: {
    command: "pnpm --filter @pushhub/server exec wrangler dev --port 4911 --ip 127.0.0.1 --var ADMIN_KEY:e2e-admin-key",
    url: "http://127.0.0.1:4911/",             // 轮询资产 index.html 直到 2xx 即就绪
    reuseExistingServer: true,                  // 本地复用已开的 dev；CI 置 false
    stdout: "ignore",
    timeout: 60_000,
  },
});
```

[VERIFIED: wrangler 4.126.0 本机 `--help` 实查 `--var`/`--port`/`--ip`/`--inspector-port` 旗标存在；Playwright webServer 选项见官方 docs/test-webserver [CITED: playwright.dev/docs/test-webserver]]

**E2E 流程骨架：**

```
setup: POST /api/admin/channels（Bearer e2e-admin-key）→ 拿 channelKey/sendKey（频道名时间戳唯一，可重复跑）
SC1:   goto /（demo 页）→ 填表单/URL 参数注入 key → 状态指示 online → 发消息 → 列表实时出现
SC3:   点攻击样本按钮 → 断言渲染 DOM 无 <script>、无 onerror 属性、a 带 rel=noopener
SC2:   context.setOffline(true) → 状态变 reconnecting → API 再发 2 条（Node 侧 fetch 不受浏览器离线影响）
       → setOffline(false) → 状态回 online → 2 条消息补拉出现且零重复
```

注意事项：(a) `--var ADMIN_KEY:...` 只存在于本地 dev 进程，不触生产 secret；(b) 本地 KV 状态写在 `packages/server/.wrangler/`（已存在该目录），累积的临时频道无害；(c) `setOffline` 对已建立 WS 的实际行为需 Wave 0 实证（Chromium 通常关闭长连——若不关，备选：demo 页留 `window.__pushhub` 调试句柄直接 `disconnect()` 底层 socket 模拟意外断开，或经 CDP Network.emulateNetworkConditions）；(d) E2E 页面引用 `/pushhub.js`——**测试前必须先 build**（playwright 的 `globalSetup` 或 webServer command 前置 `pnpm --filter @pushhub/web-sdk run build &&`）。

### Pattern 5: 构建产物流水线（build → server/public，产物不进 git）

**建议（推荐 A）：**

- `build.mjs`：esbuild 打包 → 写 `packages/web-sdk/dist/pushhub.js` → 复制到 `packages/server/public/pushhub.js` → 打印 min/gzip 体积；
- `.gitignore` 增加这两个产物路径；
- root `package.json` 的 `deploy` 脚本改为 `"deploy": "pnpm --filter @pushhub/web-sdk run build && pnpm --filter @pushhub/server run deploy"`——**`pnpm run deploy` 命令契约不变**（DEPLOY.md 的版本 +1 流程不受影响），只是内部先构建；
- 文档注明：跑 `wrangler dev` 看静态资产前先 build（可加 root `dev` 便捷脚本串联）。

**方案 B（产物进 git）权衡：** 任意 checkout 可直接 deploy、不依赖构建链；代价是"忘了重新 build 就 deploy 了旧 SDK"这一整类 stale-产物 bug，且 diff 噪声大。Phase 1 的部署纪律（每计划部署 +1 版本、D-14/D-15 checklist）已经要求构建链在场——**推荐 A（链式构建）**。

**SC4（资产命中不计 Worker 请求）验证归生产冒烟：** 本地 wrangler dev 无法观察计费。部署后：`curl https://pushhub.dyun.org/pushhub.js` 多次 + dashboard 请求计数不增（或 `wrangler tail` 无对应 invocation）。写进 D-15 checklist 扩展项（人工，~1 分钟）。

### Anti-Patterns to Avoid

- **ESM 默认导出直接做 IIFE 全局**：全局变 `{default:X}`，SC1 两行接入直接崩（见 Pattern 1 实证表）。
- **`JSON.stringify({type:"ping", v:1})` 构造心跳**：键序≠服务端匹配串字面量，ping 降级为唤醒 DO 的普通入站消息（烧额度）；必须字符串常量。
- **重连后只吃首拉 history 不发 sync**：缺口 >50 条时静默丢消息（首拉只给最近 50）。
- **在 happy-dom 里断言 DOMPurify 消毒结果**：双向失真（Pitfall 3），安全回归形同虚设。
- **SDK import happy-dom/任何 Node-only 包**：esbuild 直接打不进浏览器 bundle（Node 内置模块 unresolvable，本机实证）。
- **重连库/backoff 库**：CLAUDE.md Do-NOT-use——seq 补拉/退避上限/visibility 联动必须自控。
- **SDK 里塞消息列表 UI**：D-19 定位边界——SDK 不拥有 DOM 结构。

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Markdown 解析 | 正则/手写 tokenizer | marked 18.0.11 | 语法覆盖（表格/任务列表/删除线）与 CommonMark 边界 20 年积累；手写必漏 |
| HTML 消毒 | 正则 strip 标签/属性 | dompurify 3.4.14 | XSS 对抗是军备竞赛（mutation XSS、命名空间混淆、URI scheme 绕过）；正则消毒是被公开打穿的经典错误 |
| WS 重连 | — | **手写**（约 50-100 行，本阶段核心交付物） | 例外：这是业务核心而非通用问题，CLAUDE.md 明令自控 |
| 帧结构校验框架 | 引 zod 等 schema 库 | 手写 TS guard + @pushhub/shared 类型 | CLAUDE.md：消息体字段少不值得引库；Phase 1 validators.ts 同路线 |
| 协议类型/常量 | 复制定义 | import @pushhub/shared | 唯一事实源冻结（01-02 one-way 门）；复制即漂移 |

**Key insight:** 本阶段"don't hand-roll"的唯一例外恰恰是最核心的重连状态机——它是三端移植的参考实现，必须自控；其余（解析/消毒）全部用标准库。

## Common Pitfalls

### Pitfall 1: esbuild 全局暴露形态错误（SC1 直接失败）
**What goes wrong:** `export default PushHub` + `--global-name=PushHub` → 宿主 `new PushHub()` 抛 "not a constructor"。
**Why it happens:** esbuild IIFE 全局 = 入口模块 exports 命名空间；default 是其中一个属性（issues #869/#3740 未按"直接赋值"实现）。
**How to avoid:** `.cts` 入口 `module.exports = PushHub`（Pattern 1，实证）。
**Warning signs:** build 产物尾部 `var PushHub=(()=>{...return{name:...}})()`；或 happy path 联调时 `typeof PushHub === "object"`。

### Pitfall 2: type:module 包内 CJS 入口的运行时炸弹
**What goes wrong:** `.ts` 入口写 `module.exports` 构建仅 WARNING、**运行时** ReferenceError: module is not defined。
**Why it happens:** esbuild 按 nearest package.json `"type": "module"` 判 ESM。
**How to avoid:** 入口扩展名 `.cts`。**Warning signs:** 构建输出里的 `commonjs-variable-in-esm` WARNING——把它当 error 对待。

### Pitfall 3: happy-dom 下 DOMPurify 行为失真（本研究最重要发现）
**What goes wrong:** happy-dom 20.11.6 + dompurify 3.4.14：一种配置下 `<script>` 元素幸存、`onclick`/`javascript:` href 幸存（假阴性——安全回归被欺骗）；另一种配置下合法 `a`/`img` 元素被整删、hook 属性未写入（假阳性——正常渲染被误判失败）。
**Why it happens:** happy-dom 的 DOM/parse/serialize 保真度不足 DOMPurify 的运行假设（DOMParser/属性反射/序列化路径差异）。
**How to avoid:** **消毒断言只跑 jsdom（单测）与真浏览器（Playwright）**。状态机/去重/协议解析测试无需 DOM（node 环境即可）。D-25 标记 reversible，据此建议把其中 "happy-dom" 落地为 jsdom——需 discuss/planner 确认。
**Warning signs:** 任何在 happy-dom 里 `sanitize()` 后看到 `<script>`、`on*` 属性、`javascript:` href 的输出。

### Pitfall 4: 心跳帧字节不匹配 → 零唤醒保活失效
**What goes wrong:** ping 帧键序不同（`{"type":"ping","v":1}`）→ 服务端 auto-response 不拦截 → 每次心跳唤醒 DO（计请求额度）且 pong 语义漂移。
**Why it happens:** `setWebSocketAutoResponse` 是**字节级**匹配（[VERIFIED: packages/server/src/chat-room.ts:44 匹配串原文 `'{\"v\":1,\"type\":\"ping\"}'`；构造器注释"auto-response 必须在构造器重设"）。
**How to avoid:** SDK 内 `const PING = '{"v":1,"type":"ping"}'` 字符串常量直发。
**Warning signs:** 本地 dev 控制台看到 ping 进入 webSocketMessage 处理器。

### Pitfall 5: 误把首拉 history 当"只需去重不需 sync"
**What goes wrong:** 重连后只过滤首拉 50 条就认为追平——离线超 50 条消息时中间段永久丢失。
**Why it happens:** 服务端 accept 后无条件推 `since:null` 最近 50 条（chat-room.ts:377），看起来"像是补拉"。
**How to avoid:** 重连序列固定为：吃首拉 → 发 sync since=last_seq → has_more 循环翻页（Pattern 3）。
**Warning signs:** E2E 断线测试里补拉数量恰好 ≤50。

### Pitfall 6: Playwright url 用 localhost 绕道 IPv6
**What goes wrong:** webServer 就绪轮询命中 IPv6 `::1` 而 wrangler dev 绑 127.0.0.1 → 判定未就绪/起双实例。
**How to avoid:** `baseURL`/`url` 一律 `127.0.0.1`。

### Pitfall 7: WS URL 构造不经编码
**What goes wrong:** channelKey 含保留字符 → 服务端路由 `[^/]+` 匹配失败或 decodeURIComponent 抛错 → 401。
**How to avoid:** `wsUrl = baseUrl.replace(/^http/, "ws").replace(/\/+$/, "") + "/api/ws/" + encodeURIComponent(key)`（服务端逐段 decodeURIComponent，[VERIFIED: packages/server/src/index.ts:105-113 正则 `/^\/api\/ws\/([^\/]+)$/` + try/catch decode]）。

### Pitfall 8: 双 vitest 环境混进一个 config
**What goes wrong:** server 的 cloudflareTest 池与 SDK 的 DOM 环境耦合 → workerd 里跑 DOM 代码（D-25 明令不加 SDK 级 vitest-pool-workers 层的原因）。
**How to avoid:** 每包独立 `vitest.config.ts`；web-sdk 包内用 docblock `// @vitest-environment jsdom` 只给 render 测试切环境，状态机测试保持 node 环境跑得更快。

### Pitfall 9: 部署了旧产物 / dev 看不到 SDK
**What goes wrong:** 产物进 git 且忘了重建 → 生产 pushhub.js 落后源码；或产物 gitignore 后直接 `wrangler dev` → /pushhub.js 404。
**How to avoid:** Pattern 5 链式脚本（deploy 与 dev 前置 build）；E2E 的 webServer command 同样前置 build。

### Pitfall 10: `v !== 1` 帧的处理方向搞反
**What goes wrong:** SDK 收到未来版本帧选择忽略重试 → 死循环；或选择静默吞掉 → 协议演进静默失配。
**How to avoid:** D-07 客户端侧职责 = 断连 + 报错 + 不重连（fatal error 事件 + status offline）。方向记忆：**服务端宽容（忽略坏帧不断连），客户端严格（不识别即断）**。

## Code Examples

### 帧接收侧 guard（SDK 版，未知字段忽略）

```typescript
// 源码依据: packages/shared/src/index.ts:87-156（帧类型冻结定义）
import { PROTOCOL_VERSION, type ServerFrame } from "@pushhub/shared";

export type FrameResult =
  | { ok: true; frame: ServerFrame }
  | { ok: false; fatal: boolean; message: string };

export function parseServerFrame(raw: string): FrameResult {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch {
    return { ok: false, fatal: false, message: "unparseable frame" }; // 丢弃不断连
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, fatal: false, message: "non-object frame" };
  }
  const f = parsed as Record<string, unknown>;
  if (f.v !== PROTOCOL_VERSION) {
    return { ok: false, fatal: true, message: `unsupported v: ${String(f.v)}` }; // D-07 客户端断连
  }
  switch (f.type) {
    case "message": case "history": case "pong": case "error":
      return { ok: true, frame: f as unknown as ServerFrame }; // 未知字段忽略（D-07）
    default:
      return { ok: false, fatal: false, message: `unknown type: ${String(f.type)}` };
  }
}
```

（结构精度的深校验——message 帧 13 字段类型检查——按需加在 message/history 分支内，风格对照 `validators.ts` 的手写 guard 路线；fixtures 反例做契约输入。）

### 契约测试吃 golden fixtures（复用 Phase 1 资产）

```typescript
// test/fixtures-contract.test.ts —— shared 包 exports 已映射 fixtures 目录
// [VERIFIED: packages/shared/package.json:9 原文 "./fixtures/*": "./fixtures/*"]
import positiveHistory from "@pushhub/shared/fixtures/history-frame.positive.json";
import wsError from "@pushhub/shared/fixtures/ws-error-frame.json";
// 逐条喂 parseServerFrame：正例 ok:true、_note 字段按未知字段忽略规则被丢弃
```

### 状态机单测形态（fake timers 驱动退避）

```typescript
// test/machine-backoff.test.ts（node 环境，无需 DOM）
import { describe, it, expect, vi, beforeEach } from "vitest";
beforeEach(() => vi.useFakeTimers());
it("full jitter 退避上限 60s（SC2）", () => {
  const m = createMachine();
  for (let i = 0; i < 30; i++) m.input({ kind: "WS_CLOSE", code: 1006 });
  const delays = m.outputs.filter(o => o.kind === "schedule").map(o => o.delayMs);
  expect(Math.max(...delays)).toBeLessThanOrEqual(60_000); // cap 锁定
});
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| jsdom 是唯一 Node DOM 测试宿主 | happy-dom（轻量高速）崛起 | 2023-2025 | 速度收益真实，但**保真度换速度**——DOMPurify 这类依赖 DOM 边界行为的库仍需 jsdom/真浏览器（本研究实证） |
| `export default` + globalName 直接可用（直觉写法） | esbuild 仍要求 CJS 入口做直接全局 | 长期如此（#3740 open） | `.cts` 入口是标准解 |
| DOMPurify 2.x / UMD 引入 | 3.4.x 默认导出即工厂、原生 ESM | 3.0（2023） | `import createDOMPurify from "dompurify"` 一条路通吃 browser/jsdom/Tauri（D-20 依赖此特性） |
| vitest environmentMatchGlobs | projects / per-file docblock | vitest 3→4 | 单包内按文件切环境用 `// @vitest-environment jsdom` |

**Deprecated/outdated:**
- `@cloudflare/workers-types` 手动安装（CLAUDE.md Do-NOT-use；本阶段不涉及——SDK 不碰 workerd 类型）
- snarkdown / markdown-it（CLAUDE.md Do-NOT-use 清单）

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `context.setOffline(true)` 会关闭 Chromium 已建立的 WS 连接（Playwright E2E 断连手段） | Pattern 4 / Validation | E2E 断连用例需换实现（调试句柄/CDP）——Wave 0 首个 E2E spike 即验证，有两条备选路 |
| A2 | 重连退避 base=500ms、心跳 30s、pong 死线 10s、探活死线 5s、去重窗口 1000 | Pattern 3 | 均为 Discretion 建议值，不影响契约；调参即可 |
| A3 | marked+DOMPurify 之外的 SDK 自身逻辑体积 ~6-10KB min | Standard Stack | 预算性质；构建时实测为准（体积断言可进 build.mjs 阈值报警，超 120KB min 才是真问题） |
| A4 | status 枚举建议值 `"connecting" \| "online" \| "reconnecting" \| "offline"`；error 载荷建议 `{ message: string; code?: string; fatal?: boolean }` | Pattern 3 / API 表面 | Discretion 项；一旦发布即对外契约（D-16 one-way），规划阶段定稿前值得用户过目 |
| A5 | demo 页可用 URL 参数（如 `?server=&key=`）预填表单供 E2E 注入 | Pattern 4 | 实现细节；若不做则 E2E 走表单填写路径，稍慢但可行 |
| A6 | Playwright Chromium 二进制可经现有网络下载（必要时配 PLAYWRIGHT_DOWNLOAD_HOST 镜像） | Environment | E2E 层被阻塞；单测层不受影响；fallback：用户手动装浏览器或镜像源 |

## Open Questions

1. **D-25 的单测 DOM 宿主：happy-dom → jsdom（证据充分的偏差建议）**
   - What we know：happy-dom 下 DOMPurify 双向失真（实证 9 类攻击样本中多类结果错误）；jsdom 下全对；D-25 自标 reversible（测试栈组织可调）。
   - What's unclear：用户是否在意 jsdom 的额外依赖体积/速度（jsdom 稍重）。
   - Recommendation：采纳 jsdom（或纯 Playwright 承载全部消毒断言 + node 承载其余）。planner 在 PLAN.md 显式记录该偏差；若用户坚持 happy-dom，则消毒断言全部上移 Playwright 层，happy-dom 只测状态机无关项。
2. **D-16 与 D-17 的交集语义：history 批次内的 messages 是否过滤后再发**
   - What we know：D-16 说"不展开 history 批次、无 SDK 私有加工"；D-17 说"宿主回调永不见重复消息"。重连时服务端无条件重推最近 50 条，其中必有已见消息。
   - What's unclear：过滤 `history.messages` 数组（帧形态不变、语义变为"新到你的消息"）是否算 D-16 禁止的"私有加工"。
   - Recommendation：过滤。理由：不过滤则 D-17 被违反（宿主见重复）；帧类型/字段/oldest_kept_seq/has_more 原样保留，仅 messages 内容按去重窗口筛选——这是两决策唯一自洽的交集。planner 将此解读写进 API 文档措辞（"history.messages 永远只含宿主未见消息"），三端移植照此。
3. **Playwright 断连手段的实证（A1）**——Wave 0 第一个 E2E spike 验证 setOffline 是否真关 WS；备选 demo 页调试句柄。不阻塞规划。
4. **demo 页 script 标签的缓存策略**——静态资产带 etag；demo 页引 `/pushhub.js` 可加 `?v=<version>` 查询参数规避宿主缓存旧 SDK（实现细节，Discretion，顺手做）。

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | 构建/测试 | ✓ | v22.19.0 | — |
| pnpm | workspace | ✓ | 10.33.0 | — |
| esbuild 二进制 | build | ✓（0.28.1，vitest 传递依赖 + onlyBuiltDependencies 白名单） | 0.28.1 | 显式装 0.28.2 |
| wrangler（含 dev） | E2E webServer | ✓ | 4.126.0 | — |
| npm registry 网络 | 安装依赖 | ✓（spike 中多次 install 成功） | — | 镜像源 |
| Playwright Chromium 二进制 | E2E | ✗ 未安装 | — | `pnpm --filter @pushhub/web-sdk exec playwright install chromium`（中国网络必要时 `PLAYWRIGHT_DOWNLOAD_HOST` 镜像） |
| Chrome DevTools / 本机浏览器 | 排障 | ✓（Windows 11 开发机） | — | — |

**Missing dependencies with no fallback:** none（Chromium 二进制为一次性显式安装步骤，planner 排进 Wave 0）。

**Missing dependencies with fallback:** Playwright 浏览器下载若遇网络阻断——镜像变量兜底；E2E 整层不可用时单测层（vitest node+jsdom）仍可推进，E2E 后补。

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | vitest 4.1.11（SDK 单测，独立 config）+ @playwright/test 1.62.1（E2E） |
| Config file | `packages/web-sdk/vitest.config.ts`（新建，Wave 0）+ `packages/web-sdk/playwright.config.ts`（新建，Wave 0） |
| Quick run command | `pnpm --filter @pushhub/web-sdk test` |
| Full suite command | `pnpm --filter @pushhub/web-sdk run build && pnpm --filter @pushhub/web-sdk test && pnpm --filter @pushhub/web-sdk run e2e` |

> server 包测试（`pnpm --filter @pushhub/server test`，`vitest run --max-workers=1 --no-isolate` [VERIFIED: packages/server/package.json:6 原文 `"test": "vitest run --max-workers=1 --no-isolate"`]）与本阶段并行不悖；root `test` 脚本建议扩为串起两包。

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| WEB-01 | 构建产物全局可直接 new | E2E（真产物 + 真页面两行接入） | `pnpm --filter @pushhub/web-sdk run e2e -- e2e/viewer.spec.ts` | ❌ Wave 0 |
| WEB-01 | IIFE 打包形态正确（全局为类） | 构建断言（build.mjs 内嵌冒烟：产物加载后 `typeof PushHub === "function"`） | `pnpm --filter @pushhub/web-sdk run build` | ❌ Wave 0 |
| WEB-02 | 帧→事件映射（4 事件） | unit（node，mock WebSocket 注入状态机） | `pnpm --filter @pushhub/web-sdk test -- test/machine-events.test.ts` | ❌ Wave 0 |
| WEB-02 | 帧解析契约（golden fixtures 正反例） | unit（node） | `pnpm --filter @pushhub/web-sdk test -- test/frames.test.ts` | ❌ Wave 0 |
| WEB-02 | 实时收消息端到端 | E2E（真 DO 扇出） | `pnpm --filter @pushhub/web-sdk run e2e -- e2e/viewer.spec.ts` | ❌ Wave 0 |
| WEB-04 | 退避 full jitter + cap 60s | unit（fake timers） | `pnpm --filter @pushhub/web-sdk test -- test/machine-backoff.test.ts` | ❌ Wave 0 |
| WEB-04 | seq 去重（实时/补拉交叠零重复） | unit（node） | `pnpm --filter @pushhub/web-sdk test -- test/dedup.test.ts` | ❌ Wave 0 |
| WEB-04 | 断连→重连→补拉（宿主无感） | E2E（setOffline 混沌） | `pnpm --filter @pushhub/web-sdk run e2e -- e2e/reconnect.spec.ts` | ❌ Wave 0 |
| WEB-04 | v≠1 帧断连不重连 | unit | `pnpm --filter @pushhub/web-sdk test -- test/machine-fatal.test.ts` | ❌ Wave 0 |
| WEB-05 | renderMarkdown 消毒（攻击样本） | unit（**jsdom** 环境 docblock） | `pnpm --filter @pushhub/web-sdk test -- test/render.test.ts` | ❌ Wave 0 |
| WEB-05 | demo 页攻击样本渲染安全 | E2E（真浏览器） | `pnpm --filter @pushhub/web-sdk run e2e -- e2e/viewer.spec.ts` | ❌ Wave 0 |
| SC2（生产维度） | 部署断连重连续补拉 | manual smoke（D-15 checklist 扩展：部署后开查看器观察） | 人工（经 https://pushhub.dyun.org） | n/a |
| SC4 | /pushhub.js 资产命中不计 Worker 请求 | manual smoke（dashboard 请求计数/wrangler tail） | 人工 | n/a |

### Sampling Rate

- **Per task commit:** `pnpm --filter @pushhub/web-sdk test`（node+jsdom 单测，秒级）
- **Per wave merge:** `pnpm --filter @pushhub/web-sdk run build && pnpm --filter @pushhub/web-sdk test`（+ server 包回归一次）
- **Phase gate:** 全套 + `e2e`（wrangler dev 拉起）+ 部署生产冒烟（D-15 checklist + SC2/SC4 人工项）后再 `/gsd-verify-work`

### Wave 0 Gaps

- [ ] `packages/web-sdk/` 包骨架（package.json / tsconfig / vitest.config.ts / playwright.config.ts）
- [ ] `test/fixtures/attack-samples.json`（攻击样本 + 预期输出，断言基线取自本研究实证表）
- [ ] Playwright Chromium 安装：`pnpm --filter @pushhub/web-sdk exec playwright install chromium`
- [ ] setOffline 断连行为 spike（Open Question 3，第一个 E2E 用例前置）
- [ ] root `package.json` `test`/`deploy` 脚本扩展（多包串联）+ `.gitignore` 产物条目

## Security Domain

> `security_enforcement: true`，ASVS Level 1（config.json 实查）。本阶段是 XSS 防线的主战场。

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes（继承） | Channel Key 经 WS URL 路径段（浏览器 WS 无法带鉴权头——Phase 1 既定）；SDK 不碰 Admin/Send Key |
| V3 Session Management | no | 无会话概念（密钥即身份） |
| V4 Access Control | no（继承） | 服务端已拒无效密钥（401，不建 DO stub） |
| V5 Input Validation | yes | 帧接收侧 guard（v/type/结构 + 未知字段忽略）；`LIMITS.TEXT_MAX=32768` 等上限常量同源 shared |
| V6 Cryptography | no | 无新密码学；wid 生成在服务端 |
| V12 CSRF/CSP（顺带） | partial | demo 页可加 CSP meta（`default-src 'self'`）——可选加固，非验收项 |

### Known Threat Patterns for {browser SDK + 不可信消息源}

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| 存储型 XSS（消息 Markdown 内嵌 `<script>`/`<img onerror>`/`javascript:`） | Tampering/Elevation | marked→DOMPurify 管道 + 攻击样本 fixtures 回归（SC3，本阶段最高优先安全项）；**绝不允许未经消毒的 innerHTML**（CLAUDE.md Do-NOT-use） |
| 反向 tabnabbing（消息链接 `target=_blank` 窃取 window.opener） | Spoofing | D-21 hook 强制 `rel=noopener noreferrer`（实证生效） |
| click_url 跳转滥用 | Tampering | demo 页点击消息时对 click_url 走同样的消毒/白名单逻辑（`javascript:` scheme 剥除）——D-21 "click_url 跳转同理" |
| 协议混淆帧（伪造 v/type） | Tampering | 客户端侧 guard：v≠1 fatal 断连；未知 type 丢弃；未知字段忽略（前瞻兼容与防注入的平衡，D-07） |
| Channel Key 泄露面 | Information Disclosure | SDK 不把 key 写进任何日志/错误消息；demo 页 localStorage 存 key 是用户自担的便利取舍（D-24 锁定）——文档注明 |
| 恶意 WS 消息洪水/超大帧 | DoS | 服务端侧已限（1MiB/帧、10 万请求/天）；SDK 侧：单帧解析 try/catch 不崩宿主页面 |

## Sources

### Primary (HIGH confidence)

- 本机实证（2026-08-26，Windows 11 / Node v22.19.0）：
  - esbuild 0.28.1 IIFE/globalName 四种入口形态实验（含 type:module 包与 workspace .ts 依赖、真实 bundle 体积 72,841/24,426 bytes）
  - dompurify 3.4.14 + marked 18.0.11 攻击样本矩阵 × happy-dom 20.11.6 / jsdom 29.1.1 双环境对照
  - wrangler 4.126.0 `wrangler dev --help` 旗标实查（--var/--port/--ip/--inspector-port）
- 仓库源码 Read（本 session）：`packages/shared/src/index.ts`、`validators.ts`、`fixtures/`（history-frame.positive/ws-error-frame 抽样）、`packages/server/src/chat-room.ts`、`index.ts`、`wrangler.jsonc`、`vitest.config.ts`、`package.json`（root/server/shared）、`scripts/smoke.mjs`、`tsconfig.base.json`、`pnpm-workspace.yaml`
- registry 实查（npm view，2026-08-26）：marked/dompurify/happy-dom/@playwright/test/esbuild/jsdom/vitest 版本与 scripts

### Secondary (MEDIUM confidence)

- [esbuild issues #869 / #3740](https://github.com/evanw/esbuild/issues/3740) — globalName 与 default export 语义（与实证一致）
- [playwright.dev/docs/test-webserver](https://playwright.dev/docs/test-webserver) — webServer 选项
- [cure53/DOMPurify issue #317](https://github.com/cure53/DOMPurify/issues/317) — afterSanitizeAttributes hook 官方模式
- [vitest.dev/guide/environment](https://vitest.dev/guide/environment) + [happy-dom wiki: Setup as Test Environment](https://github.com/capricorn86/happy-dom/wiki/Setup-as-Test-Environment) — 环境配置与 docblock
- `.planning/research/STACK.md` §Web SDK/§Testing（前置研究）与 `D:\AIworkspaces\PushHub\.claude\CLAUDE.md`（技术栈约束）

### Tertiary (LOW confidence)

- Playwright `context.setOffline` 对已建立 WS 的行为（A1，待 Wave 0 spike）
- marked/DOMPurify 体积构成的第三方拆分数字（已被本机实测总量取代，仅拆分比例作参考）

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - 版本 registry 实查 + CLAUDE.md 锁定 + 本机实证关键行为
- Architecture: HIGH - 协议契约/服务端行为全部读源码逐行核对；打包/消毒/测试三层模式实证
- Pitfalls: HIGH - 10 条中 8 条有直接实证或源码行号支撑（A1/A2 两条已标 ASSUMED 并给验证路径）

**Research date:** 2026-08-26
**Valid until:** 2026-09-25（marked/dompurify/esbuild 为稳定慢变领域；@playwright/test 迭代快，进入执行期若跨月建议复查版本）
