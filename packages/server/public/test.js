/**
 * PushHub 测试页逻辑（04-04 Task 1，D-55/D-56/D-58——ADM-04 五区块）。
 *
 * 本文件是三端联调与协议排障工具：
 *  - ① 连接配置：server + Channel Key 经 pushhub.js 收流；Send Key 仅会话
 *    内存（输入框本体），绝不写入 localStorage（Pitfall 7——权限高于
 *    Channel Key，页面明示取舍）；展示名随 reply 帧 by 字段自报（D-51/D-53）；
 *  - ② 构造消息：POST /api/send（同源相对路径，Bearer Send Key），
 *    title/text/priority/options ≤4/callback_url 逐字段输入；
 *  - ③ 实时消息流：wid→DOM 节点 Map；快捷选项按钮与自定义输入框调
 *    hub.reply()（04-03 API）；answered 帧回写——冻结按钮 + 追加回复行；
 *    already_replied 错误帧提示"已被他人回复"（D-44 败者 UI）；
 *  - ④ 验签器（D-56）：三步分步显示——时间窗 / HMAC 重算 / XOR 常时比较；
 *  - ⑤ 失败记录查询（D-58）：Bearer Channel Key 调 GET /api/callback-failures。
 *
 * 安全锚点（prohibition 双保险）：
 *  - 消息 text 与 answered_content 进 DOM 的唯一入口是
 *    PushHub.renderMarkdown 返回值（与 SDK 同一消毒管道，全文件恰两处
 *    调用点——测试页不得内嵌第二套 Markdown 渲染管道）；
 *  - title / wid / answered_by 一律 textContent（展示名是任意外部输入，
 *    名字藏 XSS 防线——D-53）；失败记录表格单元格同理全 textContent；
 *  - 验签器常时比较用手写 XOR 累加（crypto.subtle.timingSafeEqual 是
 *    Workers 专有非标准扩展，浏览器抛 TypeError——Pitfall 3）。
 *
 * 调试句柄：window.__pushhub = 当前 PushHub 实例（排障定位）。
 */
"use strict";
(function () {
  var LS_SERVER = "pushhub.server";
  var LS_KEY = "pushhub.key";
  var LS_NAME = "pushhub.name";
  // 注：Send Key 无对应存储键——仅存于输入框会话内存（Pitfall 7）。

  /** 验签时间窗（毫秒，与 04-02 SIGNATURE_TOLERANCE_MS 同口径——KEY-06）。 */
  var SIGNATURE_TOLERANCE_MS = 300000;

  var connectForm = document.getElementById("connect-form");
  var serverInput = document.getElementById("server-url");
  var keyInput = document.getElementById("channel-key");
  var sendKeyInput = document.getElementById("send-key");
  var nameInput = document.getElementById("display-name");
  var statusDot = document.getElementById("status-dot");
  var statusText = document.getElementById("status-text");
  var errorBar = document.getElementById("error-bar");
  var composeForm = document.getElementById("compose-form");
  var titleInput = document.getElementById("msg-title");
  var textInput = document.getElementById("msg-text");
  var priorityInput = document.getElementById("msg-priority");
  var optionInputs = [
    document.getElementById("msg-option-1"),
    document.getElementById("msg-option-2"),
    document.getElementById("msg-option-3"),
    document.getElementById("msg-option-4"),
  ];
  var callbackUrlInput = document.getElementById("msg-callback-url");
  var sendResult = document.getElementById("send-result");
  var messagesEl = document.getElementById("messages");
  var verifyForm = document.getElementById("verify-form");
  var verifySecretInput = document.getElementById("verify-secret");
  var verifyMessageIdInput = document.getElementById("verify-message-id");
  var verifyTimestampInput = document.getElementById("verify-timestamp");
  var verifySignatureInput = document.getElementById("verify-signature");
  var verifyRawBodyInput = document.getElementById("verify-rawbody");
  var verifyStep1 = document.getElementById("verify-step-1");
  var verifyStep2 = document.getElementById("verify-step-2");
  var verifyStep3 = document.getElementById("verify-step-3");
  var btnFailures = document.getElementById("btn-failures");
  var failuresResult = document.getElementById("failures-result");

  var hub = null;
  /** wid → 消息 DOM 节点索引（answered 帧按 wid 回写定位，D-55）。 */
  var nodesByWid = new Map();

  var STATUS_LABEL = {
    connecting: "连接中",
    online: "已连接",
    reconnecting: "重连中",
    offline: "已断开",
  };

  function setStatus(status) {
    statusDot.className = "dot dot-" + status;
    statusText.textContent = STATUS_LABEL[status] || status;
  }

  /**
   * 错误显示（error 事件统一入口）。already_replied（D-44 败者 UI）换用
   * 业务文案"已被他人回复"，其余照 viewer 模式显示 label+code+message。
   */
  function showError(err) {
    if (err && err.code === "already_replied") {
      errorBar.hidden = false;
      errorBar.textContent = "已被他人回复：这条消息已被群内其他人先行处置（先到先得，连接保持）。";
      return;
    }
    var label = err && err.fatal ? "致命错误" : "错误";
    var code = err && err.code ? "（" + err.code + "）" : "";
    var message = err && err.message ? err.message : String(err);
    errorBar.hidden = false;
    errorBar.textContent = label + code + "：" + message;
  }

  /** 发送区块结果行（纯 textContent——响应内容不经任何 HTML 管道）。 */
  function showSendResult(text) {
    sendResult.hidden = false;
    sendResult.textContent = text;
  }

  /** 回复署名：展示名输入框当前值；空串 = 匿名（by 不传，answered_by 存 null）。 */
  function replyBy() {
    var by = nameInput.value.trim();
    return by === "" ? undefined : by;
  }

  /**
   * 回复动作（04-03 hub.reply——fail-fast：not_connected / invalid_frame
   * 本地拒绝经 error 事件返回；already_replied 等域级拒绝同路透传）。
   */
  function doReply(wid, payload) {
    if (hub === null) {
      showError({ message: "尚未连接（先在①区建立 Channel Key 连接）" });
      return;
    }
    hub.reply(wid, payload, replyBy());
  }

  /**
   * answered 状态回写（on("answered") 与 history 已回复消息共用）：
   * 冻结该消息全部快捷按钮与自定义输入，追加回复行。
   * 回复行前缀经 textContent（answered_by 是任意外部输入，D-53）；
   * answered_content 经 renderMarkdown（唯一消毒管道的第二调用点）。
   * 幂等：已有回复行则不再追加（answered 事件含本人回声，可能重复到达）。
   */
  function applyAnsweredState(li, answeredBy, answeredContent) {
    var buttons = li.querySelectorAll("button.msg-option-btn, button.msg-reply-btn");
    for (var i = 0; i < buttons.length; i++) buttons[i].disabled = true;
    var replyInput = li.querySelector("input.msg-reply-input");
    if (replyInput !== null) replyInput.disabled = true;
    if (li.querySelector(".answered-line") !== null) return;

    var line = document.createElement("div");
    line.className = "answered-line";
    var prefix = document.createElement("span");
    prefix.className = "answered-prefix";
    prefix.textContent = answeredBy ? "已由" + answeredBy + "回复：" : "已回复：";
    line.appendChild(prefix);
    var content = document.createElement("span");
    content.className = "answered-content";
    if (typeof answeredContent === "string" && answeredContent !== "") {
      content.innerHTML = window.PushHub.renderMarkdown(answeredContent);
    } else {
      content.textContent = "（无内容）";
    }
    line.appendChild(content);
    li.appendChild(line);
  }

  /**
   * 消息渲染（on("message") 与 on("history").messages 统一入口）：
   * 时间/标题/wid 纯文本 textContent；text 经 PushHub.renderMarkdown 写入
   * innerHTML（消毒管道唯一入口的第一调用点，prohibition）；options 渲染为
   * 快捷回复按钮 + 自定义回复输入行。
   */
  function appendMessage(m) {
    var li = document.createElement("li");
    li.className = "msg";
    li.setAttribute("data-wid", typeof m.wid === "string" ? m.wid : "");

    var head = document.createElement("div");
    head.className = "msg-head";
    var time = document.createElement("time");
    time.textContent = new Date(m.created_at).toLocaleTimeString();
    head.appendChild(time);
    if (m.title) {
      var title = document.createElement("strong");
      title.textContent = m.title;
      head.appendChild(title);
    }
    var widEl = document.createElement("span");
    widEl.className = "msg-wid";
    widEl.textContent = typeof m.wid === "string" ? m.wid : "";
    head.appendChild(widEl);
    li.appendChild(head);

    var body = document.createElement("div");
    body.className = "msg-body";
    body.innerHTML = window.PushHub.renderMarkdown(m.text);
    li.appendChild(body);

    // 回复交互行：快捷选项按钮（options 存在时）+ 自定义输入。
    var actions = document.createElement("div");
    actions.className = "msg-actions";
    if (Array.isArray(m.options)) {
      m.options.forEach(function (opt) {
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = "msg-option-btn";
        btn.textContent = opt;
        btn.addEventListener("click", function () {
          doReply(m.wid, { selected_option: opt });
        });
        actions.appendChild(btn);
      });
    }
    var replyInput = document.createElement("input");
    replyInput.type = "text";
    replyInput.className = "msg-reply-input";
    replyInput.placeholder = "自定义回复（Markdown）…";
    replyInput.setAttribute("aria-label", "自定义回复 " + (typeof m.wid === "string" ? m.wid : ""));
    var replyBtn = document.createElement("button");
    replyBtn.type = "button";
    replyBtn.className = "msg-reply-btn";
    replyBtn.textContent = "回复";
    function submitCustomReply() {
      var text = replyInput.value;
      if (text === "") return;
      doReply(m.wid, { text: text });
    }
    replyBtn.addEventListener("click", submitCustomReply);
    replyInput.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter") {
        ev.preventDefault();
        submitCustomReply();
      }
    });
    actions.appendChild(replyInput);
    actions.appendChild(replyBtn);
    li.appendChild(actions);

    if (typeof m.wid === "string" && m.wid !== "") nodesByWid.set(m.wid, li);
    messagesEl.appendChild(li);

    // history 中的已回复消息直接呈现冻结态 + 回复行（重连后状态可见）。
    if (m.answered === true) {
      applyAnsweredState(li, m.answered_by, m.answered_content);
    }
  }

  /** answered 帧处理：按 wid 定位节点回写（节点不在 DOM 则忽略）。 */
  function handleAnsweredFrame(frame) {
    var li = nodesByWid.get(frame.wid);
    if (li === undefined) return;
    applyAnsweredState(li, frame.answered_by, frame.answered_content);
  }

  /** history 帧处理（messages 已被 SDK 按去重窗口过滤）。 */
  function handleHistoryFrame(frame) {
    for (var i = 0; i < frame.messages.length; i++) {
      appendMessage(frame.messages[i]);
    }
  }

  /** 建立连接（连接前 destroy 旧实例 + 清空流与 wid 索引）。 */
  function connect(serverUrl, channelKey) {
    if (hub !== null) {
      hub.destroy();
      hub = null;
    }
    nodesByWid.clear();
    messagesEl.textContent = "";
    errorBar.hidden = true;
    try {
      window.localStorage.setItem(LS_SERVER, serverUrl);
      window.localStorage.setItem(LS_KEY, channelKey);
      window.localStorage.setItem(LS_NAME, nameInput.value.trim());
    } catch (e) {
      // localStorage 不可用（隐私模式等）——免填功能降级，连接不受影响。
    }
    setStatus("connecting");
    hub = new window.PushHub(serverUrl, channelKey);
    window.__pushhub = hub; // 调试句柄：排障定位（D-24 模式）
    hub.on("status", setStatus);
    hub.on("error", showError);
    hub.on("message", appendMessage);
    hub.on("history", handleHistoryFrame);
    hub.on("answered", handleAnsweredFrame);
  }

  connectForm.addEventListener("submit", function (ev) {
    ev.preventDefault();
    var serverUrl = serverInput.value.trim();
    var channelKey = keyInput.value.trim();
    if (!serverUrl || !channelKey) return;
    connect(serverUrl, channelKey);
  });

  // ---- ② 构造消息发送（POST /api/send，同源相对路径 + Bearer Send Key）----
  composeForm.addEventListener("submit", function (ev) {
    ev.preventDefault();
    var sendKey = sendKeyInput.value.trim();
    if (sendKey === "") {
      showSendResult("FAIL：缺少 Send Key（①区第三行，仅会话内存不落盘）");
      return;
    }
    var body = { text: textInput.value, priority: priorityInput.value };
    var title = titleInput.value.trim();
    if (title !== "") body.title = title;
    var options = [];
    for (var i = 0; i < optionInputs.length; i++) {
      var opt = optionInputs[i].value.trim();
      if (opt !== "") options.push(opt);
    }
    if (options.length > 0) body.options = options;
    var callbackUrl = callbackUrlInput.value.trim();
    if (callbackUrl !== "") body.callback_url = callbackUrl;

    fetch("/api/send", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + sendKey,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    })
      .then(function (resp) {
        return resp.json().then(function (data) {
          return { status: resp.status, data: data };
        });
      })
      .then(function (r) {
        if (r.status === 200 && r.data && typeof r.data.id === "string") {
          showSendResult("已发送 id=" + r.data.id + " seq=" + r.data.seq + "（消息应即时出现在③区）");
        } else {
          var code = r.data && r.data.error && r.data.error.code ? r.data.error.code : "?";
          var message = r.data && r.data.error && r.data.error.message ? r.data.error.message : JSON.stringify(r.data);
          showSendResult("FAIL HTTP " + r.status + " " + code + "：" + message);
        }
      })
      .catch(function (err) {
        showSendResult("FAIL：" + String(err));
      });
  });

  // ---- ④ 验签器（D-56 三步：时间窗 → HMAC 重算 → XOR 常时比较）----

  /**
   * 浏览器常时比较（Pitfall 3：无内置 timingSafeEqual——手写 XOR 累加）：
   * 对两 hex 字符串的 Uint8Array，diff 自 a.length ^ b.length 起，逐字节 OR；
   * 长度不等直接不等（两段式，与服务端 D-13 同构）。
   */
  function timingSafeEqualHex(aHex, bHex) {
    var a = new TextEncoder().encode(aHex);
    var b = new TextEncoder().encode(bHex);
    var diff = a.length ^ b.length;
    var n = Math.min(a.length, b.length);
    for (var i = 0; i < n; i++) diff |= a[i] ^ b[i];
    return diff === 0;
  }

  /** HMAC-SHA256(secret, payload) → hex（Web Crypto，与 04-02 signCallback 同口径）。 */
  async function hmacHex(secret, payload) {
    var enc = new TextEncoder();
    var key = await crypto.subtle.importKey(
      "raw",
      enc.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    var mac = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
    var bytes = new Uint8Array(mac);
    var out = "";
    for (var i = 0; i < bytes.length; i++) {
      out += bytes[i].toString(16).padStart(2, "0");
    }
    return out;
  }

  /** 单步结果显示（pass/fail 着色 + 原因；纯 textContent）。 */
  function showStep(el, ok, text) {
    el.hidden = false;
    el.className = "verify-step " + (ok ? "pass" : "fail");
    el.textContent = (ok ? "PASS " : "FAIL ") + text;
  }

  verifyForm.addEventListener("submit", function (ev) {
    ev.preventDefault();
    var secret = verifySecretInput.value;
    var messageId = verifyMessageIdInput.value.trim();
    var ts = verifyTimestampInput.value.trim();
    var signature = verifySignatureInput.value.trim();
    var rawBody = verifyRawBodyInput.value;

    // 第 1 步：时间窗（|now - ts| ≤ 300000ms；ts 非数字即 FAIL）。
    var tsNum = Number(ts);
    var step1Ok = ts !== "" && Number.isFinite(tsNum) && Math.abs(Date.now() - tsNum) <= SIGNATURE_TOLERANCE_MS;
    var step1Text =
      "第 1 步 时间窗：message_id=" + (messageId === "" ? "（空）" : messageId) +
      "，timestamp=" + (ts === "" ? "（空）" : ts) +
      (ts !== "" && Number.isFinite(tsNum)
        ? "，偏移 " + Math.abs(Date.now() - tsNum) + "ms（容忍窗 " + SIGNATURE_TOLERANCE_MS + "ms）"
        : "，timestamp 不是有限数字");
    showStep(verifyStep1, step1Ok, step1Text);

    // 第 2 步：HMAC 重算一致（signed payload = ts + "." + rawBody，毫秒口径
    // 04-02；重算值与签名头普通字符串相等比对——篡改 body 任一字节即此处 FAIL）。
    // secret 缺失即 FAIL（KEY-06 消费侧：无 secret 无从验签）。
    if (secret === "") {
      showStep(verifyStep2, false, "第 2 步 HMAC 重算一致：缺少 signing secret");
      showStep(verifyStep3, false, "第 3 步 常时比较：前置步骤失败（无重算值可比较）");
      return;
    }
    hmacHex(secret, ts + "." + rawBody)
      .then(function (expected) {
        var step2Ok = expected === signature && signature !== "";
        showStep(
          verifyStep2,
          step2Ok,
          "第 2 步 HMAC 重算一致：" + (step2Ok
            ? "sha256(secret, ts + \".\" + rawBody) 与签名头一致（= " + expected + "）"
            : "重算 " + expected + " ≠ 签名头 " + (signature === "" ? "（空）" : signature)),
        );
        // 第 3 步：常时比较（手写 XOR；签名缺失即 FAIL——对应"缺头回调被拒"）。
        if (signature === "") {
          showStep(verifyStep3, false, "第 3 步 常时比较：缺少 PushHub-Signature");
          return;
        }
        var match = timingSafeEqualHex(expected, signature);
        showStep(
          verifyStep3,
          match,
          "第 3 步 常时比较（XOR 累加）：" + (match ? "签名一致" : "签名不一致（body 被篡改 / secret 不对 / 签名伪造）"),
        );
      })
      .catch(function (err) {
        showStep(verifyStep2, false, "第 2 步 HMAC 重算失败：" + String(err));
        showStep(verifyStep3, false, "第 3 步 常时比较：前置步骤失败");
      });
  });

  // ---- ⑤ 失败记录查询（D-58：GET /api/callback-failures，Bearer Channel Key）----
  btnFailures.addEventListener("click", function () {
    var channelKey = keyInput.value.trim();
    if (channelKey === "") {
      failuresResult.textContent = "";
      var hint = document.createElement("p");
      hint.className = "empty-state";
      hint.textContent = "缺少 Channel Key（①区第二行）——查询以 Channel Key 为鉴权域。";
      failuresResult.appendChild(hint);
      return;
    }
    fetch("/api/callback-failures", {
      headers: { Authorization: "Bearer " + channelKey },
    })
      .then(function (resp) {
        return resp.json().then(function (data) {
          return { status: resp.status, data: data };
        });
      })
      .then(function (r) {
        failuresResult.textContent = "";
        if (r.status !== 200) {
          var errP = document.createElement("p");
          errP.className = "empty-state";
          var code = r.data && r.data.error && r.data.error.code ? r.data.error.code : "?";
          errP.textContent = "查询失败 HTTP " + r.status + " " + code;
          failuresResult.appendChild(errP);
          return;
        }
        var failures = r.data && Array.isArray(r.data.failures) ? r.data.failures : [];
        if (failures.length === 0) {
          var empty = document.createElement("p");
          empty.className = "empty-state";
          empty.textContent = "无失败记录（该频道没有最终投递失败的回调）。";
          failuresResult.appendChild(empty);
          return;
        }
        var table = document.createElement("table");
        table.className = "failures";
        var headRow = document.createElement("tr");
        ["wid", "url", "last_error", "attempts", "final_failed_at"].forEach(function (col) {
          var th = document.createElement("th");
          th.textContent = col;
          headRow.appendChild(th);
        });
        table.appendChild(headRow);
        failures.forEach(function (row) {
          var tr = document.createElement("tr");
          [row.wid, row.url, row.last_error, String(row.attempts),
            typeof row.final_failed_at === "number" ? new Date(row.final_failed_at).toISOString() : ""].forEach(function (val) {
            var td = document.createElement("td");
            td.textContent = val === null || val === undefined ? "" : String(val);
            tr.appendChild(td);
          });
          table.appendChild(tr);
        });
        failuresResult.appendChild(table);
      })
      .catch(function (err) {
        failuresResult.textContent = "";
        var p = document.createElement("p");
        p.className = "empty-state";
        p.textContent = "查询失败：" + String(err);
        failuresResult.appendChild(p);
      });
  });

  // ---- URL 参数预填（E2E 注入路径，viewer 同模式）：?server=…&key=…&name=… ----
  // server+key 两者齐备时自动连接；name 仅预填展示名。localStorage 作缺省回填。
  var params = new URLSearchParams(window.location.search);
  var urlServer = params.get("server");
  var urlKey = params.get("key");
  var urlName = params.get("name");
  try {
    serverInput.value = urlServer || window.localStorage.getItem(LS_SERVER) || window.location.origin;
    keyInput.value = urlKey || window.localStorage.getItem(LS_KEY) || "";
    nameInput.value = urlName || window.localStorage.getItem(LS_NAME) || "";
  } catch (e) {
    // localStorage 不可用（隐私模式等）——免填功能降级：server 回退页面 origin。
    serverInput.value = urlServer || window.location.origin;
    keyInput.value = urlKey || "";
    nameInput.value = urlName || "";
  }
  if (urlServer && urlKey) {
    connect(urlServer, urlKey);
  }
})();
