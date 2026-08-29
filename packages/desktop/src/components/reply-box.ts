/**
 * 回复区组件（05-06 Task 2，SC3/WIN-03/RPL-05）——绑定当前选中消息：
 * 快捷选项按钮组（消息 options 随帧，上限 4）+ 自定义输入 + invoke reply。
 *
 * 状态纪律：
 *  - 空输入发送禁用（must_haves）；无 options 的消息不渲染快捷按钮；
 *  - answered 后快捷按钮与输入全部冻结禁用（防止重复处置，RPL-05——服务端
 *    already_replied 拒绝之外的第二道客户端防线）；
 *  - 当前无选中消息时回复区收起（hidden）；
 *  - invoke 错误内联提示（错误码三分支静态文案映射——不静默吞掉）；
 *  - by 字段不经前端——Rust reply 命令从配置取全局展示名（D-72）。
 */
import { invoke } from "@tauri-apps/api/core";
import * as state from "../state";

/** 快捷选项渲染上限（随帧 options 超出部分忽略——服务端 OPTIONS_MAX_COUNT 同量级裁剪）。 */
const QUICK_OPTION_LIMIT = 4;

/** 错误码 → 内联提示文案（acceptance：not_connected/invalid_frame/limit_exceeded 三分支映射）。 */
const REPLY_ERROR_TEXT: Record<string, string> = {
  invalid_frame: "回复内容无效——恰填一项且不超长度上限",
  not_connected: "频道未连接——回复未发送，请稍后重试",
  limit_exceeded: "内容超出长度上限——请缩短后重试",
};

export interface ReplyBoxView {
  /** 依据 state（selectedWid + 对应消息 answered 态）整体重渲染。 */
  update(): void;
}

/** onSelectionCleared：取消选中时同步消息列表高亮（main.ts 编排）。 */
export function initReplyBox(onSelectionCleared: () => void): ReplyBoxView {
  const root = document.getElementById("reply-area") as HTMLElement;

  function show(message: state.UiMessage): void {
    const target = message.title ?? message.text.split("\n")[0] ?? message.wid;

    const head = document.createElement("div");
    head.className = "reply-head";
    const targetEl = document.createElement("span");
    targetEl.className = "reply-target";
    targetEl.textContent = `回复：${target.slice(0, 60)}`;
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "reply-close";
    closeBtn.title = "取消选中";
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", () => {
      state.selectMessage(null);
      onSelectionCleared();
      update();
    });
    head.append(targetEl, closeBtn);

    root.replaceChildren(head);

    // answered：快捷按钮与输入全部冻结（RPL-05）。
    if (message.answered) {
      const note = document.createElement("div");
      note.className = "reply-answered-note";
      note.textContent = "该消息已处置——快捷选项与输入已冻结";
      root.append(note);
      root.hidden = false;
      return;
    }

    async function sendReply(payload: { selected_option?: string; text?: string }): Promise<void> {
      const channelId = state.store.current;
      const wid = state.store.selectedWid;
      if (channelId === null || wid === null) return;
      try {
        await invoke("reply", { channelId, wid, payload });
        // 成功——等待 ph://answered 扇出回写（群内实时可见）；无即时 UI 动作。
      } catch (err) {
        const code = (err as { code?: string }).code ?? "unknown";
        const line = document.createElement("div");
        line.className = "reply-error";
        line.textContent = `${REPLY_ERROR_TEXT[code] ?? "回复失败——请稍后重试"}（${code}）`;
        root.append(line);
      }
    }

    // 快捷选项按钮组（无 options 不渲染——空态纪律）。
    const options = (message.options ?? []).filter((o) => o !== "").slice(0, QUICK_OPTION_LIMIT);
    if (options.length > 0) {
      const group = document.createElement("div");
      group.className = "quick-options";
      for (const option of options) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "quick-option";
        btn.textContent = option;
        btn.addEventListener("click", () => void sendReply({ selected_option: option }));
        group.append(btn);
      }
      root.append(group);
    }

    const row = document.createElement("div");
    row.className = "reply-input-row";
    const input = document.createElement("textarea");
    input.className = "reply-input";
    input.placeholder = "自定义回复（Markdown）…";
    const sendBtn = document.createElement("button");
    sendBtn.type = "button";
    sendBtn.className = "reply-send";
    sendBtn.textContent = "发送";
    sendBtn.disabled = true; // 空输入禁用（must_haves）
    input.addEventListener("input", () => {
      sendBtn.disabled = input.value.trim() === "";
    });
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey) && !sendBtn.disabled) {
        void sendReply({ text: input.value });
      }
    });
    sendBtn.addEventListener("click", () => void sendReply({ text: input.value }));
    row.append(input, sendBtn);
    root.append(row);
    root.hidden = false;
  }

  function update(): void {
    const wid = state.store.selectedWid;
    const ch = state.currentChannel();
    const message = wid !== null && ch !== null ? state.messageByWid(ch.id, wid) : null;
    if (message === null) {
      root.hidden = true; // 无选中消息——收起
      root.replaceChildren();
      return;
    }
    show(message);
  }

  return { update };
}
