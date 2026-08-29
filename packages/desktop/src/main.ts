/**
 * 前端入口与事件桥（05-01 tracer → 05-06 完整展示层，D-60/D-76）。
 *
 * 职责边界（CLAUDE.md 硬禁令 + must_haves prohibitions）：前端是纯展示层——
 * 零浏览器侧套接字构造（连接唯一归属 Rust 进程）；窗口打开 → invoke
 * channel_snapshot 全量重建，运行中只消费 append-only 事件（D-60）。
 *
 * 事件桥（05-05 事件通道总表全部落位）：
 *  - ph://status：侧栏状态点 + 主区头部状态；
 *  - ph://message：当前频道追加渲染 / 非当前频道未读 +1（Rust 侧 SeqDedup
 *    已去重，前端按 seq 二次去重——快照与在途事件竞态防线）；
 *  - ph://history：批量并入（seq 去重 + 升序；非当前频道不计未读）；
 *  - ph://answered：消息条目 answered 徽标原位更新（D-17 不新增条目）；
 *  - ph://locate（D-67 三级定位）：显示并聚焦窗口 → 切换到载荷频道 →
 *    滚动到 wid 元素并高亮渐隐；
 *  - （05-06 Task 2）ph://first-close-hint 归 setup.ts。
 *
 * 就绪门（05-01）：listeners 挂齐后 emit ph://frontend-ready——Rust 侧
 * run_channel 等到信号才 Connect（首帧 status 事件竞态防线，顺序不可换）。
 */
import { emit, listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import * as state from "./state";
import { initSidebar, type SidebarView } from "./components/sidebar";
import { initMessageList, type MessageListView } from "./components/message-list";

// ---- 事件载荷形态（Rust serde 序列化；flatten 帧 = channel_id + 帧字段）----

interface StatusPayload {
  channel_id: string;
  status: state.ChannelStatus;
}

type MessagePayload = state.UiMessage & { channel_id: string };

interface HistoryPayload {
  channel_id: string;
  messages: state.UiMessage[];
  oldest_kept_seq: number;
  has_more: boolean;
}

interface AnsweredPayload {
  channel_id: string;
  wid: string;
  seq: number;
  answered: boolean;
  answered_by?: string | null;
  answered_at: number;
  answered_content?: string | null;
}

interface LocatePayload {
  channel_id: string;
  wid: string;
}

const statusEl = document.getElementById("status") as HTMLElement;
const channelNameEl = document.getElementById("current-channel-name") as HTMLElement;

let sidebar: SidebarView;
let messages: MessageListView;

/** 主区头部：当前频道名 + 连接状态（#status 同时是 tracer E2E 的锚点）。 */
function renderHeader(): void {
  const ch = state.currentChannel();
  channelNameEl.textContent = ch?.name ?? "未配置频道";
  statusEl.textContent = ch?.status ?? "—";
}

/** 频道切换编排（侧栏点击/ph://locate 共用）：状态切换 → 全量重建 →
 * set_current_channel 上报（决策矩阵 D-65 输入）→ snapshot 并集合并。 */
async function switchChannel(id: string): Promise<void> {
  state.switchChannel(id);
  sidebar.render();
  messages.rebuild(state.currentMessages());
  messages.setSelected(null);
  renderHeader();
  await invoke("set_current_channel", { channelId: id }).catch(() => {
    // 焦点上报失败不影响展示（决策矩阵退化按非当前频道处理）。
  });
  try {
    const snap = await invoke<state.SnapshotView | null>("channel_snapshot", { channelId: id });
    if (snap !== null && state.store.current === id) {
      state.mergeSnapshot(id, snap.messages);
      messages.rebuild(state.currentMessages());
    }
  } catch {
    // snapshot 失败不影响事件流（运行中事件仍会到达）。
  }
}

/** 消息条目点击 → 选中（回复区绑定；05-06 Task 2 接线回复区更新）。 */
function onClickMessage(wid: string): void {
  const selected = state.store.selectedWid === wid ? null : wid;
  state.selectMessage(selected);
  messages.setSelected(selected);
}

/** ph://locate 三级定位（D-67）：显示+聚焦窗口 → 切换频道 → 滚动高亮。 */
async function handleLocate(p: LocatePayload): Promise<void> {
  const win = getCurrentWindow();
  await win.show().catch(() => {});
  await win.setFocus().catch(() => {});
  if (state.store.current !== p.channel_id && state.store.channels.has(p.channel_id)) {
    await switchChannel(p.channel_id);
  }
  await messages.locate(p.wid);
}

// ---- 事件桥 ----

function bindEvents(): void {
  void listen<StatusPayload>("ph://status", (event) => {
    state.setStatus(event.payload.channel_id, event.payload.status);
    sidebar.render();
    renderHeader();
  });

  void listen<MessagePayload>("ph://message", (event) => {
    const p = event.payload;
    const { channel_id, ...frame } = p;
    const result = state.appendMessage(channel_id, frame);
    if (!result.inserted) return;
    if (channel_id === state.store.current) {
      if (result.atTail) messages.append(result.message);
      else messages.rebuild(state.currentMessages());
    } else {
      sidebar.render(); // 未读角标
    }
  });

  void listen<HistoryPayload>("ph://history", (event) => {
    const p = event.payload;
    state.applyHistory(p.channel_id, p.messages);
    if (p.channel_id === state.store.current) {
      messages.rebuild(state.currentMessages());
    }
  });

  void listen<AnsweredPayload>("ph://answered", (event) => {
    const p = event.payload;
    const msg = state.applyAnswered(p.channel_id, {
      wid: p.wid,
      answered: p.answered,
      answered_by: p.answered_by ?? null,
      answered_at: p.answered_at,
      answered_content: p.answered_content ?? null,
    });
    if (msg !== null && p.channel_id === state.store.current) {
      messages.updateAnswered(msg);
    }
  });

  void listen<LocatePayload>("ph://locate", (event) => {
    void handleLocate(event.payload);
  });
}

// ---- 启动 ----

async function bootstrap(): Promise<void> {
  const cfg = await invoke<state.ConfigView>("get_config");
  state.loadConfig(cfg);

  sidebar = initSidebar({
    onSelect: (id) => void switchChannel(id),
    onAddChannel: () => {
      // 05-06 Task 2：向导表单挂载（D-73 复用同一表单）。
    },
    onOpenSettings: () => {
      // 05-06 Task 2：设置面板挂载（D-72/D-70/D-74）。
    },
  });
  messages = initMessageList(onClickMessage);

  sidebar.render();
  messages.rebuild(state.currentMessages());
  renderHeader();

  if (state.store.current !== null) {
    await switchChannel(state.store.current);
  }

  bindEvents();
  // 就绪门：listeners 挂齐后才放行 Rust Connect（顺序不可换）。
  await emit("ph://frontend-ready");
}

void bootstrap();
