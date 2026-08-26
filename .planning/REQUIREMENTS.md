# Requirements: PushHub

**Defined:** 2026-08-26
**Core Value:** Webhook 发送方发出的消息，配置了同一通知密钥的所有客户端能实时收到并回复，发送方能实时收到回复——这条链路必须稳定可靠。

## v1 Requirements

Requirements for initial release. Each maps to roadmap phases.

### 服务端核心

- [ ] **SRV-01**: 外部系统可通过 POST /send 发送通知（Send Key 鉴权），载荷含 title、body（Markdown）、可选 priority 标签
- [ ] **SRV-02**: 消息载荷可附带快捷回复选项（string[]，上限 4 个）与 callback_url，随消息分发到客户端
- [x] **SRV-03**: 客户端可通过 WebSocket 连接频道（Channel Key 鉴权），同频道新消息实时扇出到所有在线连接
- [ ] **SRV-04**: WebSocket 使用 DO Hibernation API（ctx.acceptWebSocket），空闲连接不计活跃时长
- [ ] **SRV-05**: 消息持久化到 DO SQLite，每频道维护单调递增 seq；客户端重连/上线时通过 since 游标补拉错过的消息
- [ ] **SRV-06**: 群聊语义：多个客户端连同一频道，消息互通、成员变更不丢消息
- [x] **SRV-07**: 消息协议含版本字段，三端客户端实现不漂移

### 密钥与安全

- [ ] **KEY-01**: 三级密钥体系：Admin Key（管理操作）、Send Key（只发送）、Channel Key（接收+回复）
- [ ] **KEY-02**: Web 管理页（Admin Key 登录）可创建/删除/重置频道及其密钥
- [ ] **KEY-03**: 每频道可创建多个 Send Key，可单独吊销——不同脚本/系统用不同 Key，泄露不互伤
- [ ] **KEY-04**: 任一级密钥可单独重置，重置后旧密钥立即失效（Channel Key 重置不丢失频道历史）
- [ ] **KEY-05**: 每 Send Key 每分钟限发 30 条（可配置），超限返回 429
- [ ] **KEY-06**: 回调请求带 PushHub-Message-Id 与签名头，发送方可验签防伪造回调

### 双向通信

- [ ] **RPL-01**: 客户端可回复消息：快捷选项（发送方随消息提供）或自定义文本输入
- [ ] **RPL-02**: 回复内容以 Markdown 格式传输与渲染
- [ ] **RPL-03**: 有人回复时，服务端自动把回复 POST 回发送方随消息提供的 callback_url
- [ ] **RPL-04**: 回调送达失败时自动重试（指数退避，有上限），最终失败记录可查
- [ ] **RPL-05**: answered 状态同步：消息被回复后，群内所有客户端实时看到该消息已回复及回复内容，防止重复处置

### Windows 桌面客户端（Tauri 2）

- [ ] **WIN-01**: 应用驻系统托盘常驻，关闭窗口不退出
- [ ] **WIN-02**: 新消息弹出 Windows 原生通知，点击通知打开消息窗口
- [ ] **WIN-03**: 消息窗口：消息列表（Markdown 渲染、已消毒）、快捷选项按钮、自定义回复输入框
- [ ] **WIN-04**: WebSocket 连接运行在 Rust 核心（tokio-tungstenite），窗口关闭不断线；断线自动重连（指数退避+jitter）
- [ ] **WIN-05**: 重连后自动补拉离线期间的消息
- [ ] **WIN-06**: 配置界面：填服务端地址 + Channel Key 即接入

### 安卓客户端（原生 Kotlin）

- [ ] **AND-01**: 前台服务维持 WebSocket 连接（specialUse/dataSync 类型），锁屏不断线
- [ ] **AND-02**: 新消息弹系统通知栏通知（含 POST_NOTIFICATIONS 运行时权限申请），点击进入消息界面
- [ ] **AND-03**: 消息界面：消息列表（Markdown 渲染、已消毒）、快捷选项按钮、自定义回复输入框
- [ ] **AND-04**: 断线自动重连 + 重连后自动补拉离线消息
- [ ] **AND-05**: 配置界面：填服务端地址 + Channel Key 即接入
- [ ] **AND-06**: 在主流国产 ROM（MIUI/EMUI 至少各一台真机）上锁屏 8 小时仍能收到通知（电池优化白名单引导）

### 网页 SDK

- [ ] **WEB-01**: pushhub.js 单文件分发（零依赖零构建），`<script>` 引入后 `new PushHub(serverUrl, channelKey)` 即可使用
- [ ] **WEB-02**: SDK 实时接收频道消息并通过回调/事件暴露给宿主页面
- [ ] **WEB-03**: SDK 支持宿主页面发起回复（快捷选项或自定义文本）
- [ ] **WEB-04**: SDK 内置断线重连（指数退避+jitter）与离线补拉，宿主无感
- [ ] **WEB-05**: SDK 提供消息渲染辅助（Markdown 渲染 + DOMPurify 消毒），也可仅暴露原始数据由宿主自行渲染

### 管理页与测试页

- [ ] **ADM-01**: 管理页：Admin Key 登录，频道列表/创建/删除
- [ ] **ADM-02**: 管理页：密钥管理（查看/重置/吊销 Send Key、重置 Channel Key）
- [ ] **ADM-03**: 管理页：频道消息历史查看（排障用）
- [ ] **ADM-04**: 测试页：可视化发消息（构造 title/body/options/callback_url）、看实时消息流、发起回复——三端联调与协议排障工具
- [ ] **ADM-05**: 管理页与测试页由 Worker 静态资源托管（免费、不占请求额度）

## v2 Requirements

Deferred to future release. Tracked but not in current roadmap.

### 扩展消息

- **EXT-01**: 图片/语音/文件消息（v1 用 URL 链接表达）
- **EXT-02**: 消息撤回与编辑
- **EXT-03**: 已读回执（细粒度，比 answered 更重）
- **EXT-04**: 每用户身份/昵称展示（v1 密钥即身份，所有客户端匿名）

### 平台扩展

- **PLT-01**: iOS 原生客户端
- **PLT-02**: macOS / Linux 桌面客户端（Tauri 天然跨平台，补平台验证）
- **PLT-03**: npm 包形态的 Web SDK（v1 仅单文件 JS）

### 运维增强

- **OPS-01**: 消息保留窗口可配置 + 自动清理任务
- **OPS-02**: 多语言管理页
- **OPS-03**: 频道成员在线状态显示

## Out of Scope

Explicitly excluded. Documented to prevent scope creep.

| Feature | Reason |
|---------|--------|
| 用户账号体系（注册/登录） | 密钥即身份，保持接入零门槛——这是核心差异化 |
| E2EE 端到端加密 | 与回调中继架构矛盾（服务端需读 callback_url）；HTTPS 传输加密对 v1 场景足够 |
| 邮件/短信/电话扇出 | 违反零成本约束（需付费服务） |
| FCM/APNs 推送集成 | 增加外部依赖与配置门槛；v1 靠前台服务/常驻连接达成实时性 |
| 服务器自部署形态（Docker） | 明确选择 Cloudflare Workers 免费额度路线，不维护双部署目标 |
| 附件上传存储 | R2 免费额度有限且增加复杂度；URL 链接已满足 v1 场景 |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| SRV-01 | Phase 1 | Pending |
| SRV-02 | Phase 1 | Pending |
| SRV-03 | Phase 1 | Complete |
| SRV-04 | Phase 1 | Pending |
| SRV-05 | Phase 1 | Pending |
| SRV-06 | Phase 1 | Pending |
| SRV-07 | Phase 1 | Complete |
| KEY-01 | Phase 1 | Pending |
| KEY-05 | Phase 1 | Pending |
| WEB-01 | Phase 2 | Pending |
| WEB-02 | Phase 2 | Pending |
| WEB-04 | Phase 2 | Pending |
| WEB-05 | Phase 2 | Pending |
| KEY-02 | Phase 3 | Pending |
| KEY-03 | Phase 3 | Pending |
| KEY-04 | Phase 3 | Pending |
| ADM-01 | Phase 3 | Pending |
| ADM-02 | Phase 3 | Pending |
| ADM-03 | Phase 3 | Pending |
| ADM-05 | Phase 3 | Pending |
| RPL-01 | Phase 4 | Pending |
| RPL-02 | Phase 4 | Pending |
| RPL-03 | Phase 4 | Pending |
| RPL-04 | Phase 4 | Pending |
| RPL-05 | Phase 4 | Pending |
| KEY-06 | Phase 4 | Pending |
| WEB-03 | Phase 4 | Pending |
| ADM-04 | Phase 4 | Pending |
| WIN-01 | Phase 5 | Pending |
| WIN-02 | Phase 5 | Pending |
| WIN-03 | Phase 5 | Pending |
| WIN-04 | Phase 5 | Pending |
| WIN-05 | Phase 5 | Pending |
| WIN-06 | Phase 5 | Pending |
| AND-01 | Phase 6 | Pending |
| AND-02 | Phase 6 | Pending |
| AND-03 | Phase 6 | Pending |
| AND-04 | Phase 6 | Pending |
| AND-05 | Phase 6 | Pending |
| AND-06 | Phase 6 | Pending |

**Coverage:**

- v1 requirements: 40 total（注：初始定义时误计为 33，逐条枚举实为 40，已修正）
- Mapped to phases: 40
- Unmapped: 0

---
*Requirements defined: 2026-08-26*
*Last updated: 2026-08-26 after roadmap creation (traceability filled, 40/40 mapped)*
