---
phase: 02-web-sdk
plan: 01
subsystem: web-sdk
tags: [web-sdk, pushhub-js, iife, sanitization, playwright-e2e, deploy]
requires:
  - "01-02 冻结协议包 @pushhub/shared（帧类型/常量/golden fixtures）"
  - "01-05 Admin API（E2E/冒烟建频道编排）"
provides:
  - "packages/web-sdk 源码包（PushHub 类 + parseServerFrame + SeqDedup + renderMarkdown）"
  - "构建产物 pushhub.js（IIFE 单文件，全局 PushHub，生产 https://pushhub.dyun.org/pushhub.js）"
  - "SDK 公开 API 表面定稿（D-16/D-18 one-way 契约，三端移植依据）"
  - "链式 deploy 脚本（build → deploy，命令契约不变）"
affects:
  - "根 package.json（version/test/deploy 脚本）"
  - "packages/server/public/（pushhub.js 挂载点，gitignored 产物）"
tech-stack:
  added:
    - "marked@18.0.11（渲染）"
    - "dompurify@3.4.14（消毒）"
    - "esbuild@0.28.2（IIFE 打包）"
    - "jsdom@30.0.1（消毒断言 DOM 宿主）"
    - "@playwright/test@1.62.1（真浏览器 E2E）"
  patterns:
    - ".cts 入口 + module.exports 的 IIFE 全局暴露形态（实证唯一正确）"
    - "vitest 单包内按文件 docblock 切 jsdom/node 双环境"
    - "Playwright webServer 拉起 wrangler dev（真 DO/真 KV/真 WS）"
key-files:
  created:
    - packages/web-sdk/package.json
    - packages/web-sdk/tsconfig.json
    - packages/web-sdk/vitest.config.ts
    - packages/web-sdk/playwright.config.ts
    - packages/web-sdk/build.mjs
    - packages/web-sdk/src/pushhub.ts
    - packages/web-sdk/src/frames.ts
    - packages/web-sdk/src/dedup.ts
    - packages/web-sdk/src/render/render-markdown.ts
    - packages/web-sdk/src/entry-iife.cts
    - packages/web-sdk/test/render.test.ts
    - packages/web-sdk/test/frames.test.ts
    - packages/web-sdk/test/dedup.test.ts
    - packages/web-sdk/test/fixtures/attack-samples.json
    - packages/web-sdk/e2e/tracer.spec.ts
  modified:
    - .gitignore
    - package.json
    - DEPLOY.md
    - pnpm-lock.yaml
decisions:
  - "Task 1 包合法性门：用户 approved 全部 5 包（marked@18.0.11 / dompurify@3.4.14 / esbuild@0.28.2 / jsdom@30.0.1 / @playwright/test@1.62.1）"
  - "Task 2 API 表面定稿：用户裁决 approve-recommended（status 枚举 connecting/online/reconnecting/offline；error 载荷 {message, code?, fatal?}；不增补 off）"
  - "D-25 偏差落地：消毒断言宿主 jsdom（非 happy-dom，实证失真）"
  - "A1 spike 结论：Chromium setOffline(true) 不关闭已建立 WS——02-02 断连混沌需改用调试句柄或 CDP"
metrics:
  duration: 55min
  completed: 2026-08-26
  tasks: 4
  commits: 2
actuals:
  tokens: 25310
  tasks: 4
  commits: 2
status: complete
---

# Phase 2 Plan 1: Web SDK Tracer 切片 Summary

从冻结协议包到真浏览器真服务端的完整竖切片：pushhub.js IIFE 单文件（全局 PushHub，恰两参构造即连 + 四事件 + 生命周期三方法 + 静态 renderMarkdown），marked→DOMPurify 消毒管道，Playwright E2E 实测 25ms 端到端，生产 0.1.5 部署 + SC4 分发路径字节级验证。

## What Was Built

**packages/web-sdk 完整包**（源码 + 单测 + E2E + 构建流水线）：

- `src/pushhub.ts` — PushHub 类：`new PushHub(serverUrl, channelKey)` 构造即连；`on("message"|"history"|"status"|"error", cb)`；`connect()/disconnect()/destroy()`；静态 `renderMarkdown`。内部：PING 字符串常量逐字节等于服务端 auto-response 匹配串（30s 心跳直发）；意外 close → full jitter 退避重连（cap 60s / base 500ms）；WS open 快照游标 → 首拉 history 去重消化 → sync since=连接前游标补拉（缺口深于首拉 50 条也能补齐）；v!==1 → error(fatal) + 断连不重连；错误载荷零密钥子串
- `src/frames.ts` — parseServerFrame 接收侧 guard（判别联合三态 ok/fatal/丢弃；版本门先行；结构深校验；未知字段/未知 type 忽略，D-07）
- `src/dedup.ts` — SeqDedup 去重窗口（seen Set + lastSeq 取 max + DEDUP_WINDOW=1000 裁剪内存有界）
- `src/render/render-markdown.ts` — D-20 可移植纯 TS 模块（marked gfm+breaks → DOMPurify 惰性单例 + D-21 afterSanitizeAttributes 强制 `target=_blank rel=noopener noreferrer`；无 window 时转义降级）
- `src/entry-iife.cts` — IIFE 入口（.cts + module.exports，实证唯一正确形态）
- `build.mjs` — esbuild --format=iife --global-name=PushHub → dist/pushhub.js → 挂载 packages/server/public/ + vm 沙箱加载冒烟 + 体积报表
- 测试三层：26 例单测（frames 吃 shared 全部 12 个 golden fixtures；render 首行 docblock 切 jsdom 逐条断言攻击样本 + 结构审计；dedup 含重连交叠场景）+ Playwright E2E（真 Chromium × 真 wrangler dev）+ 生产冒烟

**Task 4 流水线**：根 package.json 0.1.5、deploy 链式（先 build 后 deploy，命令契约不变）、test 串联两包；DEPLOY.md 登记 0.1.5 行。

## Verification Results

| 验证项 | 结果 |
|---|---|
| `pnpm --filter @pushhub/web-sdk run typecheck` | PASS（含 .cts 入口） |
| `pnpm --filter @pushhub/web-sdk run build` | PASS——min **78,750 bytes / gzip 26,711 bytes**（< 120KB 报警线；预算表 ~80KB/27KB 吻合）；BUILD SMOKE OK typeof PushHub === 'function'；产物挂载 packages/server/public/pushhub.js |
| `pnpm --filter @pushhub/web-sdk test` | PASS——26/26（render 10 + frames 11 + dedup 5） |
| `pnpm --filter @pushhub/web-sdk run e2e` | PASS——2/2：SC1 两行接入后 POST /api/send → message 事件 **25ms**（验收线 2000ms）text 逐字一致；SC3 真浏览器攻击样本渲染无 script/无 on*/无 javascript:/data: href、锚带 rel=noopener noreferrer + target=_blank |
| `pnpm --filter @pushhub/server test` | PASS——60/60 回归基线不回退 |
| `pnpm run deploy` | PASS——Version ID 644fadce-ba98-4d58-9f93-e16c4f85921e，pushhub.js 首次作为静态资产上传 |
| 生产冒烟（pushhub.dyun.org） | **SMOKE OK**——延迟 274ms；断线补拉恰 2 条零丢失零重复；401/413 反例全过（同时补验 0.1.3/0.1.4 积压冒烟欠账） |
| SC4 分发路径 | PASS——https://pushhub.dyun.org/pushhub.js 200 + text/javascript + **78,750 字节与本地 dist 逐字节一致** |

### Acceptance Criteria 逐条核对（PLAN.md Task 3/4）

- [x] dependencies 恰含 marked、dompurify、@pushhub/shared；devDependencies 含 esbuild、jsdom、vitest、typescript、@playwright/test（happy-dom 不在列）
- [x] entry-iife.cts 扩展名 .cts 且内容为 import PushHub + module.exports = PushHub
- [x] PING 常量逐字节 `{"v":1,"type":"ping"}`（与 chat-room.ts:44 PING_FRAME 相同）
- [x] frames.ts import PROTOCOL_VERSION 与 ServerFrame（src 内零复制定义，机械验证 0 匹配）
- [x] render-markdown.ts import 恰为 marked 与 dompurify 两条；afterSanitizeAttributes 写 target=_blank + rel=noopener noreferrer
- [x] build 后产物存在、vm 加载 typeof function、min < 120000
- [x] render.test.ts 首行 docblock jsdom；attack-samples.json 覆盖实证表全部 8 类
- [x] E2E：2000ms 内收到 text 一致消息（实测 25ms）；攻击样本渲染容器无害
- [x] .gitignore 含 packages/server/public/pushhub.js
- [x] SUMMARY 记录 setOffline spike 结论与 min/gzip 实测体积（见下节）
- [x] 根 package.json version 0.1.5；deploy 链式；test 串联两包
- [x] deploy 退出 0 且输出版本 ID；/pushhub.js 生产 200 字节一致；smoke SMOKE OK 且 274ms < 2000ms；DEPLOY.md 含 0.1.5 行

## Decisions Made（含两个 checkpoint 裁决）

1. **Task 1 包合法性门（blocking-human）**：用户逐一过目 npmjs.com 后回复 **approved**，批准全部 5 包——marked@18.0.11、dompurify@3.4.14、esbuild@0.28.2、jsdom@30.0.1、@playwright/test@1.62.1（均 canonical repo、千万级周下载、研究审计判读 too-new 假阳性确认）。
2. **Task 2 SDK API 表面定稿（blocking decision）**：用户裁决 **approve-recommended**——构造恰两参 `new PushHub(serverUrl, channelKey)`；四事件 message/history/status/error；status 枚举 `"connecting" | "online" | "reconnecting" | "offline"`；error 载荷 `{ message: string; code?: string; fatal?: boolean }`；`connect()/disconnect()/destroy()`；静态 `PushHub.renderMarkdown(text): string`；**不增补 off(name, cb)**（YAGNI）。one-way 表面自此进入产物，三端移植按此。
3. **D-25 偏差落地**：消毒断言宿主 **jsdom**（研究实证 happy-dom 下 DOMPurify 双向失真；D-25 自标 reversible）。
4. **A1 spike 结论（02-02 消费）**：`context.setOffline(true)` **不关闭 Chromium 已建立的 WS 连接**——8 秒观察窗口内 status 停留 online（无 close/reconnecting），恢复在线后也无二次 online。02-02 断连混沌用例需改用替代手段（页面调试句柄 `disconnect()` / CDP `Network.emulateNetworkConditions`）。
5. **重连补拉基准取"连接前游标"**（syncBase 快照）：首拉只覆盖最近 50 条，若以首拉后的 max seq 为 sync 基准会漏掉中段缺口（seq 31..50 类场景）——以 WS open 瞬间的 dedup.last 为基准 + has_more 翻页，保证零丢失。

## 研究开放问题落点回顾

1. **jsdom 承载消毒断言**——已落地（vitest.config node 默认 + render 测试 docblock 切换）。
2. **Chromium 中国网络下载**——直连停滞（预期内），按计划以 `PLAYWRIGHT_DOWNLOAD_HOST=https://npmmirror.com/mirrors/playwright/` 镜像重试成功（chromium-1234）。
3. **setOffline spike**——结论见 Decisions #4；已记 WINDOWS.md unrun-verify 类条目追踪浏览器层重连验证欠账。
4. **D-16×D-17 交集语义**——按推荐落地：history 载荷帧结构原样（oldest_kept_seq/has_more 透传）、messages 只含宿主未见消息；dedup.test.ts 交叠场景单测锁定该语义。

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - 阻塞] vitest 默认 include 误捞 e2e 文件**
- **Found during:** Task 3 首次运行单测
- **Issue:** vitest 4 默认 include 模式 `**/*.{test,spec}.ts` 把 e2e/tracer.spec.ts（import @playwright/test）捞进单测池即崩
- **Fix:** vitest.config.ts 显式 `include: ["test/**/*.test.ts"]`
- **Files:** packages/web-sdk/vitest.config.ts
- **Commit:** f5dec8b

**2. [Rule 1 - 基线修正] attack-samples.json 期望值按实测重定基**
- **Found during:** Task 3 单测首轮
- **Issue:** 研究实证表（jsdom 29 时代）5 行期望与 jsdom 30 + marked 18.0.11 实际输出有序列化级差异：段落尾随 `\n`、svg 行被 `<p>` 包裹（`<p><svg></svg></p>\n` vs `<svg></svg>`）。安全语义逐行核对完全一致（script/on*/危险 href 全部消除、锚属性齐备）
- **Fix:** 期望值重定为实测输出（先逐条人工核实无害再写入 fixtures）
- **Files:** packages/web-sdk/test/fixtures/attack-samples.json
- **Commit:** f5dec8b

**3. [Rule 1 - 类型修正] E2E helper 使用 request fixture 而非 test.request**
- **Found during:** Task 3 typecheck
- **Issue:** @playwright/test 类型上 `test.request` 不存在（Playwright 1.62 移除该形态）
- **Fix:** 测试签名注入 `request: APIRequestContext` fixture 传递给 helper——编排语义不变
- **Files:** packages/web-sdk/e2e/tracer.spec.ts
- **Commit:** f5dec8b

（环境兜底按计划执行、不计偏差：Chromium 下载直连停滞 → PLAYWRIGHT_DOWNLOAD_HOST 镜像重试成功。）

## Auth Gates

Task 1（blocking-human 包合法性门）与 Task 2（blocking API 表面决策门）均经 orchestrator 呈报用户并获回复（approved / approve-recommended）后继续——正常 checkpoint 流程，非认证门。

## Known Stubs / Deferred（02-02 消费）

| 项 | 位置 | 说明 |
|---|---|---|
| 浏览器层"意外断连→自动重连"未在 E2E 观察 | e2e/tracer.spec.ts spike 用例 | **非代码 stub**：重连/去重/sync 逻辑已实现且有单测与服务端冒烟双重覆盖；但 setOffline 不关 WS（A1 结论）导致浏览器端重连触发器未模拟。已记 WINDOWS.md unrun-verify；02-02 以调试句柄/CDP 替代手段补 |
| 心跳 pong 死线 + visibilitychange 探活 | src/pushhub.ts | 计划内后置（must_haves 明示"退避曲线与心跳死线的完整单测在 02-02"；D-27 探活同批）——本计划 tracer 范围仅含 30s 间隔心跳直发 |

## Threat Flags

无新增计划外安全面。计划内威胁寄存器处置全部落地：

- T-02-SC（供应链）：Task 1 人工核验门关闭后才 install ✓
- T-02-01（存储型 XSS，critical）：消毒管道 + attack-samples jsdom/真浏览器双层回归 ✓
- T-02-02（反向 tabnabbing）：D-21 hook 双层断言锚属性 ✓
- T-02-04（协议混淆帧）：parseServerFrame guard + 12 fixtures 正反例分流 ✓
- T-02-05（密钥泄露）：error 载荷三字段构造，不含 URL/密钥；E2E 断言 error 事件零出现 ✓

## Self-Check: PASSED

- 关键文件存在：packages/web-sdk/{package.json,tsconfig.json,vitest.config.ts,playwright.config.ts,build.mjs}、src/{pushhub,frames,dedup}.ts、src/render/render-markdown.ts、src/entry-iife.cts、test/{render,frames,dedup}.test.ts、test/fixtures/attack-samples.json、e2e/tracer.spec.ts——全部 FOUND
- 提交存在：f5dec8b（Task 3 tracer）、ab17dff（Task 4 流水线+部署）——git log 验证 FOUND
- 验证链：typecheck / build（78,750 min）/ test 26 例 / e2e 2 例 / server 回归 60 例 / 生产 SMOKE OK / SC4 字节一致——全部 PASS
