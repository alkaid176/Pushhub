/**
 * 消息列表组件（05-06 Task 1，D-60/D-76/WIN-03）。
 *
 * 渲染纪律（T-05-06-01 + prohibitions）：innerHTML 只接收 renderMarkdown
 * 输出——`@pushhub/web-sdk/render` 的 renderMarkdown 是消息渲染唯一入口
 * （D-20 跨包复用首次兑现：marked + DOMPurify 双 FORBID + target=_blank/
 * rel=noopener noreferrer hook 全部继承）；title / text / answered_content
 * 三处富文本全部经管道，其余消息字段（answered_by、时间）一律 textContent。
 * 任何消息文本不经管道不得进 DOM。
 *
 * 视图命令式方法由 main.ts 桥接层在数据更新后调用（append-only 快路径 +
 * 全量重建慢路径，对齐 D-60「窗口打开快照全量重建、运行中只追加事件」）：
 *  - append：尾部插入（实时帧快路径——锚定滚动位置）；
 *  - rebuild：全量重建（频道切换/快照合并/乱序插入）；
 *  - updateAnswered：answered 徽标原位更新（不新增条目，D-17）；
 *  - locate：滚动到 data-wid 元素并高亮渐隐（D-67 三级定位的第三级）。
 */
import { renderMarkdown } from "@pushhub/web-sdk/render";
import type { UiMessage } from "../state";

export interface MessageListView {
  rebuild(messages: UiMessage[]): void;
  append(msg: UiMessage): void;
  updateAnswered(msg: UiMessage): void;
  setSelected(wid: string | null): void;
  /** 滚动至 wid 元素并高亮渐隐（元素可能在频道切换 snapshot 重建在途——轮询等待）。 */
  locate(wid: string): Promise<boolean>;
}

export function initMessageList(onClickMessage: (wid: string) => void): MessageListView {
  const scrollEl = document.getElementById("message-scroll") as HTMLElement;
  const listEl = document.getElementById("messages") as HTMLElement;

  function rowOf(wid: string): HTMLElement | null {
    return listEl.querySelector<HTMLElement>(`.msg[data-wid="${CSS.escape(wid)}"]`);
  }

  function nearBottom(): boolean {
    return scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < 60;
  }

  function scrollToBottom(): void {
    scrollEl.scrollTop = scrollEl.scrollHeight;
  }

  function formatTime(ts: number): string {
    const d = new Date(ts);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `${hh}:${mm}`;
  }

  /** 空态占位（must_haves：空消息列表渲染空态文案）。 */
  function showEmpty(): void {
    listEl.replaceChildren();
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.id = "empty";
    empty.textContent = "暂无消息——等待 Webhook 推送";
    listEl.append(empty);
  }

  /** 消息条目 DOM（data-wid/data-seq 定位锚点；innerHTML 仅管道输出）。 */
  function buildRow(msg: UiMessage): HTMLElement {
    const row = document.createElement("div");
    row.className = "msg" + (msg.answered ? " answered" : "");
    row.dataset.wid = msg.wid;
    row.dataset.seq = String(msg.seq);

    const head = document.createElement("div");
    head.className = "msg-head";
    if (msg.title !== undefined && msg.title !== null && msg.title !== "") {
      const title = document.createElement("span");
      title.className = "msg-title";
      title.innerHTML = renderMarkdown(msg.title);
      head.append(title);
    }
    const time = document.createElement("span");
    time.className = "msg-time";
    time.textContent = formatTime(msg.created_at);
    head.append(time);

    const body = document.createElement("div");
    body.className = "msg-body";
    // 唯一渲染入口：text 经共享消毒管道（T-05-06-01）。
    body.innerHTML = renderMarkdown(msg.text);

    const answered = document.createElement("div");
    answered.className = "answered-line";
    answered.hidden = true;
    const prefix = document.createElement("span");
    prefix.className = "answered-prefix";
    const content = document.createElement("span");
    content.className = "answered-content";
    answered.append(prefix, content);

    row.append(head, body, answered);
    if (msg.answered) applyAnsweredTo(row, msg);
    return row;
  }

  /** answered 徽标原位更新（已由 X 回复：内容——内容同为外部输入，经管道）。 */
  function applyAnsweredTo(row: HTMLElement, msg: UiMessage): void {
    row.classList.add("answered");
    const line = row.querySelector<HTMLElement>(".answered-line");
    if (line === null) return;
    const prefix = line.querySelector<HTMLElement>(".answered-prefix");
    const content = line.querySelector<HTMLElement>(".answered-content");
    if (prefix !== null) {
      prefix.textContent =
        msg.answered_by !== null && msg.answered_by !== undefined && msg.answered_by !== ""
          ? `已由 ${msg.answered_by} 回复：`
          : "已回复：";
    }
    if (content !== null) {
      content.innerHTML = renderMarkdown(msg.answered_content ?? "");
    }
    line.hidden = false;
  }

  // 点击选中（回复区绑定）——事件委托。
  listEl.addEventListener("click", (ev) => {
    const row = (ev.target as HTMLElement).closest<HTMLElement>(".msg");
    if (row?.dataset.wid !== undefined) onClickMessage(row.dataset.wid);
  });

  return {
    rebuild(messages) {
      if (messages.length === 0) {
        showEmpty();
        return;
      }
      const frag = document.createDocumentFragment();
      for (const m of messages) frag.append(buildRow(m));
      listEl.replaceChildren(frag);
      scrollToBottom();
    },

    append(msg) {
      listEl.querySelector(".empty-state")?.remove();
      const stick = nearBottom();
      listEl.append(buildRow(msg));
      if (stick) scrollToBottom();
    },

    updateAnswered(msg) {
      const row = rowOf(msg.wid);
      if (row !== null) applyAnsweredTo(row, msg);
    },

    setSelected(wid) {
      listEl.querySelectorAll(".msg.selected").forEach((el) => el.classList.remove("selected"));
      if (wid !== null) rowOf(wid)?.classList.add("selected");
    },

    async locate(wid) {
      // 频道切换的 snapshot 重建在途时元素尚未渲染——短轮询等待（3s 上限）。
      const deadline = Date.now() + 3_000;
      for (;;) {
        const row = rowOf(wid);
        if (row !== null) {
          row.scrollIntoView({ block: "center" });
          row.classList.remove("locate-flash");
          // 强制 reflow 以重启动画（同元素连续两次定位）。
          void row.offsetWidth;
          row.classList.add("locate-flash");
          return true;
        }
        if (Date.now() >= deadline) return false;
        await new Promise((r) => setTimeout(r, 100));
      }
    },
  };
}
