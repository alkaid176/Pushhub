# Pitfalls Research — PushHub

**Domain:** Cloudflare Workers 上的 Webhook 通知 + 实时群聊（三端客户端）
**Researched:** 2026-08-26
**Verification method:** 平台限额基于 STACK.md 已核实的官方文档；新增事实（免费层突发限额、DO 时长计费基数、Android 13 通知权限与 FGS 行为、tauri-plugin-notification Windows 限制、浏览器 WS 鉴权、国产 ROM 查杀、vitest-pool-workers 已知问题）经官方文档 / 官方 known-issues 页 / 社区多源交叉验证，逐条标注置信度。

---

## 一、Cloudflare 免费额度（额度数学 = 本项目生死线）

### 1.1 非休眠 WebSocket 烧穿 DO 时长预算（最致命的单一坑）
**描述：** DO 时长按「活跃墙钟秒数 × max(实际内存, 128 MB)」计费。免费层每天 13,000 GB-s，换算成活跃秒数 = 13,000 ÷ 0.125 GB = **104,000 活跃秒/天（约 28.9 小时）**。用标准 `ws.accept()`（非 Hibernation API）的 DO 只要连着一个客户端就永不休眠：一个群 24 小时常驻 = 86,400 s × 0.125 GB = **10,800 GB-s = 日预算的 83%**；两个常驻群 = 21,600 GB-s = 166%，免费额度当天耗尽，之后所有 DO 请求直接报错。反之用 `ctx.acceptWebSocket()` 休眠：每条消息唤醒亚秒级，按每天 1 万条消息 × 0.5 s 估算 ≈ 625 GB-s = 日预算的 4.8%，完全无压力。
**Warning signs:** 部署后几小时开始 `Exceeded Durable Object free tier duration limit` 类错误；dashboard 里 DO duration 每小时稳定增长 ~450 GB-s（= 一个常驻 DO）。
**Prevention:** 一律 `ctx.acceptWebSocket()`，禁止 `ws.accept()`（STACK.md 已列入 Do NOT use，代码评审设为硬性检查项）；写一个 vitest 断言：连接空闲 N 秒后 DO 状态应为 hibernated（可通过 `ctx.storage` 不被读写来间接验证）；上线后第一天看 dashboard 的 duration 曲线确认空闲时归零。
**Phase:** 服务端 MVP（第 1 阶段）——验收标准必须包含「空闲群不产生时长计费」。
**Confidence:** HIGH（官方计费公式 + 官方示例算式）

### 1.2 免费层 1,000 请求/分钟突发限额 × 重连风暴
**描述：** 免费层除了 10 万请求/天，还有**账户级 1,000 请求/分钟突发限额**（官方文档已不显眼，社区多源确认仍生效）。每次 `wrangler deploy` 会断开所有 WebSocket——本项目 CLAUDE.md 流程是「每次部署测试版本号+1」，意味着开发期每天都在触发全量断连。若客户端用固定短间隔重试（如 1 秒）：20 个客户端 = 1,200 次升级请求/分钟，立刻撞墙收到 429/503；100 个客户端 = 6,000 次/分钟，且持续失败会进一步加剧重试。附带伤害：每次重连握手 = 1 次 Worker 请求 + 1 次 DO 唤醒。
**Warning signs:** 部署后客户端集中报 429；Cloudflare dashboard 请求速率出现尖刺锯齿。
**Prevention:** 三端统一实现「指数退避 + full jitter，上限 60s」（`delay = random(0, min(cap, base * 2^n))`），把重连代码做成共享算法规范写进协议文档，三端各自实现 + 契约测试；退避后 100 客户端稳态重连 ≈ 1.7 req/s，安全。
**Phase:** 服务端 MVP + 首个客户端（Web SDK）阶段同步实现；早于任何"多客户端"功能。
**Confidence:** MEDIUM-HIGH（突发限额社区确认，官方文档淡化；数学自证）

### 1.3 50 子请求/次调用限制打爆回调扇出
**描述：** 免费层每次 Worker/DO 调用最多 50 个子请求（fetch、DO stub 调用都算）。危险设计模式：在 Worker 入口层循环——一条 webhook 消息扇出到多个 DO、或一次请求里循环发多个回调 POST、或回调失败在循环里重试。50 个很快用完，第 51 个 fetch 抛 `Too many subrequests` 异常。
**Warning signs:** 消息量上来后偶发 `Too many API requests by single worker invocation`；单条消息触发多群/多回调时报错。
**Prevention:** 架构上保证**每次调用子请求个位数**：Worker 入口只做 1 次 KV 鉴权读 + 1 次 DO stub fetch；回调 POST 在 DO 内执行（每个 DO 调用独立拥有 50 配额，且一次只发 1 个回调）；重试上限 1 次、串行不循环展开。写进服务端架构约束文档。
**Phase:** 服务端 MVP（回调功能的实现阶段）。
**Confidence:** HIGH（官方 limits 页 + STACK.md 已核实）

### 1.4 KV 最终一致性 + 最小 60s 缓存：重置密钥后旧密钥仍有效约 1 分钟
**描述：** KV 写入最长 60 秒才传播到所有边缘节点，且 KV 读 `cacheTtl` 最小 60 秒。后果一（安全）：Admin 重置 Channel Key 后，被泄露的旧 Key 在最长约 1-2 分钟内**仍然可用**；后果二（开发困惑）：本地 `wrangler dev` 的 KV 是即时一致的——重置立刻生效，测试全绿，上生产后出现"重置了还能连"的灵异现象。
**Warning signs:** 生产环境重置密钥后旧密钥短时间内鉴权通过；本地与生产行为不一致。
**Prevention:** 文档化「密钥轮换存在 ≤60s 双活窗口」为已知行为；对安全敏感操作（删除频道）在 DO 内同时吊销（DO 状态是强一致的，鉴权以 DO 内白名单为最终裁决，KV 只做第一层加速）；绝不用 KV 做需要即时生效的吊销列表。
**Phase:** 服务端 MVP（鉴权设计时）。
**Confidence:** HIGH（官方 KV limits 文档）

### 1.5 KV 1,000 写/天：把 KV 当状态存储
**描述：** 免费层 KV 每天仅 1,000 次写。错误用法：每条消息更新频道元数据、用 KV 做计数器/限流/在线名单——一天几千条消息就写爆，且同 key 限 1 写/秒。
**Warning signs:** KV write 限额曲线逼近 1,000/天；出现 `WRITE_LIMIT_REACHED`。
**Prevention:** KV 只存三样：key→channel 映射、频道元数据、（可选）Admin key 哈希——只在建群/重置时写（每天个位数）。一切高频状态（消息、成员、游标、限流桶）全部进 DO SQLite。写进架构约束。
**Phase:** 服务端 MVP。
**Confidence:** HIGH（官方文档，STACK.md 已核实）

### 1.6 DO SQLite 100,000 行写/天：每条消息的写入行数要精打细算
**描述：** 免费层 DO SQLite 每天共 10 万行写入，和 10 万请求/天同数量级。若每条消息写 3-4 行（消息行 + 成员游标行×N + answered 状态行），实际消息容量骤降至 2.5-3 万条/天；再加上「回复也要扇出+写库」就再打对折。个人/小团队够用，但设计冗余行写入会提前 3-4 倍触顶。
**Warning signs:** dashboard 的 SQLite rows written 与消息量比例 > 2:1。
**Prevention:** 消息表 1 行搞定（seq 用 INTEGER PRIMARY KEY 自增即 rowid，免费）；成员 last_seq 不按成员单独写行——用 attachment（`serializeAttachment`，每连接 ≤2KB）存在连接上；answered 状态用 UPDATE 消息行而非插入新行；alarm 定期清理旧消息时用批量 DELETE 并注意删除也计行数，清理频率别太密（每天 1 次而非每小时）。
**Phase:** 服务端 MVP（表结构设计时一次性定对，后期改表=迁移痛苦）。
**Confidence:** HIGH（官方 pricing 页）

### 1.7 每次部署断开所有 WebSocket（开发期每天都在发生）
**描述：** `wrangler deploy` 替换 isolate，所有进行中的 WS 连接（含休眠中的）全部断开。这不是边缘情况——本项目用户工作流就是频繁部署测试。若客户端没有重连+补拉，每次部署后所有端变哑巴直到手动刷新/重启。
**Warning signs:** 每次部署后客户端收不到消息，直到重启应用。
**Prevention:** 把「重连 + 带 last_seq 补拉」视为三端客户端的**第一等公民功能**而非增强项，Web SDK 的第一个迭代就要做；把每次部署当作免费的混沌测试——部署后 10 秒内观察客户端自动恢复并补拉到漏掉的消息。
**Phase:** 服务端 MVP + Web SDK 首个迭代。
**Confidence:** HIGH（官方 WebSocket 文档，STACK.md 已核实）

### 1.8 10ms CPU 上限：服务端别渲染 Markdown
**描述：** 免费层每次调用 10ms CPU。消息扇出（JSON parse + 1 行 SQLite insert + N 次 ws.send）远够；但如果哪天想"顺手"在服务端渲染/清洗 Markdown、做复杂校验、大 payload 多次序列化，就会超限（超限调用被杀，连接抖动）。
**Warning signs:** 大消息（几十 KB）时偶发 1102/worker 超时错误。
**Prevention:** 服务端定位为**哑管道**：存储原文 + 原文扇出 + 原文回调，渲染和清洗全部在客户端做；入口处限制消息体大小（见安全节）。
**Phase:** 服务端 MVP（架构原则）。
**Confidence:** HIGH（官方 limits + 工程判断）

---

## 二、WebSocket（协议与实现）

### 2.1 浏览器 WS 无法带 Authorization 头：密钥放查询串 = 泄露进日志
**描述：** 浏览器 `new WebSocket(url)` 只能传 url 和 subprotocol，不能设自定义头。把 Channel Key 放 `wss://host/ws?key=xxx` 查询串：URL 会进 CF 访问日志、Logpush、代理日志、错误上报（浏览器历史其实不记 WS URL，主要泄露面是服务端/中间层日志）。Webhook POST 方（curl/脚本）没有此限制，应走 `Authorization` 头。
**Warning signs:** 代码评审发现鉴权信息出现在 URL；日志系统里出现带 key 的完整 URL。
**Prevention:** 分两端处理——Webhook API 一律 `Authorization` 头；WS 连接采用**首帧鉴权**：客户端先连 `wss://host/ws`，连上后第一帧发 `{"type":"auth","key":"..."}`，服务端校验失败即 close(4001)。若担心未鉴权连接白白唤醒 DO，可在 Worker 入口层先用 KV 校验（详见安全 5.3 的折中方案）。备选：Sec-WebSocket-Protocol 技巧（key 作为子协议值传，走头不走 URL），但服务端响应头必须回显选中的子协议，否则浏览器握手失败——实现细节多，v1 不推荐。
**Phase:** 服务端 MVP（WS 协议设计）+ Web SDK 首迭代。
**Confidence:** HIGH（WebSocket 规范 + 多源社区验证）

### 2.2 DO 内存状态在休眠/驱逐后丢失（DO 第一大坑）
**描述：** DO 休眠或被运行时驱逐后，类字段（`this.members`、`this.lastSeq` 等内存状态）**全部丢失**，唤醒后是全新实例。经典错误：把成员列表、频道配置存在内存 Map 里——`wrangler dev` 本地实例常年温热不驱逐，测试全过；上生产后偶发"成员列表空了""频道配置丢了"，且无法稳定复现。
**Warning signs:** 生产环境偶发状态丢失但本地永远复现不了；代码里 DO 类有非派生的实例字段且未从存储重建。
**Prevention:** 铁律：**DO 内存字段一律视为缓存**，每次 handler 入口先重建状态：连接列表来自 `this.ctx.getWebSockets()`（休眠连接也能拿到句柄），每连接元数据来自 `deserializeAttachment`，持久数据来自 SQLite。代码评审检查项：DO 类字段必须能在任意时刻从这三源重建。
**Phase:** 服务端 MVP（ChatRoom DO 实现时）。
**Confidence:** HIGH（官方 best-practices 文档 + 社区高频踩坑）

### 2.3 Hibernation API 的限制清单
**描述：** 休眠 API 有若干易踩的边角：① `acceptWebSocket()` 必须在创建连接的那个 fetch 请求处理期内调用，不能延后异步再 accept；② attachment 上限 2,048 字节，超了直接抛错（大状态放 SQLite）；③ `setWebSocketAutoResponse` 只能回**静态预置响应**，不能执行逻辑（对 ping 场景刚好够用）；④ 休眠只对**入站**连接生效，DO 主动外连的 WebSocket 会让 DO 常驻计费（本项目不需要外连 WS）；⑤ 向已断开客户端的休眠 socket `send()` 不会同步抛错，坏连接要靠 close 事件回收。
**Warning signs:** `acceptWebSocket` 在 setTimeout/异步回调里调用报错；attachment 序列化异常；扇出后部分客户端永远收不到但服务端无报错。
**Prevention:** 把这五条写进服务端实现 checklist；扇出循环对每个 `ws.send()` 包 try/catch 并在 close 事件里清理；心跳客户端侧判 pong 超时（服务端 auto-response 不产生可见回执日志，客户端必须自己计时）。
**Phase:** 服务端 MVP。
**Confidence:** HIGH（官方 WebSocket/Hibernation 文档，STACK.md 已交叉核实）

### 2.4 假设 WS 送达可靠（无 ack、无序保证、半开连接）
**描述：** 三种典型错觉：① "send() 成功 = 客户端收到了"——TCP 半开时 send 照样不抛错；② "断线了会触发 onclose"——iOS Safari 后台冻结、NAT 超时后连接黑洞化，close 事件可能几分钟不触发甚至永远不触发，`readyState` 还停在 1；③ "重连后状态自然对齐"。把业务逻辑建立在这三个假设上 = 消息静默丢失。
**Warning signs:** 客户端代码里没有心跳超时逻辑；测试只用正常断网（能触发 close）而没模拟黑洞。
**Prevention:** ① 不做逐条 ack（复杂度不值），改用**游标对账模型**：服务端先写库再扇出（write-ahead），客户端记录 last_seq，重连/心跳超时后带 last_seq 补拉，重复消息按 seq 幂等去重——这一个模型同时解决丢消息、重复消息、半开连接三个问题；② 三端心跳：每 30-60s 发 `{"type":"ping"}`（服务端 auto-response 免费回），连续 2-3 次超时即主动 close+重连；Android 端另配 OkHttp `pingInterval(15s)` 协议层心跳。
**Phase:** 协议设计（服务端 MVP 之前/同期）——seq/游标是协议第一设计决策。
**Confidence:** HIGH（WebSocket 通用工程实践）

### 2.5 iOS Safari 后台冻结 WebSocket（Web SDK 在 iOS 上的现实）
**描述：** PROJECT.md 明确网页 SDK 是 iOS 的替代方案，但 iOS Safari 切后台会冻结页面 JS、挂起 WS；回前台后 socket 常处于"看着 OPEN 实际已死"的半开状态。锁屏、切 App、左右滑切换标签页都会触发。不做处理 = iPhone 用户每次切走再回来就收不到消息。
**Warning signs:** iOS Safari 上切后台 30 秒再回来，消息不再到达，刷新页面才恢复。
**Prevention:** SDK 监听 `visibilitychange`：进入后台记时间戳；回到前台时若后台时长 > 心跳间隔，不等心跳超时，立即主动 close + 重连 + 补拉；`pageshow`（bfcache 恢复）走同样路径。
**Phase:** Web SDK 阶段（用真 iOS 设备或 Playwright 模拟验证）。
**Confidence:** HIGH（Safari 行为社区广泛记录）

---

## 三、Android（原生 Kotlin）

### 3.1 国产 ROM 杀前台服务（MIUI/EMUI/ColorOS——用户在中国，必踩）
**描述：** 即使是合规的前台服务 + 常驻通知，MIUI/EMUI 等国产 ROM 的省电管控照样杀——通常在锁屏后几十分钟或夜间。这不是 bug 是特性：MIUI 需要「自启动」权限 + 电池 saver 设「无限制」；EMUI 需要在「应用启动管理」关闭"自动管理"并手动开三个开关（自动启动/关联启动/后台活动）。原生 AOSP 行为完全正常 → 开发时模拟器一切正常，用户真机隔夜必死。
**Warning signs:** 模拟器正常、国产真机锁屏几小时后断连；用户反馈"晚上收不到，早上打开才收到一堆"。
**Prevention:** ① 应用内做「保活引导」页：检测 `PowerManager.isIgnoringBatteryOptimizations()`，按厂商给出引导（跳转 `APPLICATION_DETAILS_SETTINGS`，文案引导开自启动/电池无限制/最近任务加锁——参考 dontkillmyapp.com 各厂商页）；② 兜底链：FGS `START_STICKY` + `BOOT_COMPLETED`/`LOCKSCREEN` 广播自启 + `AlarmManager.setAndAllowWhileIdle` 心跳闹钟检测服务死亡并拉起；③ 验收标准必须包含「MIUI/EMUI 真机锁屏 8 小时仍在线」（用户环境正好有国产设备）。
**Phase:** Android 阶段第一周做真机 spike 验证（STACK.md Gaps 已列）。
**Confidence:** HIGH（dontkillmyapp + 各厂商官方设置路径多源一致）

### 3.2 Android 14/15 前台服务类型陷阱：dataSync 每日 6 小时超时
**描述：** Android 14 起前台服务**必须**声明 `foregroundServiceType` 并声明对应权限，缺失直接抛 `MissingForegroundServiceTypeException` 崩溃；Android 15（targetSdk 35+）对 `dataSync` 类型施加**每天约 6 小时硬超时**，`onTimeout()` 后系统强停服务——常驻 WS 连接每天准时断一次。STACK.md 已选 `specialUse`（自分发无 Play 审核负担），此坑的残余风险是：照抄网上 2023 年前的 dataSync 教程。
**Warning signs:** Logcat 出现 FGS 类型异常；targetSdk 35 + dataSync 时服务每天运行 6 小时整后停止（`onTimeout` 回调）。
**Prevention:** 用 `specialUse` + manifest 里 `PROPERTY_SPECIAL_USE_FGS_SUBTYPE` 声明用途（"persistent websocket notification channel"）；声明 `FOREGROUND_SERVICE_SPECIAL_USE` 权限；退路是 targetSdk 34 + dataSync（自分发不受 Play 的 targetSdk 政策约束）。实现 `onTimeout()` 回调即使理论上不触发也写日志——将来政策变化能第一时间看到。
**Phase:** Android 阶段（服务骨架实现时）。
**Confidence:** HIGH（Android 官方行为变更文档；specialUse 策略 MEDIUM，待真机验证）

### 3.3 POST_NOTIFICATIONS 被拒 = 静默失败（服务活着，通知隐形）
**描述：** Android 13+ 通知是运行时权限。被拒后：前台服务**照常运行、WS 照常收消息，但所有通知（含 FGS 常驻通知）不再显示**——用户以为 App 坏了/被杀了，实际连接活得好好的。更阴险的是用户不会主动联想到权限：症状是"收不到通知"，诊断方向全错。另注意 `FOREGROUND_SERVICE` 与 `POST_NOTIFICATIONS` 是两个独立权限。
**Warning signs:** 真机测试时通知栏无任何通知但 Logcat 显示消息正常到达；`areNotificationsEnabled()` 返回 false。
**Prevention:** 首启引导流程第一步请求 `POST_NOTIFICATIONS`（Android 13+）；主界面持续检测 `areNotificationsEnabled()`，被拒时显示常驻提示条（"通知权限未开启，消息不会提醒"）+ 一键跳转设置；拒绝授权路径要进仪器测试。
**Phase:** Android 阶段（首启引导 + 通知实现）。
**Confidence:** HIGH（官方文档 + Stack Overflow 交叉）

### 3.4 WebSocket 放在 Activity 里（旋转屏幕就断线）
**描述：** OkHttp WebSocket 客户端如果由 Activity 持有/创建：旋转屏幕、导航返回、Activity 被回收 → 连接随 Activity 泄漏或断开，重建后还要全套重连+补拉。表现为"转个屏就掉线一次"。
**Warning signs:** WebSocket/client 对象在 Activity 字段里；旋转屏幕后 Logcat 出现重连日志。
**Prevention:** 连接归**前台服务（或进程级单例 Repository）所有**：OkHttp client 与 WebSocket listener 在 Service 内，Activity 通过绑定服务/LifecycleService + StateFlow/LiveData 订阅消息流；Activity 只做展示与输入。这也和 3.1/3.2 的常驻需求天然一致。
**Phase:** Android 阶段（架构设计时定死，不要先做 Activity 版再重构）。
**Confidence:** HIGH（Android 组件生命周期常识）

### 3.5 通知点击深链错乱（点开全是同一条消息）
**描述：** 每个 `NotificationCompat.Builder` 若复用同一个不含消息标识的 PendingIntent：extras 被复用/覆盖，点任何通知都打开最后一条（或第一条）消息；Android 12+ 还有 trampoline 限制（不能从后台广播接收器里直接 startActivity）。
**Warning signs:** 测试连发多条通知，点击不同通知打开同一消息。
**Prevention:** PendingIntent 用消息 seq 作 `requestCode`（区分不同 Intent）+ `FLAG_UPDATE_CURRENT`；Activity 用 `singleTask` + `onNewIntent` 处理路由；通知点击走标准 PendingIntent（这是允许的，trampoline 限制只针对广播中转）；每群一个 NotificationChannel + 消息用同 channel 的 summary 堆叠。
**Phase:** Android 阶段（通知功能实现）。
**Confidence:** HIGH（Android 官方通知指南）

### 3.6 Doze 深度休眠下的网络限制
**描述：** 前台服务在 Doze 下大部分场景保持网络可用，但**深度 Doze + 厂商激进省电**组合仍可能限制后台网络（维护窗口外）。纯 AOSP 上 FGS 一般无恙，叠加国产 ROM 后不可假设"FGS = 永远有网"。
**Warning signs:** 夜间消息延迟到亮屏才集中到达（时间戳与到达时间差大）。
**Prevention:** 申请忽略电池优化（`REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` + 引导弹窗——自分发 App 无 Play 政策顾虑）；心跳闹钟（`setAndAllowWhileIdle`）兼做连接健康检查；服务端消息有 seq 游标，任何延迟最终都能补拉，把"实时"降级为"最终到达"的兜底天然成立。
**Phase:** Android 阶段（与 3.1 同一 spike 验证）。
**Confidence:** MEDIUM-HIGH（官方 Doze 文档 + 真机行为差异大，需 spike）

---

## 四、Tauri 桌面端（Windows）

### 4.1 关窗即退出：托盘常驻的生命周期没接对
**描述：** Tauri 默认所有窗口关闭后 App 退出。要做"托盘常驻"必须同时处理三处：① 窗口 `CloseRequested` 事件里 `api.prevent_close()` + 隐藏窗口；② `RunEvent::ExitRequested` 里阻止退出（macOS 上窗口关闭不退出是系统行为，Windows 上必须显式做）；③ 托盘菜单提供真正的"退出"项。漏一处：要么点 X 就整个退出（连接断），要么永远退不出（进程僵尸）。
**Warning signs:** 点窗口 X 后托盘图标消失/进程退出；或退出菜单无效。
**Prevention:** 三个钩子一起写并在首个桌面迭代手动冒烟；"最小化到托盘"与"退出"做成两个明确入口。
**Phase:** Desktop 阶段第一个迭代（骨架期，别等到功能完成）。
**Confidence:** HIGH（Tauri 2 官方模式）

### 4.2 WS 跑在 WebView JS 里：窗口一隐/一关连接就没了
**描述：** WebView2 对隐藏/最小化窗口会节流 JS 定时器（rAF 停止、setTimeout 变慢），关闭窗口直接销毁 JS 上下文——放在前端 JS 里的 WebSocket 会随窗口"假死"或死亡。聊天窗口可以随时关，但连接必须活着，这从根本上冲突。STACK.md 已定"连接归 Rust 侧"，此坑的残余风险是实现时图省事在前端 `new WebSocket()`。
**Warning signs:** 前端代码里出现 `new WebSocket(`；关闭聊天窗口后通知停止。
**Prevention:** 架构铁律：连接、重连、心跳、补拉全部在 Rust 侧（tokio-tungstenite 任务），通过 Tauri event（`emit`）推给前端渲染，前端只发"回复"命令；前端零连接逻辑意味着窗口随便开关。代码评审硬检查项。
**Phase:** Desktop 阶段（架构设计定死）。
**Confidence:** HIGH（WebView 行为 + STACK.md 已核实决策）

### 4.3 Windows 通知没有操作按钮：官方插件在 Windows 上不支持 Action
**描述：** `tauri-plugin-notification` 的 action buttons / 文本输入（`addActionInput`）是**移动端专属 API，Windows 上不可用**；Windows 桌面上只有标题+正文+图标的基础 Toast。指望"通知上直接快捷回复"在 Windows 落不了地（除非自写 WinRT AppNotificationManager 集成，复杂度爆炸）。另注意官方文档标注 Windows 上通知"仅对已安装的应用生效"——开发期未安装场景 Toast 行为可能不稳，且应用退出后通知点击的激活回调不可靠。
**Warning signs:** 在 Windows 上调用 action 相关 API 无效果/报不支持；产品预期文档里出现"通知内直接回复"。
**Prevention:** 产品预期管理（写进 ROADMAP）：Windows 通知 = 注意力提醒，点击 → 显示/聚焦主窗口并定位到该消息；快捷回复按钮在窗口内渲染。Android 端通知直接回复（RemoteInput）技术上可行但 v1 也统一走点击进 App，保持两端体验一致、砍复杂度。若未来真要 Windows 通知按钮，单独立项评估 WinRT 原生方案。
**Phase:** Desktop 阶段规划期（预期管理）——避免 roadmap 里写出落不了地的验收标准。
**Confidence:** MEDIUM-HIGH（官方文档 + 社区插件生态佐证）

### 4.4 single-instance 插件必须第一个注册（Windows 特有顺序要求）
**描述：** `tauri-plugin-single-instance` 在 Windows 上要求**最先注册**（官方 README 明示），放晚了第二实例检测失效——双开 App = 两条 WS 连接 = 同一客户端收到双份消息 + 通知重复，用户完全无法理解发生了什么。
**Warning signs:** 同时启动两个实例都在运行；用户反馈"每条消息弹两次"。
**Prevention:** builder 链里 single-instance 放第一位（代码注释标明原因）；第二实例回调里向首实例转发启动参数后自行退出。
**Phase:** Desktop 阶段骨架期。
**Confidence:** HIGH（官方插件 README）

### 4.5 自启动与托盘静默启动
**描述：** 常驻通知类应用用户期待开机自启（tauri-plugin-autostart，Windows 写注册表 Run 键）；但自启动若直接弹主窗口很扰人，需要支持启动参数（如 `--hidden`）静默启动到托盘。
**Warning signs:** 无——这是易漏的功能完整项，漏了表现为"重启电脑后收不到通知，要手动开 App"。
**Prevention:** autostart 插件 + args 解析（`std::env::args`）+ 隐藏启动路径；设置页提供自启开关。
**Phase:** Desktop 阶段（打磨期，可在核心链路之后）。
**Confidence:** HIGH（常规工程实践）

---

## 五、Webhook 与安全

### 5.1 开放中继：泄露的 Send Key = 无限垃圾消息推送权
**描述：** Webhook API 本质是"知道密钥就能让所有客户端弹通知"。Send Key 出现在脚本/配置/cron 里，泄露面大；无限流的话，攻击者（或一个失控的循环脚本）可以 24 小时轰炸群内所有设备，还会连带烧光每日请求/写入额度。
**Warning signs:** 额度曲线异常上涨；某 Send Key 短时间内高频 POST；用户抱怨垃圾通知。
**Prevention:** DO 内做**每 Send Key 令牌桶限流**（如 30 条/分钟 + 1,000 条/天，桶状态存 SQLite——KV 写不起）；消息体大小上限（如 64 KB）+ text 字段长度上限；超限返回 429 + 明确文档；Admin Key 可独立重置 Send Key（设计已有）。限流逻辑进 vitest 契约测试。
**Phase:** 服务端 MVP（与 webhook 入口同一迭代——不能"以后再加"）。
**Confidence:** HIGH（通用安全工程）

### 5.2 callback_url 滥用：把 Worker 变成别人的 DDoS 放大器
**描述：** 回复回调会 POST 到**发送方任意提供的 URL**。攻击向量：拿 Send Key 灌消息、callback_url 填受害者地址——Worker 免费替攻击者向任意目标发 HTTP POST（还可借重试机制放大）。Workers 边缘访问不到内网（SSRF 内网风险低），主要风险是放大攻击与额度消耗。
**Warning signs:** 回调目标地址五花八门且高频；回调 fetch 失败率高。
**Prevention:** callback_url 仅允许 `https:`（拒绝 http/其他 scheme）；请求体 ≤ 8 KB；`AbortSignal.timeout(5000)` 超时；重试最多 1 次且总回调量并入 Send Key 限流桶；回调请求带可辨识 User-Agent（`PushHub-Callback/1`）+ 文档声明幂等建议（回调体含 message_id/reply 时间戳，接收方去重）。
**Phase:** 服务端 MVP（回调功能实现时）。
**Confidence:** HIGH（通用安全工程）

### 5.3 未鉴权 WS 连接消耗 DO 唤醒（廉价 DoS 面）
**描述：** 若 WS 鉴权放在 DO 内首帧做：任何人都能免费发起 `wss://host/ws` 握手 → 每次都创建/唤醒 DO（DO 请求 + 时长双重消耗）。脚本狂连可以不碰消息限额直接烧 DO 请求额度。
**Warning signs:** 大量只连接不鉴权的 DO 请求；dashboard DO request 曲线与合法消息量不匹配。
**Prevention:** 分层鉴权：Worker 入口层先校验（KV 查 Channel Key，无效直接 401，**不创建 DO stub**）——这一层校验需要 key 出现在升级请求里（查询串或 subprotocol），存在 2.1 的日志泄露权衡；折中方案：查询串放一次性短暂 ticket？复杂。v1 务实取舍：**查询串带 key + Worker 层 KV 预检 + DO 内最终裁决（强一致）**，日志泄露风险由"CF 日志属自己可控面 + 密钥可独立重置"兜底；文档记录此权衡，未来可升级 ticket 模式。同时给 WS 升级路由加简单 IP 限流（Worker 内存 token bucket，粗粒度即可）。
**Phase:** 服务端 MVP（鉴权分层设计）。
**Confidence:** MEDIUM-HIGH（威胁建模推导，取舍为工程判断）

### 5.4 Markdown XSS：三端渲染全部要消毒，一处不漏
**描述：** 消息正文是**任意外部发送方的 Markdown**，marked 不消毒原始 HTML——`<img onerror>`、`<script>`、`javascript:` 链接直通 innerHTML = 存储型 XSS 打到所有群成员。三端三个渲染路径 = 三个潜在漏点：① Web SDK（浏览器，最直接）；② Tauri WebView2（同样完整 JS 环境，且 XSS 后可能触达 Tauri IPC → 能力配置不严就是任意命令执行）；③ Android（若用 TextView.fromHtml 处理含 HTML 的 markdown 则样式注入/自动图片加载，WebView 渲染则同 ①）。管理页若预览消息还有第四处。
**Warning signs:** 任一端出现 `innerHTML =` 且上游是 marked 输出；Android 用 `HtmlCompat.fromHtml` 处理原始消息；Tauri capabilities 里聊天窗口挂了 shell/fs 等宽权限。
**Prevention:** ① Web SDK 与 Tauri 前端**共用同一份渲染模块**（STACK.md 布局已定）：`DOMPurify.sanitize(marked.parse(text))`，DOMPurify 配置显式白名单，禁 `script/iframe/style`、`on*` 属性、`javascript:` URI；② Android 用 Markwon 渲染到 TextView（span 体系默认不执行 HTML/JS，**不要**开 HtmlPlugin 处理原始 HTML）；③ Tauri 侧纵深防御：聊天窗口 capabilities 收敛到最小集（不含 shell/fs/opener）、`app.security.csp` 配置严格 CSP——即使消毒被绕过也难横向；④ 管理页复用同一消毒模块；⑤ 用一组攻击样本（`<img src=x onerror=alert(1)>` 等）做三端共用的回归 fixture。
**Phase:** Web SDK 首迭代建立消毒模块；Desktop 复用 + capabilities 加固；Android 阶段接 Markwon。
**Confidence:** HIGH（本域最高危坑，DOMPurify 官方推荐用法）

### 5.5 管理页与密钥的存放
**描述：** Admin Key 是最高权限（删频道/重置密钥）。管理页是静态资产托管的 SPA，Admin Key 通常存 localStorage——管理页任何 XSS（比如渲染频道名/消息预览时）直接偷走 Admin Key。密钥哈希若写死在 wrangler.jsonc 里会随仓库泄露。
**Warning signs:** 管理页直接 innerHTML 渲染任何服务端数据；wrangler.jsonc 里出现密钥字面量。
**Prevention:** 管理页所有动态内容过同一消毒模块；Admin Key 哈希走 `wrangler secret put`（secret 不进仓库）；文档明确"Admin Key 只在管理页会话使用、不进脚本"。
**Phase:** 服务端 MVP（管理页实现时）。
**Confidence:** HIGH（通用 Web 安全）

---

## 六、协议设计（一次定对，改起来四端联动）

### 6.1 消息没有服务端分配的 ID/seq：去重、回复、补拉、已答状态全做不了
**描述：** 若消息只带发送方的时间戳/无 ID：无法引用回复（callback 回传时发送方不知道回的是哪条）、无法去重（重连补拉与实时推送重叠时客户端分不清）、无法做已答状态、离线补拉没有游标锚点。**seq 是整个协议的脊柱**，事后加 = 全端数据迁移。
**Warning signs:** 协议 schema 里消息没有服务端分配的单调递增 id；讨论中出现"客户端自己生成 UUID 去重"。
**Prevention:** ChatRoom DO 的消息表用 `seq INTEGER PRIMARY KEY AUTOINCREMENT`（SQLite rowid，零成本单调）；所有消息（含系统事件：加入/已答）都带 seq；客户端持久化 last_seq。协议文档第一页写明。
**Phase:** 协议设计（服务端 MVP 之前的 shared/ 包第一版）。
**Confidence:** HIGH（分布式消息系统标准实践）

### 6.2 没有 answered 状态同步：群聊里三个人都回了"确认"
**描述：** 快捷回复是本项目核心交互。若"谁回过"不广播+持久化：A、B、C 都看到"确认/忽略"按钮，三人各回一次，callback_url 收到三份重复回复——自动化发送方（往往是脚本）最怕这种不确定性。
**Warning signs:** 协议里没有 `answered` 事件/字段；多客户端同开时回复了同一条。
**Prevention:** 消息行加 `answered_by/answered_at/answered_content` 字段；首个回复到达时 UPDATE + 广播 `message_answered` 事件；其余客户端按钮变为"已由 X 回复：确认"；补拉历史时 answered 状态随消息行返回（离线期间被别人回了也能正确展示）；后续回复仍允许（自定义补充）但 UI 明示已有回复。回调体带 `message_id` + 回复序号供发送方判重。
**Phase:** 协议设计 + 服务端 MVP；三端 UI 在各自阶段实现。
**Confidence:** HIGH（群聊交互设计推导）

### 6.3 四端协议版本漂移（TS×2 / Rust / Kotlin 手工镜像）
**描述：** 协议类型在 server 与 web-sdk 间共享 TS 源码，但 Rust（serde）与 Kotlin（kotlinx.serialization）是**手工镜像**——改协议时漏改一端，只有跨端集成时才炸，且症状诡异（字段默认值吞掉、枚举反序列化失败静默丢消息）。三端发布节奏不同，线上长期共存多版本客户端。
**Warning signs:** 改 schema 的 PR 只动了 TS 没动 Rust/Kotlin；某端用 `#[serde(default)]` 把未知字段吞了。
**Prevention:** ① shared/ 包放 **golden JSON fixtures**（每类消息的正例/反例），四个代码库的测试都跑同一份 fixtures（Rust/Kotlin 测试内嵌同目录 JSON）；② 协议带 `v` 版本字段，演进规则：只加字段不改语义、未知字段必须忽略（serde `deny_unknown_fields` **禁用**）；③ schema 变更 PR checklist 固定四项（server/web-sdk/desktop/android）；④ 回调（发给外部发送方）的格式单独版本化——它是公开 API。
**Phase:** 协议设计定 fixtures 机制 + 各端首迭代接入。
**Confidence:** HIGH（多端协议工程标准实践）

### 6.4 回调送达的重复与乱序（发送方视角）
**描述：** 服务端重试机制 + 客户端可能的重复回复，意味着发送方 callback_url 可能收到：同一回复的重复 POST、乱序 POST。发送方若不做幂等（比如"确认"触发一次部署），重复回调 = 灾难。
**Warning signs:** 文档没提幂等；发送方示例代码直接处理回调执行动作。
**Prevention:** 回调体设计：`{message_id, seq, replied_by, text|option, replied_at, attempt}`；重试仅当网络层失败且最多 1 次；文档第一段就写"回调可能重复，按 message_id+replied_by 幂等处理"；示例代码展示去重写法。
**Phase:** 服务端 MVP（回调 API 设计）+ 接入文档。
**Confidence:** HIGH（Webhook 系统标准实践）

### 6.5 1 MiB 入站 WS 消息上限与协议上限不一致
**描述：** 平台层 WS 入站消息上限 1 MiB（STACK.md 已核实），但业务上绝不该接受这么大的聊天消息（CPU/存储/渲染压力 + 骚扰面）。不在协议层早早设小上限，将来就要处理平台 1013/1016 错误与业务校验两层混乱。
**Warning signs:** 协议文档没写消息长度上限；客户端输入框无字数限制。
**Prevention:** 协议规定 text ≤ 8,192 字符、options ≤ 10 项×每项 64 字符、callback_url ≤ 2,048 字符；服务端入口校验超限返回明确错误码；三端输入框前端同步限制。
**Phase:** 协议设计。
**Confidence:** HIGH（平台限制 + 工程判断）

---

## 七、DevOps（wrangler 本地 / 测试 / 迭代）

### 7.1 wrangler dev 本地环境掩盖三个生产差异
**描述：** 本地（miniflare/workerd）与生产的关键差异：① **限额不强制**——10ms CPU、50 子请求、每日额度本地都不管，超限代码本地全绿上线就炸；② **KV 即时一致**——本地 KV 写完立即可读，1.4 的重置延迟窗口本地永远测不出；③ **DO 不驱逐**——本地实例常驻温热，2.2 的内存状态丢失本地几乎无法复现。结论：本地测试通过 ≠ 生产行为正确。
**Warning signs:** 所有测试都只在 `wrangler dev` 跑过；从未看过生产 dashboard 曲线。
**Prevention:** 本项目工作流（每次迭代部署测试版本+1）恰好是最好的对策——**每次部署后做 5 分钟生产冒烟**：连接→发消息→断连重连→补拉→回调；重点看 dashboard 的 DO duration（验证休眠）、request 曲线（验证重连风暴受控）；额度相关代码（限流、批量删除）以生产实测为准。
**Phase:** 全阶段流程规范（写进每个部署迭代的 checklist）。
**Confidence:** HIGH（官方文档 + miniflare 已知行为）

### 7.2 vitest-pool-workers 已知怪癖：测试文件级隔离、DO 内存态不重置、alarm 不隔离
**描述:** 官方 known-issues：① Vitest 4 时代 `isolatedStorage`/`singleWorker` 选项已移除，存储隔离粒度变为**每测试文件**——同文件内前一个测试写的 DO 数据后一个测试还能看到，测试间隐性依赖导致顺序敏感的偶发失败；② DO 的**内存状态（类字段）在同一文件内跨测试保留**，恰好掩盖 2.2 的生产问题；③ **alarm 不随隔离重置**，未触发的 alarm 跨测试泄漏，报 `"Failed to pop isolated storage stack"`；④ `defineWorkersConfig` 的 compatibility_date 必须与 wrangler 配置一致，不匹配时 SQLite-backed DO 类行为漂移出诡异错误；⑤ 静态资产（assets）在测试环境不可用——管理页/SDK 分发路径测不了，只能测 API 路由。
**Warning signs:** 测试偶发失败且与执行顺序相关；出现 "Failed to pop isolated storage stack"；测试里依赖了上个测试建的频道数据。
**Prevention:** 测试设计规范：一个场景一个测试文件（文件级隔离就是场景级隔离）；每个测试自建频道/key 前缀避免碰撞；alarm 相关测试要么等 alarm 全部触发完（await）要么显式删除；compatibility_date 在 defineWorkersConfig 里从 wrangler 配置程序化读取（不手抄）；管理页测试另行用 Playwright 对部署实例做（用户 CLAUDE.md 本就指定 Playwright 做 Web UI 测试）。
**Phase:** 服务端 MVP（搭建测试框架时立规矩）。
**Confidence:** HIGH（官方 known-issues 页 + 迁移指南）

### 7.3 DO 类名迁移是一次性决策
**描述：** `new_sqlite_classes` 声明的类名是对象命名空间的一部分。上线后改类名 = 全新命名空间 = 所有群的 DO 实例与 SQLite 数据"消失"（其实还在旧类名下）；删除类需要显式 `deleted_classes` 迁移。命名随意（`Room1`、临时拼写错误）会变成永久遗产。
**Warning signs:** 想重命名 DO 类的 PR；wrangler 迁移文件堆积。
**Prevention:** 第一版就定稳定类名（`ChatRoom`，可选 `KeyRegistry`）；类名变更视为破坏性操作需专门迁移脚本 + 数据搬迁计划；wrangler 迁移文件进版本控制永不手改。
**Phase:** 服务端 MVP（wrangler.jsonc 首次提交）。
**Confidence:** HIGH（官方迁移文档）

### 7.4 调试可观测性：没有日志的 DO 是黑洞
**描述：** WS 消息链路（webhook→DO→扇出→回调）横跨多个异步边界，出问题时没有任何日志就只能瞎猜。免费层 `wrangler tail` 可用但有采样/速率限制，Workers Logs 免费额度有限——常见结局：上线后第一次"消息没送达"完全无法归因。
**Warning signs:** 出过一次"不知道消息丢哪了"的事故；代码里没有结构化日志点。
**Prevention:** 关键路径埋结构化 `console.log`（json 格式：event, channel, seq, client 数, 耗时）；从第一天开启 Workers Logs（免费额度内低量场景够用）+ 调试时 `wrangler tail --format pretty`；扇出与回调各记一条结果日志（成功数/失败数/重试与否）。
**Phase:** 服务端 MVP。
**Confidence:** MEDIUM-HIGH（官方可观测性工具 + 实践判断，具体免费额度数字未核实）

---

## Top 5 Critical Pitfalls（按「必然踩 + 代价最大」排序）

| # | Pitfall | 一句话后果 | 首要防线 | 应在哪个 Phase 解决 |
|---|---------|-----------|---------|-------------------|
| 1 | 非休眠 WebSocket 烧 DO 时长（1.1） | 一个 24/7 群烧掉 83% 日预算，免费额度当天死 | 只用 `ctx.acceptWebSocket()`，验收含"空闲不计时长" | 服务端 MVP，第 1 迭代 |
| 2 | Markdown XSS 直通三端（5.4） | 任意外部发送方存储型 XSS 打所有群成员 | 共享 DOMPurify 消毒模块 + Markwon + Tauri capabilities/CSP 收敛 | Web SDK 首迭代建立模块，三端复用 |
| 3 | 协议无 seq/游标（6.1 + 2.4） | 丢消息无法补拉、重复无法去重、回复无法引用——核心链路"稳定可靠"承诺落空 | SQLite rowid 作 seq + write-ahead 先写库再扇出 + last_seq 对账模型 | 协议设计，先于一切功能代码 |
| 4 | Android 国产 ROM 杀前台服务（3.1 + 3.2 + 3.3） | 用户真机隔夜必断连且通知静默失败，"收不到"三连 | specialUse FGS + 保活引导页 + 通知权限检测 + 真机 8 小时锁屏验收 | Android 阶段第一周 spike |
| 5 | 重连风暴打爆 1,000 req/min（1.2 + 1.7） | 每次部署（本项目高频）后客户端集体 429，雪崩式断联 | 三端统一指数退避+full jitter（上限 60s），部署当混沌测试验收 | 服务端 MVP + Web SDK 首迭代 |

**贯穿性原则（写给 roadmap）：**
- 免费额度的数学（1.1/1.5/1.6）决定了**架构约束必须写进第一版代码**，不能"先跑起来再优化"——额度类错误上线当天就爆，没有缓冲期。
- 协议三要素（seq、answered 状态、版本字段 + golden fixtures）在第 1 阶段 shared/ 包里一次定对，四端联动的返工成本是单端的四倍。
- 本项目"每次部署测试"的工作流要主动利用：每次部署 = 免费的断连重连混沌测试，冒烟 checklist 固化（连接恢复 + 补拉 + 回调 + dashboard 曲线）。

---

## Sources

- [Cloudflare Workers Limits（官方）](https://developers.cloudflare.com/workers/platform/limits/) — 免费层请求/子请求/CPU 限额（STACK.md 已核实）
- [Cloudflare Durable Objects Pricing（官方）](https://developers.cloudflare.com/durable-objects/platform/pricing/) — 时长计费公式 128MB 基数、13k GB-s/天（含官方算式示例）
- [Cloudflare Community：免费层 429 突发限额讨论](https://community.cloudflare.com/t/outbound-traffic-receives-response-with-429-status-code/188479) — 1,000 req/min 免费层突发限额（MEDIUM-HIGH）
- [Durable Objects WebSocket / Hibernation（官方）](https://developers.cloudflare.com/durable-objects/best-practices/websockets/) — 休眠行为、attachment、部署断连（STACK.md 已核实）
- [Android 13 通知运行时权限（官方）](https://developer.android.com/develop/ui/compose/notifications/notification-permission) + [Stack Overflow：权限被拒时 FGS 行为](https://stackoverflow.com/questions/73067939/start-foreground-service-after-notification-permission-was-disabled-causes-crash) — FGS 存活但通知隐形
- [Android 15 FGS 超时（官方）](https://developer.android.com/develop/background-work/services/fgs/timeout) — dataSync 6 小时限制
- [dontkillmyapp.com](https://dontkillmyapp.com) + [小米官方自启动说明](https://www.mi.com/global/support/faq/details/KA-507611/) + [各品牌后台保活指引](https://help.biolovision.net/Keep_Background_Services_Alive_on_Android_(by_Brand)) — MIUI/EMUI 查杀与白名单路径
- [Tauri v2 Notification 插件（官方）](https://v2.tauri.app/plugin/notification/) — Windows 仅基础 Toast、action 为移动端 API、安装要求
- [WebSocket 鉴权方式综述（websocket.org）](https://websocket.org/guides/authentication/) + [OpenReplay：WebSocket Authentication](https://blog.openreplay.com/websocket-authentication/) — 浏览器无法设 Authorization 头、四种替代方案对比
- [vitest-pool-workers Known Issues（官方）](https://developers.cloudflare.com/workers/testing/vitest-integration/known-issues/) + [Vitest 3→4 迁移指南（官方）](https://developers.cloudflare.com/workers/testing/vitest-integration/migration-guides/migrate-from-vitest-3-to-vitest-4/) — 文件级隔离、alarm 不隔离、isolatedStorage 移除
- [Workers SDK issue #11031](https://github.com/cloudflare/workers-sdk/issues/11031) — 并发 DO 请求导致 isolated storage 栈错误

## Confidence Assessment

| Area | Level | Reason |
|------|-------|--------|
| Cloudflare 免费额度类 | HIGH | 官方计费公式/limits 页直接推算；突发限额为 MEDIUM-HIGH（社区确认） |
| WebSocket/协议类 | HIGH | 官方文档 + 通用分布式消息工程实践 |
| Android 类 | HIGH（3.4/3.5）、MEDIUM-HIGH（3.1/3.6 真机表现待 spike） | 官方行为变更文档 + dontkillmyapp；OEM 实际行为差异大 |
| Tauri 类 | HIGH（生命周期/架构）、MEDIUM-HIGH（通知 action 限制基于官方文档+生态佐证） | 官方文档为主 |
| 安全类 | HIGH | 通用安全工程 + DOMPurify 官方推荐用法；5.3 折中方案为工程判断 |
| DevOps 类 | HIGH（known-issues 官方页）、MEDIUM-HIGH（7.4 可观测性额度细节） | 官方文档为主 |
