/**
 * PushHub demo 查看器逻辑（02-03 Task 1，D-22/D-23/D-24）。
 *
 * 本文件是 pushhub.js 的第一个真实宿主：
 *  - D-23：查看器自身即 SC1 证明——接入只用
 *    <script src="/pushhub.js"> + new PushHub(serverUrl, channelKey) 两行；
 *  - D-22：只收消息不构造消息不回复（发消息用 curl/smoke.mjs，回复属 Phase 4）；
 *  - D-24：接入配置存 localStorage（下次免填，取舍在页面注明）；
 *    URL 参数 ?server=...&key=... 预填并可自动连接（E2E 注入路径，研究 A5）。
 *
 * 安全锚点：
 *  - 消息 text 进 DOM 的唯一入口是 PushHub.renderMarkdown 返回值（与 SDK 同一
 *    消毒管道，无双路径漂移——prohibition）；
 *  - click_url 是消息内不可信跳转指令：跳转前 scheme 白名单（仅 http/https），
 *    其余丢弃并 console 提示；window.open 带 noopener（D-21 "click_url 跳转同理"）；
 *  - title 是纯文本，经 textContent 写入（不进 Markdown 管道也不进 innerHTML）。
 *
 * 调试句柄：window.__pushhub = 当前 PushHub 实例（排障定位与 E2E 断连兜底）；
 * window.__pushhubViewer.feedHistory(frame) 以真实代码路径驱动 history 处理逻辑
 * （分隔线等 D-10 语义的单测式驱动入口——生产不影响，仅调试/测试用）。
 */
"use strict";
(function () {
  var LS_SERVER = "pushhub.server";
  var LS_KEY = "pushhub.key";

  var form = document.getElementById("connect-form");
  var serverInput = document.getElementById("server-url");
  var keyInput = document.getElementById("channel-key");
  var statusDot = document.getElementById("status-dot");
  var statusText = document.getElementById("status-text");
  var errorBar = document.getElementById("error-bar");
  var messagesEl = document.getElementById("messages");
  var attackButtons = document.getElementById("attack-buttons");
  var attackOut = document.getElementById("attack-out");

  var hub = null;
  /** 当前已见最早 seq（oldest_kept_seq 分隔线判定依据，D-10/D-24）。 */
  var earliestSeq = null;
  /** 分隔线只渲染一次。 */
  var separatorShown = false;

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

  function showError(err) {
    var label = err && err.fatal ? "致命错误" : "错误";
    var code = err && err.code ? "（" + err.code + "）" : "";
    var message = err && err.message ? err.message : String(err);
    errorBar.hidden = false;
    errorBar.textContent = label + code + "：" + message;
  }

  /**
   * click_url 跳转（D-21）：消息内 click_url 不可信——先做 scheme 白名单
   * （仅 http 与 https 放行），其余 scheme 丢弃并 console 提示；再以
   * noopener 新窗口打开（防反向 tabnabbing）。
   */
  function safeOpenClickUrl(url) {
    var parsed;
    try {
      parsed = new URL(url, window.location.origin);
    } catch (e) {
      console.warn("[viewer] click_url 无法解析，已丢弃：", url);
      return;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      console.warn(
        "[viewer] click_url scheme 不在白名单（仅 http/https），已丢弃：",
        parsed.protocol,
      );
      return;
    }
    window.open(parsed.href, "_blank", "noopener,noreferrer");
  }

  /**
   * 消息渲染唯一管道（on("message") 与 on("history").messages 统一入口）：
   * 时间戳 + title 加粗（纯文本 textContent）+ text 经 PushHub.renderMarkdown
   * 写入 innerHTML（消毒管道唯一入口，prohibition）。
   */
  function appendMessage(m) {
    var li = document.createElement("li");
    li.className = "msg";

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
    li.appendChild(head);

    var body = document.createElement("div");
    body.className = "msg-body";
    body.innerHTML = window.PushHub.renderMarkdown(m.text);
    li.appendChild(body);

    if (m.click_url) {
      li.classList.add("clickable");
      li.addEventListener("click", function () {
        safeOpenClickUrl(m.click_url);
      });
    }

    if (typeof m.seq === "number" && (earliestSeq === null || m.seq < earliestSeq)) {
      earliestSeq = m.seq;
    }
    messagesEl.appendChild(li);
  }

  /**
   * "更早的消息已被清理"分隔线（D-10 诚实缺口语义可视化，只渲染一次）。
   *
   * 服务端 oldest_kept_seq = 频道现存最老 seq（MIN(seq)，空频道为 0）；频道
   * seq 从 1 起，故 MIN(seq)=1 等价于"从未清理"。判定：oldest_kept_seq > 1
   * （确实清理过更早消息）且 oldest_kept_seq >= earliestSeq（宿主已翻页见到
   * 保留窗口最底部——翻页途中 earliestSeq 还很新时不预告）。计划原文下界为
   * "> 0"，那会让每个全新频道（MIN=1、一条没清过）都误报"已清理"——按
   * D-10 "诚实缺口：不虚构不存在的缺口"落为 > 1（SUMMARY 记偏差）。
   */
  function maybeSeparator(oldestKeptSeq) {
    if (separatorShown) return;
    if (typeof oldestKeptSeq !== "number" || oldestKeptSeq <= 1) return;
    if (earliestSeq === null || oldestKeptSeq <= earliestSeq - 1) return;
    var li = document.createElement("li");
    li.className = "separator";
    li.textContent = "—— 更早的消息已被清理 ——";
    messagesEl.insertBefore(li, messagesEl.firstChild);
    separatorShown = true;
  }

  /**
   * history 帧处理（on("history") 的真实处理器；也经
   * window.__pushhubViewer.feedHistory 暴露给测试/排障驱动）。
   * messages 已被 SDK 按去重窗口过滤（D-16×D-17 交集语义——永远只含宿主
   * 未见消息）；oldest_kept_seq 与 has_more 原样透传（本查看器不翻页，
   * SDK 的 sync 翻页已覆盖）。
   */
  function handleHistoryFrame(frame) {
    for (var i = 0; i < frame.messages.length; i++) {
      appendMessage(frame.messages[i]);
    }
    maybeSeparator(frame.oldest_kept_seq);
  }

  /** 建立连接（D-23 两行接入；连接前 destroy 旧实例防重复连接）。 */
  function connect(serverUrl, channelKey) {
    if (hub !== null) {
      hub.destroy();
      hub = null;
    }
    earliestSeq = null;
    separatorShown = false;
    messagesEl.textContent = "";
    errorBar.hidden = true;
    try {
      window.localStorage.setItem(LS_SERVER, serverUrl);
      window.localStorage.setItem(LS_KEY, channelKey);
    } catch (e) {
      // localStorage 不可用（隐私模式等）——免填功能降级，连接不受影响。
    }
    setStatus("connecting");
    hub = new window.PushHub(serverUrl, channelKey);
    window.__pushhub = hub; // 调试句柄：排障定位 + E2E 断连兜底（D-24）
    hub.on("status", setStatus);
    hub.on("error", showError);
    hub.on("message", appendMessage);
    hub.on("history", handleHistoryFrame);
  }

  form.addEventListener("submit", function (ev) {
    ev.preventDefault();
    var serverUrl = serverInput.value.trim();
    var channelKey = keyInput.value.trim();
    if (!serverUrl || !channelKey) return;
    connect(serverUrl, channelKey);
  });

  // URL 参数预填（E2E 注入路径，研究 A5）：?server=...&key=...；
  // 两者齐备时自动连接，否则等表单提交。localStorage 作缺省回填（D-24 下次免填）。
  var params = new URLSearchParams(window.location.search);
  var urlServer = params.get("server");
  var urlKey = params.get("key");
  try {
    serverInput.value = urlServer || window.localStorage.getItem(LS_SERVER) || window.location.origin;
    keyInput.value = urlKey || window.localStorage.getItem(LS_KEY) || "";
  } catch (e) {
    // localStorage 不可用（隐私模式等）——免填功能降级：server 回退页面 origin、key 留空。
    serverInput.value = urlServer || window.location.origin;
    keyInput.value = urlKey || "";
  }
  if (urlServer && urlKey) {
    connect(urlServer, urlKey);
  }

  // ---- 攻击样本区（D-22：本地经 renderMarkdown 渲染展示，不从服务端发送；验证的就是消毒本身）----
  var ATTACK_SAMPLES = [
    {
      label: "script 注入",
      text: '<script>alert("xss")</script>后置文本',
    },
    {
      label: "img onerror",
      text: '<img src=x onerror=alert(1)>',
    },
    {
      label: "javascript: 链接",
      text: "[不可点的链接](javascript:alert(1))",
    },
  ];
  ATTACK_SAMPLES.forEach(function (sample) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = sample.label;
    btn.addEventListener("click", function () {
      var div = document.createElement("div");
      div.className = "attack-sample";
      div.innerHTML = window.PushHub.renderMarkdown(sample.text);
      attackOut.appendChild(div);
    });
    attackButtons.appendChild(btn);
  });

  // 调试/测试驱动入口（feedHistory 走真实处理代码路径）。
  window.__pushhubViewer = { feedHistory: handleHistoryFrame };
})();
