# Phase 2: Web SDK 参考客户端 - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-08-26
**Phase:** 2-Web SDK 参考客户端
**Areas discussed:** SDK 事件 API 表面, 渲染辅助形态, Demo 页深度, 测试矩阵与 iOS 验证

---

## 灰区选择

用户全选四个灰区：SDK 事件 API 表面、渲染辅助形态、Demo 页深度、测试矩阵与 iOS 验证。

---

## SDK 事件 API 表面

### Q1: on() 事件枚举怎么定？

| Option | Description | Selected |
|--------|-------------|----------|
| 细粒度三事件 | message / status / error；接口面最小，三端移植最直接 | |
| 四事件含 history | history 独立暴露补拉批次（含 oldest_kept_seq），宿主可感知"更早消息已清理"分隔线时机 | ✓ |
| 最小两事件 | 只有 message + error；连接状态不暴露 | |

**User's choice:** 四事件含 history
**Notes:** history 独立事件让宿主可感知窗口缺口语义（D-10）的呈现时机。

### Q2: 首拉/补拉的 history 批次里的消息，宿主从哪个事件拿？

| Option | Description | Selected |
|--------|-------------|----------|
| history 统一 | 首拉 history 帧也走 on("history")；语义与协议帧一一对应，无 SDK 私有加工 | ✓ |
| 展开进 message | SDK 展开 history 批次逐条走 on("message")，history 仅作批次边界通知 | |

**User's choice:** history 统一
**Notes:** 无

### Q3: seq 幂等去重归 SDK 还是宿主？

| Option | Description | Selected |
|--------|-------------|----------|
| SDK 内去重 | 内部维护 last_seq + 已见 seq 窗口，宿主回调永不见重复（SC2 第二道防线） | ✓ |
| 透传宿主去重 | SDK 透传全部帧，seq 去重由宿主负责；SDK 更薄但三端各写一遍 | |

**User's choice:** SDK 内去重
**Notes:** 无

### Q4: 连接生命周期 API 怎么设计？

| Option | Description | Selected |
|--------|-------------|----------|
| connect/disconnect/destroy | new 即自动连接；disconnect 主动断开停重连；destroy = disconnect + 清监听 + 释放资源 | ✓ |
| 仅 new/destroy | 接口更小，但宿主无法临时断开稍后重连 | |
| 显式 connect() | 构造无副作用，但 SC1 两行接入多一步 | |

**User's choice:** connect/disconnect/destroy
**Notes:** 无

### Q5: API 表面继续深挖还是下一灰区？

**User's choice:** 下一个灰区
**Notes:** status 枚举值、error 载荷结构标注为 Claude 裁量。

---

## 渲染辅助形态

### Q1: 渲染辅助做成什么形态？

| Option | Description | Selected |
|--------|-------------|----------|
| 纯函数 | PushHub.renderMarkdown(text) → 安全 HTML 字符串；宿主自拼 DOM；最薄 | ✓ |
| 函数+列表组件 | 再提供 mount(el) 渲染消息列表——接得更快但 SDK 开始拥有 UI 形态 | |
| 渲染另发文件 | pushhub-render.js 可选文件——主包更小但"单文件"承诺变成两文件 | |

**User's choice:** 纯函数
**Notes:** 无

### Q2: 渲染代码与 Phase 5 Tauri 的共享怎么组织？

| Option | Description | Selected |
|--------|-------------|----------|
| 纯函数可移植 | 渲染核心写成可移植纯 TS 模块，pushhub.js 打包、Tauri 前端 import 同一模块 | ✓ |
| Phase 5 再议 | Phase 2 只管 SDK 好用，共享届时可能复制粘贴——四端消毒逻辑可能漂移 | |
| 抽独立共享包 | packages/render 独立包——过度工程，消费者只有 SDK 一个 | |

**User's choice:** 纯函数可移植
**Notes:** 无

### Q3: 消毒后的链接点击行为归 SDK 统一处理吗？

| Option | Description | Selected |
|--------|-------------|----------|
| 强制 _blank+noopener | DOMPurify hook：渲染出的 <a> 强制 target=_blank + rel=noopener noreferrer | ✓ |
| 链接由宿主管 | 消毒后链接保持原样——更纯但宿主忘配就是安全缺口 | |

**User's choice:** 强制 _blank+noopener
**Notes:** 无

### Q4: 渲染形态继续深挖还是下一灰区？

**User's choice:** 下一个灰区
**Notes:** marked 配置细节留规划阶段。

---

## Demo 页深度

### Q1: Demo 页做到什么深度？

| Option | Description | Selected |
|--------|-------------|----------|
| 轻量查看器 | 接入表单 + 消息流列表 + 连接状态指示 + 攻击样本按钮；不构造消息不回复（Phase 4 域） | ✓ |
| 最简验证页 | 只留占位页 + blank.html 两行接入验证 SC1 字面 | |
| 加发消息表单 | 查看器 + 发测试消息（调 /api/send 需 Send Key）——与 Phase 4 ADM-04 撞车 | |

**User's choice:** 轻量查看器
**Notes:** 无

### Q2: SC1 的"空白 HTML 页两行接入"怎么验收？

| Option | Description | Selected |
|--------|-------------|----------|
| 查看器即验证 | 查看器本身就用 <script src=/pushhub.js> + new PushHub() 零构建接入，存在即 SC1 证明 | ✓ |
| 另建 blank.html | 约 10 行纯字面验收页——语义最纯粹但多维护一个页面 | |

**User's choice:** 查看器即验证
**Notes:** 无

### Q3: 查看器的实用细节包含到什么程度？

| Option | Description | Selected |
|--------|-------------|----------|
| 含排障细节 | localStorage 存配置；部署断连自动重连续补拉（SC2 观察点）；"更早消息已清理"分隔线 | ✓ |
| 严格四件套 | 只做表单+消息流+状态灯+攻击样本按钮 | |

**User's choice:** 含排障细节
**Notes:** 无

### Q4: Demo 页继续深挖还是下一灰区？

**User's choice:** 下一个灰区
**Notes:** 页面布局风格留给规划/执行阶段。

---

## 测试矩阵与 iOS 验证

### Q1: SDK 测试栈怎么分层？

| Option | Description | Selected |
|--------|-------------|----------|
| 两层：单测+E2E | happy-dom 单测（mock WS 纯逻辑）+ Playwright 冒烟（真浏览器真服务端） | ✓ |
| 三层含 workerd | 再加 SDK 级 vitest-pool-workers 集成——SDK 是浏览器产物，Node 池有环境裂缝 | |
| 仅 Playwright | 测试最真实但反馈慢，重连时序用 E2E 验证脆弱 | |

**User's choice:** 两层：单测+E2E
**Notes:** 无

### Q2: Playwright E2E 的服务端用哪个环境？

| Option | Description | Selected |
|--------|-------------|----------|
| wrangler dev | 本地真服务端（真 DO/KV/WS）+ localhost——快、可重复、不耗生产额度；生产验证沿用 D-14/D-15 节奏 | ✓ |
| 直连生产 | 环境最真但耗额度、污染真频道、网络抖动 flaky | |
| 全 mock | page.route() 拦截伪造 WS——协议兼容性验证不足 | |

**User's choice:** wrangler dev
**Notes:** 无

### Q3: iOS Safari visibilitychange 恢复路径怎么处理？

| Option | Description | Selected |
|--------|-------------|----------|
| 代码就绪+追踪 | SDK 实现探活逻辑 + 代码评审确认完备；真机验证记 WINDOWS.md 不阻塞 | |
| 真机阻塞验收 | Phase 2 验收前必须 iOS 真机过一轮 | |
| 不进行IOS测试 | 不做任何 iOS 专项测试 | ✓ |

**User's choice:** 不进行IOS测试
**Notes:** 用户明确不做 iOS 测试。

### Q4（边界确认）: visibilitychange 探活逻辑本身写不写进 SDK？

| Option | Description | Selected |
|--------|-------------|----------|
| 逻辑内量不追踪 | SDK 实现包含探活逻辑（标准 API 不依赖真机），但不做 iOS 专项测试也不追踪 | ✓ |
| 纯通用重连 | 不写任何 visibilitychange 特殊处理，纯靠心跳超时——iOS 恢复慢一个心跳周期 | |

**User's choice:** 逻辑内量不追踪
**Notes:** 澄清了"不测试"≠"不实现"——逻辑写入但风险不追踪。

### Q5: 测试矩阵还有想深挖的吗？

**User's choice:** 讨论完成
**Notes:** 心跳周期数值、退避参数留规划阶段。

---

## 收尾

**Q:** 四个灰区全部讨论完毕，还有未澄清的灰区吗？
**User's choice:** 生成 CONTEXT

---

## Claude's Discretion

- status 事件枚举具体值、error 事件载荷结构
- marked 配置细节与渲染模块文件组织
- 重连退避参数数值（上限 60s 已锁）、心跳周期与死线阈值
- packages/web-sdk 内部目录结构与 npm scripts
- 攻击样本 fixture 具体内容集
- 查看器页面布局风格

## Deferred Ideas

None — discussion stayed within phase scope
