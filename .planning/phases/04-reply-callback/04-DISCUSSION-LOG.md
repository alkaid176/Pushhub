# Phase 4: 回复链与回调送达 - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-08-28
**Phase:** 4-回复链与回调送达
**Areas discussed:** 回复语义与锁定, 签名密钥方案, 回复者身份, 测试页形态

---

## 回复语义与锁定

### Q1: 回复锁定语义：消息被回复后，还能再回复吗？

| Option | Description | Selected |
|--------|-------------|----------|
| 一次锁定 | 服务端首答即写 answered 四字段，后续回复全部拒（错误码区分"消息不存在"与"已回复"）；SC1 最强保证；回调只发一次幂等天然成立 | ✓ |
| 首答锁定+可补充 | 快捷按钮冻结但可追加自定义文本，每次补充都更新并重新回调 | |
| 完全自由 | 不限次数，每次都触发回调；RPL-05 防重复处置形同虚设 | |

**User's choice:** 一次锁定
**Notes:** 个人/小团队告警群：一人处置即完成，重复处置无意义

### Q2: 回调触发时机：首答后的拒绝要不要也告知发送方？

| Option | Description | Selected |
|--------|-------------|----------|
| 首答触发一次 | 只有首次成功回复触发一次回调；被拒回复不回调；SC5 幂等语义最简 | ✓ |
| 拒绝也通知 | 首答回调 + 拒绝事件也回调（有人试图重复处置）——协议复杂、噪音多 | |

**User's choice:** 首答触发一次

### Q3: 两个客户端几乎同时点回复的竞态怎么处理？

| Option | Description | Selected |
|--------|-------------|----------|
| 先到先得+败者收帧 | DO 单线程串行，首到成功次到收错误帧；败者收到 answered 帧 UI 自然冻结 | ✓ |
| 乐观锁+UI 先冻结 | 客户端先冻结按钮再发 reply，失败才解冻 | |

**User's choice:** 先到先得+败者收帧

### Q4: 回复的传输通道：WS 帧还是 HTTP 接口？

| Option | Description | Selected |
|--------|-------------|----------|
| WS 内 reply 帧 | v:1 reply 帧 + ack/error 帧 + answered 扇出帧；复用既有鉴权连接；3 新帧类型 + golden fixtures（D-07 合规） | ✓ |
| HTTP 回复接口 | POST /api/reply——两套通道不一致，浏览器已连 WS 另开 HTTP 纯多余 | |

**User's choice:** WS 内 reply 帧

### Q5: 回复载荷验证规则：selected_option 与自定义 text 的关系？

| Option | Description | Selected |
|--------|-------------|----------|
| 恰一 + 白名单 | selected_option 必须在 options 内；text ≤ 32KB 同 D-02；恰提供其一；失败回错误帧不断连 | ✓ |
| 允许叠加 | 同时选快捷选项又附加文本——表达力强但四端渲染复杂 | |

**User's choice:** 恰一 + 白名单

---

## 签名密钥方案

### Q1: 签名密钥选型：频道独立 signing secret 还是复用 Send Key？

| Option | Description | Selected |
|--------|-------------|----------|
| 频道独立 secret | 每频道生成独立 signing secret（随创建下发、管理页可查可重置）；HMAC-SHA256；与 Send Key 权限分离——Stripe/Slack/GitHub 同模式 | ✓ |
| 复用 Send Key | 零新增概念——但多把 Key 时发送方要记"用哪把发的"；泄露时发送与验签同时失守 | |

**User's choice:** 频道独立 secret

### Q2: 签名覆盖范围：防重放要不要进 v1？

| Option | Description | Selected |
|--------|-------------|----------|
| 时间戳+body | PushHub-Message-Id / PushHub-Timestamp / PushHub-Signature（HMAC-SHA256 hex）；防重放+防篡改双保险；验签三步：时间窗→重算→常时比较。Stripe 同款 | ✓ |
| 仅内容签名 | 不防重放（截获重发无法识别） | |

**User's choice:** 时间戳+body

### Q3: 回调 POST 的 body 结构：回调专用结构还是复用 WS 帧？

| Option | Description | Selected |
|--------|-------------|----------|
| 回调专用结构 | {message_id, reply, replied_at, channel_id}——回调面向脚本，WS 面向聊天客户端，两域不耦合 | ✓ |
| 复用 MessageFrame | 零新结构但回声冗余 + 两域耦合 | |

**User's choice:** 回调专用结构

### Q4: 回调重试机制：RPL-04 要求指数退避有上限——具体怎么实现？

| Option | Description | Selected |
|--------|-------------|----------|
| alarm 重试+记录 | DO alarm 驱动指数退避（~5 次封顶），最终失败写 SQLite 记录行可查；休眠零成本额度可控 | ✓ |
| 单次重试 | 实现最简但瞬时抖动误判最终失败，RPL-04 未满足 | |
| 无限重试 | 目标永久下线则无限烧额度 | |

**User's choice:** alarm 重试+记录

---

## 回复者身份

### Q1: answered_by 的取值：自报展示名、连接随机 ID、还是匿名？

| Option | Description | Selected |
|--------|-------------|----------|
| 自报展示名 | 连接时/回复时自报名字（如"小明的手机"），服务端不验证直接存；零账号体系但群内能区分；EXT-04 可平滑升级 | ✓ |
| 连接随机 ID | 服务端 UUID——实现最简但不可读，"已由 a3f8…回复"体验差 | |
| 完全匿名 | answered_by 恒 null——与 SC1"已由某人回复"原文不符 | |

**User's choice:** 自报展示名

### Q2: 展示名的携带时机：随 reply 帧一起发还是连接时先声明？

| Option | Description | Selected |
|--------|-------------|----------|
| 随 reply 帧 | reply 帧 + by? 字段——用时才报，未回复连接匿名挂；attachment 跨休眠存活 | ✓ |
| 连接时声明 | identity 帧先声明——多一次协议往返 + 服务端连接→名字映射状态 | |

**User's choice:** 随 reply 帧

### Q3: 展示名约束：可缺省还是必填？

| Option | Description | Selected |
|--------|-------------|----------|
| ≤64 可缺省 | UTF-16 码元同频道名口径；缺省 = 匿名回复；渲染走 textContent 或消毒管道防 XSS | ✓ |
| 必填 | 强制配置门槛，降低"扫码即用"体验 | |

**User's choice:** ≤64 可缺省

### Q4: 回调要不要把回复者名字也带给发送方？

| Option | Description | Selected |
|--------|-------------|----------|
| 携带 | 回调 body 加 replied_by（可 null）——审批日志场景关键上下文 | ✓ |
| 不携带 | 发送方只知"有人回复"不知是谁 | |

**User's choice:** 携带

---

## 测试页形态

### Q1: ADM-04 测试页的形态：独立页面还是叠加在现有页面上？

| Option | Description | Selected |
|--------|-------------|----------|
| 独立 test 页 | test.html + test.js 全功能双向工具（构造+发送+流+回复+验签+失败查询）；viewer 保持轻量（D-22 定位延续） | ✓ |
| 升级 viewer | viewer 变重，D-22"只收不发的轻量 demo"被破坏 | |
| 并入 admin | admin.js 已 1399 行再叠加职责过重，且管理页身份是密钥治理 | |

**User's choice:** 独立 test 页

### Q2: 测试页要不要内置验签演示（SC5 支撑）？

| Option | Description | Selected |
|--------|-------------|----------|
| 验签器+观察窗 | 粘贴回调 headers/body 本地验签可视化演示 + callback_url 输入框支持外部接收器 | ✓ |
| 仅输入框 | 实现最简但 SC5"验签语义经真实接收方验证"缺可视化支撑 | |

**User's choice:** 验签器+观察窗

### Q3: SC5 真实脚本场景的交付形态：独立可拷贝的接收器脚本还是仅 E2E？

| Option | Description | Selected |
|--------|-------------|----------|
| Node 接收器脚本 | scripts/callback-receiver.mjs 本地监听验签打印——验收证据 + 用户可拷贝参考实现双重交付 | ✓ |
| 仅 E2E 覆盖 | 测试代码即证据但不产出用户可拷贝脚本 | |

**User's choice:** Node 接收器脚本

### Q4: 回调最终失败记录（RPL-04 可查）的查询入口放哪？

| Option | Description | Selected |
|--------|-------------|----------|
| 测试页查 | 按频道拉取失败记录（wid/URL/错误/重试次数/时间）——测试页是协议排障工具定位闭环；管理页本期不动 | ✓ |
| 管理页查 | 复用登录态但 admin.js 再膨胀且跨 ADM 需求域 | |
| 两页都查 | 重复建设 v1 无必要 | |

**User's choice:** 测试页查

---

## Claude's Discretion

- 新帧类型的具体命名与 ack 帧字段细节
- answered 状态同步帧形态（独立 answered 帧 vs message 帧重发——SeqDedup 硬约束倾向独立帧）
- 回调重试档位数值与总次数上限（~5 次量级）
- timestamp 容忍窗具体值（~5 分钟量级）
- signing secret 生成方式与长度
- 测试页代码复用方式与 UI 布局细节
- 失败记录 API 路径设计
- attachment 存展示名的结构演进
- E2E 测试组织

## Deferred Ideas

None — discussion stayed within phase scope
