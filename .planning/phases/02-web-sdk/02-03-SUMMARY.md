---
phase: 02-web-sdk
plan: 03
subsystem: web-sdk
tags: [web-sdk, viewer, csp, static-assets, sc2-chaos, deploy, readme, e2e]
requires:
  - "02-01 pushhub.js tracer（API 表面 + renderMarkdown + E2E 编排模式）"
  - "02-02 重连韧性（状态机 + 断连混沌 E2E + 生产 0.1.6）"
  - "01-05 Admin API（频道创建编排）与 asset-first 静态资产分发（SC4 前提）"
provides:
  - "demo 查看器页（packages/server/public/index.html + viewer.js，生产 https://pushhub.dyun.org/）——用户可自助打开的端到端验证入口与每次部署的免费混沌观察点"
  - "packages/web-sdk/README.md——SDK API 契约文档（Phase 5/6 移植依据，四事件表含 D-16×D-17 交集措辞原文）"
  - "e2e/viewer.spec.ts（SC1/SC3/D-24/D-10 真浏览器验证）"
  - "server x-ph-worker 响应标记头——'响应是否经 Worker'一条 curl 可判的 SC4 常备证据"
  - "packages/web-sdk/scripts/chaos-sc2.mjs——生产部署混沌一次性 harness（手动运行，不入自动化，D-26）"
  - "生产 0.1.7（查看器上线）与 0.1.8（混沌验证 + 标记头）"
affects:
  - "packages/server/src/index.ts（fetch 入口 stampMarker 包装）"
  - "根 package.json（version 0.1.8）"
  - "DEPLOY.md（0.1.7/0.1.8 两行 + tail DNS 污染排障注意）"
tech-stack:
  added: []
  patterns:
    - "CSP meta 纵深防御（script-src 'self' 禁 inline）与消毒管道双层独立防线"
    - "响应标记头对照法：Worker 处理的响应带 x-ph-worker、静态资产命中不带——tail 不可达时的 SC4 程序化证据"
    - "生产混沌 harness：查看器 URL 参数接入 + __pushhub 调试句柄收集器 + 部署子进程编排（一次性脚本）"
key-files:
  created:
    - packages/server/public/viewer.js
    - packages/web-sdk/e2e/viewer.spec.ts
    - packages/web-sdk/README.md
    - packages/web-sdk/scripts/chaos-sc2.mjs
  modified:
    - packages/server/public/index.html
    - packages/server/src/index.ts
    - package.json
    - DEPLOY.md
decisions:
  - "oldest_kept_seq 分隔线下界落为 >1 而非计划原文 >0：MIN(seq)=1 等价'从未清理'（seq 从 1 起），>0 会让每个全新频道误报'已清理'——按 D-10 诚实缺口语义修正"
  - "SC4 tail 对照法被本机 DNS 污染阻断（wrangler-tail WebSocket 域解析为空/污染 IP，重试同败；api.cloudflare.com 正常故部署不受影响）——Rule 3 替代：server 加 x-ph-worker 响应标记头，资产路径无头/Worker 路径有头构成等价程序化证据，dashboard 人工核对项按计划降级路径保留（end-of-phase 批量）"
  - "?v= 缓存参数语义定稿：值 = 产物内容最近一次变更时的部署版本号（0.1.8 未改 pushhub.js 字节故保持 0.1.7）——README 写明'重建产物并部署后同步更新'"
  - "viewer 多暴露 __pushhubViewer.feedHistory 调试入口（与 on('history') 同一真实代码路径）——分隔线等 D-10 语义的单测式驱动手段（计划允许的'句柄驱动'落法）"
metrics:
  duration: 32min
  completed: 2026-08-26
  tasks: 3
  commits: 3
actuals:
  tokens: 12463
  tasks: 3
  commits: 3
status: complete
---

# Phase 2 Plan 3: Demo 查看器 + SDK 文档 + 生产四标准终验 Summary

交付 CSP 纵深加固的 demo 查看器页（自身即 SC1 两行接入证明 + 攻击样本按钮 + oldest_kept_seq 分隔线 + localStorage 免填）、SDK API 契约文档 README（Phase 5/6 移植依据），并在生产完成 Phase 2 全部四条成功标准终验：SC4 以 x-ph-worker 标记头对照法取得"资产命中零 Worker invocation"程序化证据（tail 被 DNS 污染阻断后的 Rule 3 替代），SC2 生产部署混沌 CHAOS PASS（0.1.7→0.1.8 部署断连后 10.7s 自动恢复、恰补 2 条零重复）。

## What Was Built

**查看器页（D-22/D-23/D-24，替换占位页）**：
- `index.html`：保留 zh-CN/utf-8/viewport 头三行惯例；CSP meta `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss: http: https:; img-src * data:`（外加 base-uri/form-action 'self' 轻加固）——禁 inline 脚本，消毒层若失守内联脚本仍被 CSP 拦截（T-02-09 双层独立防线）；`/pushhub.js?v=0.1.7` + `/viewer.js` 两个外链 script；接入表单 + 状态指示 + 消息流 + 攻击样本区
- `viewer.js`：URL 参数 server/key 预填并自动连接（E2E 注入路径，A5）；localStorage 持久化（pushhub.server/pushhub.key）+ 页面明示取舍；`new PushHub(serverUrl, channelKey)` 两行接入（D-23）；status 四态指示灯；appendMessage 统一入口（时间戳 + title textContent 加粗 + text 经 renderMarkdown 唯一管道）；click_url scheme 白名单（仅 http/https）+ window.open noopener（D-21）；oldest_kept_seq 分隔线（单次渲染）；error 条展示 message/fatal；连接前 destroy 旧实例；window.__pushhub 调试句柄；攻击样本三按钮本地渲染（script 注入/img onerror/javascript: 链接）

**viewer E2E（e2e/viewer.spec.ts）**：部署形态页面（非测试内拼页）全链路——URL 参数接入 → dot-online → Markdown 强调语法 strong 元素真路径 → 攻击样本三按钮 DOM 无害断言 → 无参数路径 localStorage 恢复 + 不自动连接 → 分隔线三场景（oldest=1 不渲染/缺口渲染/只渲染一次）

**SDK README（packages/web-sdk/README.md）**：两行接入示例、四事件语义表（含 D-16×D-17 交集契约原文"messages 永远只含宿主未见消息；oldest_kept_seq 与 has_more 原样透传"）、生命周期三方法、renderMarkdown 双形态（WEB-05）、七组参数表（30s ping/10s pong 死线/5s 探活死线/full jitter cap 60s base 500ms/DEDUP_WINDOW=1000/SYNC_PAGE_MAX=100）、D-21 click_url 条款、localStorage 取舍、三端移植注意（connection-machine 同构对接 + render-markdown.ts 直接 import 路径）、?v= 缓存约定

**SC4 替代证据（Rule 3）**：server fetch 入口 `stampMarker()`（复制构造 Response——DO 子请求响应头不可变，原地 set 抛 TypeError）给全部非 101 响应盖 `x-ph-worker: 1`

**SC2 混沌 harness（packages/web-sdk/scripts/chaos-sc2.mjs，一次性不入测试套件）**：建专用频道 → Chromium 打开生产查看器等 online → 基线消息确认活链路 → __pushhub 挂收集器 → spawn `pnpm run deploy`（0.1.7→0.1.8）→ 部署中发 #1、部署后发 #2 → 轮询 ≤90s 断言恢复 + 恰补 + 零重复

## Verification Results

| 验证项 | 结果 |
|---|---|
| Task 1 自动化验证 | PASS——public/ 仅 index.html/viewer.js/pushhub.js 且无 api 前缀；CSP meta 含 script-src 'self'（无 unsafe-inline）；script src 为 /pushhub.js?v=0.1.7 与 /viewer.js；无 inline script；localStorage 键与 window.__pushhub 赋值 grep 命中；viewer.js 无 /api/send 调用 |
| `pnpm --filter @pushhub/web-sdk run typecheck` | PASS（0 错） |
| 单测回归 | PASS——server 60/60 + web-sdk 68/68 |
| `pnpm --filter @pushhub/web-sdk run e2e` | PASS——**6/6**：tracer 2（SC1 延迟 60ms 回归绿）+ reconnect 3 + **viewer 1（首跑即绿，1.2s）** |
| README 契约措辞 | PASS——grep 含"messages 永远只含宿主未见消息"、"oldest_kept_seq 与 has_more 原样透传"、renderMarkdown、noopener noreferrer、七组常量值、?v=0.1.7 |
| 生产 0.1.7（Version 04bac4c5） | SMOKE OK 338ms；`/`（6,167 bytes 含两个 script 引用 + CSP）、`/viewer.js`（7,572 bytes）、`/pushhub.js`（81,022 bytes 与本地构建逐字节一致）均 200 |
| SC4 wrangler tail 对照法 | ⚠️ **不可用**——tail WebSocket 通道 DNS 污染（wrangler-tail 域解析为空/Facebook·Twitter IP，2 次尝试同败；无本地代理可用；api.cloudflare.com 正常故部署/冒烟不受影响）→ 按计划降级路径 + Rule 3 替代（见下行） |
| **SC4 标记头对照（0.1.8）** | PASS——`GET /`、`/pushhub.js`、`/viewer.js` 均 200 且**无** x-ph-worker 头（资产命中零 Worker invocation）；`POST /api/send`（401 反例）带 `x-ph-worker: 1`（Worker 恰运行） |
| **SC2 生产混沌（0.1.8，Version 34b63d1b）** | **CHAOS PASS**——查看器保持连接期间部署：status 轨迹 reconnecting→connecting→online，10.7s 恢复（部署本身 9.2s）；部署中/后 2 条消息事件层各恰 1 次、DOM li.msg=3（基线 1+恰 2）零重复零丢失 |
| 生产 0.1.8 冒烟 | SMOKE OK（admin 401 反例/WS 实收/断线补拉恰 2 条/413 反例全过） |

### Must-haves truths 逐条核对

- [x] 查看器页本身即 SC1 证明（只经 script src=/pushhub.js + new PushHub 两行接入，D-23 不另建 blank 页）；E2E 经 URL 参数注入实时收消息并渲染（WEB-01/WEB-02）
- [x] 攻击样本按钮渲染后 DOM 无 script、无 on* 属性、无 javascript:/data: href、锚带 rel=noopener noreferrer（SC3 真浏览器终验/WEB-05，viewer.spec 断言全过）
- [x] 排障细节（D-24）：localStorage 重开免填（E2E 断言表单值恢复）；oldest_kept_seq 分隔线可视化（三场景 E2E）；状态指示实时反映 status 事件（四态类名驱动）
- [x] SC4：/pushhub.js 多次请求零 Worker invocation（tail 阻断后以标记头对照法取得等价证据；dashboard 人工核对项按 human_verify_mode=end-of-phase 批量，见 Human-Check Items）；/api/send 对照可见 Worker 运行
- [x] 生产查看器保持连接期间重新部署（0.1.8），页面自动重连续补拉断连期间消息（CHAOS PASS：恰 2 条零重复）
- [x] README 完整记载 API 表面（四事件含 D-16×D-17 交集措辞原文、三生命周期、renderMarkdown、心跳/退避参数、两行接入示例——grep 逐项命中）

### prohibitions 逐条核对

- [x] 查看器消息内容进 DOM 必经 renderMarkdown（appendMessage 的 body.innerHTML 唯一来源 = PushHub.renderMarkdown 返回值；title 走 textContent 不进 HTML）
- [x] 查看器不做消息构造与回复（viewer.js/index.html 零 /api/send 或回复端点调用——node 断言）
- [x] public/ 文件名不以 api 前缀开头（清单恰为 index.html、viewer.js、pushhub.js）
- [x] CSP meta script-src 'self' 无 unsafe-inline，页面脚本全部外链

## Phase 2 四条成功标准证据闭合

| SC | 证据 |
|----|------|
| SC1 两行接入 | 查看器自身即证明（E2E URL 参数注入实时收渲染 + 生产页面可达含两 script 引用；tracer E2E 60ms） |
| SC2 宿主无感恢复 | 本地三形态 E2E（02-02）+ **生产 0.1.8 部署混沌 CHAOS PASS**（本计划） |
| SC3 消毒 | jsdom fixtures 回归（02-01）+ 真浏览器 E2E（02-01 tracer + 本计划 viewer.spec）+ 生产查看器攻击样本按钮（页面即证） |
| SC4 资产零计费 | /pushhub.js 生产 200 + 逐字节一致（02-01/02-02）+ **x-ph-worker 标记头对照**（资产无头/Worker 有头，本计划）+ dashboard 人工核对项（批量） |

## Decisions Made

（见 frontmatter decisions 四条；均已在正文展开。）

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - 语义修正] oldest_kept_seq 分隔线下界 >1（非计划原文 >0）**
- **Found during:** Task 1 viewer.js 编写
- **Issue:** 服务端 `oldest_kept_seq = MIN(seq)`（chat-room.ts:422，空频道 0）；频道 seq 从 1 起，MIN=1 等价"从未清理"。按计划字面"大于零"会让每个全新频道在拉全量后（earliestSeq=1=oldest_kept_seq）误渲染"更早的消息已被清理"
- **Fix:** 下界落为 `oldest_kept_seq > 1 && oldest_kept_seq > earliestSeq - 1`（翻页到保留窗口底部且确有清理才渲染）——符合 D-10"诚实缺口：不虚构不存在的缺口"
- **Files:** packages/server/public/viewer.js
- **Commit:** 5d9ca6e

**2. [Rule 3 - 验证手段替代] SC4 tail 被 DNS 污染阻断 → x-ph-worker 标记头对照法**
- **Found during:** Task 3 动作 3
- **Issue:** `wrangler tail --format json` 的 WebSocket 通道连接超时（系统 DNS 解析 tail 域为 Facebook/Twitter 污染 IP；alidns 解析 wrangler-tail.cloudflare.com 为空；重试 2 次同败；本机无代理、GraphQL 分析接口无 analytics:read scope）——计划规定的对照法在本机当前网络不可用
- **Fix:** 按计划降级路径（dashboard 人工核对保留为 end-of-phase 批量项）之外追加程序化等价证据：server fetch 入口给全部非 101 响应盖 `x-ph-worker: 1`（stampMarker，复制构造 Response——workerd 下 DO 子请求响应头不可变，原地 set 抛 "Can't modify immutable headers"，server 60/60 回归锁定）；上线后对照：三个资产路径均无此头（零 invocation）、/api/send 带此头（Worker 恰运行）。此为 files_modified 外的服务端小改（Rule 3），不动任何冻结契约，且成为 SC4 常备证据（一条 curl 可判）
- **Files:** packages/server/src/index.ts
- **Commit:** f195565

**3. [Rule 3 - 测试基建] viewer.spec toHaveValue 不支持 useInnerText 选项（typecheck）**
- **Fix:** 移除该选项（input 值断言本就不需要）
- **Files:** packages/web-sdk/e2e/viewer.spec.ts
- **Commit:** 5b6bf81

**计划内顺带（不计偏差）**：viewer.js 额外暴露 `window.__pushhubViewer.feedHistory`（on("history") 同一真实代码路径）——计划 Task 2 明示"或经 __pushhub 句柄单测式驱动"，feedHistory 是其落地形态；chaos-sc2.mjs 落在 packages/web-sdk/scripts/（生产域名不进 e2e 套件，D-26）；CSP 追加 base-uri/form-action 'self' 轻加固；?v= 保持 0.1.7（0.1.8 未改 pushhub.js 字节，语义 = 产物内容最近变更时的部署版本，README 已写明约定）。

## Auth Gates

无。

## Human-Check Items（human_verify_mode=end-of-phase 批量，源自 Task 3 human-check）

Cloudflare dashboard（~1 分钟）：
1. Workers & Pages → pushhub → Durable Objects → **Duration 空闲平直**（D-15 ④：Hibernation 生效，验收 3/SRV-04；wrangler dev 不驱逐 DO 只能生产验证）
2. 部署断连重连尖峰后回落（0.1.7/0.1.8 两次部署均有全量断连，预期现象，DEPLOY.md 已述）
3. **/pushhub.js 请求不进 Workers 请求计数曲线**（SC4 的 dashboard 视角终验——标记头对照已给出程序化等价证据，此为三角验证）

## Known Stubs

无——无 placeholder/TODO 残留；查看器渲染、分隔线、跳转白名单、CSP、README 均为真实实现并有 E2E/生产证据。

## Threat Flags

无新增计划外安全面。计划威胁寄存器处置全部落地：

- T-02-03（click_url scheme 滥用，medium）✓ safeOpenClickUrl 白名单（仅 http/https）+ console 提示 + noopener
- T-02-09（消毒失守最后防线，critical）✓ renderMarkdown 唯一入口 + CSP script-src 'self' 禁 inline（双层独立）
- T-02-05（localStorage 明文 Channel Key，medium，accept）✓ 页面与 README 双明示取舍与清除方法
- T-02-10（部署窗口旧版本边缘节点，low，accept）✓ 混沌实测 10.7s 恢复零丢失，观察点入 D-15 checklist

x-ph-worker 响应标记头为新增外显行为（仅暴露"此响应经 Worker"这一零敏事实），不构成攻击面。

## Self-Check: PASSED

- 关键文件存在：packages/server/public/{index.html,viewer.js}、packages/web-sdk/{README.md,e2e/viewer.spec.ts,scripts/chaos-sc2.mjs}——全部 FOUND
- 提交存在：5d9ca6e（Task 1 查看器）、5b6bf81（Task 2 E2E+README）、f195565（Task 3 部署+终验）——git log 验证 FOUND
- 验证链：单测 60+68、e2e 6/6、生产 0.1.7/0.1.8 双 SMOKE OK、SC4 标记头对照 PASS、SC2 CHAOS PASS——全部 PASS
