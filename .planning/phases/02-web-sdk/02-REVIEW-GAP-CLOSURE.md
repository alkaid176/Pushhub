---
phase: 02-web-sdk
reviewed: 2026-08-27T13:55:00Z
depth: standard
files_reviewed: 14
files_reviewed_list:
  - packages/web-sdk/src/render/render-markdown.ts
  - packages/web-sdk/src/connection-machine.ts
  - packages/web-sdk/src/pushhub.ts
  - packages/web-sdk/build.mjs
  - packages/web-sdk/scripts/chaos-sc2.mjs
  - packages/web-sdk/test/fixtures/attack-samples.json
  - packages/web-sdk/test/machine-fatal.test.ts
  - packages/web-sdk/test/adapter-lifecycle.test.ts
  - packages/web-sdk/test/cache-bust-sync.test.ts
  - packages/web-sdk/e2e/viewer.spec.ts
  - packages/server/public/viewer.js
  - packages/server/public/index.html
  - package.json
  - DEPLOY.md
findings:
  critical: 1
  warning: 4
  info: 5
  total: 10
status: issues_found
---

# Phase 02: Code Review Report — Gap Closure Increment (G-02-2/3/4)

**Reviewed:** 2026-08-27T13:55:00Z（diff base b852d01..HEAD，13 commits）
**Depth:** standard
**Files Reviewed:** 14
**Status:** issues_found

## Summary

审查范围为 Phase 02 gap-closure 增量：G-02-2（SVG 锚点两分支 tagName）、G-02-3（build.mjs ?v= 注入）、G-02-4/WR-02/WR-03/WR-04（FORBID_TAGS、localStorage 读防护、WS_FAIL 容错）及 0.1.9 版本推进与部署记录。

**增量本身的四项修复经对抗性核查均判定正确**：

- G-02-2 两分支判定（`"A" || "a"`）语义正确：HTML 命名空间 tagName 大写、SVG 命名空间小写，jsdom 单测与 fixture（svg-anchor 样本）实证锁定；
- WS_FAIL 状态机在全部六态（idle/connecting/online/reconnecting/offline/destroyed）及可构造的竞态序列（disconnect→connect 同 tick 双 WS_FAIL 挂起、destroy 后迟到派发、重连定时器路径构造失败）下均无复活、无误报、无密钥泄漏（错误文案静态、测试断言不含 `phc_`）；
- build.mjs "恰命中一次" 硬断言是正确的 loud-failure 设计（0 命中/多命中均构建失败）；
- viewer.js localStorage 读侧 try/catch 优先级链（url 参数 || localStorage || 缺省）降级正确，短路求值使 url 参数存在时根本不触碰 localStorage。

**实证验证**（不轻信申报，全部本机复跑）：web-sdk 单测 81/81 绿（fixture 预期表逐字复现，DOMPurify 3.4.14 的 FORBID_TAGS unwrap 语义被测试证实）；Playwright e2e 8/8 绿（含新增 WR-03/WR-04 用例）；`tsc -p` 零错误；测试/构建副作用后工作树保持干净（注入幂等实证）。

**但发现一项 Critical**：消毒管道对 **`style` 属性（任意内联 CSS）与 `class` 属性原样放行**——用 0.1.9 生产字节（dist/pushhub.js）直测证实，`<div style="position:fixed;inset:0;...">` 与 `<div class="error-bar">` 逐字穿透。WR-02 "收敛 UI 伪装攻击面" 的目标只关闭了 `<style>` **元素**，未关闭 `style` **属性**，任意 Webhook 发送方仍可在查看器 origin 上渲染全屏覆盖层钓鱼与伪造系统错误横幅。另有 4 项 Warning（含一项已登记未修复的生产密钥仓库卫生问题）与 5 项 Info。

## Critical Issues

### CR-01: 消毒管道放行 `style`/`class` 属性——全屏覆盖层钓鱼与伪造系统 UI 直通（WR-02 目标未闭合）

**File:** `packages/web-sdk/src/render/render-markdown.ts:67-69`
**Issue:** 增量为 `purify.sanitize` 增加了 `FORBID_TAGS: ["style", "form", "input", ...]`，注释声称目的之一是"表单钓鱼/UI 伪装攻击面"收敛。但 DOMPurify 默认 `ALLOWED_ATTR` 包含 `style` 与 `class`，本次未加 `FORBID_ATTR`。用 0.1.9 生产字节（`packages/web-sdk/dist/pushhub.js`）在 jsdom 实测：

```
IN : <div style="position:fixed;inset:0;background:#fff;z-index:9999">假登录页覆盖层</div>
OUT: <div style="position:fixed;inset:0;background:#fff;z-index:9999">假登录页覆盖层</div>   ← 原样穿透

IN : <div class="error-bar">致命错误（伪造）：请访问 https://evil.example 重置密钥</div>
OUT: <div class="error-bar">致命错误（伪造）：请访问 https://evil.example 重置密钥</div>     ← 原样穿透
```

攻击链：任意 Webhook 发送方（持有 Send Key 的第三方集成，可能已被攻陷）→ 消息 text 含原始 HTML → `renderMarkdown` 穿透 → viewer.js `body.innerHTML`（viewer.js:109）→ (a) `position:fixed;inset:0` 使内容脱出消息容器**覆盖整个视口**，在 pushhub.dyun.org origin 上伪造系统页/登录页钓鱼；(b) `class="error-bar"` 直接命中查看器自身 CSS（index.html:61-69 红底白字错误横幅），伪造"致命错误"系统消息。index.html CSP 的 `style-src 'unsafe-inline'`（index.html:10）对内联 style 无兜底作用。DOMPurify 默认不清洗 style 属性的 CSS 值（无内置属性白名单），实证确认逐字透传。由于 D-20 设计是"四端同一消毒管道"，该缺口将随模块复用传播到 Phase 5 桌面端。

**Fix:**
```ts
return purify.sanitize(marked.parse(text, { async: false }), {
  FORBID_TAGS: ["style", "form", "input", "button", "select", "textarea", "label", "option"],
  FORBID_ATTR: ["style", "class", "id"], // UI 伪装攻击面真正收敛：禁内联 CSS/宿主类名/宿主 id
});
```
viewer 自身样式全部经由外层容器类名施加（`li.msg`/`msg-body`），消息内容剥离 class/style 不影响宿主渲染；marked 自身不产出 style/class 属性，无兼容损失。同时在 `test/fixtures/attack-samples.json` 增补 `inline-style-overlay`、`host-class-spoof` 两个样本固化预期输出（现有 12 样本无一覆盖属性向量，这正是缺口在实证表中不可见的原因）。

## Warnings

### WR-01: 生产 ADMIN_KEY 明文文件在仓库目录内、无 gitignore 防护（已登记未修复）

**File:** `.gitignore`（缺条目）＋ `.claude/admin.key`（64 字节未跟踪文件，git status 可见 `?? .claude/admin.key`）
**Issue:** 执行方在 02-06 已发现并登记（`.planning/phases/02-web-sdk/deferred-items.md` #1，状态 open），但截至本审查仍未修复。`.gitignore` 覆盖 `.dev.vars` 却不含 `.claude/admin.key`，一次 `git add -A` / `git add .` 即把生产 Admin Key 明文写入历史（git 历史污柔回滚代价极高）。审查期间再次核实该文件仍在、仍未被忽略。密钥分级约束（CLAUDE.md：任一级泄露可单独重置）意味着泄露后需轮换 + 全量 `wrangler secret put` 重部署。
**Fix:** 在 `.gitignore` 增补一行 `.claude/admin.key`（或把该文件移出仓库目录）；随后建议顺手轮换该 Key（它已在多份日志/文档语境中出现）。一行改动，建议归入 /gsd-quick 立即处理而非顺延。

### WR-02: README 仍教授已被机制废除的手工 ?v= 约定，且示例值停在 0.1.7

**File:** `packages/web-sdk/README.md:124`
**Issue:** G-02-3 把 ?v= 从"人工同步纪律"（README 有约定）改为 build.mjs 构建期注入，index.html:129 注释也已改为"勿手改"。但 README:124 仍写着旧约定："引用 `/pushhub.js` 时带版本查询参数（如 `/pushhub.js?v=0.1.7`）规避浏览器[缓存]"——(a) 与新机制及"勿手改"直接矛盾；(b) 示例值本身又是散落的硬编码版本号（0.1.7），与 chaos-sc2 头注释、cache-bust 测试注释同属 G-02-3 事故的成因类（散落版本号漂移）。第三方接入者照 README 手改 index.html 会与下一次构建注入打架。
**Fix:** README 该段改为描述现状："查看器页面的 `?v=` 由 `packages/web-sdk/build.mjs` 构建期自动注入根 `package.json` version，勿手改；自建宿主页面建议同样以版本号或内容哈希作查询参数"。删除示例中的具体版本号。

### WR-03: ?v= 机制只保证"与 package.json 同步"，不保证"字节变更必然伴随版本变更"

**File:** `packages/web-sdk/build.mjs:47-67` ＋ `package.json:3`
**Issue:** 注入机制 + cache-bust-sync 测试共同保证 `index.html ?v= === package.json version`。但若开发者改了 SDK 源码后忘记执行 DEPLOY.md 规定的"部署前补丁位 +1"，构建会以同版本号 0.1.9 注入并部署**内容已变的** pushhub.js——浏览器对同 URL（?v=0.1.9）命中缓存，静默投放旧字节。这正是 G-02-3 事故形态的残余半边：同步已机制化，"必须 bump"仍纯靠人。cache-bust-sync 两项断言在此场景下全绿（两端一致地错）。
**Fix:** 在 build.mjs 注入段加内容锚定——例如把 `?v=` 值改为产物内容哈希前 8 位（`?v=<sha256(pushhub.js).slice(0,8)>`，天然无需 bump）；或保留版本号但在 deploy 链路加前置校验："产物字节相对上次部署记录有变而 version 未变 → 构建失败"。

### WR-04: cache-bust-sync Test 2 的构建副作用使 Test 1 的失败不可复现（本地自愈）

**File:** `packages/web-sdk/test/cache-bust-sync.test.ts:53-59`
**Issue:** Test 2 执行真实 build.mjs，会把当前根 version 写进 `index.html`（已实证幂等、当前树干净）。但版本号刚 bump 未构建时：Test 1 失败（index.html stale）→ 同一 run 内 Test 2 随即构建并**把 index.html 修好**→ 测试输出 1 failed，开发者本地重跑却全绿（失败不可复现）；CI 因不提交中间态每次都稳定失败 Test 1。单测修改被跟踪源文件本身也是副作用设计，值得隔离。
**Fix:** Test 2 在构建前快照 `index.html` 原文，断言完成后 `try/finally` 写回原字节——机制生效性已验证，副作用不复存在，Test 1 的失败在任何环境可稳定复现：
```ts
it("机制生效：执行一次构建后断言仍成立", () => {
  const before = readFileSync(indexHtmlPath, "utf8");
  try {
    execFileSync(execPath, [buildScriptPath], { stdio: "pipe" });
    const values = refValues(readFileSync(indexHtmlPath, "utf8"));
    expect(values.length).toBe(1);
    expect(values[0]).toBe(rootPkg.version);
  } finally {
    writeFileSync(indexHtmlPath, before); // 还原子测副作用，失败可复现
  }
});
```

## Info

### IN-01: chaos 脚本 usage 示例仍硬编码 0.1.8

**File:** `packages/web-sdk/scripts/chaos-sc2.mjs:20`
**Issue:** 本增量把脚本内日志的硬编码版本改为 `${EXPECT_VERSION}`（第 114 行），但头部 usage 示例仍是 `--expect-version 0.1.8`——散落版本号漂移的又一实例（与 G-02-3 成因同类）。
**Fix:** 示例改为占位写法 `--expect-version <当前根 package.json version>`。

### IN-02: cache-bust 测试注释引用具体版本号 0.1.8

**File:** `packages/web-sdk/test/cache-bust-sync.test.ts:32`
**Issue:** "（version 单一来源，0.1.8）"——版本已 0.1.9，注释过期；把具体版本号写进注释注定随每次 bump 过期。
**Fix:** 删去具体版本，改"（version 单一来源）"。

### IN-03: pushhub.ts catch 路径注释 "this.ws 保持 null" 与实现不符

**File:** `packages/web-sdk/src/pushhub.ts:242`
**Issue:** `openSocket` 顶部的 stale-socket 防护只 detach 回调并 close，未把 `this.ws` 置 null；构造抛出路径直接 return。故在"重连后旧 socket 尚未被 onclose 置 null"的路径下，WS_FAIL 窗口期 `this.ws` 实际指向已 detach 的旧 socket 而非 null。行为无害（回调已摘除、sendPing/sendSync 有 `readyState === OPEN` 门控、机器 offline 后无动作），但注释错误会误导后续维护（尤其 Phase 5 Rust 同构移植时照注释理解语义）。
**Fix:** 注释改为"this.ws 不指向新 socket（保持旧值或 null，均已 detach 不产事件）"，或在 catch 分支显式 `this.ws = null`。

### IN-04: attack-samples 缺 SVG 锚点的危险 scheme 变体样本

**File:** `packages/web-sdk/test/fixtures/attack-samples.json:42-46`
**Issue:** svg-anchor 样本用 `https:` xlink:href，只证明了 SVG 分支的 target/rel 注入（G-02-2 修复点）；未证明 SVG 锚点上 `javascript:`/`data:` xlink:href 被剥离（依赖 DOMPurify 内建 URI 检查）。两分支判定是本增量核心安全修复，其反例面应有实证固化。
**Fix:** 增补样本 `{"name":"svg-anchor-js-href","input":"<svg><a xlink:href=\"javascript:alert(1)\"><text>x</text></a></svg>", "expected": ...}`（expected 以实跑输出为准固化），与 CR-01 的属性向量样本一并补齐。

### IN-05: CSP 对内联 style 的放行与 CR-01 叠加（pre-existing，建议随 CR-01 一并收紧）

**File:** `packages/server/public/index.html:8-11`
**Issue:** `style-src 'self' 'unsafe-inline'` 为页面自身 `<style>` 块所需，但同时也使 CR-01 的内联 style 穿透失去 CSP 兜底；`img-src * data:` 允许消息中外链图片（追踪像素可作阅读回执）。两者均早于本增量，非本次引入。
**Fix:** CR-01 落地 FORBID_ATTR 后，`unsafe-inline` 的实际暴露面只剩页面自有样式，可维持现状；若进一步收紧，可将页面样式外链化后去掉 `unsafe-inline`，img-src 考虑加代理或保持现状（图片是聊天功能面）。

---

## 审查覆盖说明（对抗性核查未发现问题的区域）

- `connection-machine.ts` WS_FAIL（316-329）：六态门控、与 v!==1 fatal 的 `fatalStopped` 差异（WS_FAIL 后 state=offline 天然无定时器无 close 跟随，无需 fatalStopped）、CONNECT 手动恢复语义——均构造序列核查通过；`machine-fatal.test.ts` 新增 6 用例与实现一致。
- `pushhub.ts` WS_FAIL 延迟一跳派发（237-250）：构造即连时序（宿主 on() 先挂）正确；destroy 后迟到派发被机器 destroyed 门控消化；两个挂起 WS_FAIL 竞态（disconnect→connect 同 tick）收敛为恰一次 fatal；密钥纪律（静态文案）由测试断言锁死。
- `viewer.js` localStorage 读防护（198-205）：短路优先级链正确，catch 全量重赋值幂等；e2e WR-03 实证绿。
- `build.mjs` 注入（47-67）：正则字符类对当前版本形态（`0-9A-Za-z.-`）足够；命中数硬断言 loud-failure；注入幂等经实跑验证（工作树零 diff）。
- `attack-samples.json` 既有 12 样本：jsdom 实跑逐字复现（含 DOMPurify ≥3.2 FORBID_TAGS unwrap 语义——form/button 剥壳留文本、style 连内容移除）。
- DEPLOY.md 0.1.9 行申报的单测 81/81 与 e2e 8/8 本机复跑核实为真。

_Reviewed: 2026-08-27T13:55:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
