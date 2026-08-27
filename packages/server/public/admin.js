/**
 * PushHub 管理页逻辑（03-01 Task 2，D-28/D-29/D-37/D-38/D-39；03-02 Send Key
 * 管理；03-03 Channel Key 重置与频道删除）。
 *
 * 本切片职责：
 *  - 登录屏障（D-28）：载入无 pushhub.admin 存储 → 仅登录卡；有存储 → 主界面
 *    + GET /api/admin/channels 验证；任何 401 → 清存储回登录卡；登出同款。
 *  - 频道列表 + 创建（D-37/D-38）：创建 201 → 重拉列表 + 自动选中 + 接入
 *    片段卡（D-39 三块：curl / Channel Key 明文 / viewer 直达链接）。
 *  - 密钥行（D-29）：掩码 key.slice(0,7)+"…"+key.slice(-4)；眼睛揭示切换
 *    （不跨刷新/跨选择持久）；复制写完整密钥 + data-copied 反馈。
 *  - Send Key 管理（03-02，D-30/D-31/D-32）：创建表单（label 可选 ≤64）→
 *    201 后片段卡仅第 1 块；列表六要素行（标签/未命名 + 掩码 + 日期 + 眼睛 +
 *    复制 + 吊销红字）；达 10 个按钮 disabled + 上限提示；吊销走原生 dialog
 *    确认框（逐字文案）→ DELETE 204 → 行消失；400 send_key_limit 经错误条
 *    透传（UI 上限态与 API 检查双保险）。
 *  - Channel Key 重置（03-03，D-33）：确认框逐字契约（客户端立即断开/旧密钥
 *    ≤1 分钟全局失效/历史完整保留）→ POST 201 → 新密钥明文一次性展示（mono +
 *    复制，接入片段卡同款）+ 60s 双活窗口提示条（#d9a300 边框式）+ 掩码行刷新。
 *  - 频道删除（03-03，D-34 硬删除）：确认框前缀联动（输入非空且为频道名前缀
 *    才启用——GitHub 删仓库模式宽松变体）→ DELETE 204 → 列表移除 + 详情
 *    回空态。
 *  - 消息历史（03-04，D-40 排障视图）：详情面板 <details> 折叠区首展懒加载；
 *    seq 倒序渲染（#seq/时间 mono + title 加粗 + answered 徽标）+「加载更多」
 *    before 游标翻页 + 清理分隔线（oldest_kept_seq > 1）+ 空态文案。
 *
 * 安全纪律：
 *  - 消息正文是全文件唯一经 window.PushHub.renderMarkdown 消毒管道写 DOM 的
 *    入口（T-03-16，与 viewer 同款唯一管道纪律——构建期硬断言全文件恰 1 处，
 *    见 03-04 验证链）；其余一切用户可控字符串（频道名/标签/日期/密钥/错误
 *    消息/确认框文案/历史头部 #seq/时间/标题/徽标文本）一律 textContent
 *    （T-03-02/T-03-09）；眼睛图标经 <template> 克隆（inline SVG 是标记非
 *    脚本，CSP 兼容）。
 *  - 全部 API 同源相对路径 + Authorization: Bearer 头（无 CORS/CSRF 面）；
 *    鉴权经服务端 checkAdminAuth（T-03-01），本页不新增路由。
 *  - localStorage 键 pushhub.admin（独立于 viewer 两键），读写均 try/catch
 *    （WR-03 先例：存储全禁环境功能降级，不异常夭折）。
 *  - 无自动轮询（KV list 独立 1,000 次/天额度红线）——手动「刷新」即重试入口。
 */
"use strict";
(function () {
  var LS_ADMIN = "pushhub.admin";
  /** 每频道 Send Key 上限（D-31，与服务端 keys.ts SEND_KEY_LIMIT 同值约定）。 */
  var SEND_KEY_LIMIT = 10;

  var loginForm = document.getElementById("login-form");
  var adminKeyInput = document.getElementById("admin-key-input");
  var btnLogin = document.getElementById("btn-login");
  var app = document.getElementById("app");
  var topbarActions = document.getElementById("topbar-actions");
  var errorBar = document.getElementById("error-bar");
  var createForm = document.getElementById("create-form");
  var channelNameInput = document.getElementById("channel-name-input");
  var btnCreate = document.getElementById("btn-create");
  var channelList = document.getElementById("channel-list");
  var channelDetail = document.getElementById("channel-detail");
  var btnRefresh = document.getElementById("btn-refresh");
  var btnLogout = document.getElementById("btn-logout");
  var eyeIconTpl = document.getElementById("eye-icon");
  var revokeDialog = document.getElementById("revoke-dialog");
  var revokeDialogTitle = document.getElementById("revoke-dialog-title");
  var revokeDialogBody = document.getElementById("revoke-dialog-body");
  var btnRevokeCancel = document.getElementById("btn-revoke-cancel");
  var btnRevokeConfirm = document.getElementById("btn-revoke-confirm");
  var resetDialog = document.getElementById("reset-dialog");
  var resetDialogTitle = document.getElementById("reset-dialog-title");
  var resetDialogBody = document.getElementById("reset-dialog-body");
  var btnResetCancel = document.getElementById("btn-reset-cancel");
  var btnResetConfirm = document.getElementById("btn-reset-confirm");
  var deleteDialog = document.getElementById("delete-dialog");
  var deleteDialogTitle = document.getElementById("delete-dialog-title");
  var deleteDialogBody = document.getElementById("delete-dialog-body");
  var deleteNameInput = document.getElementById("delete-name-input");
  var btnDeleteCancel = document.getElementById("btn-delete-cancel");
  var btnDeleteConfirm = document.getElementById("btn-delete-confirm");

  var adminKey = null;
  var channels = [];
  var selectedId = null;
  /** 刚创建频道的接入片段数据（D-39：Send/Channel Key 明文一次性展示，关闭即弃）。 */
  var pendingSnippet = null;
  /** 刚创建 Send Key 的片段数据（D-30：仅第 1 块 curl，关闭即弃）。 */
  var pendingSendKeySnippet = null;
  /** 待确认吊销的 Send Key（dialog 打开期间持有，关闭即弃）。 */
  var pendingRevoke = null;
  /** 待重置的频道 channelId（dialog 打开期间持有，关闭即弃）。 */
  var pendingReset = null;
  /** 刚重置出的新 Channel Key（D-33：明文一次性展示数据，关闭即弃）。 */
  var pendingNewKey = null;
  /** 待删除的频道（D-34：dialog 打开期间持有，关闭即弃）。 */
  var pendingDelete = null;

  // ---- localStorage（WR-03：读写均 try/catch；存储不可用时降级为会话内存态） ----

  function readStoredKey() {
    try {
      return window.localStorage.getItem(LS_ADMIN);
    } catch (e) {
      return null;
    }
  }

  function storeKey(key) {
    try {
      window.localStorage.setItem(LS_ADMIN, key);
    } catch (e) {
      // 存储不可用（隐私模式等）——本次会话内存态即可，功能不夭折。
    }
  }

  function clearStoredKey() {
    try {
      window.localStorage.removeItem(LS_ADMIN);
    } catch (e) {
      // 同上。
    }
  }

  // ---- 错误条（D-06 信封透传；#c0392b 底白字） ----

  function showErrorBar(text) {
    errorBar.hidden = false;
    errorBar.textContent = text;
  }

  function hideErrorBar() {
    errorBar.hidden = true;
  }

  function networkError() {
    showErrorBar("网络请求失败，请检查连接后点「刷新」重试。");
  }

  /**
   * API 失败统一出口。401 特例：清存储回登录卡 + 固定文案（不给探测方
   * "接近正确"的区分信号——与服务端同码同文案策略一致）；其余按
   * 「{操作}失败（{code}）：{message}——请修正后重试。」透传信封。
   */
  function handleApiFailure(resp, json, actionLabel) {
    if (resp.status === 401) {
      clearStoredKey();
      adminKey = null;
      enterLoginScreen();
      showErrorBar("Admin Key 无效（invalid_key）：请重新输入。");
      return;
    }
    var code = json && json.error && json.error.code ? json.error.code : "unknown";
    var message =
      json && json.error && json.error.message ? json.error.message : "未知错误";
    showErrorBar(actionLabel + "失败（" + code + "）：" + message + "——请修正后重试。");
  }

  // ---- API（全部同源相对路径 + Bearer 头） ----

  function fetchChannelsWith(key) {
    return fetch("/api/admin/channels", {
      headers: { Authorization: "Bearer " + key },
    }).then(function (resp) {
      return resp
        .json()
        .catch(function () {
          return null;
        })
        .then(function (json) {
          return { resp: resp, json: json };
        });
    });
  }

  /** 响应体（可能空/非 JSON）安全解析为 {resp, json} 对。 */
  function fetchJsonPair(resp) {
    return resp
      .json()
      .catch(function () {
        return null;
      })
      .then(function (json) {
        return { resp: resp, json: json };
      });
  }

  /** 重拉频道列表并整体重渲染（创建/吊销后的统一刷新路径）。 */
  function refreshChannels(actionLabel) {
    renderListLoading();
    fetchChannelsWith(adminKey)
      .then(function (r) {
        if (r.resp.status === 200 && r.json && Array.isArray(r.json.channels)) {
          setChannels(r.json.channels);
        } else {
          handleApiFailure(r.resp, r.json, actionLabel);
        }
      })
      .catch(networkError);
  }

  // ---- 屏幕切换（D-28 登录屏障） ----

  function enterLoginScreen() {
    loginForm.hidden = false;
    app.hidden = true;
    topbarActions.hidden = true;
  }

  function enterMainScreen() {
    loginForm.hidden = true;
    app.hidden = false;
    topbarActions.hidden = false;
  }

  // ---- 小工具 ----

  function setBusy(btn, busy, normalLabel) {
    btn.disabled = busy;
    btn.textContent = busy ? "加载中…" : normalLabel;
  }

  function maskKey(key) {
    return key.slice(0, 7) + "…" + key.slice(-4);
  }

  function formatDate(ts) {
    return new Date(ts).toLocaleDateString();
  }

  /** 复制（D-29）：写完整密钥 + 「已复制」反馈 1.5s 复原 + data-copied 属性。 */
  function copyText(text, btn) {
    if (!navigator.clipboard || !navigator.clipboard.writeText) {
      showErrorBar("复制失败：浏览器剪贴板不可用。");
      return;
    }
    navigator.clipboard.writeText(text).then(
      function () {
        btn.textContent = "已复制";
        btn.setAttribute("data-copied", "");
        window.setTimeout(function () {
          btn.textContent = "复制";
          btn.removeAttribute("data-copied");
        }, 1500);
      },
      function () {
        showErrorBar("复制失败：浏览器剪贴板写入被拒绝。");
      },
    );
  }

  function buildCopyButton(text) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "copy-btn";
    btn.textContent = "复制";
    btn.addEventListener("click", function () {
      copyText(text, btn);
    });
    return btn;
  }

  /**
   * 眼睛揭示按钮（D-29，Channel Key 行与 Send Key 行共用）：点击切换目标
   * value 元素的掩码/明文（textContent 切换，绝不经标记注入路径写密钥）；揭示态
   * 不跨刷新/跨选择持久（随行销毁的组件局部状态）。
   */
  function buildEyeButton(valueEl, key) {
    var revealed = false;
    var eye = document.createElement("button");
    eye.type = "button";
    eye.className = "icon-btn";
    eye.setAttribute("aria-label", "显示完整密钥");
    if (eyeIconTpl && eyeIconTpl.content) {
      eye.appendChild(eyeIconTpl.content.cloneNode(true));
    }
    eye.addEventListener("click", function () {
      revealed = !revealed;
      valueEl.textContent = revealed ? key : maskKey(key);
      eye.setAttribute("aria-label", revealed ? "隐藏完整密钥" : "显示完整密钥");
    });
    return eye;
  }

  /**
   * 密钥行组件（D-29）：[掩码 mono] [眼睛按钮 inline SVG] [复制按钮]，gap 8px。
   */
  function buildKeyRow(key) {
    var row = document.createElement("div");
    row.className = "key-row";
    var value = document.createElement("span");
    value.className = "key-value mono";
    value.textContent = maskKey(key);
    row.appendChild(value);
    row.appendChild(buildEyeButton(value, key));
    row.appendChild(buildCopyButton(key));
    return row;
  }

  // ---- 接入片段卡（D-39：三块各自带独立复制按钮；03-02 增仅第 1 块变体） ----

  /** curl 发送方接入示例文本（D-39 第 1 块 / D-30 新 Send Key 片段共用构造器）。 */
  function buildCurlText(sendKey) {
    return (
      "curl -X POST " +
      window.location.origin +
      "/api/send \\\n" +
      '  -H "Authorization: Bearer ' +
      sendKey +
      '" \\\n' +
      '  -H "Content-Type: application/json" \\\n' +
      '  -d \'{"title": "Hello", "text": "来自 PushHub 的第一条消息"}\''
    );
  }

  function snippetBlock(heading, textToCopy) {
    var block = document.createElement("div");
    block.className = "snippet-block";
    var head = document.createElement("div");
    head.className = "snippet-block-head";
    var label = document.createElement("span");
    label.className = "snippet-block-label";
    label.textContent = heading;
    head.appendChild(label);
    head.appendChild(buildCopyButton(textToCopy));
    block.appendChild(head);
    return block;
  }

  function buildCopyLine(labelText, value) {
    var line = document.createElement("div");
    line.className = "copy-line";
    var name = document.createElement("span");
    name.className = "copy-line-label";
    name.textContent = labelText;
    var val = document.createElement("span");
    val.className = "key-value mono";
    val.textContent = value;
    line.appendChild(name);
    line.appendChild(val);
    return line;
  }

  function buildSnippetCard(s) {
    var origin = window.location.origin;
    var card = document.createElement("div");
    card.className = "snippet-card";
    card.setAttribute("data-testid", "snippet-card");

    var title = document.createElement("h2");
    title.className = "snippet-title";
    title.textContent =
      "已创建「" +
      s.name +
      "」——请复制以下接入信息（关闭后列表中密钥以掩码显示，需要时可点眼睛按钮查看完整密钥）";
    card.appendChild(title);

    // 第 1 块 · 发送方接入（给机器人/脚本）：curl 含 {origin}/api/send 与 Bearer Send Key。
    var curl = buildCurlText(s.sendKey);
    var b1 = snippetBlock("发送方接入（给机器人/脚本）", curl);
    var pre = document.createElement("pre");
    pre.className = "snippet-code";
    pre.textContent = curl;
    b1.appendChild(pre);
    card.appendChild(b1);

    // 第 2 块 · 客户端接入（给接收端配置）：服务端地址 + Channel Key 明文。
    var b2 = snippetBlock("客户端接入（给接收端配置）", s.channelKey);
    b2.appendChild(buildCopyLine("服务端地址", origin));
    b2.appendChild(buildCopyLine("Channel Key", s.channelKey));
    card.appendChild(b2);

    // 第 3 块 · 网页端直达：viewer URL 参数自动连接（noopener 新窗口）。
    var viewerUrl =
      origin +
      "/?server=" +
      encodeURIComponent(origin) +
      "&key=" +
      encodeURIComponent(s.channelKey);
    var b3 = snippetBlock("网页端直达", viewerUrl);
    var linkLine = document.createElement("div");
    linkLine.className = "copy-line";
    var link = document.createElement("a");
    link.className = "key-value mono";
    link.href = viewerUrl;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = viewerUrl;
    linkLine.appendChild(link);
    b3.appendChild(linkLine);
    card.appendChild(b3);

    var close = document.createElement("button");
    close.type = "button";
    close.className = "text-btn snippet-close";
    close.textContent = "已保存，关闭";
    close.addEventListener("click", function () {
      pendingSnippet = null;
      renderDetail();
    });
    card.appendChild(close);

    return card;
  }

  /**
   * 新建 Send Key 的片段卡（D-30/UI-SPEC「创建 Send Key 成功后：同款卡片
   * 仅含第 1 块」）：curl 示例含该 Key 完整值（201 是密钥唯一完整返回点），
   * 关闭即弃。
   */
  function buildSendKeySnippetCard(s) {
    var card = document.createElement("div");
    card.className = "snippet-card";
    card.setAttribute("data-testid", "snippet-card");

    var title = document.createElement("h2");
    title.className = "snippet-title";
    title.textContent =
      "已创建 Send Key「" +
      (s.label ? s.label : "未命名") +
      "」——请复制以下接入信息（关闭后列表中密钥以掩码显示）";
    card.appendChild(title);

    var curl = buildCurlText(s.key);
    var b1 = snippetBlock("发送方接入（给机器人/脚本）", curl);
    var pre = document.createElement("pre");
    pre.className = "snippet-code";
    pre.textContent = curl;
    b1.appendChild(pre);
    card.appendChild(b1);

    var close = document.createElement("button");
    close.type = "button";
    close.className = "text-btn snippet-close";
    close.textContent = "已保存，关闭";
    close.addEventListener("click", function () {
      pendingSendKeySnippet = null;
      renderDetail();
    });
    card.appendChild(close);

    return card;
  }

  /**
   * 重置 Channel Key 成功卡（03-03，D-33）：新密钥明文一次性展示（mono +
   * 复制按钮，接入片段卡同款）+ 60s 双活窗口提示条（#d9a300 边框式非填充），
   * 关闭即弃。
   */
  function buildResetKeyCard(s) {
    var card = document.createElement("div");
    card.className = "snippet-card";
    card.setAttribute("data-testid", "new-key-display");

    var title = document.createElement("h2");
    title.className = "snippet-title";
    title.textContent =
      "已重置 Channel Key——请立即复制新密钥（关闭后列表中密钥以掩码显示，需要时可点眼睛按钮查看完整密钥）";
    card.appendChild(title);

    var block = snippetBlock("新 Channel Key", s.channelKey);
    block.appendChild(buildCopyLine("Channel Key", s.channelKey));
    card.appendChild(block);

    var hint = document.createElement("p");
    hint.id = "key-reset-hint";
    hint.className = "dual-window-hint";
    hint.textContent =
      "已重置。旧密钥最长约 1 分钟内仍可能被边缘缓存放行，之后全局失效。";
    card.appendChild(hint);

    var close = document.createElement("button");
    close.type = "button";
    close.className = "text-btn snippet-close";
    close.textContent = "已保存，关闭";
    close.addEventListener("click", function () {
      pendingNewKey = null;
      renderDetail();
    });
    card.appendChild(close);

    return card;
  }

  // ---- 频道列表（D-38：0/1/N 同一列表形态；独立滚动） ----

  function renderListLoading() {
    channelList.textContent = "";
    var p = document.createElement("p");
    p.className = "list-status";
    p.textContent = "加载中…";
    channelList.appendChild(p);
  }

  function renderChannelList() {
    channelList.textContent = "";
    if (channels.length === 0) {
      var heading = document.createElement("p");
      heading.className = "empty-heading";
      heading.textContent = "还没有频道";
      var body = document.createElement("p");
      body.className = "empty-body";
      body.textContent =
        "在上方输入频道名称创建第一个频道，创建后即可获得 Channel Key 与 Send Key。";
      channelList.appendChild(heading);
      channelList.appendChild(body);
      return;
    }
    channels.forEach(function (ch) {
      var item = document.createElement("button");
      item.type = "button";
      item.className = "channel-item";
      var name = document.createElement("span");
      name.className = "channel-item-name";
      name.textContent = ch.name;
      var date = document.createElement("span");
      date.className = "channel-item-date mono";
      date.textContent = formatDate(ch.createdAt);
      item.appendChild(name);
      item.appendChild(date);
      if (ch.channelId === selectedId) {
        item.classList.add("selected");
        item.setAttribute("aria-current", "true");
      }
      item.addEventListener("click", function () {
        selectedId = ch.channelId;
        renderChannelList();
        renderDetail();
      });
      channelList.appendChild(item);
    });
  }

  // ---- 详情面板（D-38 右栏：片段卡在顶，Channel Key / Send Key 区块） ----

  function findSelected() {
    for (var i = 0; i < channels.length; i++) {
      if (channels[i].channelId === selectedId) return channels[i];
    }
    return null;
  }

  function renderDetail() {
    channelDetail.textContent = "";
    var ch = findSelected();
    if (ch === null) {
      var empty = document.createElement("p");
      empty.className = "detail-empty";
      empty.textContent = "在左侧选择一个频道查看详情。";
      channelDetail.appendChild(empty);
      return;
    }

    var name = document.createElement("h2");
    name.className = "detail-name";
    name.textContent = ch.name;
    channelDetail.appendChild(name);

    var meta = document.createElement("p");
    meta.className = "detail-meta mono";
    meta.textContent = "创建于 " + new Date(ch.createdAt).toLocaleString();
    channelDetail.appendChild(meta);

    if (pendingSnippet !== null && pendingSnippet.channelId === ch.channelId) {
      channelDetail.appendChild(buildSnippetCard(pendingSnippet));
    }
    if (
      pendingSendKeySnippet !== null &&
      pendingSendKeySnippet.channelId === ch.channelId
    ) {
      channelDetail.appendChild(buildSendKeySnippetCard(pendingSendKeySnippet));
    }
    if (pendingNewKey !== null && pendingNewKey.channelId === ch.channelId) {
      channelDetail.appendChild(buildResetKeyCard(pendingNewKey));
    }

    var ckBlock = document.createElement("section");
    ckBlock.className = "detail-block";
    var ckHead = document.createElement("h2");
    ckHead.textContent = "Channel Key";
    ckBlock.appendChild(ckHead);
    ckBlock.appendChild(buildKeyRow(ch.channelKey));
    // 重置入口（D-33，destructive 保留清单第 3 项：红字按钮）。
    var btnResetKey = document.createElement("button");
    btnResetKey.type = "button";
    btnResetKey.id = "btn-reset-channel-key";
    btnResetKey.className = "revoke-btn";
    btnResetKey.textContent = "重置 Channel Key";
    btnResetKey.addEventListener("click", function () {
      openResetDialog(ch.channelId);
    });
    ckBlock.appendChild(btnResetKey);
    channelDetail.appendChild(ckBlock);

    channelDetail.appendChild(buildSendKeysBlock(ch));

    // 消息历史折叠区（03-04，D-40）：懒加载 <details>——首次展开才 GET messages。
    channelDetail.appendChild(buildHistoryBlock(ch));

    // 删除频道（D-34 硬删除，destructive 保留清单第 1 项：详情面板底部红按钮）。
    var danger = document.createElement("section");
    danger.className = "danger-block";
    var btnDelete = document.createElement("button");
    btnDelete.type = "button";
    btnDelete.id = "btn-delete-channel";
    btnDelete.className = "revoke-btn";
    btnDelete.textContent = "删除频道";
    btnDelete.addEventListener("click", function () {
      openDeleteDialog(ch);
    });
    danger.appendChild(btnDelete);
    channelDetail.appendChild(danger);
  }

  /**
   * Send Key 管理区（03-02，D-30/D-31/D-32 + UI-SPEC #6）：
   * 创建表单（label 可选 ≤64）+ 上限态（达 10 disabled + 提示）+ 列表
   * （六要素行：标签/未命名 graytext、掩码、日期 mono、眼睛、复制、吊销红字）
   * + 空态文案。全部随频道数据重渲染——上限态/空态无需独立状态管理。
   */
  function buildSendKeysBlock(ch) {
    var block = document.createElement("section");
    block.className = "detail-block";
    var head = document.createElement("h2");
    head.textContent = "Send Keys";
    block.appendChild(head);

    var keys = ch.sendKeys || [];
    var atLimit = keys.length >= SEND_KEY_LIMIT;

    // 创建表单：label 空输入视为省略（POST 体不带 label 键）。
    var form = document.createElement("form");
    form.id = "sendkey-form";
    var formRow = document.createElement("div");
    formRow.className = "sendkey-form-row";
    var input = document.createElement("input");
    input.id = "sendkey-label-input";
    input.name = "label";
    input.type = "text";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.setAttribute("maxlength", "64");
    input.placeholder = "如 deploy-bot（可选）";
    var btn = document.createElement("button");
    btn.type = "submit";
    btn.id = "btn-create-sendkey";
    btn.className = "primary-btn";
    btn.textContent = "创建 Send Key";
    if (atLimit) {
      btn.disabled = true;
    }
    formRow.appendChild(input);
    formRow.appendChild(btn);
    form.appendChild(formRow);
    if (atLimit) {
      var hint = document.createElement("p");
      hint.id = "sendkey-limit-hint";
      hint.className = "limit-hint";
      hint.textContent = "已达上限（10 个）";
      form.appendChild(hint);
    }
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      createSendKey(ch.channelId, input);
    });
    block.appendChild(form);

    if (keys.length === 0) {
      var empty = document.createElement("p");
      empty.className = "sendkey-empty";
      empty.textContent =
        "该频道没有 Send Key——创建一个给脚本使用，不同脚本各用各的 Key，泄露不互伤。";
      block.appendChild(empty);
      return block;
    }

    keys.forEach(function (rec) {
      var row = document.createElement("div");
      row.className = "sendkey-row";
      row.setAttribute("data-testid", "sendkey-row");
      var label = document.createElement("span");
      label.className = "sendkey-label";
      if (rec.label) {
        label.textContent = rec.label;
      } else {
        label.textContent = "未命名";
        label.classList.add("unnamed");
      }
      row.appendChild(label);
      var value = document.createElement("span");
      value.className = "key-value mono";
      value.textContent = maskKey(rec.key);
      row.appendChild(value);
      var date = document.createElement("span");
      date.className = "mono sendkey-date";
      date.textContent = formatDate(rec.createdAt);
      row.appendChild(date);
      row.appendChild(buildEyeButton(value, rec.key));
      row.appendChild(buildCopyButton(rec.key));
      var revoke = document.createElement("button");
      revoke.type = "button";
      revoke.className = "revoke-btn";
      revoke.textContent = "吊销";
      revoke.addEventListener("click", function () {
        openRevokeDialog(ch.channelId, rec);
      });
      row.appendChild(revoke);
      block.appendChild(row);
    });
    return block;
  }

  // ---- 消息历史折叠区（03-04，D-40 + UI-SPEC Interaction #4）----

  /** 历史空态文案（UI-SPEC Copywriting 补充文案表，逐字）。 */
  var HISTORY_EMPTY_TEXT =
    "该频道还没有消息——Webhook 发送第一条消息后会显示在这里。";
  /** 清理分隔线文案（同 viewer D-10 分隔线，逐字）。 */
  var HISTORY_SEPARATOR_TEXT = "—— 更早的消息已被清理 ——";

  /**
   * 历史区状态（随频道切换重置；同频道重渲染——refreshChannels 后
   * renderDetail 重建 DOM——保留已加载页，消息从本状态重放）。
   */
  var historyState = null;

  function resetHistoryState(channelId) {
    historyState = {
      channelId: channelId,
      loaded: false,
      loading: false,
      messages: [], // 已加载消息（API 返回序——倒序，最新在前）
      hasMore: false,
      oldestKept: 0,
    };
  }

  function ensureHistoryState(channelId) {
    if (historyState === null || historyState.channelId !== channelId) {
      resetHistoryState(channelId);
    }
    return historyState;
  }

  /**
   * 单条历史消息渲染（倒序即 API 返回序，最新在最上——直接 appendChild）：
   * 头部 = #seq（mono）+ 时间（mono graytext）+ title（如有则 strong
   * textContent；无 title 不渲染标题行——viewer appendMessage 同款）+
   * answered 徽标双态（true → 「已回复」绿样式 / false → 「未回复」graytext
   * 样式；本期恒 false，绿样式 Phase 4 复用）；正文 = renderMarkdown 消毒
   * 管道（全管理页唯一该类入口，T-03-16）。
   */
  function buildHistoryMessage(m) {
    var item = document.createElement("div");
    item.className = "hist-msg";
    item.setAttribute("data-testid", "history-msg");

    var head = document.createElement("div");
    head.className = "hist-msg-head";
    var seq = document.createElement("span");
    seq.className = "mono hist-seq";
    seq.textContent = "#" + m.seq;
    head.appendChild(seq);
    var time = document.createElement("time");
    time.className = "mono hist-time";
    time.textContent = new Date(m.created_at).toLocaleTimeString();
    head.appendChild(time);
    if (m.title) {
      var title = document.createElement("strong");
      title.className = "hist-title";
      title.textContent = m.title;
      head.appendChild(title);
    }
    var badge = document.createElement("span");
    badge.className =
      m.answered === true ? "badge-answered" : "badge-unanswered";
    badge.textContent = m.answered === true ? "已回复" : "未回复";
    head.appendChild(badge);
    item.appendChild(head);

    var body = document.createElement("div");
    body.className = "hist-msg-body";
    body.innerHTML = window.PushHub.renderMarkdown(m.text);
    item.appendChild(body);
    return item;
  }

  /**
   * 历史列表整体渲染（首拉完成后与翻页追加后统一入口——从状态重放，同频道
   * 重渲染亦走此处）：
   *  - 未加载：空容器（首展 toggle 时才发起请求）；
   *  - 空（首拉 messages 空数组且未加载过更多）：空态文案；
   *  - 有消息：倒序渲染；has_more=true → 显示「加载更多」；has_more=false →
   *    隐藏按钮，且 oldest_kept_seq > 1 时列表底部渲染清理分隔线（viewer
   *    maybeSeparator 同款判定：oldest_kept_seq <= 1 等价从未清理不渲染——
   *    D-10 诚实缺口，不虚构不存在的缺口；每频道每次展开至多一条）。
   */
  function renderHistoryInto(list, moreBtn, state) {
    list.textContent = "";
    moreBtn.hidden = true;
    if (!state.loaded) {
      return;
    }
    if (state.messages.length === 0) {
      var empty = document.createElement("p");
      empty.className = "history-empty";
      empty.textContent = HISTORY_EMPTY_TEXT;
      list.appendChild(empty);
      return;
    }
    state.messages.forEach(function (m) {
      list.appendChild(buildHistoryMessage(m));
    });
    if (state.hasMore) {
      moreBtn.hidden = false;
    } else if (state.oldestKept > 1) {
      var sep = document.createElement("p");
      sep.className = "history-separator";
      sep.textContent = HISTORY_SEPARATOR_TEXT;
      list.appendChild(sep);
    }
  }

  /**
   * 历史折叠区块（renderDetail 组装）：summary「消息历史（排障）」+
   * #history-list（独立滚动）+ #btn-history-more。首展 toggle 懒加载（未
   * 加载且未在途才发起）；「加载更多」带 before=当前已渲染列表最小 seq。
   */
  function buildHistoryBlock(ch) {
    var state = ensureHistoryState(ch.channelId);
    var details = document.createElement("details");
    details.className = "history-block";
    details.id = "history-details";
    var summary = document.createElement("summary");
    summary.textContent = "消息历史（排障）";
    details.appendChild(summary);

    var list = document.createElement("div");
    list.id = "history-list";
    list.className = "history-list";
    details.appendChild(list);

    var more = document.createElement("button");
    more.type = "button";
    more.id = "btn-history-more";
    more.className = "history-more-btn";
    more.textContent = "加载更多";
    more.hidden = true;
    details.appendChild(more);

    details.addEventListener("toggle", function () {
      if (details.open && !state.loaded && !state.loading) {
        loadHistory(ch.channelId, null);
      }
    });
    more.addEventListener("click", function () {
      if (state.loading) return;
      var minSeq = null;
      for (var i = 0; i < state.messages.length; i++) {
        var s = state.messages[i].seq;
        if (typeof s === "number" && (minSeq === null || s < minSeq)) {
          minSeq = s;
        }
      }
      if (minSeq === null) return;
      loadHistory(ch.channelId, minSeq);
    });

    // 同频道重渲染：从状态重放已加载页（首展前则保持空容器）。
    renderHistoryInto(list, more, state);
    return details;
  }

  /**
   * 历史页加载（before === null 首页 / 否则游标翻页）：
   *  - SDK 缺失前置检查：无 window.PushHub.renderMarkdown 时错误条提示且
   *    不发起请求（消息正文无消毒管道可渲染——错误且不抛异常，(g)）；
   *  - 请求期间「加载更多」disabled + 「加载中…」；首页在列表区文本占位；
   *  - 迟到响应防御：回调时频道已切换则丢弃（不渲染进新频道）；
   *  - 错误走既有错误条（handleApiFailure：401 特例清存储回登录；信封
   *    code/message 透传）。
   */
  function loadHistory(channelId, before) {
    if (adminKey === null) return;
    var state = ensureHistoryState(channelId);
    if (
      !window.PushHub ||
      typeof window.PushHub.renderMarkdown !== "function"
    ) {
      showErrorBar("消息渲染组件（pushhub.js）加载失败，请刷新页面重试。");
      return;
    }
    state.loading = true;
    hideErrorBar();
    var moreBtn = document.getElementById("btn-history-more");
    if (before === null) {
      var listEl = document.getElementById("history-list");
      if (listEl !== null) {
        listEl.textContent = "";
        var loading = document.createElement("p");
        loading.className = "history-status";
        loading.textContent = "加载中…";
        listEl.appendChild(loading);
      }
    } else if (moreBtn !== null) {
      setBusy(moreBtn, true, "加载更多");
    }
    var query =
      before === null ? "" : "?before=" + encodeURIComponent(before);
    fetch(
      "/api/admin/channels/" +
        encodeURIComponent(channelId) +
        "/messages" +
        query,
      { headers: { Authorization: "Bearer " + adminKey } },
    )
      .then(fetchJsonPair)
      .then(function (r) {
        state.loading = false;
        if (moreBtn !== null) {
          setBusy(moreBtn, false, "加载更多");
        }
        if (
          r.resp.status === 200 &&
          r.json &&
          Array.isArray(r.json.messages)
        ) {
          // 频道已切换：迟到响应丢弃。
          if (historyState === null || historyState.channelId !== channelId) {
            return;
          }
          state.loaded = true;
          state.messages = state.messages.concat(r.json.messages);
          state.hasMore = r.json.has_more === true;
          state.oldestKept =
            typeof r.json.oldest_kept_seq === "number"
              ? r.json.oldest_kept_seq
              : 0;
          var list = document.getElementById("history-list");
          var more = document.getElementById("btn-history-more");
          if (list !== null && more !== null) {
            renderHistoryInto(list, more, state);
          }
        } else {
          handleApiFailure(r.resp, r.json, "加载消息历史");
        }
      })
      .catch(function () {
        state.loading = false;
        if (moreBtn !== null) {
          setBusy(moreBtn, false, "加载更多");
        }
        networkError();
      });
  }

  // ---- Send Key 创建/吊销交互（03-02） ----

  function createSendKey(channelId, input) {
    if (adminKey === null) return;
    var btn = document.getElementById("btn-create-sendkey");
    var labelValue = input.value.trim();
    setBusy(btn, true, "创建 Send Key");
    hideErrorBar();
    fetch("/api/admin/channels/" + encodeURIComponent(channelId) + "/send-keys", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + adminKey,
        "content-type": "application/json",
      },
      body: JSON.stringify(labelValue ? { label: labelValue } : {}),
    })
      .then(fetchJsonPair)
      .then(function (r) {
        setBusy(btn, false, "创建 Send Key");
        if (r.resp.status === 201 && r.json && r.json.key) {
          input.value = "";
          pendingSendKeySnippet = {
            channelId: channelId,
            key: r.json.key,
            label: r.json.label,
          };
          refreshChannels("刷新列表");
        } else {
          // 400 send_key_limit 等经错误条透传信封 message（竞态兜底——
          // UI 上限态与 API 上限检查双保险，D-31）。
          handleApiFailure(r.resp, r.json, "创建 Send Key");
        }
      })
      .catch(function () {
        setBusy(btn, false, "创建 Send Key");
        networkError();
      });
  }

  /** 吊销确认框（UI-SPEC Destructive 逐字契约；原生 dialog 焦点陷阱 + Esc）。 */
  function openRevokeDialog(channelId, rec) {
    pendingRevoke = { channelId: channelId, key: rec.key, label: rec.label };
    revokeDialogTitle.textContent =
      "吊销 Send Key「" + (rec.label ? rec.label : maskKey(rec.key)) + "」？";
    revokeDialogBody.textContent =
      "吊销后使用该密钥的脚本下次调用将收到 401（最长约 1 分钟边缘缓存窗口）。此操作不可撤销。";
    revokeDialog.showModal();
  }

  btnRevokeCancel.addEventListener("click", function () {
    pendingRevoke = null;
    revokeDialog.close();
  });
  // Esc 关闭同样清引用（cancel 事件在 close() 与 Esc 两路径都触发）。
  revokeDialog.addEventListener("cancel", function () {
    pendingRevoke = null;
  });

  btnRevokeConfirm.addEventListener("click", function () {
    if (pendingRevoke === null) {
      revokeDialog.close();
      return;
    }
    if (adminKey === null) {
      pendingRevoke = null;
      revokeDialog.close();
      return;
    }
    var target = pendingRevoke;
    pendingRevoke = null;
    revokeDialog.close();
    setBusy(btnRevokeConfirm, true, "确认吊销");
    hideErrorBar();
    fetch(
      "/api/admin/channels/" +
        encodeURIComponent(target.channelId) +
        "/send-keys/" +
        encodeURIComponent(target.key),
      {
        method: "DELETE",
        headers: { Authorization: "Bearer " + adminKey },
      },
    )
      .then(fetchJsonPair)
      .then(function (r) {
        setBusy(btnRevokeConfirm, false, "确认吊销");
        if (r.resp.status === 204) {
          // 行消失：整体重渲染（列表数据来自重拉的 id: 记录）。
          refreshChannels("刷新列表");
        } else {
          handleApiFailure(r.resp, r.json, "吊销 Send Key");
        }
      })
      .catch(function () {
        setBusy(btnRevokeConfirm, false, "确认吊销");
        networkError();
      });
  });

  // ---- Channel Key 重置交互（03-03，D-33——确认框逐字契约 + 一次性明文展示） ----

  function openResetDialog(channelId) {
    pendingReset = channelId;
    resetDialog.showModal();
  }

  btnResetCancel.addEventListener("click", function () {
    pendingReset = null;
    resetDialog.close();
  });
  // Esc 关闭同样清引用（cancel 事件在 close() 与 Esc 两路径都触发）。
  resetDialog.addEventListener("cancel", function () {
    pendingReset = null;
  });

  btnResetConfirm.addEventListener("click", function () {
    if (pendingReset === null) {
      resetDialog.close();
      return;
    }
    if (adminKey === null) {
      pendingReset = null;
      resetDialog.close();
      return;
    }
    var target = pendingReset;
    pendingReset = null;
    resetDialog.close();
    setBusy(btnResetConfirm, true, "确认重置");
    hideErrorBar();
    fetch(
      "/api/admin/channels/" + encodeURIComponent(target) + "/reset-channel-key",
      {
        method: "POST",
        headers: { Authorization: "Bearer " + adminKey },
      },
    )
      .then(fetchJsonPair)
      .then(function (r) {
        setBusy(btnResetConfirm, false, "确认重置");
        if (r.resp.status === 201 && r.json && r.json.channelKey) {
          // 新密钥明文一次性展示 + 60s 提示条；掩码行经 refreshChannels 更新。
          pendingNewKey = { channelId: target, channelKey: r.json.channelKey };
          refreshChannels("刷新列表");
        } else {
          handleApiFailure(r.resp, r.json, "重置 Channel Key");
        }
      })
      .catch(function () {
        setBusy(btnResetConfirm, false, "确认重置");
        networkError();
      });
  });

  // ---- 频道删除交互（03-03，D-34——前缀联动 GitHub 删仓库模式宽松变体） ----

  /**
   * 前缀联动：输入非空（value.length > 0）且为频道名前缀
   * （name.startsWith(value)）时才启用删除按钮；初始与清空态 disabled。
   */
  function updateDeleteButtonState() {
    if (pendingDelete === null) {
      btnDeleteConfirm.disabled = true;
      return;
    }
    var value = deleteNameInput.value;
    btnDeleteConfirm.disabled = !(
      value.length > 0 &&
      pendingDelete.name.startsWith(value)
    );
  }

  function openDeleteDialog(ch) {
    pendingDelete = ch;
    deleteDialogTitle.textContent = "删除频道「" + ch.name + "」";
    deleteNameInput.value = "";
    updateDeleteButtonState();
    deleteDialog.showModal();
  }

  deleteNameInput.addEventListener("input", updateDeleteButtonState);

  btnDeleteCancel.addEventListener("click", function () {
    pendingDelete = null;
    deleteDialog.close();
  });
  deleteDialog.addEventListener("cancel", function () {
    pendingDelete = null;
  });

  btnDeleteConfirm.addEventListener("click", function () {
    if (pendingDelete === null || btnDeleteConfirm.disabled) {
      if (deleteDialog.open) {
        deleteDialog.close();
      }
      return;
    }
    if (adminKey === null) {
      pendingDelete = null;
      deleteDialog.close();
      return;
    }
    var target = pendingDelete;
    pendingDelete = null;
    deleteDialog.close();
    setBusy(btnDeleteConfirm, true, "我已理解后果，删除频道");
    hideErrorBar();
    fetch("/api/admin/channels/" + encodeURIComponent(target.channelId), {
      method: "DELETE",
      headers: { Authorization: "Bearer " + adminKey },
    })
      .then(fetchJsonPair)
      .then(function (r) {
        setBusy(btnDeleteConfirm, false, "我已理解后果，删除频道");
        if (r.resp.status === 204) {
          // 频道从列表消失；详情回空态「在左侧选择一个频道查看详情。」
          // （setChannels 对 selectedId 缺席频道的既有处理）。
          // 已删频道的一次性展示数据一并弃。
          if (
            pendingSnippet !== null &&
            pendingSnippet.channelId === target.channelId
          ) {
            pendingSnippet = null;
          }
          if (
            pendingSendKeySnippet !== null &&
            pendingSendKeySnippet.channelId === target.channelId
          ) {
            pendingSendKeySnippet = null;
          }
          if (
            pendingNewKey !== null &&
            pendingNewKey.channelId === target.channelId
          ) {
            pendingNewKey = null;
          }
          refreshChannels("刷新列表");
        } else {
          handleApiFailure(r.resp, r.json, "删除频道");
        }
      })
      .catch(function () {
        setBusy(btnDeleteConfirm, false, "我已理解后果，删除频道");
        networkError();
      });
  });

  function setChannels(list) {
    channels = Array.isArray(list) ? list : [];
    if (selectedId !== null && findSelected() === null) {
      selectedId = null;
    }
    renderChannelList();
    renderDetail();
  }

  // ---- 交互：登录（D-28） ----

  loginForm.addEventListener("submit", function (ev) {
    ev.preventDefault();
    var key = adminKeyInput.value.trim();
    if (!key) return;
    setBusy(btnLogin, true, "登录");
    hideErrorBar();
    fetchChannelsWith(key)
      .then(function (r) {
        setBusy(btnLogin, false, "登录");
        if (r.resp.status === 200 && r.json && Array.isArray(r.json.channels)) {
          adminKey = key;
          storeKey(key);
          adminKeyInput.value = "";
          enterMainScreen();
          renderListLoading();
          setChannels(r.json.channels);
        } else {
          handleApiFailure(r.resp, r.json, "登录");
        }
      })
      .catch(function () {
        setBusy(btnLogin, false, "登录");
        networkError();
      });
  });

  // ---- 交互：创建频道（D-39：201 → 重拉列表 + 自动选中 + 片段卡） ----

  createForm.addEventListener("submit", function (ev) {
    ev.preventDefault();
    var name = channelNameInput.value.trim();
    if (!name || adminKey === null) return;
    setBusy(btnCreate, true, "创建频道");
    hideErrorBar();
    fetch("/api/admin/channels", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + adminKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: name }),
    })
      .then(function (resp) {
        return resp
          .json()
          .catch(function () {
            return null;
          })
          .then(function (json) {
            return { resp: resp, json: json };
          });
      })
      .then(function (r) {
        setBusy(btnCreate, false, "创建频道");
        if (
          r.resp.status === 201 &&
          r.json &&
          r.json.channelId &&
          r.json.sendKeys &&
          r.json.sendKeys[0]
        ) {
          channelNameInput.value = "";
          pendingSnippet = {
            channelId: r.json.channelId,
            name: r.json.name,
            channelKey: r.json.channelKey,
            sendKey: r.json.sendKeys[0].key,
          };
          selectedId = r.json.channelId;
          renderListLoading();
          fetchChannelsWith(adminKey)
            .then(function (r2) {
              if (r2.resp.status === 200 && r2.json && Array.isArray(r2.json.channels)) {
                setChannels(r2.json.channels);
              } else {
                handleApiFailure(r2.resp, r2.json, "刷新列表");
              }
            })
            .catch(networkError);
        } else {
          handleApiFailure(r.resp, r.json, "创建频道");
        }
      })
      .catch(function () {
        setBusy(btnCreate, false, "创建频道");
        networkError();
      });
  });

  // ---- 交互：手动刷新（KV list 额度红线——禁止自动轮询）与登出 ----

  btnRefresh.addEventListener("click", function () {
    if (adminKey === null) return;
    btnRefresh.disabled = true;
    renderListLoading();
    fetchChannelsWith(adminKey)
      .then(function (r) {
        btnRefresh.disabled = false;
        if (r.resp.status === 200 && r.json && Array.isArray(r.json.channels)) {
          setChannels(r.json.channels);
        } else {
          handleApiFailure(r.resp, r.json, "刷新列表");
        }
      })
      .catch(function () {
        btnRefresh.disabled = false;
        networkError();
      });
  });

  btnLogout.addEventListener("click", function () {
    clearStoredKey();
    adminKey = null;
    channels = [];
    selectedId = null;
    pendingSnippet = null;
    pendingSendKeySnippet = null;
    pendingRevoke = null;
    pendingReset = null;
    pendingNewKey = null;
    pendingDelete = null;
    historyState = null;
    if (revokeDialog.open) {
      revokeDialog.close();
    }
    if (resetDialog.open) {
      resetDialog.close();
    }
    if (deleteDialog.open) {
      deleteDialog.close();
    }
    hideErrorBar();
    enterLoginScreen();
  });

  // ---- Destructive 确认框逐字契约（03-03，UI-SPEC D-33/D-34）----
  // 文案由本文件 textContent 填充（token 契约单一来源；HTML 骨架零文案）。

  resetDialogTitle.textContent = "重置 Channel Key？";
  resetDialogBody.textContent =
    "重置后该频道所有已连接的客户端将立即被断开，需用新密钥重新连接；旧密钥最长约 1 分钟后全局失效（边缘缓存窗口）。频道历史消息完整保留。";
  deleteDialogBody.textContent =
    "硬删除不可恢复：全部消息历史将被清空，Channel Key 与所有 Send Key 立即失效，所有连接立即断开。输入频道名称以确认：";
  btnDeleteConfirm.textContent = "我已理解后果，删除频道";
  deleteNameInput.placeholder = "输入频道名称的开头部分";

  // ---- 载入（D-28：有存储直接主界面并验证；无存储仅登录卡） ----

  (function init() {
    var stored = readStoredKey();
    if (stored) {
      adminKey = stored;
      enterMainScreen();
      renderListLoading();
      fetchChannelsWith(stored)
        .then(function (r) {
          if (r.resp.status === 200 && r.json && Array.isArray(r.json.channels)) {
            setChannels(r.json.channels);
          } else {
            handleApiFailure(r.resp, r.json, "登录");
          }
        })
        .catch(networkError);
    } else {
      enterLoginScreen();
    }
  })();
})();
