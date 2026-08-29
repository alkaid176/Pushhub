/**
 * 设置面板（05-06 Task 2，D-72/D-70/D-74）——主窗口内模态（不进托盘菜单）：
 *  - 展示名输入（invoke set_display_name，空即清除为 None → 匿名回复）；
 *  - 全局勿扰开关（invoke toggle_dnd——与托盘 CheckItem 双入口同一数据源）；
 *  - 每频道静音开关（invoke set_channel_muted——只影响通知不影响连接）。
 */
import { invoke } from "@tauri-apps/api/core";
import * as state from "../state";

export function mountSettings(): void {
  const overlay = document.getElementById("overlay") as HTMLElement;

  const card = document.createElement("div");
  card.className = "panel-card";

  const title = document.createElement("h2");
  title.className = "panel-title";
  title.textContent = "设置";
  const sub = document.createElement("p");
  sub.className = "panel-sub";
  sub.textContent = "展示名随每次回复携带（D-72）；勿扰与静音只影响通知，不影响连接。";

  // ---- 展示名（D-72）----
  const nameField = document.createElement("div");
  nameField.className = "form-field";
  const nameLabel = document.createElement("label");
  nameLabel.textContent = "展示名（回复署名；留空 = 匿名）";
  const nameRow = document.createElement("div");
  nameRow.className = "form-actions";
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.placeholder = "如：Windows 笔电";
  nameInput.value = state.store.displayName ?? "";
  nameInput.autocomplete = "off";
  const nameSaveBtn = document.createElement("button");
  nameSaveBtn.type = "button";
  nameSaveBtn.className = "btn";
  nameSaveBtn.textContent = "保存";
  const nameFeedback = document.createElement("div");
  nameFeedback.className = "form-feedback";
  nameFeedback.hidden = true;
  nameSaveBtn.addEventListener("click", () => {
    const raw = nameInput.value.trim();
    // 空串 → null（清除为匿名）；超限由 Rust limit_exceeded 显式拒绝。
    void (async () => {
      try {
        await invoke("set_display_name", { name: raw === "" ? null : raw });
        state.store.displayName = raw === "" ? null : raw;
        nameFeedback.className = "form-feedback ok";
        nameFeedback.textContent = raw === "" ? "已清除——后续回复匿名" : "展示名已保存";
      } catch (err) {
        const code = (err as { code?: string }).code ?? "unknown";
        nameFeedback.className = "form-feedback err";
        nameFeedback.textContent = `保存失败（${code}）——名称过长（上限 64 字）`;
      }
      nameFeedback.hidden = false;
    })();
  });
  nameRow.append(nameInput, nameSaveBtn);
  nameField.append(nameLabel, nameRow, nameFeedback);

  // ---- 全局勿扰（D-70）----
  const dndRow = document.createElement("div");
  dndRow.className = "settings-row";
  const dndLabel = document.createElement("span");
  dndLabel.className = "settings-row-label";
  dndLabel.textContent = "全局勿扰（完全不出通知）";
  const dndSwitch = document.createElement("input");
  dndSwitch.type = "checkbox";
  dndSwitch.className = "switch";
  dndSwitch.checked = state.store.dnd;
  dndSwitch.addEventListener("change", () => {
    void invoke("toggle_dnd", { dnd: dndSwitch.checked })
      .then(() => {
        state.store.dnd = dndSwitch.checked;
      })
      .catch(() => {
        dndSwitch.checked = state.store.dnd; // 失败回滚显示态
      });
  });
  dndRow.append(dndLabel, dndSwitch);

  // ---- 每频道静音（D-70）----
  const channelSection = document.createElement("div");
  channelSection.append(dndRow);
  for (const ch of state.store.channels.values()) {
    const row = document.createElement("div");
    row.className = "settings-row";
    const label = document.createElement("span");
    label.className = "settings-row-label";
    label.textContent = `频道「${ch.name}」静音`;
    const sw = document.createElement("input");
    sw.type = "checkbox";
    sw.className = "switch";
    sw.checked = ch.muted;
    sw.addEventListener("change", () => {
      void invoke("set_channel_muted", { id: ch.id, muted: sw.checked })
        .then(() => {
          state.setChannelMuted(ch.id, sw.checked);
        })
        .catch(() => {
          sw.checked = ch.muted; // 失败回滚显示态
        });
    });
    row.append(label, sw);
    channelSection.append(row);
  }

  const closeRow = document.createElement("div");
  closeRow.className = "form-actions";
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "btn btn-primary";
  closeBtn.textContent = "关闭";
  closeBtn.addEventListener("click", () => {
    overlay.hidden = true;
    overlay.replaceChildren();
  });
  closeRow.append(closeBtn);

  card.append(title, sub, nameField, channelSection, closeRow);
  overlay.replaceChildren(card);
  overlay.hidden = false;
}
