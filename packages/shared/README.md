# @pushhub/shared — PushHub v1 线协议（冻结）

四端（TS 服务端 / Web SDK / Rust 桌面 / Kotlin 安卓）的唯一协议事实源：
全部 WS 帧类型、`/api/send` 请求体与响应、错误码枚举、上限与窗口常量、
golden fixtures（正反例逐字节冻结）。**任何一端可仅凭本包 + fixtures
实现协议，零口头约定。**

冻结时点：Phase 1 计划 01-02（用户裁决 freeze，按 CONTEXT D-01~D-07 原样冻结）。
冻结后字段删除或语义变更即**破坏性协议变更**——须走协议版本升级（v:2）+ 四端联动改造。

## 协议演进规则（D-07，冻结生效）

1. **只加字段，不改语义。** 已冻结字段的名字、类型、语义、缺省行为不得变更；
   允许新增可选字段（新字段未提供时不得出现，保持省略语义）。
2. **未知字段必须忽略。** 收到不认识的字段时静默忽略、不报错不断连。
   Rust 侧 serde **禁用 `deny_unknown_fields`**（默认即忽略未知字段，
   显式声明该属性会破坏向前兼容，禁止添加）；TS 侧不写 excess property 拒绝逻辑；
   Kotlin 侧 data class 只声明已知字段。
3. **客户端不识别的 `v` 即断连报错。** 所有 WS 帧顶层带 `v`（整数递增，当前 1）；
   客户端收到 `v` 不认识的帧说明对端说的是另一版协议，必须断开连接并报错，
   不得降级猜测。服务端侧对 v 不匹配的入站业务帧：回一帧
   `WsErrorFrame`（code `invalid_version`）并忽略该帧、不断连（客户端职责
   与服务端行为分离，见 01-02 Flagged Assumptions）。

## WS 帧清单（全部顶层带 `v: 1`）

| 帧 | 方向 | 字段 | 语义 |
|----|------|------|------|
| `message` | 服务端 → 客户端 | `v, type, wid, seq, title?, text, options?, callback_url?, click_url?, priority, answered, answered_by, answered_at, answered_content, created_at` | 新消息实时扇出。wid=m_+16 字符对外 ID；seq=频道内单调游标；answered 四字段 D-03 一次定全（Phase 1 恒初始值）；可选字段未提供时不出现（options 永不为空数组） |
| `ping` | 客户端 → 服务端 | `v, type` | 应用层心跳；服务端 `setWebSocketAutoResponse` 零唤醒自动回 `pong`（不消耗计费） |
| `pong` | 服务端 → 客户端 | `v, type` | 心跳应答（auto-response 自动回帧） |
| `sync` | 客户端 → 服务端 | `v, type, since, limit?` | 补拉请求。`since: null` 首次连接（拉最近 `INITIAL_FETCH` 条）；`since: n` 拉 seq > n 增量；`limit` 缺省 `SYNC_LIMIT_DEFAULT`、上限 `SYNC_LIMIT_MAX`（D-11：补拉全部走 WS，不设 HTTP 历史接口） |
| `history` | 服务端 → 客户端 | `v, type, messages[], oldest_kept_seq, has_more` | 补拉响应。messages 按 seq 升序；`oldest_kept_seq` 为频道现存最老 seq——请求的 since 小于它时客户端呈现"更早消息已清理"分隔线，不报错不断连（D-10）；`has_more: true` 表示未拉完，客户端续翻 |
| `error` | 服务端 → 客户端 | `v, type, code, message` | WS 侧错误帧（code 仅 `invalid_frame` / `invalid_version`） |

## HTTP 接口契约

- `POST /api/send`（Bearer Send Key）请求体 `SendBody`：
  `title?, text(必填), priority?, options?, callback_url?, click_url?`
- 成功响应 `SendResult`：`{"id": "<wid>", "seq": <n>}`
- 错误响应统一信封（D-06）：`{"error":{"code":"...","message":"..."}}`

## 错误码清单

HTTP 侧（错误信封，message 为通用文案，不含堆栈/内部键名/密钥回显）：

| code | HTTP | 触发条件 |
|------|------|---------|
| `invalid_key` | 401 | Send Key / Channel Key / Admin Key 缺失或无效 |
| `payload_too_large` | 413 | D-02 任一上限超限（message 指明超长字段） |
| `rate_limited` | 429 | 每 Send Key 每分钟超 `RATE_LIMIT_PER_MIN` 条（响应另带 `Retry-After` 头，秒数到窗口重置——是 HTTP 响应头而非信封字段） |
| `invalid_body` | 400 | 结构/类型/枚举违例（如 priority 非 low/normal/high、缺 text） |
| `invalid_json` | 400 | 请求体不是合法 JSON |
| `server_error` | 500 | 服务端内部错误（通用文案，不泄漏细节） |

WS 帧侧（`WsErrorFrame`）：

| code | 触发条件 |
|------|---------|
| `invalid_frame` | 入站帧不是合法的 v:1 客户端帧（非 JSON / 非 ping、sync 结构 / since、limit 非法） |
| `invalid_version` | 入站帧 `v` 不等于 `PROTOCOL_VERSION` |

## 上限与窗口常量

| 常量 | 值 | 依据 |
|------|----|------|
| `LIMITS.TEXT_MAX` | 32768 | D-02（长度按 JS string.length / UTF-16 码元判定） |
| `LIMITS.TITLE_MAX` | 256 | D-02 |
| `LIMITS.OPTIONS_MAX_COUNT` | 4 | D-02 / SRV-02 |
| `LIMITS.OPTIONS_ITEM_MAX` | 64 | D-02 |
| `LIMITS.URL_MAX` | 2048 | D-02（callback_url / click_url 共用） |
| `RETENTION_KEEP` | 500 | D-08 每频道保留窗口 |
| `INITIAL_FETCH` | 50 | D-09 首次连接默认拉取条数 |
| `SYNC_LIMIT_DEFAULT` | 200 | D-11 sync limit 缺省值 |
| `SYNC_LIMIT_MAX` | 500 | D-11 sync limit 上限 |
| `RATE_LIMIT_PER_MIN` | 30 | KEY-05（可配置，超限 429） |
| `WID_PREFIX` / `WID_LENGTH` | `m_` / 16 | D-05 对外消息 ID 形态 |

省略语义（SRV-02 边界，`validateSendBody` 归一规则）：可选字段的 `null`
与缺省均视为未提供、不报错；`options` 空数组归一为省略（存储 NULL、
帧中不出现该字段），单元素数组合法。

## fixtures 目录（golden 契约基线）

`fixtures/*.json` 是正反例逐字节冻结的 golden 集：每类帧至少 1 正 1 反、
错误信封逐 code 一例。**冻结后任何字节变化都是协议事件**，须走显式协议
变更流程（git 历史比对 fixtures 目录）。

文件内 `_` 前缀键（`_note` / `_violation` / `_meta`）是元数据，说明反例
意图与错误码关联，**不参与线协议序列化**——四端实现时剔除。

消费方式：

- TS（server / web-sdk）：workspace 静态 import——
  `import mf from "@pushhub/shared/fixtures/message-frame.positive.json"`
  （`resolveJsonModule` 已开）。反例驱动 `validateSendBody` /
  `validateInboundFrame` 断言拒绝 code 与 `_violation` 元数据闭环。
- Rust（Phase 5）/ Kotlin（Phase 6）：以仓库相对路径
  `packages/shared/fixtures/*.json` 直接读文件断言（不经 npm）。

## 边界与实现细节

- KV 键前缀（`ch:` / `sk:` / `id:`）是**服务端实现细节**而非线协议，
  唯一来源 `packages/server/src/keys.ts`，不在本包定义。
- 本包零运行时依赖（纯类型 + 纯函数），不 import Cloudflare Workers API
  （`cloudflare:workers`、绑定类型、KV/DO/secret API 均禁止）——
  四端契约包必须运行时无关。
- `validators.ts` 的阈值全部引用本包常量，文件内不出现裸数字阈值。
