/**
 * 首次关闭一次性提示（05-06 Task 2，D-71）——Rust 在首次关窗拦截时 emit
 * ph://first-close-hint（此后不再发——first_close_hint_shown 落盘）；本模块
 * 渲染模态提示「已最小化到托盘」，确认后 invoke mark_first_close_hint 置位。
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export function initFirstCloseHint(): void {
  void listen("ph://first-close-hint", () => {
    showHint();
  });
}

function showHint(): void {
  const layer = document.getElementById("hint-layer") as HTMLElement;

  const card = document.createElement("div");
  card.className = "panel-card";

  const title = document.createElement("h2");
  title.className = "panel-title";
  title.textContent = "已最小化到托盘";
  const sub = document.createElement("p");
  sub.className = "panel-sub";
  sub.textContent =
    "PushHub 会驻留后台保持连接（关窗 ≠ 退出）。左键托盘图标可重新打开窗口；右键托盘图标选择「退出」才会真正结束进程。";

  const actions = document.createElement("div");
  actions.className = "form-actions";
  const okBtn = document.createElement("button");
  okBtn.type = "button";
  okBtn.className = "btn btn-primary";
  okBtn.textContent = "知道了";
  okBtn.addEventListener("click", () => {
    // 置位持久化（幂等）——此后关窗不再提示。
    void invoke("mark_first_close_hint").finally(() => {
      layer.hidden = true;
      layer.replaceChildren();
    });
  });
  actions.append(okBtn);

  card.append(title, sub, actions);
  layer.replaceChildren(card);
  layer.hidden = false;
  okBtn.focus();
}
