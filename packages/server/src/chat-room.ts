/**
 * ChatRoom —— 每频道一个实例的扇出中心（Durable Object，SQLite-backed）。
 *
 * 职责（01-01 切片 + 01-03 发送侧完整化）：
 *  - publish 内部请求：冻结校验器纵深防御 → seq 分配（显式 COALESCE(MAX)+1，
 *    禁 AUTOINCREMENT）→ 全字段 SQLite 落库（options 序列化 JSON 字符串、
 *    空省存 NULL）→ 冻结 MessageFrame 全连接扇出
 *  - WS 升级：Hibernation API 三件套（acceptWebSocket / serializeAttachment /
 *    setWebSocketAutoResponse）——空闲不计时长（SRV-04）
 *
 * 内存字段一律视为可丢弃缓存：休眠唤醒即清空，可从 getWebSockets / attachment /
 * SQLite 重建（PITFALLS 2.2）。
 *
 * 仅信 Worker 转发的内部请求（X-PH-Verified: 1 可信头，Pattern 8）——
 * DO 只经 binding 可达，内部头是双重防线。
 */
import { DurableObject } from "cloudflare:workers";
import {
  PROTOCOL_VERSION,
  WID_LENGTH,
  WID_PREFIX,
  type MessageFrame,
  type Priority,
} from "@pushhub/shared";
import { validateSendBody, type NormalizedSendBody } from "@pushhub/shared/validators";

// ---- WS 帧字面量（D-07：全帧带版本；两串各远小于 2048 字符上限）----
// 客户端应用层心跳：发 PING_FRAME 原文即被 setWebSocketAutoResponse 零唤醒自动回应。
const PING_FRAME = '{"v":1,"type":"ping"}';
const PONG_FRAME = '{"v":1,"type":"pong"}';

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

export class ChatRoom extends DurableObject {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // 幂等 DDL：构造器在每次唤醒时重跑（休眠唤醒后实例状态清空）。
    ctx.storage.sql.exec(CREATE_MESSAGES_DDL);
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
    return errorEnvelope(404, "not_found", "Unknown internal route.");
  }

  /**
   * publish：校验（纵深防御——Worker 层已拒非法载荷，DO 内复跑同一冻结校验器
   *   保证任何到达此处的请求体仍满足 D-02/D-04 契约）→ 同步块内取 seq →
   *   显式 INSERT 全字段落库 → 全连接扇出冻结 MessageFrame → 返回 {id, seq}。
   * 两句 exec 之间零 await = 自动原子提交（Pattern 3）；
 * 游标同步 .one()/toArray() 收完，不跨 await 持有（Pitfall 9）。
 */
  private async handlePublish(request: Request): Promise<Response> {
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

    return new Response(JSON.stringify({ id: wid, seq }), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  /** WS 升级：acceptWebSocket（绝不调用标准 accept——烧时长额度，Anti-Pattern #1）。 */
  private handleWebSocketUpgrade(): Response {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server);
    // 每连接状态跨休眠存活（serializeAttachment，上限 16,384 字节——本结构极小）。
    server.serializeAttachment({
      clientId: crypto.randomUUID(),
      connectedAt: Date.now(),
    });
    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * 入站业务帧：本期收到非 ping 业务帧时忽略（sync 补拉处理归 01-04）。
   * ping/pong 由 auto-response 零唤醒自动回应，不会进入本处理器。
   */
  async webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer): Promise<void> {
    // 01-04 将在此处理 {"type":"sync", since, limit} 帧。
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    ws.close(code, reason);
  }
}
