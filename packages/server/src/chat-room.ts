/**
 * ChatRoom —— 每频道一个实例的扇出中心（Durable Object，SQLite-backed）。
 *
 * 职责（01-01 切片 + 01-03 发送侧 + 01-04 接收侧）：
 *  - publish 内部请求：冻结校验器纵深防御 → seq 分配（显式 COALESCE(MAX)+1，
 *    禁 AUTOINCREMENT）→ 全字段 SQLite 落库（options 序列化 JSON 字符串、
 *    空省存 NULL）→ 冻结 MessageFrame 全连接扇出
 *  - WS 升级：Hibernation API 三件套（acceptWebSocket / serializeAttachment /
 *    setWebSocketAutoResponse）——空闲不计时长（SRV-04）；
 *    accept 成功后立即推送首拉 history 帧（最近 INITIAL_FETCH 条，D-09）
 *  - webSocketMessage：validateInboundFrame 白名单校验（v:1/type/since/limit）
 *    → sync 补拉（keyset 翻页 + limit 钳制 + oldest_kept_seq，D-10/D-11）
 *
 * 内存字段一律视为可丢弃缓存：休眠唤醒即清空，可从 getWebSockets / attachment /
 * SQLite 重建（PITFALLS 2.2）。
 *
 * 仅信 Worker 转发的内部请求（X-PH-Verified: 1 可信头，Pattern 8）——
 * DO 只经 binding 可达，内部头是双重防线。
 */
import { DurableObject } from "cloudflare:workers";
import {
  INITIAL_FETCH,
  PROTOCOL_VERSION,
  RATE_LIMIT_PER_MIN,
  RATE_WINDOW_MS,
  RETENTION_KEEP,
  SYNC_LIMIT_DEFAULT,
  SYNC_LIMIT_MAX,
  WID_LENGTH,
  WID_PREFIX,
  type HistoryFrame,
  type MessageFrame,
  type Priority,
  type WsErrorFrame,
} from "@pushhub/shared";
import {
  validateInboundFrame,
  validateSendBody,
  type NormalizedSendBody,
} from "@pushhub/shared/validators";

// ---- WS 帧字面量（D-07：全帧带版本；两串各远小于 2048 字符上限）----
// 客户端应用层心跳：发 PING_FRAME 原文即被 setWebSocketAutoResponse 零唤醒自动回应。
const PING_FRAME = '{"v":1,"type":"ping"}';
const PONG_FRAME = '{"v":1,"type":"pong"}';

// Worker→DO 可信内部头：限流分键（KEY-05）用的 Send Key 原值（与 index.ts 同名约定，
// 经 X-PH-Verified 可信通道随内部请求到达，不外泄任何响应）。
const SEND_KEY_HEADER = "X-PH-Send-Key";

// D-08 清理节奏：alarm 每日一次（保留窗口 DELETE + 限流桶清扫），数值可调
// （reversible——清理逻辑不随数值变化）。DELETE 也计 SQLite 行写额度，
// 一天一次批量足够（Pitfall 5：清理过频额度翻倍消耗）。
const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;

// ---- messages 表：Phase 1 冻结版 13 列 DDL（Pattern 4，不建二级索引）----
// seq 频道内单调游标（显式赋值）；wid 对外 ID（m_ + 16 字符，D-05）；
// answered 字段集 Phase 1 一次定全（D-03），本期恒为初始值。
const CREATE_MESSAGES_DDL = `
  CREATE TABLE IF NOT EXISTS messages (
    seq              INTEGER PRIMARY KEY,
    wid              TEXT NOT NULL,
    title            TEXT,
    text             TEXT NOT NULL,
    options          TEXT,
    callback_url     TEXT,
    click_url        TEXT,
    priority         TEXT NOT NULL DEFAULT 'normal',
    answered         INTEGER NOT NULL DEFAULT 0,
    answered_by      TEXT,
    answered_at      INTEGER,
    answered_content TEXT,
    created_at       INTEGER NOT NULL
  )
`;

// ---- rate_sends 表（KEY-05，Pattern 5 逐字）：每 Send Key 固定窗口计数 ----
// Send Key 单频道归属（sk:<key> -> channelId）使计数天然落在同一 ChatRoom DO，
// 单线程无竞态；每条消息限流开销 = +1 行读 +1 行写。
// 过期桶行随每日清理 alarm 一并清理（D-08，alarm 本身归 01-04+）。
const CREATE_RATE_SENDS_DDL = `
  CREATE TABLE IF NOT EXISTS rate_sends (
    send_key     TEXT PRIMARY KEY,
    window_start INTEGER NOT NULL,
    count        INTEGER NOT NULL
  )
`;

// ---- wid 生成（D-05）：前缀 + 长度引用 shared 常量（阈值单一来源），
// URL-safe 字母表去易混淆字符，不引外部 ID 库。----
const WID_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz";

function generateWid(): string {
  const bytes = new Uint8Array(WID_LENGTH);
  crypto.getRandomValues(bytes);
  let wid = WID_PREFIX;
  for (let i = 0; i < WID_LENGTH; i++) {
    wid += WID_ALPHABET[bytes[i] % WID_ALPHABET.length];
  }
  return wid;
}

/** D-06 错误信封。message 为通用文案，不含堆栈与内部键名。 */
function errorEnvelope(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

// ---- 补拉查询（01-04）：全 13 列显式列出（哑管道——text/options/URL 逐字透传，
// 不 SELECT * 以免列序漂移），seq 主键天然支持 keyset 分页（不建二级索引）。----
const MESSAGE_COLUMNS =
  "seq, wid, title, text, options, callback_url, click_url, priority, " +
  "answered, answered_by, answered_at, answered_content, created_at";

/** messages 表行的 TS 形态（options 为 JSON 字符串或 NULL；answered 为 0/1）。 */
interface MessageRow {
  seq: number;
  wid: string;
  title: string | null;
  text: string;
  options: string | null;
  callback_url: string | null;
  click_url: string | null;
  priority: string;
  answered: number;
  answered_by: string | null;
  answered_at: number | null;
  answered_content: string | null;
  created_at: number;
}

/**
 * 行 → 冻结 MessageFrame（与 publish 扇出帧逐字段同构，含省略语义：
 * 可选字段 NULL 时键不出现、options 反序列化为 string[]、answered 0/1 → boolean）。
 * history 帧内消息与实时扇出消息形态完全一致——客户端单条渲染路径（SRV-06）。
 */
function rowToMessageFrame(row: MessageRow): MessageFrame {
  const frame: MessageFrame = {
    v: PROTOCOL_VERSION,
    type: "message",
    wid: row.wid,
    seq: row.seq,
    ...(row.title !== null ? { title: row.title } : {}),
    text: row.text,
    ...(row.options !== null
      ? { options: JSON.parse(row.options) as string[] }
      : {}),
    ...(row.callback_url !== null ? { callback_url: row.callback_url } : {}),
    ...(row.click_url !== null ? { click_url: row.click_url } : {}),
    priority: row.priority as Priority,
    answered: row.answered !== 0,
    answered_by: row.answered_by,
    answered_at: row.answered_at,
    answered_content: row.answered_content,
    created_at: row.created_at,
  };
  return frame;
}

/**
 * D-11 limit 钳制三态：缺省 SYNC_LIMIT_DEFAULT；大于上限压到 SYNC_LIMIT_MAX；
 * 小于 1 抬到 1。经 validateInboundFrame 的入站 limit 恒为 [1, MAX] 整数或
 * 缺省（越界值在冻结校验器处已回 invalid_frame——fixtures 逐字节冻结的反例
 * 语义，Flagged Assumption 按冻结契约落地）；本钳制是对 SQL 层的纵深防线
 * （limit+1 取行前任何值都不越界），缺省分支是热路径。
 */
function clampSyncLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return SYNC_LIMIT_DEFAULT;
  }
  if (limit > SYNC_LIMIT_MAX) {
    return SYNC_LIMIT_MAX;
  }
  if (limit < 1) {
    return 1;
  }
  return limit;
}

export class ChatRoom extends DurableObject {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // 幂等 DDL：构造器在每次唤醒时重跑（休眠唤醒后实例状态清空）。
    ctx.storage.sql.exec(CREATE_MESSAGES_DDL);
    ctx.storage.sql.exec(CREATE_RATE_SENDS_DDL);
    // auto-response 必须在构造器重设——休眠唤醒后不复活（Pitfall 3）。
    // 协议层 ping/pong 由运行时自动应答且不唤醒 DO（零计费零时长）。
    // WebSocketRequestResponsePair 是 workerd 运行时全局构造器（同 WebSocketPair），
    // 不从 cloudflare:workers 模块导入（该模块无此导出，见 01-01 执行记录）。
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(PING_FRAME, PONG_FRAME),
    );
  }

  async fetch(request: Request): Promise<Response> {
    // 仅信 Worker 转发的内部请求（Pattern 8）。
    if (request.headers.get("X-PH-Verified") !== "1") {
      return errorEnvelope(401, "invalid_key", "Missing or invalid credentials.");
    }

    const url = new URL(request.url);
    if (url.pathname === "/publish" && request.method === "POST") {
      return this.handlePublish(request);
    }
    if (url.pathname === "/ws" && request.headers.get("Upgrade") === "websocket") {
      return this.handleWebSocketUpgrade();
    }
    if (url.pathname === "/cleanup-rate" && request.method === "POST") {
      return this.handleCleanupRate(request);
    }
    if (url.pathname === "/kick-all" && request.method === "POST") {
      return this.handleKickAll();
    }
    if (url.pathname === "/purge" && request.method === "POST") {
      return this.handlePurge();
    }
    return errorEnvelope(404, "not_found", "Unknown internal route.");
  }

  /**
   * 吊销联动第三环（03-02，D-32——planner 裁定即时清理）：删除该 Send Key 的
   * rate_sends 行。X-PH-Send-Key 缺失即内部契约违例——照 publish 同款处理
   * （T-03-08：本分支位于 X-PH-Verified 校验之后，结构继承防护）。
   * 幂等：行不存在时 DELETE 零行为；键名永不复用 + 每日 alarm 自然清扫兜底。
   */
  private handleCleanupRate(request: Request): Response {
    const sendKey = request.headers.get(SEND_KEY_HEADER);
    if (sendKey === null) {
      return errorEnvelope(401, "invalid_key", "Missing or invalid credentials.");
    }
    this.ctx.storage.sql.exec(
      "DELETE FROM rate_sends WHERE send_key = ?1",
      sendKey,
    );
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  /**
   * 重置 Channel Key 踢连（03-03，D-33）：遍历全部已连接 WS（getWebSockets
   * 含休眠中连接句柄——运行时句柄表是唯一真相）逐个 close，计数返回。
   * close code 1008 = policy violation（连接因策略被终止，planner 裁定记入
   * 决策表）；reason 供 Phase 5/6 客户端展示细化。已死连接 close 抛错时
   * 忽略（publish 死连接清理同款容错）。web SDK 不区分 close code 一律
   * 退避重连——踢连后的旧 Key 重挂防线由 Worker 侧编排顺序（KV 写先）
   * 与 ≤60s 缓存窗口共同保证，不在本路由职责内。
   */
  private handleKickAll(): Response {
    let kicked = 0;
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(1008, "channel key reset");
        kicked++;
      } catch {
        // 已死连接（publish 死连接清理同款容错）。
      }
    }
    return new Response(JSON.stringify({ kicked }), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  /**
   * 频道硬删除清库（03-03，D-34）：踢连（close 1008 "channel deleted"）→
   * deleteAll() → deleteAlarm() 三步成对执行。
   *
   * 红线：deleteAll 与 deleteAlarm 必须成对——deleteAll 官方语义清整个
   * SQLite 库（含 SQL 表与 KV 型数据，原子）但**不删 alarm**，而本项目
   * alarm 处理器尾部无条件重设（自愈节奏），漏 deleteAlarm 即僵尸 DO
   * 永久每日唤醒烧额度（Pitfall 1）。幂等：对已清空 DO 重放本路由是
   * no-op（构造器在下次唤醒重建空表后再清一次无害）——部分失败的删除
   * 链可整链重试。
   */
  private async handlePurge(): Promise<Response> {
    let kicked = 0;
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(1008, "channel deleted");
        kicked++;
      } catch {
        // 已死连接。
      }
    }
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.deleteAlarm();
    return new Response(JSON.stringify({ kicked }), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  /**
   * publish：校验（纵深防御——Worker 层已拒非法载荷，DO 内复跑同一冻结校验器
   *   保证任何到达此处的请求体仍满足 D-02/D-04 契约）→ 同步块内取 seq →
   *   显式 INSERT 全字段落库 → 全连接扇出冻结 MessageFrame → 返回 {id, seq}。
   * 两句 exec 之间零 await = 自动原子提交（Pattern 3）；
 * 游标同步 .one()/toArray() 收完，不跨 await 持有（Pitfall 9）。
 */
  private async handlePublish(request: Request): Promise<Response> {
    // KEY-05 限流先行（Pattern 5）：按 Send Key 固定窗口计数，先于校验、
    // seq 分配与落库——被拒消息不消耗 seq、不产生 messages 表写入。
    // Worker 转发的内部 publish 必带 X-PH-Send-Key；缺失即内部契约违例。
    const sendKey = request.headers.get(SEND_KEY_HEADER);
    if (sendKey === null) {
      return errorEnvelope(401, "invalid_key", "Missing or invalid credentials.");
    }
    const limited = this.checkRateLimit(sendKey);
    if (limited !== null) {
      return limited;
    }

    // 冻结校验器直接吃原始请求体（invalid_json 路径实体化）；
    // 错误码与信封文案与 Worker 层逐字节一致（D-06 单一来源）。
    const validation = validateSendBody(await request.text());
    if (!validation.ok) {
      return errorEnvelope(validation.status, validation.code, validation.message);
    }
    const payload: NormalizedSendBody = validation.normalized;

    const title = payload.title ?? null;
    const optionsJson = payload.options !== undefined
      ? JSON.stringify(payload.options)
      : null;
    const callbackUrl = payload.callback_url ?? null;
    const clickUrl = payload.click_url ?? null;
    const priority: Priority = payload.priority;

    const wid = generateWid();
    const createdAt = Date.now();

    // 同步块：seq = COALESCE(MAX(seq),0)+1 -> 显式 INSERT（Pattern 3，禁 AUTOINCREMENT）。
    const row = this.ctx.storage.sql
      .exec("SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM messages")
      .one() as { n: number };
    const seq = row.n;
    this.ctx.storage.sql.exec(
      "INSERT INTO messages (seq, wid, title, text, options, callback_url, click_url, priority, answered, answered_by, answered_at, answered_content, created_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, NULL, NULL, NULL, ?9)",
      seq, wid, title, payload.text, optionsJson, callbackUrl, clickUrl, priority, createdAt,
    );

    // 冻结 MessageFrame（01-02 全量类型）：D-03 answered 字段集随首帧一次定全
    // （本期恒初始值）；可选字段省略语义——未提供时键不出现（永不为空数组）。
    // 服务端是哑管道：text/options/两 URL 存储与扇出逐字保持原文，
    // 不解析 Markdown、不消费 URL（SRV-02 Prohibitions）。
    const frame: MessageFrame = {
      v: PROTOCOL_VERSION,
      type: "message",
      wid,
      seq,
      ...(title !== null ? { title } : {}),
      text: payload.text,
      ...(payload.options !== undefined ? { options: payload.options } : {}),
      ...(callbackUrl !== null ? { callback_url: callbackUrl } : {}),
      ...(clickUrl !== null ? { click_url: clickUrl } : {}),
      priority,
      answered: false,
      answered_by: null,
      answered_at: null,
      answered_content: null,
      created_at: createdAt,
    };
    const frameJson = JSON.stringify(frame);

    // 全连接扇出（含休眠中连接的句柄）；try/catch 收集死连接后统一清理。
    const dead: WebSocket[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(frameJson);
      } catch {
        dead.push(ws);
      }
    }
    for (const ws of dead) {
      ws.close(1011, "send failed");
    }

    // D-08 首个 alarm 的设置点：publish 成功路径内 getAlarm() 判空后才 set
    // （构造器绝不 setAlarm——DO 每次唤醒构造器先于 alarm 处理器执行，直接
    // set 会覆盖未触发的 alarm，Pitfall 7）。后续节奏由 alarm 处理器尾部
    // 无条件重设自愈维持。
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + RETENTION_INTERVAL_MS);
    }

    return new Response(JSON.stringify({ id: wid, seq }), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  /**
   * KEY-05 限流：每 Send Key 固定窗口计数（rate_sends 表，Pattern 5 三分支，
   * 窗口长度与阈值引用 shared 常量——改动只改一处）。
   *  - 无记录或窗口已过（now - window_start >= RATE_WINDOW_MS）→ 重置计数为 1；
   *  - 窗口内且 count >= RATE_LIMIT_PER_MIN → 429 rate_limited 信封 +
   *    Retry-After 头（窗口剩余秒数向上取整，窗口内恒 >= 1）；
   *  - 窗口内未超 → count+1 放行。
   * 返回 null 表示放行；同步方法 + 读写间零 await（DO 单线程无竞态）。
   * 固定窗口边界允许瞬时 2× 突发（Flagged Assumption KEY-05，文档化接受）。
   */
  private checkRateLimit(sendKey: string): Response | null {
    const now = Date.now();
    const row = this.ctx.storage.sql
      .exec("SELECT window_start, count FROM rate_sends WHERE send_key = ?1", sendKey)
      .toArray()[0] as { window_start: number; count: number } | undefined;
    if (row === undefined || now - row.window_start >= RATE_WINDOW_MS) {
      this.ctx.storage.sql.exec(
        "INSERT INTO rate_sends (send_key, window_start, count) VALUES (?1, ?2, 1) " +
          "ON CONFLICT(send_key) DO UPDATE SET window_start = ?2, count = 1",
        sendKey, now,
      );
      return null;
    }
    if (row.count >= RATE_LIMIT_PER_MIN) {
      const retryAfterSec = Math.ceil((RATE_WINDOW_MS - (now - row.window_start)) / 1000);
      return new Response(
        JSON.stringify({
          error: {
            code: "rate_limited",
            message: "Too many requests. Please retry later.",
          },
        }),
        {
          status: 429,
          headers: {
            "content-type": "application/json; charset=utf-8",
            "Retry-After": String(retryAfterSec),
          },
        },
      );
    }
    this.ctx.storage.sql.exec(
      "UPDATE rate_sends SET count = count + 1 WHERE send_key = ?1",
      sendKey,
    );
    return null;
  }

  /**
   * WS 升级：acceptWebSocket（绝不调用标准 accept——烧时长额度，Anti-Pattern #1）。
   * 升级路径零 await、全部同步（SQLite 读即 .toArray() 收完，Pitfall 9）——
   * accept 成功后立即推送首拉 history 帧（最近 INITIAL_FETCH 条，D-09），
   * 帧在返回 101 前入队（DO 无 waitUntil——响应返回后浮空 Promise 不可靠，
   * 同步入队是唯一可靠的首连推送点）。
   */
  private handleWebSocketUpgrade(): Response {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server);
    // 每连接状态跨休眠存活（serializeAttachment，上限 16,384 字节——本结构极小）。
    server.serializeAttachment({
      clientId: crypto.randomUUID(),
      connectedAt: Date.now(),
    });
    this.sendHistory(server, null, undefined);
    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * 入站业务帧（01-04）：非 string（ArrayBuffer）直接忽略；string 先过
   * validateInboundFrame（冻结白名单：v:1 / type 枚举 / since/limit 结构，
   * 任何入站字符串不直接进 SQL，T-01-07）。
   *  - 校验失败 → 回 WsErrorFrame（invalid_version / invalid_frame）后返回，
   *    连接保持（Flagged Assumption SRV-07：服务端忽略坏帧不断连——
   *    "不识别的 v 即断连"是客户端侧职责，D-07）；
   *  - ping → 防御性忽略（auto-response 零唤醒层已按字节匹配拦截，理论上
   *    收不到；键序不同的 ping 帧落进来也不应导致任何状态变化）；
   *  - sync → keyset 补拉（sendHistory）。
   */
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") {
      return;
    }
    const validation = validateInboundFrame(message);
    if (!validation.ok) {
      const errorFrame: WsErrorFrame = {
        v: PROTOCOL_VERSION,
        type: "error",
        code: validation.code,
        message: validation.message,
      };
      ws.send(JSON.stringify(errorFrame));
      return;
    }
    const frame = validation.frame;
    if (frame.type === "ping") {
      return;
    }
    this.sendHistory(ws, frame.since, frame.limit);
  }

  /**
   * 补拉核心（D-09/D-10/D-11）——全程同步（游标 .toArray() 即收，零跨 await，
   * Pitfall 9），响应一条 history 帧：
   *  - since === null（首拉）：最近 INITIAL_FETCH 条——seq 降序 LIMIT n+1
   *    取回后内存反转（升序输出），多取的 1 条即 has_more 证据；
   *  - since 为数字（增量）：keyset 查询 WHERE seq > ? ORDER BY seq ASC
   *    LIMIT n+1（多取 1 条判定 has_more，返回前裁掉——禁 OFFSET 分页）；
   *  - limit 经 clampSyncLimit 钳制（缺省 200 / 钳 [1, 500]）；
   *  - oldest_kept_seq = MIN(seq)（空频道为 0）——请求的 since 早于它时
   *    客户端呈现"更早消息已清理"分隔线，不报错不断连（D-10 诚实缺口语义）。
   */
  private sendHistory(ws: WebSocket, since: number | null, limit?: number): void {
    const oldestRow = this.ctx.storage.sql
      .exec("SELECT MIN(seq) AS m FROM messages")
      .one() as { m: number | null };

    let rows: MessageRow[];
    let hasMore: boolean;
    if (since === null) {
      const fetched = this.ctx.storage.sql
        .exec(
          `SELECT ${MESSAGE_COLUMNS} FROM messages ORDER BY seq DESC LIMIT ?1`,
          INITIAL_FETCH + 1,
        )
        .toArray() as unknown as MessageRow[];
      hasMore = fetched.length > INITIAL_FETCH;
      rows = (hasMore ? fetched.slice(0, INITIAL_FETCH) : fetched).reverse();
    } else {
      const capped = clampSyncLimit(limit);
      const fetched = this.ctx.storage.sql
        .exec(
          `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE seq > ?1 ORDER BY seq ASC LIMIT ?2`,
          since,
          capped + 1,
        )
        .toArray() as unknown as MessageRow[];
      hasMore = fetched.length > capped;
      rows = hasMore ? fetched.slice(0, capped) : fetched;
    }

    const frame: HistoryFrame = {
      v: PROTOCOL_VERSION,
      type: "history",
      messages: rows.map(rowToMessageFrame),
      oldest_kept_seq: oldestRow.m ?? 0,
      has_more: hasMore,
    };
    ws.send(JSON.stringify(frame));
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    ws.close(code, reason);
  }

  /**
   * D-08 每日保留清理（alarm，Pitfall 5/7）：
   *  - messages：DELETE WHERE seq <= MAX(seq) - RETENTION_KEEP——严格小于当前
   *    max，永不删 max 行（显式 seq 赋值的单调不回退前提；表空时 MAX 为
   *    NULL，条件恒假零删除）；
   *  - rate_sends：清扫过期限流桶（window_start 早于 24 小时前）；
   *  - catch 自捕获不重抛：alarm 自带重试仅 6 次即放弃——自 catch 才能保住
   *    每日节奏（异常留给下一次 alarm 自然重试同一批数据）；
   *  - finally 尾部无条件重设下一天（setAlarm 覆盖式，不叠加）——本方法
   *    是唯一与 publish 判空并列的 setAlarm 调用点。
   */
  async alarm(): Promise<void> {
    try {
      this.ctx.storage.sql.exec(
        "DELETE FROM messages WHERE seq <= (SELECT MAX(seq) - ?1 FROM messages)",
        RETENTION_KEEP,
      );
      this.ctx.storage.sql.exec(
        "DELETE FROM rate_sends WHERE window_start < ?1",
        Date.now() - RETENTION_INTERVAL_MS,
      );
    } catch {
      // 吞异常：清理失败不阻断重设节奏；数据幂等（下一天同条件重删）。
    } finally {
      await this.ctx.storage.setAlarm(Date.now() + RETENTION_INTERVAL_MS);
    }
  }
}
