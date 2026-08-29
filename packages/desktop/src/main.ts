/**
 * 前端入口（05-01 Task 3 tracer，D-60 纯展示层）。
 *
 * 职责边界：只监听 Tauri event 渲染——不建立任何浏览器侧套接字连接、不做补拉
 * （连接归 Rust 进程持有；前端源码零 WebSocket 构造是本 plan 的验收项）。
 *
 * 安全（T-05-01-02）：tracer 阶段 title/text 均以 textContent 写入（零 HTML
 * 解析路径——存储型 XSS 无入口）；05-06 切换 @pushhub/web-sdk/render 的
 * renderMarkdown 消毒渲染管道（D-20 跨包复用）。
 *
 * 就绪信号：listeners 挂齐后 emit ph://frontend-ready——Rust 侧 run_channel
 * 等到信号才 Connect（否则 Rust 握手快于页面加载时，首帧 status 事件在
 * listen 注册前发出即丢失，窗口永远停在初始态）。
 */
import { emit, listen } from "@tauri-apps/api/event";

interface StatusPayload {
  channel_id: string;
  status: string;
}

interface MessagePayload {
  channel_id: string;
  wid: string;
  seq: number;
  title?: string;
  text: string;
  created_at: number;
}

interface HistoryPayload {
  channel_id: string;
  messages: MessagePayload[];
  oldest_kept_seq: number;
  has_more: boolean;
}

const statusEl = document.getElementById("status") as HTMLElement;
const messagesEl = document.getElementById("messages") as HTMLElement;
const emptyEl = document.getElementById("empty");

function appendMessage(payload: MessagePayload): void {
  emptyEl?.remove();
  const row = document.createElement("div");
  row.className = "msg";
  row.dataset.seq = String(payload.seq);
  row.dataset.wid = payload.wid;

  const title = document.createElement("div");
  title.className = "msg-title";
  // textContent 安全渲染（tracer 阶段——renderMarkdown 管道在 05-06 接入）
  title.textContent = payload.title ?? payload.text.split("\n")[0] ?? "";

  const text = document.createElement("div");
  text.className = "msg-text";
  text.textContent = payload.text;

  row.append(title, text);
  messagesEl.append(row);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function bind(): void {
  void listen<StatusPayload>("ph://status", (event) => {
    statusEl.textContent = event.payload.status;
  });
  void listen<MessagePayload>("ph://message", (event) => {
    appendMessage(event.payload);
  });
  void listen<HistoryPayload>("ph://history", (event) => {
    for (const message of event.payload.messages) {
      appendMessage(message);
    }
  });
}

bind();
void emit("ph://frontend-ready");
