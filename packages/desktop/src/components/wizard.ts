/**
 * 内嵌配置向导（05-06 Task 2，D-73/WIN-06）——首启无配置与后续添加频道
 * 复用同一表单：服务端地址 + 频道名 + Channel Key 三输入 + 「验证连通」
 * （invoke test_connection，真实 WS 握手探测）+ 「保存并进入」（验证通过后
 * 启用；invoke add_channel——验证由前端显式先调，add 不隐式重复探测）。
 *
 * 安全纪律：
 *  - 表单不向任何浏览器存储写密钥（配置只经 Rust config.rs 落盘——
 *    must_haves prohibitions；本组件零存储调用）；
 *  - test_connection 错误按码分类（网络不可达 vs 密钥拒绝 vs 地址无效 vs
 *    超时），不回显服务端返回的原始错误（Rust 侧已保证静态文案）。
 */
import { invoke } from "@tauri-apps/api/core";
import { store } from "../state";

/** test_connection 错误码 → 内联提示（区分网络不可达与密钥拒绝）。 */
const CONNECT_ERROR_TEXT: Record<string, string> = {
  invalid_url: "服务端地址格式无效——请检查拼写（如 https://pushhub.dyun.org）",
  unreachable: "网络不可达——检查地址与本机网络",
  handshake_rejected: "服务端拒绝连接——Channel Key 可能不正确",
  timeout: "连接超时——服务端无响应",
};

export type WizardMode = "initial" | "add";

export interface WizardCallbacks {
  /** 保存成功（新频道 id + 名——main.ts 入列并切换）。 */
  onSaved(id: string, name: string): void;
  /** 关闭向导（add 模式的取消按钮；initial 模式无取消）。 */
  onClose(): void;
}

export function mountWizard(mode: WizardMode, cb: WizardCallbacks): void {
  const overlay = document.getElementById("overlay") as HTMLElement;

  const card = document.createElement("div");
  card.className = "panel-card";

  const title = document.createElement("h2");
  title.className = "panel-title";
  title.textContent = mode === "initial" ? "欢迎使用 PushHub" : "添加频道";
  const sub = document.createElement("p");
  sub.className = "panel-sub";
  sub.textContent =
    mode === "initial"
      ? "填服务端地址、频道名与 Channel Key 三项即接入（D-73）"
      : "与服务端同一表单——填频道名与 Channel Key（服务端地址沿用或修改）";

  function field(labelText: string, placeholder: string, inputType: "text" | "password", value = ""): {
    wrap: HTMLElement;
    input: HTMLInputElement;
  } {
    const wrap = document.createElement("div");
    wrap.className = "form-field";
    const label = document.createElement("label");
    label.textContent = labelText;
    const input = document.createElement("input");
    input.type = inputType;
    input.placeholder = placeholder;
    input.value = value;
    input.autocomplete = "off";
    input.spellcheck = false;
    wrap.append(label, input);
    return { wrap, input };
  }

  const serverField = field("服务端地址", "https://pushhub.dyun.org", "text", store.server);
  const nameField = field("频道名", "如：告警群", "text");
  const keyField = field("Channel Key", "phc_ 开头的通知密钥", "password");

  const actions = document.createElement("div");
  actions.className = "form-actions";
  const verifyBtn = document.createElement("button");
  verifyBtn.type = "button";
  verifyBtn.className = "btn";
  verifyBtn.textContent = "验证连通";
  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "btn btn-primary";
  saveBtn.textContent = mode === "initial" ? "保存并进入" : "保存";
  saveBtn.disabled = true; // 验证通过后启用
  actions.append(verifyBtn, saveBtn);
  if (mode === "add") {
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "btn";
    cancelBtn.textContent = "取消";
    cancelBtn.addEventListener("click", () => {
      overlay.hidden = true;
      overlay.replaceChildren();
      cb.onClose();
    });
    actions.append(cancelBtn);
  }

  const feedback = document.createElement("div");
  feedback.className = "form-feedback";
  feedback.hidden = true;

  function showFeedback(kind: "ok" | "err", text: string): void {
    feedback.className = `form-feedback ${kind}`;
    feedback.textContent = text;
    feedback.hidden = false;
  }

  let verified = false;

  function fieldsFilled(): boolean {
    return (
      serverField.input.value.trim() !== "" &&
      nameField.input.value.trim() !== "" &&
      keyField.input.value.trim() !== ""
    );
  }

  /** 任一字段变更即作废已验证状态（保存按钮回到禁用）。 */
  for (const f of [serverField.input, keyField.input]) {
    f.addEventListener("input", () => {
      verified = false;
      saveBtn.disabled = true;
      feedback.hidden = true;
    });
  }

  verifyBtn.addEventListener("click", () => {
    const server = serverField.input.value.trim();
    const key = keyField.input.value.trim();
    if (server === "" || key === "") {
      showFeedback("err", "请先填写服务端地址与 Channel Key");
      return;
    }
    verifyBtn.disabled = true;
    verifyBtn.textContent = "验证中…";
    void (async () => {
      try {
        await invoke("test_connection", { server, channelKey: key });
        verified = true;
        if (fieldsFilled()) saveBtn.disabled = false;
        showFeedback("ok", "连接成功——可以保存");
      } catch (err) {
        const code = (err as { code?: string }).code ?? "unknown";
        showFeedback("err", CONNECT_ERROR_TEXT[code] ?? "连接失败——请检查地址与密钥");
      } finally {
        verifyBtn.disabled = false;
        verifyBtn.textContent = "验证连通";
      }
    })();
  });

  saveBtn.addEventListener("click", () => {
    if (!verified) return;
    const server = serverField.input.value.trim();
    const name = nameField.input.value.trim();
    const key = keyField.input.value.trim();
    saveBtn.disabled = true;
    saveBtn.textContent = "保存中…";
    void (async () => {
      try {
        const id = await invoke<string>("add_channel", { server, name, key });
        overlay.hidden = true;
        overlay.replaceChildren();
        cb.onSaved(id, name);
      } catch (err) {
        const code = (err as { code?: string }).code ?? "unknown";
        showFeedback(
          "err",
          `保存失败（${code}）${code === "channel_limit_reached" ? "——最多 8 个频道" : ""}`,
        );
        saveBtn.disabled = false;
        saveBtn.textContent = mode === "initial" ? "保存并进入" : "保存";
      }
    })();
  });

  card.append(title, sub, serverField.wrap, nameField.wrap, keyField.wrap, actions, feedback);
  overlay.replaceChildren(card);
  overlay.hidden = false;
  (mode === "initial" ? serverField.input : nameField.input).focus();
}
