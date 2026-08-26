# Roadmap: PushHub

## Overview

从 Cloudflare Workers 免费额度上的服务端核心起步，到三端客户端全部落地：Phase 1 冻结线协议（seq 游标、answered 状态、版本字段 + golden fixtures）并跑通消息管道——协议一次定对，四端联动返工成本是单端四倍；Phase 2 用网页 SDK 作为参考客户端，以最低成本端到端验证协议；Phase 3 补齐密钥全生命周期管理；Phase 4 落地旗舰差异化能力——逐消息 callback_url 的回复闭环；Phase 5、6 把已冻结且经实战验证的协议分别移植到 Windows（Tauri 2）与安卓（原生 Kotlin）。每个阶段交付一条用户可观察的端到端能力；免费额度数学（休眠计费、KV 写限、限流）作为架构约束在服务端阶段一次定对。全部 40 条 v1 需求 100% 映射。

## Phases

**Phase Numbering:**

- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [x] **Phase 1: 服务端核心与协议冻结** - POST /send → WS 实时扇出 → 断线补拉的消息管道在免费额度内端到端跑通；线协议 + golden fixtures 冻结 (completed 2026-08-26)
- [ ] **Phase 2: Web SDK 参考客户端** - 单文件 pushhub.js 零依赖接入，重连 + 补拉 + 消毒渲染，作为三端移植的参考实现
- [ ] **Phase 3: 管理页与密钥生命周期** - Admin Key 登录的 Web 管理页：频道增删、多 Send Key、分级重置、消息历史排障
- [ ] **Phase 4: 回复链与回调送达** - 旗舰闭环：快捷选项/自定义回复、answered 状态同步、签名回调 POST + 重试；测试页成为三端联调工具
- [ ] **Phase 5: Windows 桌面客户端（Tauri 2）** - 托盘常驻 + 原生通知 + 消息窗口回复，WS 连接归 Rust 核心、关窗不断线
- [ ] **Phase 6: 安卓客户端（原生 Kotlin）** - specialUse 前台服务 + 通知栏 + 消息界面回复；首周真机 spike 验证国产 ROM 锁屏存活

## Phase Details

### Phase 1: 服务端核心与协议冻结

**Goal**: 外部系统 POST 的通知消息实时送达频道内所有 WebSocket 客户端，断线重连补拉零丢失，且服务端在 Cloudflare 免费额度内运行；线协议（seq 游标、answered 状态字段、版本字段 + golden fixtures）就此冻结
**Mode:** mvp
**Depends on**: Nothing (first phase)
**Requirements**: SRV-01, SRV-02, SRV-03, SRV-04, SRV-05, SRV-06, SRV-07, KEY-01, KEY-05
**Success Criteria** (what must be TRUE):

  1. 发送方以 Send Key 调用 `POST /api/send`（含 title、Markdown body、可选 options 与 callback_url），同频道所有在线 WebSocket 客户端 2 秒内实时收到该消息
  2. 多个客户端连接同一频道消息互通；某客户端离线后重连，通过 since 游标补拉到离线期间全部消息，重复消息按 seq 幂等去重，零丢失零重复
  3. 频道空闲（有挂起的 WS 连接但无消息流量）时，Cloudflare dashboard 的 DO duration 不增长——休眠 API 生效，免费额度不被空闲连接烧掉
  4. 无效或缺失密钥的 /send 请求与 WS 连接被拒绝；单个 Send Key 超过每分钟 30 条限流时收到 429
  5. shared/ 协议包（TS 类型 + golden JSON fixtures，含版本字段）就位，服务端测试对正反例 fixture 全部通过——这是三端移植的契约基线

**Plans**: 5/5 plans executed
Plans:
**Wave 1**

- [x] 01-01-PLAN.md — Walking Skeleton：全栈 tracer 切片（scaffold + /api/send + ChatRoom DO + WS 扇出 + E2E 测试 + 生产部署冒烟）

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 01-02-PLAN.md — 协议冻结：shared 完整类型 + validators + golden fixtures 正反例 + 逐字节契约测试

**Wave 3** *(blocked on Wave 2 completion)*

- [x] 01-03-PLAN.md — 发送侧完整化：校验链（413/400/401 矩阵）+ SRV-02 字段透传 + KEY-05 限流

**Wave 4** *(blocked on Wave 3 completion)*

- [x] 01-04-PLAN.md — 接收侧完整化：sync 补拉（首拉 50/翻页/oldest_kept_seq）+ 保留清理 alarm + 群聊/seq/休眠测试

**Wave 5** *(blocked on Wave 4 completion)*

- [x] 01-05-PLAN.md — 三级密钥闭合：密钥写路径 + Admin API 最小集 + D-15 完整冒烟固化

**Research note**: 建议带研究复查（wrangler types 与 vitest-pool-workers 兼容性 known-issues）；DO 类名（ChatRoom）首版即定终身命名，不可随意改名

### Phase 2: Web SDK 参考客户端

**Goal**: 任何网页引入单文件 pushhub.js 即可实时接收频道消息并安全渲染；SDK 同时是后续 Tauri/Android 移植的参考实现，以及最廉价的端到端协议验证器
**Mode:** mvp
**Depends on**: Phase 1
**Requirements**: WEB-01, WEB-02, WEB-04, WEB-05
**Success Criteria** (what must be TRUE):

  1. 空白 HTML 页仅添加 `<script src="/pushhub.js">` 与 `new PushHub(serverUrl, channelKey)`，通过 `hub.on("message", ...)` 回调即收到实时消息——零依赖、零构建
  2. 服务端重新部署（wrangler deploy）导致全量断连后，SDK 以指数退避 + full jitter（上限 60s）自动重连并补拉离线期间的消息，宿主页面无感知（每次部署即一次免费混沌测试）
  3. 含 `<script>`、`<img onerror>` 等攻击样本的消息经 SDK 渲染辅助输出安全 HTML（marked + DOMPurify 消毒），攻击样本 fixture 回归通过；宿主页面也可选择只接收原始数据自行渲染
  4. pushhub.js 由 Worker 静态资产从服务端域名直接分发，浏览器引入即可用，不产生 Worker 请求计费

**Plans**: TBD
**Research note**: 建议带研究复查（测试栈主题同 Phase 1）；iOS Safari 后台冻结的 visibilitychange 恢复路径需真机验证
**UI hint**: yes

### Phase 3: 管理页与密钥生命周期

**Goal**: 管理员通过浏览器完成频道与三级密钥的全生命周期管理（创建/删除/多 Send Key/分级重置/消息历史排障），无需任何命令行操作；真实客户端大规模接入前的必要前置
**Mode:** mvp
**Depends on**: Phase 1
**Requirements**: KEY-02, KEY-03, KEY-04, ADM-01, ADM-02, ADM-03, ADM-05
**Success Criteria** (what must be TRUE):

  1. 管理员以 Admin Key 登录管理页，可创建、列出、删除频道；创建即获得该频道的 Channel Key 与 Send Key
  2. 单个频道可创建多个 Send Key 并逐个吊销（不同脚本各用各的 Key，泄露不互伤）；重置 Channel Key 后旧密钥的现有连接被立即踢出（DO 内强一致），≤60 秒边缘缓存双活窗口已文档化，频道历史消息完整保留
  3. 管理页可按频道浏览消息历史（含回复状态），作为排障入口
  4. 管理页与测试页均由 Worker 静态资源托管，浏览器访问不产生 Worker 请求调用（dashboard 可验证）

**Plans**: TBD
**UI hint**: yes

### Phase 4: 回复链与回调送达

**Goal**: 核心差异化闭环落地——客户端可回复消息（快捷选项或自定义 Markdown），answered 状态群内实时同步，服务端将回复签名后 POST 回发送方随消息提供的 callback_url 并带重试保障；Web SDK 与测试页补齐回复能力，成为三端协议联调与排障工具
**Mode:** mvp
**Depends on**: Phase 1, Phase 2
**Requirements**: RPL-01, RPL-02, RPL-03, RPL-04, RPL-05, KEY-06, WEB-03, ADM-04
**Success Criteria** (what must be TRUE):

  1. 群内任一客户端点击快捷选项或输入自定义 Markdown 回复后，其余客户端实时看到该消息"已由某人回复：内容"且快捷按钮冻结，防止重复处置
  2. 发送方的 callback_url 实时收到回复 POST，携带 PushHub-Message-Id 与签名头，发送方可验签防伪造回调
  3. 回调目标不可达时服务端按指数退避自动重试（有上限），最终失败记录可在测试页/管理页查询
  4. 测试页可可视化构造消息（title/body/options/callback_url）、观察实时消息流、发起回复——三端联调与协议排障工具就位
  5. 一条真实自动化脚本场景（如"部署完成通知 → 人工点确认 → 脚本收到回调继续执行"）端到端跑通，回调按 message_id 幂等的语义经真实接收方验证

**Plans**: TBD
**Research note**: 回调重试语义需 spike（首答触发 vs 每答触发为 spec 级产品决策）；建议带研究复查
**UI hint**: yes

### Phase 5: Windows 桌面客户端（Tauri 2）

**Goal**: Windows 用户获得托盘常驻的原生客户端：新消息弹系统通知，消息窗口内 Markdown 渲染与回复，WS 连接由 Rust 核心持有、关窗不断线
**Mode:** mvp
**Depends on**: Phase 4
**Requirements**: WIN-01, WIN-02, WIN-03, WIN-04, WIN-05, WIN-06
**Success Criteria** (what must be TRUE):

  1. 用户仅填服务端地址 + Channel Key 即完成接入；应用驻系统托盘，关闭窗口不退出，托盘菜单提供真正的退出项（最小化到托盘与退出为两个明确入口）
  2. 新消息弹出 Windows 原生通知，点击通知打开/聚焦消息窗口并定位到该消息（Windows 通知无操作按钮——点击定位即为设计预期，快捷回复在窗口内完成）
  3. 消息窗口完整参与回复链：Markdown 渲染（复用共享消毒模块）、快捷选项按钮、自定义回复输入框、answered 状态实时可见
  4. WS 连接运行于 Rust 核心（tokio-tungstenite）：关闭消息窗口后通知照常到达；断线自动重连（指数退避 + jitter）并自动补拉离线期间的消息

**Plans**: TBD
**UI hint**: yes

### Phase 6: 安卓客户端（原生 Kotlin）

**Goal**: 安卓用户获得以后台常驻连接为核心的原生客户端：specialUse 前台服务维持 WS、系统通知栏提醒、消息界面回复；国产 ROM 真机存活经首周 spike 验证——最大技术风险最先验证
**Mode:** mvp
**Depends on**: Phase 4
**Requirements**: AND-01, AND-02, AND-03, AND-04, AND-05, AND-06
**Success Criteria** (what must be TRUE):

  1. 阶段首周真机 spike：MIUI 与 EMUI 各一台真机上，specialUse 前台服务 + 电池优化白名单引导下，锁屏 8 小时仍在线并收到通知
  2. 新消息弹系统通知栏通知（首启请求 POST_NOTIFICATIONS 运行时权限，被拒时界面常驻提示"消息不会提醒"），点击通知进入消息界面且深链定位到对应消息
  3. 消息界面完整参与回复链：Markdown 渲染（Markwon，不执行原始 HTML）、快捷选项按钮、自定义回复输入框、answered 状态实时可见
  4. 断线自动重连 + 重连后自动补拉离线消息；配置仅需填服务端地址 + Channel Key 即接入

**Plans**: TBD
**Research note**: 首周真机 spike（specialUse 存活 + MIUI/EMUI 锁屏 8 小时）为本阶段最早验收项，风险前置
**UI hint**: yes

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4 → 5 → 6

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. 服务端核心与协议冻结 | 5/5 | Complete    | 2026-08-26 |
| 2. Web SDK 参考客户端 | 0/TBD | Not started | - |
| 3. 管理页与密钥生命周期 | 0/TBD | Not started | - |
| 4. 回复链与回调送达 | 0/TBD | Not started | - |
| 5. Windows 桌面客户端（Tauri 2） | 0/TBD | Not started | - |
| 6. 安卓客户端（原生 Kotlin） | 0/TBD | Not started | - |
