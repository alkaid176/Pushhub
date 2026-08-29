/**
 * UI 状态模块（05-06 Task 1，D-60/D-76）——纯数据：频道/消息/选中态 + 查询。
 *
 * 职责边界：零连接逻辑（连接归 Rust 进程持有，前端是纯展示层——事件桥与
 * invoke 编排在 main.ts）；本模块只维护视图数据，组件经 main.ts 顶层编排
 * 读写（无框架、无事件总线——sidebar/message-list/reply-box 各自暴露命令式
 * 视图方法，由桥接层在数据更新后调用，与「runtime = append-only 事件」的
 * D-60 语义一一对应）。
 *
 * 数据模型（对齐 05-05 命令/事件消费面总表）：
 *  - UiChannel：频道元数据 + 运行时视图态（status 由 ph://status 驱动；
 *    unread 由非当前频道的实时 ph://message +1——补拉批次不计未读，防重连
 *    后角标爆炸；messages 按 seq 升序）；
 *  - 消息去重（must_haves：等值 seq 绝不渲染两次）：seqs 集合索引覆盖补拉
 *    批次与实时帧交叠、快照序列化与在途事件的窄窗竞态；
 *  - snapshot 重建采用并集合并（快照缺某条在途已渲染消息即说明该消息比
 *    快照新——保留现视图不回退）。
 */

/** 频道连接状态（ph://status 载荷枚举，四态对应侧栏四色点）。 */
export type ChannelStatus = "connecting" | "online" | "reconnecting" | "offline";

/**
 * 消息视图模型——ph://message（flatten）、ph://history.messages、
 * channel_snapshot.messages 三处载荷同构（Rust MessageFrame 序列化形态；
 * Rust 侧 Option 字段可缺省或为 null）。
 */
export interface UiMessage {
  wid: string;
  seq: number;
  title?: string | null;
  text: string;
  options?: string[] | null;
  priority: string;
  answered: boolean;
  answered_by?: string | null;
  answered_at?: number | null;
  answered_content?: string | null;
  created_at: number;
}

export interface UiChannel {
  id: string;
  name: string;
  /** 每频道静音（D-70——只影响通知，不影响连接/渲染）。 */
  muted: boolean;
  status: ChannelStatus;
  unread: number;
  /** 按 seq 升序（插入排序维护——append 快路径在尾部）。 */
  messages: UiMessage[];
  /** 已入列 seq 索引（等值 seq 去重）。 */
  seqs: Set<number>;
}

/** get_config 返回的 Config 序列化形态（Rust config::Config）。 */
export interface ConfigView {
  server: string;
  channels: { id: string; name: string; key: string; muted: boolean }[];
  display_name?: string | null;
  dnd: boolean;
  first_close_hint_shown: boolean;
}

/** channel_snapshot 返回的 BufferSnapshot 序列化形态（频道不存在为 null）。 */
export interface SnapshotView {
  messages: UiMessage[];
  evicted: number;
  oldest_kept_seq: number | null;
}

interface Store {
  channels: Map<string, UiChannel>;
  server: string;
  dnd: boolean;
  displayName: string | null;
  /** 当前频道 id（null = 无频道/向导态）。 */
  current: string | null;
  /** 当前选中消息 wid（回复区绑定；null = 回复区收起）。 */
  selectedWid: string | null;
}

export const store: Store = {
  channels: new Map(),
  server: "",
  dnd: false,
  displayName: null,
  current: null,
  selectedWid: null,
};

// ---- 查询 ----

export function currentChannel(): UiChannel | null {
  if (store.current === null) return null;
  return store.channels.get(store.current) ?? null;
}

export function currentMessages(): UiMessage[] {
  return currentChannel()?.messages ?? [];
}

/** 按 wid 取消息（回复区/answered 定位用；无则 null）。 */
export function messageByWid(channelId: string, wid: string): UiMessage | null {
  const ch = store.channels.get(channelId);
  if (ch === undefined) return null;
  return ch.messages.find((m) => m.wid === wid) ?? null;
}

// ---- 装载与频道 ----

/** 启动装载（get_config → 视图模型）。初始 status=connecting（首个 ph://status
 * 事件即校正——run_channel 在前端就绪门放行后才 Connect，必然先发 connecting）。 */
export function loadConfig(cfg: ConfigView): void {
  store.server = cfg.server;
  store.dnd = cfg.dnd;
  store.displayName = cfg.display_name ?? null;
  for (const ch of cfg.channels) {
    store.channels.set(ch.id, {
      id: ch.id,
      name: ch.name,
      muted: ch.muted,
      status: "connecting",
      unread: 0,
      messages: [],
      seqs: new Set(),
    });
  }
  store.current = cfg.channels[0]?.id ?? null;
  store.selectedWid = null;
}

/** 切换当前频道：清选中、清未读（调用方负责 snapshot 重建与 set_current_channel）。 */
export function switchChannel(id: string): void {
  if (!store.channels.has(id) || store.current === id) return;
  store.current = id;
  store.selectedWid = null;
  const ch = store.channels.get(id);
  if (ch !== undefined) ch.unread = 0;
}

/** 向导保存后新增频道入列（key 不进前端状态——配置面归 Rust 落盘）。 */
export function addChannel(id: string, name: string): UiChannel {
  const ch: UiChannel = {
    id,
    name,
    muted: false,
    status: "connecting",
    unread: 0,
    messages: [],
    seqs: new Set(),
  };
  store.channels.set(id, ch);
  if (store.current === null) store.current = id;
  return ch;
}

/** 移除频道（设置面板删除入口；当前频道被删则回退到首个剩余频道）。 */
export function removeChannel(id: string): void {
  store.channels.delete(id);
  if (store.current === id) {
    store.current = store.channels.keys().next().value ?? null;
    store.selectedWid = null;
  }
}

export function setChannelMuted(id: string, muted: boolean): void {
  const ch = store.channels.get(id);
  if (ch !== undefined) ch.muted = muted;
}

// ---- 状态与消息 ----

export function setStatus(channelId: string, status: ChannelStatus): void {
  const ch = store.channels.get(channelId);
  if (ch !== undefined) ch.status = status;
}

/** 单条并入结果：inserted=false 即等值 seq 重复（丢弃不渲染）。 */
export interface IngestResult {
  inserted: boolean;
  /** 是否尾部插入（true → 视图可 append；false → 需全量重建保序）。 */
  atTail: boolean;
  message: UiMessage;
  /** 是否累加了非当前频道未读。 */
  unreadBumped: boolean;
}

/** 升序插入位置（二分上界——等值 seq 已由 seqs 集合先行排除）。 */
function upperBound(messages: UiMessage[], seq: number): number {
  let lo = 0;
  let hi = messages.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (messages[mid].seq <= seq) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** 单条并入核心（实时帧/补拉批次/快照合并共用）。 */
function ingestOne(channelId: string, msg: UiMessage): IngestResult {
  const notInserted: IngestResult = { inserted: false, atTail: false, message: msg, unreadBumped: false };
  const ch = store.channels.get(channelId);
  if (ch === undefined) return notInserted; // 未知频道（已移除）——静默
  if (ch.seqs.has(msg.seq)) return notInserted; // 等值 seq 绝不渲染两次
  ch.seqs.add(msg.seq);
  const idx = upperBound(ch.messages, msg.seq);
  ch.messages.splice(idx, 0, msg);
  const unreadBumped = channelId !== store.current;
  if (unreadBumped) ch.unread += 1;
  return { inserted: true, atTail: idx === ch.messages.length - 1, message: msg, unreadBumped };
}

/** 实时帧（ph://message）。 */
export function appendMessage(channelId: string, msg: UiMessage): IngestResult {
  return ingestOne(channelId, msg);
}

/** 补拉/首拉批次（ph://history）——不计未读（历史非新到，防重连角标爆炸）。 */
export function applyHistory(channelId: string, msgs: UiMessage[]): IngestResult[] {
  const results: IngestResult[] = [];
  for (const m of msgs) {
    const r = ingestOne(channelId, m);
    if (r.inserted && r.unreadBumped) {
      // 补拉批次回退未读计数（ingestOne 的 +1 只应对实时帧路径）。
      const ch = store.channels.get(channelId);
      if (ch !== undefined && ch.unread > 0) ch.unread -= 1;
      r.unreadBumped = false;
    }
    results.push(r);
  }
  return results;
}

/** 快照并集合并（channel_snapshot 全量重建——D-60）。已有 seq 保留现视图
 * （在途实时帧可能比快照新）；不裁剪（会话内列表与缓冲 500 同量级）。 */
export function mergeSnapshot(channelId: string, msgs: UiMessage[]): number {
  const ch = store.channels.get(channelId);
  if (ch === undefined) return 0;
  let added = 0;
  for (const m of msgs) {
    if (ingestOne(channelId, m).inserted) {
      added += 1;
      // 快照重建语义：非当前频道不视为新未读。
      if (ch.unread > 0) ch.unread -= 1;
    }
  }
  return added;
}

/** answered 原位更新（ph://answered）；返回更新后的消息（迟到 answered /
 * 消息不在窗口时返回 null——容忍，渲染面无动作）。 */
export function applyAnswered(
  channelId: string,
  frame: { wid: string; answered: boolean; answered_by?: string | null; answered_at: number; answered_content?: string | null },
): UiMessage | null {
  const msg = messageByWid(channelId, frame.wid);
  if (msg === null) return null;
  msg.answered = frame.answered;
  msg.answered_by = frame.answered_by ?? null;
  msg.answered_at = frame.answered_at;
  msg.answered_content = frame.answered_content ?? null;
  return msg;
}

// ---- 选中态（回复区绑定） ----

/** 选中/取消选中消息（回复区展开/收起）。 */
export function selectMessage(wid: string | null): void {
  store.selectedWid = wid;
}
