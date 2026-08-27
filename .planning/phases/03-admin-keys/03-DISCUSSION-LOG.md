# Phase 3: 管理页与密钥生命周期 - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-08-27
**Phase:** 3-管理页与密钥生命周期
**Areas discussed:** 登录与密钥持有, 多 Send Key 与展示策略, 消息历史排障入口, 删除语义与 UI 形态, Channel Key 重置踢连, API 路径风格, Send Key 上限, 接入引导, 验收方式, 信息架构

---

## 登录与密钥持有

| Option | Description | Selected |
|--------|-------------|----------|
| localStorage 长期持有 | Admin Key 存 localStorage（同 viewer D-24 模式），下次免输；登出按钮手动清。零服务端会话成本 | ✓ |
| sessionStorage 会话级 | 关标签页即失效；每次开页需重新从密码库复制 | |
| 服务端会话 Cookie | 登录时提交一次，服务端发 HttpOnly Cookie 会话令牌；XSS 防护最强但增加 KV 写额度与实现复杂度 | |

**User's choice:** localStorage 长期持有
**Notes:** 单人管理场景，Admin Key 本身就是最高凭据，localStorage 持有不扩大泄露面。

## 多 Send Key 与展示策略（密钥展示）

| Option | Description | Selected |
|--------|-------------|----------|
| 掩码+点击揭示 | 默认前缀+后缀掩码（`phc_Ab3…xYz`），点眼睛单条揭示，复制按钮一键拷贝。GitHub/CF dashboard 同模式 | ✓ |
| 明文直显 | 密钥明文直接展示，不遮挡；屏幕共享/截图全量暴露 | |
| 仅创建时可见 | 创建/重置时一次性展示（T-01-04 模式），之后只能看掩码查不到完整密钥；"忘了存就永远丢" | |

**User's choice:** 掩码+点击揭示
**Notes:** 防肩窥/防截屏/防共享屏幕误泄。

## 多 Send Key 与展示策略（标签）

| Option | Description | Selected |
|--------|-------------|----------|
| 带可选标签（推荐） | 创建时可选填标签（如 deploy-bot/monitor-script），列表按标签展示，一眼分清哪个脚本在用哪个 Key | ✓ |
| 无标签 | 裸凭据，列表只能按创建时间区分 | |

**User's choice:** 带可选标签（推荐）
**Notes:** KEY-03 "不同脚本各用各的 Key" 场景的直接支撑。

## 消息历史排障入口

| Option | Description | Selected |
|--------|-------------|----------|
| admin HTTP API（推荐） | 新增 admin 鉴权 HTTP 查询 API（Worker 转发 DO 直查 messages 表，seq 游标翻页任意深度）+ 管理页内嵌渲染历史列表 | ✓ |
| 复用 WS 补拉 | 管理页复用 pushhub.js 连频道 WS，看最近 50 条+实时新增；翻不了页、看不到旧消息 | |
| HTTP API+viewer 分工 | 只做 HTTP 历史查询不嵌实时流；实时观察去 viewer 页 | |

**User's choice:** admin HTTP API（推荐）
**Notes:** D-11 "补拉全走 WS" 是客户端协议域；admin 是排障工具，需任意翻页，WS 补拉做不到。

## 删除语义与 UI 形态（删除）

| Option | Description | Selected |
|--------|-------------|----------|
| 硬删+输入名确认 | KV 三前缀清理 + DO 消息全清不可恢复；输入频道名前缀匹配才允许删（GitHub 删仓库模式） | ✓ |
| 硬删+弹窗确认 | 同硬删，普通二次点击弹窗；交互轻但误删风险高 | |
| 软删可恢复 | 密钥先失效，DO 数据保留 N 天后清理，窗口期可恢复；状态机复杂度高 | |

**User's choice:** 硬删+输入名确认
**Notes:** 个人工具场景频道重建成本极低，回收站机制是过度设计。

## 删除语义与 UI 形态（前端形态）

| Option | Description | Selected |
|--------|-------------|----------|
| vanilla 单文件（推荐） | 手写 HTML+CSS+JS 放 packages/server/public/，零构建零依赖，同 viewer 模式，SC4 静态资产免费托管 | ✓ |
| Vite+TS 构建 | 新建 packages/admin-ui 包，类型安全但增加构建链，与 viewer 风格分裂 | |

**User's choice:** vanilla 单文件（推荐）
**Notes:** 管理页复杂度与 viewer 同量级（表单+列表+状态指示）。

## Channel Key 重置踢连

| Option | Description | Selected |
|--------|-------------|----------|
| 重置即踢全部（推荐） | KV 删旧键写新键 + 同步调 DO 新增 kickAll 路由踢出全部现有 WS 连接（SC2 DO 内强一致）+ ≤60s 缓存窗口文档化 | ✓ |
| 仅换键不踢连 | 只换 KV 键，现有连接靠重连时新 key 校验失败自然淘汰；SC2 "立即踢出" 验收过不了 | |

**User's choice:** 重置即踢全部（推荐）
**Notes:** SC2 验收要求的完整实现。

## 吊销 Send Key 边界

| Option | Description | Selected |
|--------|-------------|----------|
| 删键即可（推荐） | KV 删 sk: 键 + DO rate_sends 表清理；脚本下次 POST 即 401（≤60s 窗口）。不踢 WS（Send Key 不用于 WS） | ✓ |
| 删键+DO 审计 | 额外通知 DO 记录审计日志行；v1 无消费方 | |

**User's choice:** 删键即可（推荐）
**Notes:** 频道删除也复用 kickAll 踢全部连接。

## API 路径风格

| Option | Description | Selected |
|--------|-------------|----------|
| REST 资源化（推荐） | DELETE /api/admin/channels/:id、POST .../send-keys、DELETE .../send-keys/:key、POST .../reset-channel-key、GET .../messages；与 D-12 风格一致 | ✓ |
| RPC 动作风格 | POST .../delete、POST .../reset-key 之类动作命名；与既有风格不一致 | |

**User's choice:** REST 资源化（推荐）
**Notes:** id: 记录需从单 sendKey 演进为 sendKeys 列表，GET /api/admin/channels 响应结构同步演进（消费方是管理页与 smoke 脚本，同版本联动）。

## 历史 API 数据通路

| Option | Description | Selected |
|--------|-------------|----------|
| DO 内路由（推荐） | DO 新增内部 /history 路由（seq 游标 keyset 翻页直查 messages 表），Worker admin 鉴权后 X-PH-Verified 转发；数据留 DO 天然隔离 | ✓ |
| KV 导出查询 | 历史数据导出到 KV；KV 不适合列表翻页且引入双写一致性 | |

**User's choice:** DO 内路由（推荐）
**Notes:** 复用 messages 表查询逻辑与行映射（含 answered 字段集）。

## Send Key 数量上限

| Option | Description | Selected |
|--------|-------------|----------|
| 上限 10 个（推荐） | 超出返回 400；防公网 API 被脚本 bug 循环建 Key 烧 KV 写额度（1000 写/天），多脚本场景余量足 | ✓ |
| 不设上限 | 信任管理员；脚本 bug 循环建 Key 无人发现时静默烧额度 | |

**User's choice:** 上限 10 个（推荐）
**Notes:** 无

## 接入引导

| Option | Description | Selected |
|--------|-------------|----------|
| 展示接入片段（推荐） | 创建成功后展示可复制接入信息：webhook URL + curl 示例（机器人方）、服务端地址 + Channel Key（客户端方）+ viewer 链接 | ✓ |
| 仅文档说明 | 页面只管创建/展示密钥，使用方法靠 README；接入方自己拼 URL 和请求体 | |

**User's choice:** 展示接入片段（推荐）
**Notes:** 来自用户描述的核心旅程——"给机器人创建一个 webhook 密钥，机器人通过携带密钥的 webhook 接口发送，客户端接收并提示"；接入片段是"零命令行"目标的临门一脚。

## 验收方式

| Option | Description | Selected |
|--------|-------------|----------|
| Playwright E2E（推荐） | 本地 wrangler dev 真服务，登录→建频道→建 Key→发消息→查历史→重置→踢连→删除全链路自动化；SC4 用 dashboard 请求计数验证（D-26/D-14/D-15 模式） | ✓ |
| API 测试+手测 UI | 只对 API 层做 vitest-pool-workers 集成测试，UI 手动 checklist；SC 逐条人肉重复 | |

**User's choice:** Playwright E2E（推荐）
**Notes:** 无

## 信息架构

| Option | Description | Selected |
|--------|-------------|----------|
| 单页列表+详情（推荐） | 频道列表+创建表单在上/左，选中频道展开详情面板（密钥管理、历史、删除入口）；频道数少导航最短 | ✓ |
| 列表页+详情页 | 两个视图 URL 带频道 id 可书签；多一层导航 | |

**User's choice:** 单页列表+详情（推荐）
**Notes:** 个人工具频道数 < 20。

## Claude's Discretion

- 管理页视觉风格（viewer 一致的 system-ui 极简风）
- 历史翻页条数与"加载更多"交互细节
- 掩码具体格式
- 标签长度上限与字符集校验
- kickAll 的 WS close code/reason 具体值
- 接入片段文案与 curl 示例字段取舍
- history API 查询参数命名与响应信封细节
- E2E 测试文件组织

## Deferred Ideas

None — discussion stayed within phase scope
