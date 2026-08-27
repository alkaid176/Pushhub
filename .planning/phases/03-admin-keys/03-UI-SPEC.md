---
phase: 3
slug: admin-keys
status: draft
shadcn_initialized: false
preset: none
created: 2026-08-27
---

# Phase 3 — UI Design Contract（管理页与密钥生命周期）

> 视觉基线已由 03-CONTEXT.md 锁定：**与 viewer 一致的 system-ui 极简风**（D-37 vanilla 单文件、D-38 单页列表+详情信息架构）。本文件将该基线展开为可执行的 token 与交互契约。生成者 gsd-ui-researcher，由 gsd-ui-checker 验证。上游依据：D-28~D-41（14 条锁定决策）+ 03-RESEARCH.md Pattern 5/6。参照实现：`packages/server/public/index.html`（CSP + 样式基调）、`viewer.js`（localStorage + 状态渲染模式）。

---

## Design System

| Property | Value |
|----------|-------|
| Tool | none（D-37：vanilla 手写 HTML+CSS+JS，零构建零依赖静态资产；非 React 栈，shadcn 初始化门不适用） |
| Preset | not applicable |
| Component library | none（原生 HTML 元素 + 原生 `<dialog>` 确认框 + 原生 `<details>` 折叠；不引任何 UI 库） |
| Icon library | none（仅一个手写 inline SVG 眼睛图标用于密钥揭示——inline SVG 是标记非脚本，CSP 兼容；其余全文字按钮） |
| Font | `system-ui, -apple-system, "Segoe UI", sans-serif`（与 viewer 相同）；密钥/时间戳/seq/接入片段用 `ui-monospace, monospace` |

**硬约束（继承 viewer 已验证模式）：**

- admin.html **原样复制** viewer 的 CSP meta（D-28）：`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss: http: https:; img-src * data:; base-uri 'self'; form-action 'self'`——禁止一切 inline `<script>`；物理上必须 admin.html + admin.js 两文件（RESEARCH Pitfall 3："单文件" = 单页无构建，非脚本内嵌）
- `:root { color-scheme: light dark; }`——颜色全部走 CSS 系统色 + 少量固定语义色，浅/深色模式零成本自适应
- **textContent 纪律**：频道名、标签、密钥、错误消息等一切用户可控字符串一律 `textContent` 写入；全页**唯一** `innerHTML` 入口是历史视图消息体的 `PushHub.renderMarkdown(m.text)`（D-40 消毒管道，与 viewer 同款唯一管道）
- Admin Key 存 localStorage 键 `pushhub.admin`（独立于 viewer 的 `pushhub.server`/`pushhub.key`；读取侧 try/catch 对齐 WR-03 防护先例）
- `/pushhub.js?v=` 引用由 build.mjs 构建期注入（RESEARCH Pattern 6 联动点，勿手写死版本）

---

## Spacing Scale

Declared values（全部为 4 的倍数）：

| Token | Value | Usage |
|-------|-------|-------|
| xs | 4px | 徽标内边距、眼睛图标与相邻文字间隙 |
| sm | 8px | 同组控件间隙（密钥行的掩码/眼睛/复制三件套）、消息列表 vertical gap、行内小按钮上下 padding |
| md | 12px | 卡片内边距（频道详情面板、密钥行、接入片段、消息卡片，同 viewer `.msg` 的 `8px 12px`） |
| lg | 16px | 页面左右 padding（同 viewer）、区块之间间距 |
| xl | 24px | 详情面板内大区块分隔（Channel Key 区 / Send Key 区 / 历史区 / 删除区）、h2 上边距（同 viewer） |
| 2xl | 32px | 顶栏与主内容区间距 |

Exceptions: none（viewer 中个别 6px/18px 值不入契约，统一归一到 8px/16px——视觉差异不可感知，换取 4px 网格纯净）

**控件尺寸：** 主按钮 `padding: 8px 16px`；行内小按钮（眼睛/复制/吊销）`padding: 4px 12px`、最小可点击高度 28px。桌面管理工具，无移动触屏 44px 例外。

**布局骨架（D-38 单页列表+详情）：**

- 页面 `max-width: 960px` 居中，padding 16px（viewer 单栏 720px；管理页两栏放宽）
- ≥ 800px 视口：左右两栏——左栏固定 300px（创建表单在上 + 频道列表在下），右栏 `flex: 1` 频道详情面板
- < 800px 视口：单栏堆叠，创建表单 + 频道列表在上，详情面板在下
- 频道列表与历史列表各自 `max-height` + `overflow-y: auto` 独立滚动
- 顶栏：左侧 h1 "PushHub 管理"；右侧"刷新"与"登出"文字按钮
- 未登录时主界面整体隐藏，仅渲染登录卡（见 Interaction Patterns #1）

---

## Typography

| Role | Size | Weight | Line Height |
|------|------|--------|-------------|
| Body | 16px（1rem） | 400 | 1.5 |
| Label / secondary | 13.6px（0.85rem） | 400 | 1.45 |
| Section heading（h2） | 16.8px（1.05rem） | 700 | 1.3 |
| Page title（h1） | 22.4px（1.4rem） | 700 | 1.25 |

- **恰好两个字重**：400（正文/次要文字）与 700（标题、strong、选中频道名）——不使用 500/600
- Exceptions：等宽小号 12px（0.75rem）`ui-monospace` 用于历史消息时间戳与 seq（如 `#42 14:03:22`，同 viewer time 元素）
- 接入片段代码块：13.6px（0.85rem）等宽、`white-space: pre` + `overflow-x: auto`（同 viewer pre 样式）

---

## Color

| Role | Value | Usage |
|------|-------|-------|
| Dominant (60%) | `canvas`（CSS 系统背景色，跟随浅/深色模式） | 页面背景、列表区背景 |
| Secondary (30%) | 1px solid `canvastext` 边框式面板 + `canvas` 背景（viewer `.msg` 同款：border + border-radius 8px，非填充色面） | 频道详情面板、密钥行、消息卡片、接入片段卡、登录卡、输入框与折叠区边框 |
| Accent (10%) | `#2e9e5b`（同 viewer dot-online 绿） | 仅限下方保留清单 |
| Destructive | `#c0392b`（同 viewer error-bar/offline 红） | 仅限下方保留清单 |

**Accent 保留清单（除以下 4 项，任何元素不得用绿色）：**

1. 主提交按钮：登录、创建频道、创建 Send Key（填充底 `#2e9e5b` + 白字）
2. answered 徽标"已回复"态（Phase 3 恒不触发——回复是 Phase 4 域；样式先行定义供 Phase 4 复用同一视图）
3. 选中频道列表项的 3px 左侧指示条
4. 复制成功的"已复制"反馈文案

**Destructive 保留清单（除以下 4 项，任何元素不得用红色）：**

1. 详情面板底部"删除频道"按钮
2. 每个 Send Key 行的"吊销"文字按钮
3. "重置 Channel Key"按钮及确认框内的警示文案
4. 错误条：`#c0392b` 底 + 白字、border-radius 6px、`word-break: break-all`（同 viewer error-bar）

**其他语义色（继承 viewer 状态色体系，仅用于既定语义）：**

| 值 | 语义 |
|----|------|
| `#9a9a9a` | 无数据/禁用态（同 viewer dot-idle）；"未回复"徽标、删除按钮 disabled 态文字 |
| `#d9a300` | 注意/过渡（同 viewer dot-connecting）：重置/吊销成功后的 60s 双活窗口提示条（1px 边框式，非填充） |
| `graytext`（系统色） | 说明文字、次要信息、"未命名"标签、placeholder |

---

## Copywriting Contract

用户面向文案全部中文；`{origin}` = `window.location.origin`（管理页与 API 同源）。

| Element | Copy |
|---------|------|
| Primary CTA | **创建频道**（创建表单提交按钮；登录屏障内主按钮为**登录**） |
| Empty state heading（频道列表空） | 还没有频道 |
| Empty state body（频道列表空） | 在上方输入频道名称创建第一个频道，创建后即可获得 Channel Key 与 Send Key。 |
| Error state（通用） | {操作}失败（{code}）：{message}——请修正后重试。（D-06 信封的 code 与 message 原样透传；网络级失败显示：网络请求失败，请检查连接后点「刷新」重试。） |
| Error state（401 特例） | Admin Key 无效（invalid_key）：请重新输入。——同时清除 localStorage `pushhub.admin` 并回到登录屏障 |
| Destructive confirmation | 三条确认框契约见下（D-33/D-34 锁定文案必须逐字包含） |

### 补充文案表

| 场景 | 文案 |
|------|------|
| 登录屏障说明 | 输入 Admin Key 登录。密钥仅保存在本机浏览器 localStorage（键 pushhub.admin），点「登出」清除；不使用服务端会话。 |
| 登录输入 placeholder | 粘贴 Admin Key（type="password"） |
| 历史空态 | 该频道还没有消息——Webhook 发送第一条消息后会显示在这里。 |
| Send Key 空态 | 该频道没有 Send Key——创建一个给脚本使用，不同脚本各用各的 Key，泄露不互伤。 |
| 复制成功反馈 | 已复制（1.5s 后复原为"复制"；同时置 `data-copied` 属性供 E2E 断言） |
| 加载中 | 加载中…（列表首次加载占位与翻页按钮共用） |
| Send Key 上限 | 已达上限（10 个）——创建按钮 disabled 时的相邻提示 |
| 历史保留窗口分隔线 | —— 更早的消息已被清理 ——（同 viewer D-10 分隔线，oldest_kept_seq > 1 且翻到窗口底部时显示） |

### Destructive 确认框（逐字契约）

**重置 Channel Key（D-33）：**

- 标题：重置 Channel Key？
- 正文：重置后该频道所有已连接的客户端将立即被断开，需用新密钥重新连接；旧密钥**最长约 1 分钟后全局失效**（边缘缓存窗口）。频道历史消息完整保留。
- 按钮：[取消] [确认重置]（红）
- 成功后：新密钥以**明文一次性展示** + 复制按钮（接入片段卡同款），并显示提示条：已重置。旧密钥最长约 1 分钟内仍可能被边缘缓存放行，之后全局失效。

**吊销 Send Key（D-32）：**

- 标题：吊销 Send Key「{label 或掩码}」？
- 正文：吊销后使用该密钥的脚本下次调用将收到 401（最长约 1 分钟边缘缓存窗口）。此操作不可撤销。
- 按钮：[取消] [确认吊销]（红）

**删除频道（D-34，GitHub 删仓库模式）：**

- 标题：删除频道「{name}」
- 正文：硬删除不可恢复：全部消息历史将被清空，Channel Key 与所有 Send Key 立即失效，所有连接立即断开。输入频道名称以确认：
- 输入框 placeholder：输入频道名称的开头部分
- 联动：删除按钮初始 disabled（文字 `#9a9a9a`）；输入非空且为频道名前缀（`name.startsWith(input)`）时启用
- 按钮：[取消] [我已理解后果，删除频道]（红）
- 成功后：频道从列表消失，详情面板回到未选中空态：在左侧选择一个频道查看详情。

### 接入片段卡（D-39——创建成功的临门一脚）

创建频道成功（201 响应）后，详情面板顶部插入接入片段卡：

- 卡标题：已创建「{name}」——请复制以下接入信息（关闭后列表中密钥以掩码显示，需要时可点眼睛按钮查看完整密钥）
- 第 1 块 · 发送方接入（给机器人/脚本），带独立复制按钮：

```bash
curl -X POST {origin}/api/send \
  -H "Authorization: Bearer {sendKey}" \
  -H "Content-Type: application/json" \
  -d '{"title": "Hello", "body": "来自 PushHub 的第一条消息"}'
```

- 第 2 块 · 客户端接入（给接收端配置）：服务端地址 `{origin}`、Channel Key `{channelKey}`（明文展示 + 复制按钮）
- 第 3 块 · 网页端直达：`{origin}/?server={origin}&key={channelKey}`（`target="_blank"` + `noopener,noreferrer` 打开 + 复制按钮；viewer 已支持该 URL 参数自动连接）
- 关闭按钮：[已保存，关闭]
- 创建 Send Key 成功后：同款卡片仅含第 1 块（该新 Key 的 curl 示例）

---

## Interaction Patterns

（模板外补充节——本页交互契约的事实源，planner/executor 直接引用）

1. **登录屏障（D-28）**：载入时无 `pushhub.admin` → 仅渲染登录卡；有存储 → 直接渲染主界面并发 `GET /api/admin/channels` 验证，401 → 清存储回登录卡（WR-03 同款 try/catch 读取防护）。登出 = 清 localStorage + 回登录卡。全部 API 调用同源相对路径 + `Authorization: Bearer <key>` 头。
2. **密钥行（D-29）**：`[掩码 mono 13.6px] [眼睛按钮] [复制按钮]`，gap 8px。掩码格式 **`key.slice(0, 7) + "…" + key.slice(-4)`**（`phc_`/`phs_` 前缀完整保留 + 3 字符可见 + 后 4 字符，如 `phc_Ab3…xYz`）。揭示 = 点眼睛切换明文（inline SVG 图标 + `aria-label` "显示完整密钥"/"隐藏完整密钥"）；揭示态不跨刷新/跨选择持久。复制 = `navigator.clipboard.writeText`（完整密钥），反馈见文案表。API 响应含完整密钥，掩码是**纯前端渲染行为**。
3. **确认框**：一律原生 `<dialog>.showModal()`（内置焦点陷阱与 Esc 关闭，零依赖）；后果文案在确认按钮获得焦点前完整可见。
4. **消息历史（D-40）**：详情面板内 `<details>` 折叠区（summary：消息历史（排障）），首次展开懒加载。**seq 倒序**（最新在最上）；每条 = 头部（`#seq` + 时间 mono 12px graytext + title 加粗 textContent + answered 徽标）+ 正文 `PushHub.renderMarkdown(m.text)` 写 innerHTML（唯一 innerHTML 入口）。翻页：底部"加载更多"按钮带 `before=<本页最小 seq>` 请求，每页 50 条（服务端缺省值）；`has_more=false` 时按钮隐藏。
5. **频道列表**：列表项 = 频道名（textContent）+ 创建日期（12px graytext）；选中项 3px 绿色左指示条 + 文字 700 + `aria-current="true"`。创建成功自动选中新频道并展示接入片段卡。**手动"刷新"按钮**重拉列表——禁止自动轮询（KV list 独立 1,000 次/天额度红线）。
6. **Send Key 管理（D-30/D-31/D-32）**：行 = `[标签 或「未命名」graytext] [掩码] [创建日期 mono 12px] [眼睛] [复制] [吊销红字]`。创建表单 = 标签 input（maxlength 64，placeholder `如 deploy-bot（可选）`）+ "创建 Send Key"主按钮。列表达 10 个时创建按钮 disabled + 上限提示。
7. **表单校验**：频道名 input `maxlength=64` + required（服务端 `CHANNEL_NAME_MAX_LENGTH=64` 兜底）；标签 `maxlength=64`。服务端 400（invalid_body 等）经错误条展示信封 message。
8. **E2E 锚点（D-41）**：沿用 viewer id 惯例（`#login-form`、`#channel-list`、`#channel-detail`、`#history-list`）；动态行用 `data-testid`（`sendkey-row`、`snippet-card`、`confirm-delete` 等）。

---

## UI Considerations

> 元素集来自 7 组核心界面元素（登录屏障 / 频道列表+创建表单 / 频道详情 / Send Key 列表 / 消息历史 / 删除确认 / 全局错误加载）。Empty/error 文案见 `## Copywriting Contract`，本节只做状态覆盖并引用，不重复文案。

Applicable state considerations resolved: 8 raised — 7 covered, 1 backstop, 0 unresolved

| Category | Element(s) | Status | Resolution / Reason |
|----------|------------|--------|---------------------|
| empty | 频道列表、Send Key 列表、历史视图（list-collection）；登录/创建表单（form） | ✅ covered | 三列表各有专属空态文案（「还没有频道」/「该频道没有 Send Key…」/「该频道还没有消息…」）；表单以 placeholder 引导为天然空态 |
| loading | 频道列表首次 GET、历史首页/翻页、全部提交按钮（form/list-collection/interactive-control） | ✅ covered | 列表区「加载中…」文本占位；提交/翻页按钮 disabled + 「加载中…」；无骨架屏（与 viewer 文本占位模式一致，极简基线） |
| error | 全部 API 调用与历史加载（form/list-collection/interactive-control） | ✅ covered | D-06 信封错误条（`#c0392b` 底白字）统一展示 `{操作}失败（{code}）：{message}`；401 特例清存储回登录屏障；无自动重试——手动「刷新」按钮即重试入口 |
| populated | 频道列表（典型 < 20）、Send Key 列表（≤ 10）、历史（50 条/页） | ✅ covered | 左栏 300px 垂直列表 + 右栏详情面板的典型形态；消息卡片复用 viewer `.msg` 边框式样式 |
| partial | Send Key 无标签（label null）、消息无 title、旧 schema 频道记录（form/list-collection） | ✅ covered | 无标签显示「未命名」（graytext）；无 title 消息不渲染标题行（viewer appendMessage 同款）；旧 schema 由服务端 normalize 吸收，前端无感知 |
| overflow | 密钥字符串（36+ 字符）、接入片段代码块、频道名（list-collection/static-content） | 🧪 backstop | 密钥与频道名 `overflow-wrap: anywhere`；接入片段 pre `overflow-x: auto`（viewer pre 同款）——held-out E2E 断言：完整密钥揭示态不撑破详情面板布局 |
| zero-one-many | 频道 0/1/N、Send Key 0/1/N、消息 0/1/N（list-collection） | ✅ covered | 0 → 专属空态文案；1 与 N 同一列表形态（中文无单复数变形，无文案分支）；N 大时列表区独立滚动（max-height + overflow-y） |
| long-text | 频道名输入（≤ 64）、标签输入（≤ 64）、消息长 Markdown（form/static-content/interactive-control） | ✅ covered | 输入侧 `maxlength=64` + 服务端 400 兜底；长 Markdown 经 renderMarkdown 管道 + `.msg-body { overflow-wrap: anywhere }`（viewer 同款规则） |

---

## Registry Safety

| Registry | Blocks Used | Safety Gate |
|----------|-------------|-------------|
| not applicable | — | not required（非 React 栈，未初始化 shadcn；管理页零第三方组件——唯一外部引入是第一方构建产物 `/pushhub.js` 的 `PushHub.renderMarkdown`） |

---

## Checker Sign-Off

- [ ] Dimension 1 Copywriting: PASS
- [ ] Dimension 2 Visuals: PASS
- [ ] Dimension 3 Color: PASS
- [ ] Dimension 4 Typography: PASS
- [ ] Dimension 5 Spacing: PASS
- [ ] Dimension 6 Registry Safety: PASS

**Approval:** pending
