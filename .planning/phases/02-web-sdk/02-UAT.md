---
status: testing
phase: 02-web-sdk
source: [02-VERIFICATION.md]
started: 2026-08-26T17:42:43Z
updated: 2026-08-26T17:42:43Z
---

## Current Test

number: 1
name: Cloudflare dashboard 三角验证（WINDOWS.md #5 唯一开放项）
expected: |
  ① Workers & Pages → pushhub → Durable Objects → Duration：空闲挂 WS 数分钟后平直不增（D-15④ Hibernation 生效回归）
  ② 0.1.7/0.1.8 两次部署的全量断连重连尖峰后回落
  ③ /pushhub.js 请求不出现在 Workers 请求计数曲线（SC4 dashboard 视角终验；标记头对照已给程序化等价证据，此为三角验证）
awaiting: user response

## Tests

### 1. Cloudflare dashboard 三角验证
expected: ① DO Duration 空闲平直不增（D-15④）；② 部署断连重连尖峰后回落；③ /pushhub.js 不进 Workers 请求计数曲线（SC4 终验，~1 分钟）
result: [pending]

### 2. 裁决 WR-01：SVG 锚点绕过 D-21 加固（验证器已实证复现）
expected: render-markdown.ts:54 钩子判定 node.tagName === 'A' 大小写敏感，SVG 命名空间锚点（tagName 小写 'a'）不带 target=_blank / rel=noopener noreferrer——D-21 tabnabbing 加固分支可绕过；XSS 主防线不受影响（SVG 分支下 javascript:/data: href 仍被清除）。选项：修复（tagName === 'A' || node.tagName === 'a' 两行 + attack-samples.json 增补 SVG 锚点样本固化回归）或明示接受
result: [pending]

### 3. 裁决 CR-01：?v= 缓存参数约定语义（评审 Critical，advisory）
expected: index.html:130 钉在 ?v=0.1.7 而根版本 0.1.8；chaos-sc2.mjs:114 另有硬编码 0.1.7 日志。当前无功能影响（0.1.7→0.1.8 pushhub.js 字节未变，实测 81,022B 一致）。选项：机制化（build.mjs 构建期自动注入根版本号，或 CI 断言 index.html ?v= 与根 version 一致）并同步修正 chaos-sc2.mjs；或明示接受"内容变更"语义并改写 README 措辞
result: [pending]

### 4. 裁决 WR-02/03/04 加固批次（可选）
expected: WR-02 DOMPurify 默认 profile 放行面收敛（FORBID_TAGS style/form/input/button 等；验证器实测 <style> 示例已被清除，但默认 profile 广度论点仍有效）；WR-03 viewer.js localStorage 读取路径无 try/catch（写入侧有）；WR-04 畸形 serverUrl 使构造函数同步抛异常、查看器 UI 卡"连接中"。选项：批次修复（均为小改动）或登记为 Phase 4/5 前加固项
result: [pending]

### 5. 背书 14 条 prohibitions（三个 PLAN 的 must_haves.prohibitions）
expected: 机械验证已全部通过，按流程需人工确认各条"未发生"结论成立（依赖恰三项 / 仅 IIFE 单格式 / render 模块仅 marked+dompurify / jsdom 承载断言 / src 零 innerHTML / PING 常量直发 / 协议零复制 / 状态机零平台 API / SYNC_PAGE_MAX 上限 / 宿主零重复 / viewer renderMarkdown 唯一入口 / viewer 零 api 调用 / 文件名无 api 前缀 / CSP 无 unsafe-inline）
result: [pending]

### 6. MVP 模式格式差异处理
expected: ROADMAP Phase 2 标记 Mode: mvp 但 Goal 非 User Story 格式（user-story.validate → valid: false）。选项：运行 /gsd mvp-phase 2 重排 Goal 为 User Story 格式，或明示接受现状（02-01-PLAN objective 内已有 Goal 的用户故事直译，验证按用户故事完成 User Flow Coverage）
result: [pending]

## Summary

total: 6
passed: 0
issues: 0
pending: 6
skipped: 0
blocked: 0

## Gaps
