---
status: diagnosed
phase: 02-web-sdk
source: [02-VERIFICATION.md]
started: 2026-08-26T17:42:43Z
updated: 2026-08-27T00:00:00Z
---

## Current Test

[testing complete]

## Tests

### 1. Cloudflare dashboard 三角验证
expected: ① DO Duration 空闲平直不增（D-15④）；② 部署断连重连尖峰后回落；③ /pushhub.js 不进 Workers 请求计数曲线（SC4 终验，~1 分钟）
result: pass

### 2. 裁决 WR-01：SVG 锚点绕过 D-21 加固（验证器已实证复现）
expected: render-markdown.ts:54 钩子判定 node.tagName === 'A' 大小写敏感，SVG 命名空间锚点（tagName 小写 'a'）不带 target=_blank / rel=noopener noreferrer——D-21 tabnabbing 加固分支可绕过；XSS 主防线不受影响（SVG 分支下 javascript:/data: href 仍被清除）。选项：修复（tagName === 'A' || node.tagName === 'a' 两行 + attack-samples.json 增补 SVG 锚点样本固化回归）或明示接受
result: pass
verdict: 修复（tagName 大小写两分支 + attack-samples.json 增补 SVG 锚点样本）——登记为 gap 修复项

### 3. 裁决 CR-01：?v= 缓存参数约定语义（评审 Critical，advisory）
expected: index.html:130 钉在 ?v=0.1.7 而根版本 0.1.8；chaos-sc2.mjs:114 另有硬编码 0.1.7 日志。当前无功能影响（0.1.7→0.1.8 pushhub.js 字节未变，实测 81,022B 一致）。选项：机制化（build.mjs 构建期自动注入根版本号，或 CI 断言 index.html ?v= 与根 version 一致）并同步修正 chaos-sc2.mjs；或明示接受"内容变更"语义并改写 README 措辞
result: pass
verdict: 机制化（build.mjs 构建期自动注入根版本号 + 同步修正 chaos-sc2.mjs）——登记为 gap 修复项

### 4. 裁决 WR-02/03/04 加固批次（可选）
expected: WR-02 DOMPurify 默认 profile 放行面收敛（FORBID_TAGS style/form/input/button 等；验证器实测 <style> 示例已被清除，但默认 profile 广度论点仍有效）；WR-03 viewer.js localStorage 读取路径无 try/catch（写入侧有）；WR-04 畸形 serverUrl 使构造函数同步抛异常、查看器 UI 卡"连接中"。选项：批次修复（均为小改动）或登记为 Phase 4/5 前加固项
result: pass
verdict: 批次修复（WR-02 FORBID_TAGS 收敛 + WR-03 读取侧 try/catch + WR-04 畸形 serverUrl 容错）——登记为 gap 修复项

### 5. 背书 14 条 prohibitions（三个 PLAN 的 must_haves.prohibitions）
expected: 机械验证已全部通过，按流程需人工确认各条"未发生"结论成立（依赖恰三项 / 仅 IIFE 单格式 / render 模块仅 marked+dompurify / jsdom 承载断言 / src 零 innerHTML / PING 常量直发 / 协议零复制 / 状态机零平台 API / SYNC_PAGE_MAX 上限 / 宿主零重复 / viewer renderMarkdown 唯一入口 / viewer 零 api 调用 / 文件名无 api 前缀 / CSP 无 unsafe-inline）
result: pass

### 6. MVP 模式格式差异处理
expected: ROADMAP Phase 2 标记 Mode: mvp 但 Goal 非 User Story 格式（user-story.validate → valid: false）。选项：运行 /gsd mvp-phase 2 重排 Goal 为 User Story 格式，或明示接受现状（02-01-PLAN objective 内已有 Goal 的用户故事直译，验证按用户故事完成 User Flow Coverage）
result: pass
verdict: 重排——执行 /gsd mvp-phase 2 将 Goal 改写为 User Story 格式

## Summary

total: 6
passed: 6
issues: 0
pending: 0
skipped: 0
blocked: 0

## Gaps

- gap_id: G-02-2
  truth: "SVG 命名空间锚点（tagName 小写 'a'）与 HTML 锚点同等携带 target=_blank / rel=noopener noreferrer（D-21 加固不可绕过）"
  status: failed
  reason: "User reported: 修复——裁决执行两行修复 + fixture 增补"
  severity: major
  test: 2
  root_cause: "render-markdown.ts afterSanitizeAttributes 钩子判定 node.tagName === 'A' 大小写敏感——HTML 命名空间 tagName 为大写 'A'，SVG 命名空间为小写 'a'，SVG 锚点落入 else 分支不设 target/rel（D-21 加固可绕过；XSS 主防线不受影响）"
  artifacts:
    - path: "packages/web-sdk/src/render/render-markdown.ts"
      issue: "afterSanitizeAttributes 判定 node.tagName === 'A' 大小写敏感，SVG 命名空间锚点（小写 'a'）绕过 D-21 强制新窗口"
  missing:
    - "tagName === 'A' || node.tagName === 'a' 两分支判定"
    - "attack-samples.json 增补 SVG 锚点样本（如 <svg><a xlink:href=...>）固化回归"

- gap_id: G-02-3
  truth: "index.html ?v= 缓存参数与根 package.json version 恒一致（机制保证，非人工纪律）"
  status: failed
  reason: "User reported: 机制化——裁决 build.mjs 构建期自动注入根版本号并同步修正 chaos-sc2.mjs 硬编码日志"
  severity: major
  test: 3
  root_cause: "?v= 版本号为 index.html 手工硬编码，与根 package.json version 无机制关联——版本推进依赖人工同步（0.1.8 时遗漏），未来 SDK 字节变更时会命中 stale 缓存"
  artifacts:
    - path: "packages/server/public/index.html"
      issue: "line 130 ?v=0.1.7 硬编码，与根版本 0.1.8 脱钩，未来产物变更时存在 stale 缓存机制性风险"
    - path: "packages/web-sdk/scripts/chaos-sc2.mjs"
      issue: "line 114 硬编码 '0.1.7' 日志字符串"
  missing:
    - "build.mjs 构建期自动注入根版本号到 index.html（或等价 CI 断言 ?v= 与根 version 一致）"
    - "修正 chaos-sc2.mjs:114 硬编码版本日志"

- gap_id: G-02-4
  truth: "三项加固落地：DOMPurify 放行面收敛、viewer localStorage 读取防护、畸形 serverUrl 不卡 UI"
  status: failed
  reason: "User reported: 批次修复——三项加固与 G-02-2/G-02-3 同批执行"
  severity: minor
  test: 4
  root_cause: "WR-02: DOMPurify 未配置 FORBID_TAGS，默认 profile 放行 form/input/button 等非聊天语义标签；WR-03: viewer.js localStorage 读取无 try/catch（写入侧有），存储全禁环境抛未捕获异常；WR-04: pushhub.ts 构造函数 new URL(serverUrl) 对畸形输入同步抛异常且无 emitError 路径，查看器 UI 停留'连接中'"
  artifacts:
    - path: "packages/web-sdk/src/render/render-markdown.ts"
      issue: "WR-02：DOMPurify 使用默认 profile，style/form/input/button 等标签默认放行（广度攻击面）"
    - path: "packages/server/public/viewer.js"
      issue: "WR-03：localStorage 读取路径无 try/catch，存储全禁环境脚本中途夭折（写入侧已有防护）"
    - path: "packages/web-sdk/src/pushhub.ts"
      issue: "WR-04：畸形 serverUrl 使构造函数同步抛异常，查看器 UI 卡'连接中'无 error 呈现"
  missing:
    - "WR-02：DOMPurify 配置 FORBID_TAGS（style/form/input/button 等）收敛放行面 + 相应断言"
    - "WR-03：viewer.js localStorage 读取包 try/catch（与写入侧对齐）"
    - "WR-04：构造函数对畸形 serverUrl 容错（emitError 而非同步抛异常），查看器呈现 error 态"

