/**
 * PushHub 管理页逻辑（03-01 Task 2，D-28/D-29/D-37/D-38/D-39）。
 *
 * 本切片职责：
 *  - 登录屏障（D-28）：载入无 pushhub.admin 存储 → 仅登录卡；有存储 → 主界面
 *    + GET /api/admin/channels 验证；任何 401 → 清存储回登录卡；登出同款。
 *  - 频道列表 + 创建（D-37/D-38）：创建 201 → 重拉列表 + 自动选中 + 接入
 *    片段卡（D-39 三块：curl / Channel Key 明文 / viewer 直达链接）。
 *  - 密钥行（D-29）：掩码 key.slice(0,7)+"…"+key.slice(-4)；眼睛揭示切换
 *    （不跨刷新/跨选择持久）；复制写完整密钥 + data-copied 反馈。
 *
 * 安全纪律：
 *  - 全文件零 innerHTML——频道名/日期/密钥/错误消息一律 textContent（T-03-02）；
 *    眼睛图标经 <template> 克隆（inline SVG 是标记非脚本，CSP 兼容）。
 *  - 全部 API 同源相对路径 + Authorization: Bearer 头（无 CORS/CSRF 面）；
 *    鉴权经服务端 checkAdminAuth（T-03-01），本页不新增路由。
 *  - localStorage 键 pushhub.admin（独立于 viewer 两键），读写均 try/catch
 *    （WR-03 先例：存储全禁环境功能降级，不异常夭折）。
 *  - 无自动轮询（KV list 独立 1,000 次/天额度红线）——手动「刷新」即重试入口。
 */
"use strict";
(function () {
  var LS_ADMIN = "pushhub.admin";

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

  var adminKey = null;
  var channels = [];
  var selectedId = null;
  /** 刚创建频道的接入片段数据（D-39：Send/Channel Key 明文一次性展示，关闭即弃）。 */
  var pendingSnippet = null;

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
   * 密钥行组件（D-29）：[掩码 mono] [眼睛按钮 inline SVG] [复制按钮]，gap 8px。
   * 揭示切换走 textContent（禁 innerHTML 写密钥）；揭示态不跨刷新/跨选择持久
   * （重渲染即回掩码——组件局部状态，随行销毁）。
   */
  function buildKeyRow(key) {
    var row = document.createElement("div");
    row.className = "key-row";
    var value = document.createElement("span");
    value.className = "key-value mono";
    value.textContent = maskKey(key);
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
      value.textContent = revealed ? key : maskKey(key);
      eye.setAttribute("aria-label", revealed ? "隐藏完整密钥" : "显示完整密钥");
    });
    row.appendChild(value);
    row.appendChild(eye);
    row.appendChild(buildCopyButton(key));
    return row;
  }

  // ---- 接入片段卡（D-39：三块各自带独立复制按钮） ----

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
    var curl =
      "curl -X POST " +
      origin +
      "/api/send \\\n" +
      '  -H "Authorization: Bearer ' +
      s.sendKey +
      '" \\\n' +
      '  -H "Content-Type: application/json" \\\n' +
      '  -d \'{"title": "Hello", "text": "来自 PushHub 的第一条消息"}\'';
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

    var ckBlock = document.createElement("section");
    ckBlock.className = "detail-block";
    var ckHead = document.createElement("h2");
    ckHead.textContent = "Channel Key";
    ckBlock.appendChild(ckHead);
    ckBlock.appendChild(buildKeyRow(ch.channelKey));
    channelDetail.appendChild(ckBlock);

    var skBlock = document.createElement("section");
    skBlock.className = "detail-block";
    var skHead = document.createElement("h2");
    skHead.textContent = "Send Key";
    skBlock.appendChild(skHead);
    (ch.sendKeys || []).forEach(function (rec) {
      var row = document.createElement("div");
      row.className = "sendkey-row";
      var label = document.createElement("span");
      label.className = "sendkey-label";
      label.textContent = rec.label ? rec.label : "未命名";
      row.appendChild(label);
      row.appendChild(buildKeyRow(rec.key));
      var date = document.createElement("span");
      date.className = "mono sendkey-date";
      date.textContent = formatDate(rec.createdAt);
      row.appendChild(date);
      skBlock.appendChild(row);
    });
    channelDetail.appendChild(skBlock);
  }

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
    hideErrorBar();
    enterLoginScreen();
  });

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
