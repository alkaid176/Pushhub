/**
 * 频道侧栏组件（05-06 Task 1，D-64/D-65）——频道列表（名称/四色连接状态点/
 * 未读角标/静音图标）+ 底部「添加频道」「设置」入口。
 *
 * 纯展示：数据读自 state（main.ts 桥接层在状态变化后调用 render）；
 * 频道切换/添加/设置的编排（snapshot 重建、set_current_channel、向导/
 * 设置面板挂载）经回调上抛 main.ts。
 */
import { store, type UiChannel } from "../state";

export interface SidebarCallbacks {
  onSelect(id: string): void;
  onAddChannel(): void;
  onOpenSettings(): void;
}

export interface SidebarView {
  render(): void;
}

/** 状态点四色（must_haves：连接状态点四色）。 */
function dotClass(status: UiChannel["status"]): string {
  return `dot dot-${status}`;
}

export function initSidebar(cb: SidebarCallbacks): SidebarView {
  const listEl = document.getElementById("channel-list") as HTMLElement;
  const addBtn = document.getElementById("btn-add-channel") as HTMLButtonElement;
  const settingsBtn = document.getElementById("btn-settings") as HTMLButtonElement;

  addBtn.addEventListener("click", () => cb.onAddChannel());
  settingsBtn.addEventListener("click", () => cb.onOpenSettings());

  function buildItem(ch: UiChannel): HTMLElement {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "channel-item" + (store.current === ch.id ? " active" : "");
    item.dataset.id = ch.id;

    const dot = document.createElement("span");
    dot.className = dotClass(ch.status);
    dot.title = ch.status;

    const name = document.createElement("span");
    name.className = "channel-name";
    name.textContent = ch.name;

    item.append(dot, name);

    if (ch.muted) {
      const mute = document.createElement("span");
      mute.className = "mute-mark";
      mute.textContent = "静";
      mute.title = "已静音（不出通知）";
      item.append(mute);
    }
    if (ch.unread > 0) {
      const badge = document.createElement("span");
      badge.className = "unread-badge";
      badge.textContent = ch.unread > 99 ? "99+" : String(ch.unread);
      item.append(badge);
    }

    item.addEventListener("click", () => cb.onSelect(ch.id));
    return item;
  }

  return {
    render() {
      const frag = document.createDocumentFragment();
      for (const ch of store.channels.values()) frag.append(buildItem(ch));
      listEl.replaceChildren(frag);
    },
  };
}
