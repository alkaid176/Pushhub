# PushHub

## What This Is

基于 Cloudflare Worker 免费额度构建的 Webhook 实时通知系统。服务端接收 Webhook 推送并通过 WebSocket 实时分发到多端客户端（Windows 桌面 / 安卓 / 网页 SDK）；支持群聊模式（多人共享同一通知密钥），支持双向通信——客户端可对 Webhook 消息回复（快捷选项或自定义输入，Markdown 格式），回复通过回调 URL 实时送达发送方。面向个人自动化通知、小团队告警群、机器人集成场景。

## Core Value

Webhook 发送方发出的消息，配置了同一通知密钥的所有客户端能实时收到并回复，发送方能实时收到回复——这条链路必须稳定可靠。

## Requirements

### Validated

(None yet — ship to validate)

### Active

- [ ] 服务端运行在 Cloudflare Worker 免费额度上，无服务器成本
- [ ] 分级密钥体系：Admin Key（管理）、Send Key（只发送）、Channel Key（接收+回复），可单独重置
- [ ] 服务端管理页：创建/删除/重置通知密钥（=频道/群）
- [ ] Webhook 发送 API：外部系统 POST 消息（Markdown 格式），可附带快捷回复选项与 callback_url
- [ ] 群聊：多个客户端配置同一 Channel Key，消息互通、成员可见
- [ ] 实时分发：Durable Objects 管理 WebSocket 连接与消息扇出
- [ ] 历史消息：客户端离线再上线可拉取错过的消息（Durable Objects 内置存储）
- [ ] 双向通信：客户端可回复消息（快捷选项由发送方随消息提供，或自定义输入，Markdown 格式）
- [ ] 回调送达：有人回复时，服务端自动把回复 POST 回发送方提供的 callback_url
- [ ] Windows 桌面客户端（Tauri 2）：系统托盘常驻 + Windows 原生通知 + 消息窗口 + 回复
- [ ] 安卓客户端（原生 Kotlin）：系统通知栏 + 消息界面 + 回复
- [ ] 网页 SDK（单文件 pushhub.js）：`<script>` 引入后 `new PushHub(key)` 即可收消息与回复，零依赖零构建
- [ ] 客户端配置极简：只需填服务端地址 + Channel Key 即接入

### Out of Scope

- [iOS 客户端] — v1 不做，无 Mac 开发环境；网页 SDK 可在 iOS Safari 使用作为替代
- [消息加密（E2EE）] — 依赖 HTTPS 传输加密足够 v1 场景；E2EE 复杂度高
- [图片/语音/文件消息] — v1 仅文本 Markdown，多媒体走 URL 链接表达
- [用户账号体系] — 密钥即身份，无注册登录；保持接入零门槛
- [消息已读回执/撤回] — 降低 v1 复杂度，回调只回传回复内容
- [Cloudflare Pub/Sub (MQTT)] — beta 状态且免费额度不明朗，用 Durable Objects 替代

## Context

- **部署环境**：Cloudflare Workers + Durable Objects + KV（密钥元数据）。免费额度：10 万请求/天，DO 免费 tier 支持个人与小型团队使用
- **技术选型依据**：
  - Durable Objects 是 CF 官方推荐的实时通信方案，天然支持 WebSocket hibernation API（省 CPU 时间）+ 内置 SQLite 存储（历史消息），一个 DO 实例 = 一个群的扇出中心
  - Tauri 2：用户有 TopologyConfigTool 成熟经验，包体小、内存低
  - 原生 Kotlin：后台常驻连接和系统前台服务通知最稳定可靠（用户明确选择原生而非 RN）
- **用户已有经验**：Tauri 2 + Rust（TopologyConfigTool）、Expo/RN（HappyMusic）、各类自部署服务
- **本地开发流程**（CLAUDE.md 规则）：本地开发 → 打包传输远程服务器测试 → 版本号迭代 +1；本项目特殊点：**服务端部署目标是 Cloudflare 而非自有服务器**，客户端测试仍走本地 + ADB
- **消息模型**：发送方 POST `{ text(markdown), options?: string[], callback_url?: string }` → 群内所有客户端实时收到；回复 `{ message_id, text | selected_option }` → POST 回 callback_url

## Constraints

- **Tech stack**: 服务端 TypeScript + Cloudflare Workers Runtime（不用 Node 专有 API）— 免费额度内运行
- **Tech stack**: 桌面端 Tauri 2 + Rust + WebView 前端；安卓端原生 Kotlin；网页端单文件原生 JS
- **Budget**: 零成本 — 全部依赖 Cloudflare 免费额度，不引入付费服务
- **Compatibility**: 网页 SDK 必须零依赖零构建，直接 `<script>` 引入可用
- **Performance**: 消息端到端（Webhook POST → 客户端显示）延迟 < 2 秒
- **Security**: 密钥分级（Admin/Send/Channel），任一级泄露可单独重置不影响其他级

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Durable Objects 做实时分发 | CF 官方推荐方案，WebSocket hibernation 省 CPU，内置 SQLite 存历史消息，免费额度可用 | — Pending |
| 回复送达用回调 URL（非轮询） | 实时、无状态，最适合自动化系统；发送方随消息附带 callback_url | — Pending |
| 快捷回复选项由发送方随消息提供 | 发送方最清楚该消息适合哪些回复选项（如"确认/忽略"），客户端只渲染不预设 | — Pending |
| 分级密钥 Admin/Send/Channel | 泄露可单独重置；Send Key 可交给发通知的脚本而不暴露频道控制权 | — Pending |
| 安卓端选原生 Kotlin（非 RN） | 后台常驻 WebSocket + 前台服务通知，原生最稳定可靠 | — Pending |
| 历史消息存 DO 内置存储 | 不引入 D1/R2 额外复杂度，单群内查询天然高效 | — Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-08-26 after initialization*
