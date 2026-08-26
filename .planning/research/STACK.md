# Stack Research — PushHub

**Domain:** Webhook 通知 + 实时群聊系统（Cloudflare Workers 服务端 + 三端客户端）
**Researched:** 2026-08-26
**Verification method:** 版本号全部经 npm / crates.io / Maven Central registry API 实时查询确认；Cloudflare 限额直接读取官方文档页（更新日期 2025-07 至 2026-07）并多页交叉核对。

---

## Server — Cloudflare Workers + Durable Objects + KV

### 免费额度硬数据（已核实，规划容量的依据）

| 维度 | 免费额度 | 对 PushHub 的意义 |
|------|---------|------------------|
| Workers 请求 | **100,000 次/天**（UTC 午夜重置） | 每个 Webhook POST、每个 WS 握手、每次管理页 API 调用都算 1 次 |
| Workers CPU | 10 ms / 次调用 | 消息扇出（JSON parse + SQLite insert + N 个 ws.send）远够 |
| Workers 内存 | 128 MB / isolate | 无压力 |
| DO 请求 | **100,000 次/天**（含 HTTP、RPC、**每条入站 WS 消息**、alarm） | 群聊消息量充足；文档称计费口径入站 WS 按 20:1 折算，但免费层限额是否同样折算**未明确**——按 1:1 保守规划 |
| DO 时长 | 13,000 GB-s / 天 | **必须用 Hibernation API**，否则 accept() 期间持续计时长 |
| DO SQLite 读 | 5M 行/天 | 拉历史消息无压力 |
| DO SQLite 写 | **100,000 行/天** | 每条消息约 1-2 行写入（消息 + 可选成员/游标），与请求限额同级瓶颈 |
| DO 存储 | 账户共 5 GB（单 DO 上限 10 GB） | 纯文本 Markdown 历史足够；需做保留期清理（alarm 定期删旧消息） |
| DO 类数量 | 100 个类（Free） | 一个 `ChatRoom` 类 + 可能一个 `Registry` 类，远够 |
| KV 读/写 | 100,000 读/天；**1,000 写/天**；同 key 1 写/秒；**cacheTtl 最小 60 秒** | KV 只放密钥元数据（低写频）。注意：KV 最终一致 + 最小 60s 缓存 → **重置密钥后最长约 1 分钟才全局生效** |
| Static Assets | **请求免费且不限量**，20,000 文件 × 25 MiB | 管理页 + pushhub.js SDK 由同一 Worker 的静态资产托管，**不消耗每日 10 万请求额度**（前提：资产直接命中、不触发 Worker 运行，即不开 `run_worker_first`） |

### 推荐技术栈

| Choice | Version | Rationale | Confidence |
|--------|---------|-----------|------------|
| wrangler | **4.126.0**（registry 实查） | 当前主线大版本；配置用 `wrangler.jsonc`；DO 需 `new_sqlite_classes` 迁移声明 | HIGH |
| TypeScript 设置：`wrangler types` | wrangler 4.126.0 内置 | CF 官方现推荐用 `wrangler types` 从 bindings 生成 `worker-configuration.d.ts`，**取代**手动装 `@cloudflare/workers-types`（v5 起只暴露最新运行时类型） | HIGH |
| TypeScript | **7.0.2**（registry 实查，原生移植版已是 latest） | 新项目直接用最新 stable；若个别工具链不兼容再退回 5.9.x | MEDIUM |
| Durable Objects 基类 | `import { DurableObject } from "cloudflare:workers"` | 官方推荐写法；`this.ctx.acceptWebSocket()` + `webSocketMessage/webSocketClose/webSocketError` 处理器即 Hibernation API | HIGH |
| WebSocket Hibernation API | 运行时内置 | 核心省额度手段：空闲时 DO 休眠、连接保持、来消息自动唤醒不计时长；协议层 ping/pong 由运行时自动应答且**不唤醒 DO** | HIGH |
| `state.setWebSocketAutoResponse()` | 运行时内置 | 应用层心跳保活：客户端发 `{"type":"ping"}` 自动回 pong，**零计费零唤醒**——客户端 keepalive 必须走这条路 | HIGH |
| `serializeAttachment/deserializeAttachment` | 运行时内置 | 每连接状态（client name、last_seq）跨休眠存活；上限 2048 字节，更大放 SQLite | HIGH |
| DO 存储：SQLite backend | `ctx.storage.sql` | Free 计划**只支持** SQLite-backed DO；历史消息表天然单群单库查询；SQL 限额：单行 2 MB、语句 100 KB、绑定参数 100 | HIGH |
| Workers KV | 运行时内置 | 密钥元数据（Admin/Send/Channel key → channel DO name 映射）：读多写少完美匹配 KV 免费额度；写仅发生在建群/重置 | HIGH |
| 静态资产（管理页 + SDK 分发） | wrangler `assets` 字段 | 请求免费不限量，省下每日额度给 API；`/pushhub.js` 直接从这里出 | HIGH |
| 消息协议校验 | 手写 TS 类型 + 轻量运行时校验 | 消息体就 4 个字段（text/options/callback_url/message_id），不值得引 zod（省包体；3 MB 限额虽宽但无意义加依赖） | MEDIUM |
| 回调送达（回复 → callback_url） | Worker/DO 内 `fetch()` | 无状态 POST，成功即完；失败重试 1 次 + 写一条失败日志行即可（不引 Queues） | HIGH |

### 关键 API 事实（写代码时的依据）

- 一个 DO 实例 = 一个群的扇出中心；**无硬性连接数上限**（官方称单实例可连数千客户端），实际瓶颈是单线程吞吐（软上限 1,000 请求/秒/DO）。
- 入站 WS 消息上限 **1 MiB**（接收方向）；出站批量扇出建议合帧（batching）以减少运行时切换开销。
- Hibernation **只对入站（服务端 accept 的）连接生效**；DO 主动外连的 WebSocket 会让 DO 常驻内存——本项目 DO 不需要外连 WS，回调用 fetch 即可。
- **每次部署新版本会断开所有 WebSocket 连接**——客户端重连逻辑是三端必备，不是可选项。
- 高频场景官方建议把多条逻辑消息打包进一个 WS 帧发送。

### Do NOT use（Server）

| 不要用 | 原因 |
|--------|------|
| `@cloudflare/workers-types` 手动安装 | 已被官方流程取代（`wrangler types` 生成）；已知与 vitest-pool-workers 存在兼容摩擦（workers-sdk issue #8802） |
| Cloudflare Pub/Sub (MQTT) | PROJECT.md 已排除：beta 状态、免费额度不明朗；DO 方案已确定 |
| D1 / R2 | 历史消息单群内查询用 DO 内置 SQLite 天然高效；D1/R2 增加额外服务与额度核算复杂度，无收益 |
| Cloudflare Queues 做回调重试 | 免费额度内引入额外产品维度；单条回调 fetch + 简单重试足够 |
| KV-backed DO（key-value backend） | **Free 计划不可用**（仅 SQLite-backed） |
| `ws.accept()`（标准 WS API） | 会让 DO 无法休眠，烧时长额度；一律用 `ctx.acceptWebSocket()` |
| 自建轮询/SSE | WS hibernation 就是为此设计的；轮询烧请求额度 |
| Node 专有 API | Workers 运行时不保证支持；PROJECT.md 约束已明确 |

---

## Desktop — Tauri 2 (Windows)

### 推荐技术栈

| Choice | Version | Rationale | Confidence |
|--------|---------|-----------|------------|
| Tauri | **2.11.5**（crates.io 实查） | 用户有 TopologyConfigTool 成熟经验；包体小、内存低、WebView2 免引入浏览器内核 | HIGH |
| Rust 工具链 | 最新 stable（MSVC host triple）；MSRV 1.77.2 | Tauri 2 官方 MSRV 为 1.77.2（刻意保留 Win7 兼容）；日常用最新 stable，Windows 上必须 MSVC 工具链 | HIGH |
| tauri-build | 2.6.3 | 标配 | HIGH |
| 托盘图标 | Tauri 内置 `tray-icon` 功能（tray-icon crate 0.24.2 随附） | Tauri 2 核心自带 `TrayIconBuilder`，不需要单独引 tray-icon crate 或手动 Win32 调用 | HIGH |
| Windows 原生通知 | **tauri-plugin-notification 2.3.3** | 官方插件，Windows 走 WinRT Toast，跨平台 API 一致；比 notify-rust（4.18，Linux 向向）更贴合 Tauri 工程结构 | HIGH |
| 托盘窗口定位 | tauri-plugin-positioner 2.3.3（可选） | 托盘点击弹出窗口贴任务栏定位，官方插件开箱即用 | MEDIUM |
| WebSocket 客户端 | **tokio-tungstenite 0.30.0**（crates.io 实查） | Rust 生态事实标准异步 WS 客户端；**无内置自动重连**——自己写指数退避 + 抖动重连循环（~100 行），这正是核心业务逻辑，必须自控 | HIGH |
| 异步运行时 | tokio（current 1.x） | tokio-tungstenite 的默认配套；Tauri 2 自身也用 tokio | HIGH |
| 序列化 | serde 1.0.229 + serde_json 1.0.151 | 与服务端消息协议一一对应的类型定义；脱面板数据交换标准 | HIGH |
| 前端（聊天窗口） | **Vite + 原生 TypeScript（无框架）** | 聊天窗口 UI 形态极简（消息列表 + 输入框 + 快捷回复按钮），手写 `render()` 足够；**关键收益：聊天渲染模块可与 web-sdk 共用同一份 vanilla TS 代码**（Markdown 渲染 + sanitize + 消息列表），两端一份逻辑两处复用 | MEDIUM |
| 配置存储 | tauri-plugin-store 或直接 `%APPDATA%` JSON 文件 | 就两项配置（服务端地址 + Channel Key），JSON 文件最省；插件化亦可 | MEDIUM |
| 单实例 | tauri-plugin-single-instance | 常驻托盘应用标准需求，防止双开 | HIGH |

### Do NOT use（Desktop）

| 不要用 | 原因 |
|--------|------|
| Electron | 包体 100MB+ / 内存高；用户已明确 Tauri 路线且有经验 |
| notify-rust 做通知 | Windows 上走的是 D-Bus/WinRT 混合路径，非 Tauri 官方插件生态；tauri-plugin-notification 在 Windows 用 WinRT Toast，与 Tauri 权限/能力系统一致 |
| 独立引 tray-icon crate 自建 | Tauri 2 已内聚 tray API，自引 crate 要自己桥接事件循环，纯增复杂度 |
| 重型前端框架（React/Vue 全家桶） | 单窗口聊天 UI 用不上；且会破坏与 web-sdk 共享渲染代码的机会 |
| async-tungstenite / tokio-websockets | 各有场景但非事实标准；tokio-tungstenite 文档、示例、踩坑资料最多 |
| 在前端 WebView 里建 WebSocket | 连接生命周期必须归属 Rust 侧（托盘常驻、窗口可关闭、断线重连由后台任务管理）；前端只做展示与输入，进程才不会被窗口关闭杀掉连接 |

---

## Android — 原生 Kotlin

### 推荐技术栈

| Choice | Version | Rationale | Confidence |
|--------|---------|-----------|------------|
| Kotlin | **2.2.0**（Maven Central 实查） | 当前 stable；K2 编译器成熟 | HIGH |
| AGP | **9.3.2**（Google Maven 实查） | 当前 stable（9.4 尚在 rc）；配 Gradle 最新 LTS | HIGH |
| minSdk / targetSdk | minSdk 26；targetSdk 35（如用 specialUse）或 34（如用 dataSync） | minSdk 26（Android 8）覆盖绝大多数活跃设备 + 通知通道 API；targetSdk 选择与前台服务类型策略联动（见下） | MEDIUM |
| WebSocket 客户端 | **OkHttp 5.5.0**（Maven Central 实查，5.x 已 stable） | `OkHttpClient.newWebSocket()` 内置心跳 ping/pong、连接队列；与 MockWebServer 测试体系同源 | HIGH |
| 前台服务类型 | **`specialUse`**（首选）或 `dataSync` + targetSdk 34（退路） | **关键坑**：Android 15（targetSdk 35+）对 `dataSync` 施加 **每天约 6 小时硬超时**（`onTimeout()` 后强停）。本项目自分发（ADB 安装、不上 Play），`specialUse`（`FOREGROUND_SERVICE_SPECIAL_USE` + manifest 里 `PROPERTY_SPECIAL_USE_FGS_SUBTYPE` 声明用途）无超时、无 Play 审核负担，是常驻 WS 连接的正解 | MEDIUM |
| 通知通道 | `NotificationChannel`（API 26+，minSdk 26 起天然要求） | 每个频道（channel/群）一个通知通道，用户可按群静音 | HIGH |
| POST_NOTIFICATIONS 运行时权限 | API 33+ 必须运行时申请 | Android 13 起通知是运行时权限，**未授权时通知静默丢弃**（不崩溃、无提示）——首次启动流程必须含授权引导；`FOREGROUND_SERVICE` 与 `POST_NOTIFICATIONS` 是两个独立权限 | HIGH |
| UI | 原生 View + Material Components（不引 Compose） | 消息界面 + 回复输入两个界面；View 体系代码量更少、与前台服务样板代码解耦简单；Compose 引入编译链复杂度对两屏应用无回报（若用户偏好 Compose 亦可，纯口味题） | MEDIUM |
| JSON | kotlinx.serialization（Kotlin 原生） | 与 Kotlin 2.2 编译器插件一体化，无反射 | HIGH |
| 依赖注入 | 不引框架（手写单例） | 两个界面的应用，Hilt/Koin 是负资产 | HIGH |

### Do NOT use（Android）

| 不要用 | 原因 |
|--------|------|
| React Native / Expo | PROJECT.md 已决策原生；后台常驻 WS + 前台服务在 RN 下要写原生模块，绕一圈 |
| Firebase Cloud Messaging（FCM）替代长连 | 引入 Google 服务依赖与第三方账号，违背零成本/自托管目标；且 FCM 在国内可达性差 |
| `dataSync` + targetSdk 35+ | 每日 6 小时超时直接杀死常驻连接场景；Android 15 行为变更 |
| WorkManager 替代前台服务 | WorkManager 适合延迟/周期任务，不适合需要毫秒级收消息的常驻连接；可作为超时后的重启兜底（`specialUse` 下不需要） |
| `PEOPLE`/`remoteMessaging` 等其他 FGS 类型 | 各有严格准入条件，不适合本项目语义 |
| EventBus / RxJava | OkHttp WS 回调 + LifecycleService 足够；引响应式框架纯属增复杂度 |

---

## Web SDK — 单文件 pushhub.js

### 推荐技术栈

| Choice | Version | Rationale | Confidence |
|--------|---------|-----------|------------|
| 源码语言 | TypeScript，esbuild 打包 | 类型安全 + 零运行时依赖产出 | HIGH |
| 构建器 | **esbuild 0.28.2**（registry 实查） | `esbuild src/index.ts --bundle --minify --format=iife --global-name=PushHub --outfile=dist/pushhub.js` 一条命令出单文件 IIFE，全局暴露 `PushHub`；无构建框架、无运行时 | HIGH |
| 分发格式 | IIFE 单文件（不选 UMD/ESM） | `<script src="pushhub.js">` + `new PushHub(key)` 是需求原文；UMD 的 CommonJS 分支 2026 年无意义，ESM 双文件违背单文件承诺 | HIGH |
| Markdown 渲染 | **marked 18.0.11**（registry 实查） | 持续维护（对比 snarkdown 2.0.0 自 2021 年停更）、语法覆盖全（表格/任务列表/删除线——聊天消息用得上）、低层编译器好裁剪；~40KB min 在单文件场景可接受 | MEDIUM |
| HTML 消毒 | **DOMPurify 3.4.14**（registry 实查） | **必选项**：marked/snarkdown 都不消毒原始 HTML；消息来自任意外部 Webhook 发送方，不消毒 = 存储型 XSS 直通所有客户端。min ~22KB / gzip ~7KB | HIGH |
| WS 重连 | 手写指数退避 + 抖动（~50 行） | 20 年标准模式：`delay = min(cap, base * 2^n) ± jitter`； reconnecting-websocket 等库功能无增益且增加供应链面积 | HIGH |
| 离线补拉 | 重连成功后带 `last_seq` HTTP 拉历史 | 服务端 DO SQLite 已存历史；SDK 只需记录最后 seq | HIGH |
| 心跳 | 应用层 ping → 服务端 `setWebSocketAutoResponse` 自动回 | 零计费保活（服务端不唤醒）；SDK 每 30-60s 发 `{"type":"ping"}`，N 次无 pong 判死线主动重连 | HIGH |

### 单文件体积预算（近似值）

| 组成 | min 后 | gzip 后 |
|------|--------|---------|
| SDK 自身逻辑（连接/重连/渲染 API） | ~6-10 KB | ~3-4 KB |
| marked 18.x | ~40 KB | ~13 KB |
| DOMPurify 3.4.x | ~22 KB | ~7 KB |
| **合计** | **~70 KB** | **~23 KB** |

（体积数字为第三方对比数据的近似值，LOW-MEDIUM 置信；以实际构建产物为准。若最终追求极致体积：snarkdown 2.0.0 约 1-2 KB，可把合计压到 ~30 KB min，代价是语法覆盖与维护性——不建议 v1 妥协。）

### Do NOT use（Web SDK）

| 不要用 | 原因 |
|--------|------|
| markdown-it 15.0.0 | ~100KB+，最重；它的优势（插件生态、CommonMark 严格合规）在 SDK 场景用不上 |
| snarkdown 作为默认 | 2021 年起无维护、语法子集不完整（表格等受限）；省的 40KB 换不来风险 |
| 不带 DOMPurify 直接 innerHTML | 任意外部 Webhook 发送方的 Markdown 含原始 HTML 直通 = 存储型 XSS；这是本域最高危坑 |
| UMD / 双格式打包 | 增大文件、无消费者需要 |
| 重连库依赖（reconnecting-websocket 等） | 核心逻辑必须自控（seq 补拉、退避上限、页面 visibility 事件联动），库反而碍事 |
| React/Preact 等运行时 | SDK 对外只暴露 `new PushHub(key)` + 事件回调，宿主页面的 DOM 结构由接入方决定，SDK 不该带渲染框架 |

---

## Testing

### 推荐技术栈

| Choice | Version | Rationale | Confidence |
|--------|---------|-----------|------------|
| Server 单测/集成 | **@cloudflare/vitest-pool-workers 0.22.0**（registry 实查）+ vitest 4.1.11 | CF 官方测试池：测试跑在真实 workerd 里，**真 DO、真 KV、真 WebSocket**（undici WS 客户端直连测试中的 DO）；`defineWorkersConfig` 从 wrangler 配置生成测试配置；`compatibility_date` 需与 wrangler 一致 | HIGH |
| Server 测试重点 | DO 群聊扇出 / 休眠唤醒后状态恢复 / 密钥鉴权 / 回调 POST | 这四块是核心链路；vitest-pool-workers 对 DO 支持是其存在意义 | HIGH |
| Desktop Rust 逻辑 | `cargo test` + `tauri::test` MockRuntime | 重连状态机写成纯逻辑（输入事件流、输出动作流）即可脱离 Tauri 全覆盖；`#[tauri::command]` 用 mock runtime 测 | HIGH |
| Desktop 前端 | vitest（mock `@tauri-apps/api`） | 与服务端同一测试框架，心智统一 | MEDIUM |
| Desktop E2E | tauri-driver + WebdriverIO（Windows 可用）——**可选，薄层** | 配置成本高、收益边际；v1 用手动冒烟 + Playwright 技能测 web-sdk 页面代替 | MEDIUM |
| Android 单测 | JUnit + **MockWebServer（okhttp 5.5.0 同源，mockwebserver3）** | MockWebServer 原生支持 WS 升级：可模拟服务端断连/乱序/慢消息，是测重连逻辑的标准武器 | HIGH |
| Android 仪器测试 | androidx.test instrumentation（通知出现、FGS 存活） | 通知与前台服务只能真机/模拟器验证；配合 ADB 流程（用户已有 HappyMusic 经验） | HIGH |
| Web SDK | vitest + happy-dom（或真浏览器 Playwright） | DOM 渲染 + 重连时序；最终以 Playwright 技能做真实页面冒烟（用户 CLAUDE.md 指定 Playwright 做网页 UI 测试） | HIGH |

### Do NOT use（Testing）

| 不要用 | 原因 |
|--------|------|
| miniflare 直接拼测试环境 | vitest-pool-workers 已封装（同一团队维护），自己拼 workerd/隔离环境是重复造轮子 |
| Supertest 之类 HTTP mock 测 Worker | 测试必须跑在 workerd 运行时才能暴露 DO/WS/限额边界行为；Node 环境 mock 会漏掉真问题 |
| 手动 ADB/真机作为唯一验证 | 通知权限、FGS 超时等行为可自动化回归；纯手动不可持续 |

---

## Recommended Monorepo Layout

**包管理器：pnpm workspace**（server / web-sdk / 协议类型共享同一 node 生态；desktop 前端也用 node 工具链；android 独立 Gradle 不受影响）。pnpm 的 workspace 协议让 `@pushhub/protocol` 源码级共享而无需发包。

```
PushHub/
├── pnpm-workspace.yaml
├── package.json                # 根：脚本入口（dev/test/build 全局编排）
├── .planning/                  # GSD 计划目录（已存在）
│
├── server/                     # Cloudflare Worker（部署目标：CF，非自有服务器）
│   ├── wrangler.jsonc          #   DO 绑定 + new_sqlite_classes 迁移 + KV 绑定 + assets
│   ├── src/
│   │   ├── index.ts            #   入口：路由（webhook API / ws upgrade / 管理页 API）
│   │   ├── do/
│   │   │   ├── chat-room.ts    #   ChatRoom DO：acceptWebSocket、扇出、SQLite 历史、alarm 清理
│   │   │   └── key-registry.ts #   （可选）密钥管理 DO，或纯 KV 方案
│   │   ├── auth.ts             #   三级密钥校验（KV 读 + 常量时间比较）
│   │   └── callback.ts         #   回复 → callback_url 送达 + 重试
│   ├── public/                 #   静态资产源：管理页 + pushhub.js（部署时静态服务，免费不限量）
│   └── test/                   #   vitest-pool-workers 测试
│
├── web-sdk/                    # pushhub.js 源码工程
│   ├── src/index.ts            #   PushHub 类：连接/重连/心跳/补拉/事件回调
│   ├── build.mjs               #   esbuild IIFE 单文件打包脚本
│   └── test/
│
├── shared/                     # @pushhub/protocol：消息 TS 类型（server 与 web-sdk 共享）
│   └── package.json
│
├── desktop/                    # Tauri 2 Windows 客户端
│   ├── src-tauri/              #   Rust：tokio-tungstenite 连接管理、托盘、通知命令
│   │   └── src/
│   ├── src/                    #   前端：Vite + 原生 TS（复用 web-sdk 的渲染思路/代码）
│   └── package.json
│
├── android/                    # 原生 Kotlin 客户端（Gradle 工程，独立于 pnpm）
│   ├── app/src/main/
│   │   ├── java/…/             #   WsService（specialUse FGS）+ UI
│   │   └── AndroidManifest.xml
│   └── app/src/test/           #   JUnit + MockWebServer
│
└── docs/                       # 接入文档（发送方 curl 示例、SDK 用法）
```

布局要点：
1. **`shared/` 协议包是三端契约**：消息 JSON schema 的 TS 类型定义一处维护，server 与 web-sdk 直接引用；desktop（Rust serde）与 android（kotlinx.serialization）按同一 schema 手工镜像——schema 变更时四端同步是 PR checklist 项。
2. **管理页与 pushhub.js 经 `server/public/` 由 Worker 静态资产托管**——免费不限量请求，接入方 `https://<worker-domain>/pushhub.js` 一行引入。
3. **desktop/src 与 web-sdk/src 共享聊天渲染代码**（Markdown + DOMPurify + 列表渲染）：把渲染模块放 web-sdk 内部导出，desktop 前端作为普通 npm 包引用（workspace 内直链源码）。
4. android 不进 pnpm workspace，CI/脚本层面单独 `gradlew` 编排（符合 CLAUDE.md「本地开发 → ADB 测试」流程）。

---

## Sources

- [Workers Limits（官方，2026-07-28 更新）](https://developers.cloudflare.com/workers/platform/limits/) — 免费层请求/CPU/内存/子请求/静态资产限额
- [Durable Objects Pricing（官方）](https://developers.cloudflare.com/durable-objects/platform/pricing/) — DO 免费层请求/时长/SQLite 行读写限额、20:1 WS 计费比、setWebSocketAutoResponse 免计费
- [Durable Objects Limits（官方）](https://developers.cloudflare.com/durable-objects/platform/limits/) — 单 DO 10GB、100 类（Free）、WS 消息 1MiB、1000 req/s 软上限、SQL 限额
- [Use WebSockets / Hibernation API（官方）](https://developers.cloudflare.com/durable-objects/best-practices/websockets/) — acceptWebSocket、serializeAttachment（2KB）、自动 ping/pong、休眠仅入站连接、部署断连
- [Workers KV Limits（官方）](https://developers.cloudflare.com/kv/platform/limits/) — KV 免费读写限额、同 key 1 写/秒、cacheTtl 最小 60s
- [Static Assets Billing（官方）](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/) — 静态资产请求免费不限量
- [Workers TypeScript 指南（官方）](https://developers.cloudflare.com/workers/languages/typescript/) — wrangler types 取代 workers-types
- Registry API 实查（2026-08-26）：npm（wrangler/typescript/vitest/vitest-pool-workers/marked/markdown-it/dompurify/esbuild/snarkdown）、crates.io（tauri/tauri-build/tauri-plugin-notification/tray-icon/tokio-tungstenite/serde）、Maven Central / Google Maven（okhttp 5.5.0/kotlin 2.2.0/AGP 9.3.2）
- [Foreground service types required（Android 14，官方）](https://developer.android.com/about/versions/14/changes/fgs-types-required)
- [Foreground service timeouts（Android 15，官方）](https://developer.android.com/develop/background-work/services/fgs/timeout) — dataSync 6 小时超时
- [Tauri MSRV 讨论](https://github.com/tauri-apps/tauri/issues/15579) 与 [tauri-cli Cargo.toml](https://github.com/tauri-apps/tauri/blob/dev/crates/tauri-cli/Cargo.toml) — MSRV 1.77.2
- [Tauri v2 Testing（官方）](https://v2.tauri.app/develop/tests/) — MockRuntime / tauri-driver / WebdriverIO
- [vitest-pool-workers 兼容性 issue #8802](https://github.com/cloudflare/workers-sdk/issues/8802)

## Confidence Assessment

| Area | Level | Reason |
|------|-------|--------|
| Server（CF 平台事实与限额） | HIGH | 官方文档页直接读取 + 多页交叉一致 + registry 实查版本 |
| Desktop（Tauri/Rust 选型） | HIGH | crates.io 版本实查 + 官方 MSRV 文档；前端无框架选择为工程判断（MEDIUM 部分已标注） |
| Android（FGS 策略） | MEDIUM | 版本号 registry 实查（HIGH）；specialUse vs dataSync 策略基于官方行为变更文档 + 社区佐证，未经真机验证，进入 Android 阶段时需 spike 确认 |
| Web SDK（库选型） | MEDIUM | 版本号实查（HIGH）；体积数字来自第三方对比（LOW-MEDIUM 近似值） |
| Testing | HIGH | 官方推荐路径明确，版本实查 |

## Gaps to Address（进入对应阶段时补研）

- 免费层 100k/天限额对**入站 WS 消息是否同样适用 20:1 折算**：文档措辞仅明确"billing"。按 1:1 保守设计（实际影响很小：个人/小团队消息量远低于 10 万/天）。
- Android `specialUse` FGS 在 targetSdk 35 + 国产 ROM（MIUI/EMUI 后台管控）下的实际存活表现——Android 阶段首周用真机 spike 验证。
- marked 18 的确切 min/gzip 体积——构建时以产物为准（预算表已给近似值）。
- `wrangler types` 生成文件与 vitest-pool-workers 0.22.0 的兼容性（issue #8802 状态需在 Server 阶段复查，临时退路：手写 `Env` interface）。
