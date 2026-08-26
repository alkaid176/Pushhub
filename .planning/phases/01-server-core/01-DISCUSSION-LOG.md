# Phase 1: 服务端核心与协议冻结 - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-08-26
**Phase:** 1-服务端核心与协议冻结
**Areas discussed:** 消息 schema 冻结范围, 保留窗口与补拉语义, 频道初始化方式, 部署验证节奏

---

## 消息 schema 冻结范围

### Q1: click_url 是否进 v1 协议？

| Option | Description | Selected |
|--------|-------------|----------|
| 加进 v1 | v1 协议带上 click_url?: string（≤2048），三端客户端点击消息标题/卡片即可跳转。成本几乎为零，避免上线后马上加字段 | ✓ |
| 不加，v2 再说 | v1 协议只有需求内的字段。发送方要跳转可自己写在 Markdown 正文里，最保守 | |

### Q2: 消息体大小上限？

| Option | Description | Selected |
|--------|-------------|----------|
| 研究推荐值 | text ≤ 8,192 字符、title ≤ 256、options ≤ 4×64、callback_url ≤ 2,048 | |
| 宽松档 32KB | text ≤ 32KB（Server酱同档）。给长报告类通知留余量，但单条消息存 DO SQLite 后大消息会加速消耗存储额度 | ✓ |
| 紧凑档 4KB | text ≤ 4,096（Telegram 同档）。存储最省，但可能不够放完整日志/报告 | |

### Q3: answered 字段集是否 Phase 1 一次定全？

| Option | Description | Selected |
|--------|-------------|----------|
| 一次定全 | Phase 1 消息表和 WS 帧就含 answered 相关字段（初始 null）。Phase 4 只加逻辑不改 schema——四端契约一次定全，这是协议冻结的本意 | ✓ |
| Phase 4 再加 | Phase 1 只有发送侧字段。表面上游离了回复话题，但 golden fixtures 和表结构要二次变动，违背冻结初衷 | |

### Q4: priority 字段形态？

| Option | Description | Selected |
|--------|-------------|----------|
| 三档枚举 | low/normal/high，默认 normal。映射到 Android 通知渠道/Windows toast 场景，三档是竞品验证过的最小够用集 | ✓ |
| 自由字符串 | 接受任意字符串透传（服务端不校验枚举），客户端自行解释。灵活但三端表现不一致风险高 | |
| 不做 priority | v1 协议不含。最简但违背需求 SRV-01 | |

### Q5: wid 格式？

| Option | Description | Selected |
|--------|-------------|----------|
| nanoid m_xxx | 服务端生成 16 字符 nanoid（前缀 m_）。不可猜测、URL 安全——回调去重和三端引用都好用 | ✓ |
| 直接用 seq | seq 数字作消息 ID 对外暴露。最简，但可猜测（可枚举频道消息）且语义重费 | |

### Q6: 错误响应风格？

| Option | Description | Selected |
|--------|-------------|----------|
| code+message | 统一 {error:{code,message}}，HTTP 状态码 + 机器可读 code。Slack 式错误码是竞品研究点名表扬的实践 | ✓ |
| 仅状态码+文本 | 只返回 HTTP 状态码和自由文本。实现最省，但三端无法程序化处理错误 | |

### Q7: 版本字段 v 的形式？

| Option | Description | Selected |
|--------|-------------|----------|
| 顶层 v:1 | 所有 WS 帧顶层带 v:1，演进规则写进 shared/ README：只加字段不改语义、未知字段必须忽略 | ✓ |
| 不带版本字段 | 靠 golden fixtures 变更约定。省一个字段，但四端无法运行时检测协议不匹配 | |

---

## 保留窗口与补拉语义

### Q8: 每频道保留窗口？

| Option | Description | Selected |
|--------|-------------|----------|
| 500 条/频道 | 个人/小团队告警场景够用，存储占用极小，清理压力可忽略 | ✓ |
| 1,000 条/频道 | 活跃群多一倍回溯空间，存储依然很小 | |
| 30 天时间窗 | 语义直观但活跃群可能膨胀到几万条，清理逻辑复杂一档 | |
| 2,000 条/频道 | 适合高频告警群，但接近"补拉一次要翻多页"的量级 | |

### Q9: 首次连接默认拉多少历史？

| Option | Description | Selected |
|--------|-------------|----------|
| 最近 50 条 | 首屏轻快，聊天场景够看上下文；需要更多历史时客户端可翻页拉取 | ✓ |
| 最近 100 条 | ARCHITECTURE.md 研究原推荐值。一步到位但首屏稍重 | |
| 不自动拉 | 连上后只收新消息，历史显式按需拉。最省但新设备体验突兀 | |

### Q10: since 早于保留窗口时客户端如何感知？

| Option | Description | Selected |
|--------|-------------|----------|
| 分隔线提示 | 响应带 oldest_kept_seq，客户端发现 since < oldest_kept_seq 呈现"更早消息已清理"分隔线，不报错不断连 | ✓ |
| 报错断连 | 视为协议错误。严格但会把正常清理变成故障现象 | |
| 静默忽略 | 从 oldest_kept_seq 开始渲染，不提示空洞。用户不知道丢了历史 | |

### Q11: 大窗口补拉怎么分页？

| Option | Description | Selected |
|--------|-------------|----------|
| WS 内翻页 | sync 带 limit（默认 200 上限 500），响应标 has_more 客户端续翻，不另开 HTTP 接口——补拉全部走 WS，协议面最小 | ✓ |
| HTTP 历史接口 | sync 只回一页，更早历史走 GET /api/history。与管理页复用但多一个 API 面 | |
| 两条路都要 | WS 快路径 + HTTP 完整查询。功能最全但 v1 协议面最大 | |

---

## 频道初始化方式

### Q12: Phase 1 怎么创建频道和密钥？

| Option | Description | Selected |
|--------|-------------|----------|
| Admin API 最小集 | 本期实现 POST /api/admin/channels（Admin Key 鉴权）+ GET 列表。curl/脚本自助建频道；Phase 3 管理页直接复用，零重复建设 | ✓ |
| 种子脚本 | wrangler dev 启动时预置测试频道写进 KV。测试方便但生产无入口，密钥生成逻辑要写两遍 | |
| 手动 wrangler kv | 手动写密钥进 KV。零代码但易错、无法重复、违背"密钥服务端生成"安全模型 | |

### Q13: Admin API 本期覆盖到什么程度？

| Option | Description | Selected |
|--------|-------------|----------|
| 最小集 | 只建创建 + 列表两个端点。删除/重置/吊销 Phase 3 随管理页一起做 | ✓ |
| 全套 API 骨架 | Phase 1 就把增删查重置全套建完（含 kick-all）。但本期无 UI 消费、无验收场景 | |

---

## 部署验证节奏

### Q14: Phase 1 部署节奏？

| Option | Description | Selected |
|--------|-------------|----------|
| 每计划一部署 | 每个计划完成后即 wrangler deploy 到 workers.dev，5 分钟生产冒烟通过才算完成。限额/驱逐/KV 一致性问题当场暴露；验收标准 3（DO 时长归零）只有生产可验 | ✓ |
| 阶段末一次部署 | 开发期间只在本地 wrangler dev，阶段完成后一次性部署。迭代快但风险堆积到最后爆发 | |
| 关键节点部署 | 日常本地，协议冻结/休眠验收等节点单独部署。折中但"关键节点"定义模糊 | |

### Q15: 生产冒烟验证到什么程度？

| Option | Description | Selected |
|--------|-------------|----------|
| 固定 checklist | 部署后 5 分钟 checklist：① curl 建频道 ② WS 连接收消息 ③ 断连重连补拉 ④ dashboard 看 DO duration 与请求曲线。固化进脚本/文档，每次版本 +1 都跑 | ✓ |
| 仅首末全量 | 只在首次部署和阶段验收时完整冒烟。省事但休眠/额度回归问题可能带病几迭代 | |

---

## Claude's Discretion

- monorepo 目录结构细节（pnpm workspace 布局、shared/ 包内部组织）
- 限流桶实现细节（令牌桶表结构、清理策略）
- KV 键前缀具体命名（研究推荐 ch:/sk:/id:，可微调）
- golden fixtures 组织方式（按帧类型分文件 vs 单文件多例）
- 测试文件划分粒度（遵循一场景一文件规范）

## Deferred Ideas

无——讨论未超出阶段范围。
