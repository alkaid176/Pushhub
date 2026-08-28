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
 *  - webSocketMessage：validateInboundFrame 白名单校验（v:1/type/各帧字段）
 *    → sync 补拉（keyset 翻页 + limit 钳制 + oldest_kept_seq，D-10/D-11）
 *    → reply 处理（04-01 D-45：域级校验 + answered 一次锁定落库 + ack 单发
 *      + answered 全连接扇出）
 *  - GET /history 内部请求（03-04，D-36）：admin 排障用 keyset 倒序翻页
 *    （before 游标 + limit 钳制 + oldest_kept_seq；Worker admin 鉴权后转发）
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
  type AckFrame,
  type AnsweredFrame,
  type ErrorCode,
  type HistoryFrame,
  type MessageFrame,
  type Priority,
  type ReplyFrame,
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

// Worker→DO 可信内部头：DO 代际校验用的 Channel Key 原值（WR-02；与
// index.ts/admin.ts 同名同值约定——照 SEND_KEY_HEADER 同款本地声明）。
const CHANNEL_KEY_HEADER = "X-PH-Channel-Key";

// Worker→DO 可信内部头（04-02 D-47/D-49）：signing secret 原值与频道 ID——
// /ws 升级路径与 /set-signing-secret 内部路由共用同一落盘辅助（与
// index.ts/admin.ts 同名同值约定；经 X-PH-Verified 可信通道到达，不外泄）。
const SIGNING_SECRET_HEADER = "X-PH-Signing-Secret";
const CHANNEL_ID_HEADER = "X-PH-Channel-Id";

// D-08 清理节奏：alarm 每日一次（保留窗口 DELETE + 限流桶清扫），数值可调
// （reversible——清理逻辑不随数值变化）。DELETE 也计 SQLite 行写额度，
// 一天一次批量足够（Pitfall 5：清理过频额度翻倍消耗）。
const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;

// ---- 回调投递常量（04-02，Task 2 用户裁决 approve-contract 定稿，one-way）----
// 重试档位（D-50）：attempts 递增后取档 [attempts-1]——第 1 次失败等 1s、
// 第 2 次等 2m、第 3 次等 10m、第 4 次等 30m、第 5 次失败即封顶（无档可取）。
const CALLBACK_RETRY_DELAYS_MS = [1_000, 120_000, 600_000, 1_800_000];
/** 总尝试次数硬封顶（T-04-10：每消息回调外呼上界 5 次 fetch + 5 次 alarm 唤醒）。 */
const CALLBACK_MAX_ATTEMPTS = 5;
/**
 * 签名容忍窗（D-48，approve-contract 定稿 300000ms、毫秒口径）：接收方拒收
 * 超窗请求的参考常量（供文档与 04-04 验签参考实现同口径引用）。DO 投递侧
 * 自身不校验容忍窗——那是接收方职责（重试每次新 timestamp 天然落在窗内）。
 */
export const SIGNATURE_TOLERANCE_MS = 300_000;

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

// ---- meta 表（WR-02 密钥代际）：单行键值（k/v），同步 SQL 读写——WS 升级
// 路径保持零 await 纪律（Pitfall 9）。deleteAll 清库后由 purge 重建空表
//（代际归零：频道已删，与「删除后 KV 缓存残留窗口」的文档化行为一致）。----
const CREATE_META_DDL = `
  CREATE TABLE IF NOT EXISTS meta (
    k TEXT PRIMARY KEY,
    v TEXT NOT NULL
  )
`;

// ---- callbacks 表（04-02，D-43/D-49/D-50）：回调投递队列 + 失败记录 ----
// wid 主键 = 一消息恰一回调行（D-43 恰首答触发一次）；body 为入队时预序列化
// 的 D-49 五字段 JSON——重试字节冻结（Pitfall 4：投递永远发送该字符串，键序
// 漂移会使接收方验签失败）。next_attempt_at 为调度键（alarm 单槽 min 重排）；
// status: pending | delivered | failed。deleteAll 随频道删除一并清除（频道已删
// 无需回调）；purge 重建空表（WR-01 同款）。
const CREATE_CALLBACKS_DDL = `
  CREATE TABLE IF NOT EXISTS callbacks (
    wid              TEXT PRIMARY KEY,
    url              TEXT NOT NULL,
    body             TEXT NOT NULL,
    attempts         INTEGER NOT NULL DEFAULT 0,
    next_attempt_at  INTEGER NOT NULL,
    status           TEXT NOT NULL DEFAULT 'pending',
    last_error       TEXT,
    created_at       INTEGER NOT NULL,
    final_failed_at  INTEGER
  )
`;

/** meta 表的密钥代际行键：值为最近一次重置后的当前 Channel Key。 */
const META_KEY_GEN = "channel_key_gen";

/** meta 表行键（04-02）：signing secret（回调 HMAC 签名密钥）与频道 ID
 * （D-49 回调 body 的 channel_id 数据源）——/ws 升级时随内部头落盘。 */
const META_KEY_SIGNING_SECRET = "signing_secret";
const META_KEY_CHANNEL_ID = "channel_id";

/** meta 表行键（04-02）：下次保留清理到期时刻（epoch ms）——alarm 多事件单槽
 * 调度器的第二类事件日程（Pitfall 1 根治：到期时间持久化，不被重试 alarm
 * 顺延或吞噬）。缺省语义 = 视为已到期（null → 立即补跑一次清理）。 */
const META_KEY_RETENTION_DUE = "retention_due";

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

/** handleReply 的目标行（messages 表按 wid 定位的所需列，04-01）。 */
interface ReplyTargetRow {
  seq: number;
  options: string | null;
  answered: number;
  callback_url: string | null;
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

// ---- admin 历史翻页常量（03-04，D-36）：与 shared SYNC_*（WS 补拉域）刻意
// 分离——admin 排障是独立消费者（缺省 50 非 200），两域参数语义各自演化，
// 复用同一常量会把 WS 冻结契约牵连进 admin 宽松语义。----
const ADMIN_HISTORY_LIMIT_DEFAULT = 50;
const ADMIN_HISTORY_LIMIT_MAX = 500;

/**
 * admin /history 的 limit 解析与钳制（03-04，D-36）：null / 非数字 -> 缺省
 * 50；钳制 [1, 500]。与 clampSyncLimit（WS sync 域——越界回 invalid_frame 的
 * 冻结契约）刻意分开：admin 查询参数是宽松语义（错值归缺省不报错），独立
 * 小函数避免两域契约互相牵连（T-03-18：任何值都不越 SQL 层界）。
 */
function clampAdminLimit(raw: string | null): number {
  if (raw === null) {
    return ADMIN_HISTORY_LIMIT_DEFAULT;
  }
  const n = Number(raw);
  if (Number.isNaN(n)) {
    return ADMIN_HISTORY_LIMIT_DEFAULT;
  }
  if (n > ADMIN_HISTORY_LIMIT_MAX) {
    return ADMIN_HISTORY_LIMIT_MAX;
  }
  if (n < 1) {
    return 1;
  }
  return n;
}

export class ChatRoom extends DurableObject {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // 幂等 DDL：构造器在每次唤醒时重跑（休眠唤醒后实例状态清空）。
    ctx.storage.sql.exec(CREATE_MESSAGES_DDL);
    ctx.storage.sql.exec(CREATE_RATE_SENDS_DDL);
    ctx.storage.sql.exec(CREATE_META_DDL);
    ctx.storage.sql.exec(CREATE_CALLBACKS_DDL);
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
      return this.handleWebSocketUpgrade(request);
    }
    if (url.pathname === "/cleanup-rate" && request.method === "POST") {
      return this.handleCleanupRate(request);
    }
    if (url.pathname === "/kick-all" && request.method === "POST") {
      return this.handleKickAll(request);
    }
    if (url.pathname === "/set-signing-secret" && request.method === "POST") {
      return this.handleSetSigningSecret(request);
    }
    if (url.pathname === "/purge" && request.method === "POST") {
      return this.handlePurge();
    }
    if (url.pathname === "/history" && request.method === "GET") {
      return this.handleHistory(url);
    }
    if (url.pathname === "/callback-failures" && request.method === "GET") {
      return this.handleCallbackFailures();
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
   * 退避重连——踢连后的旧 Key 重挂防线有三道：Worker 侧编排顺序（KV 写先
   * DO 踢后）+ ≤60s 缓存窗口自然过期 + 本 DO 的代际校验（WR-02，见
   * handleWebSocketUpgrade）。
   */
  private handleKickAll(request: Request): Response {
    // WR-02 代际落盘：重置流程随 kick-all 携带新 Channel Key——先写代际再
    // 踢连。被踢客户端（含 SDK 自动重连，退避首跳 <1s）在 ≤60s KV 缓存
    // 窗口内以旧 ch: 值重连时，Worker 照常转发（KV 读命中缓存），但 DO 侧
    // 代际比对不匹配即 401 拒绝——「窗口内重挂成功后长存」的缺口就此闭合
    //（此前 KV 写先 DO 踢后的顺序红线只闭合了「60s 后仍可重挂」）。同步
    // SQL 写（单行，零 await）；头缺失（内部契约演进的兼容窗口）只踢不落
    // 代际，行为退回旧语义。
    const newGen = request.headers.get(CHANNEL_KEY_HEADER);
    if (newGen !== null) {
      this.ctx.storage.sql.exec(
        "INSERT INTO meta (k, v) VALUES (?1, ?2) ON CONFLICT(k) DO UPDATE SET v = ?2",
        META_KEY_GEN,
        newGen,
      );
    }
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
   * signing secret 重置联动（04-02，D-47）：admin reset 端点 KV 写先、本路由
   * 转发后——把新 secret 与 channelId 落 meta 表（照 kick-all 代际落盘同款，
   * INSERT ON CONFLICT 覆盖式更新）。X-PH-Signing-Secret 缺失即内部契约违例
   * ——照 handleCleanupRate 同款 401。同步 SQL 写零 await；转发失败由调用方
   * try/catch 吞掉（尽力语义：下次 /ws 连接以 KV 权威值重写 meta 自然收敛）。
   */
  private handleSetSigningSecret(request: Request): Response {
    if (request.headers.get(SIGNING_SECRET_HEADER) === null) {
      return errorEnvelope(401, "invalid_key", "Missing or invalid credentials.");
    }
    this.writeChannelMeta(request);
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  /**
   * 频道级 meta 落盘（04-02）：/ws 升级与 /set-signing-secret 共用——把转发
   * 头携带的 signing secret 与 channelId 写入 meta 表（头缺失时不写——旧
   * 格式频道在补发前 meta 无 secret 行，回调链走 "no signing secret" 失败
   * 可查路径，Pitfall 8）。同步 SQL（零 await，Pitfall 9）。
   */
  private writeChannelMeta(request: Request): void {
    const secret = request.headers.get(SIGNING_SECRET_HEADER);
    if (secret !== null) {
      this.ctx.storage.sql.exec(
        "INSERT INTO meta (k, v) VALUES (?1, ?2) ON CONFLICT(k) DO UPDATE SET v = ?2",
        META_KEY_SIGNING_SECRET,
        secret,
      );
    }
    const channelId = request.headers.get(CHANNEL_ID_HEADER);
    if (channelId !== null) {
      this.ctx.storage.sql.exec(
        "INSERT INTO meta (k, v) VALUES (?1, ?2) ON CONFLICT(k) DO UPDATE SET v = ?2",
        META_KEY_CHANNEL_ID,
        channelId,
      );
    }
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
    // WR-01：重建空表——deleteAll 清整库后驻留内存的 DO 不会重跑构造器
    //（DDL 仅构造器执行），而 KV 侧 sk:/ch: 删除有 ≤60s 边缘缓存窗口：
    // 窗口内残留的 publish/ws 流量（resolveSendKey/resolveChannelKey 命中
    // 缓存、Worker 照常转发）会直接命中 "no such table" 未捕获异常 → 裸
    // 500。重建（CREATE TABLE IF NOT EXISTS 幂等）后残留流量得到空频道
    // 行为而非异常；缓存过期后恢复 Worker 层干净 401。
    // 已知残留（文档化）：窗口内残留 publish 成功落库会重设 alarm——空 DO
    // 每日唤醒一次（清理空表 no-op），额度影响可忽略。meta（代际）随
    // deleteAll 清零且重建为空——删除后的频道无代际，残留窗口语义不变
    //（WR-02 代际只闭合重置场景的重挂缺口）。
    this.ctx.storage.sql.exec(CREATE_MESSAGES_DDL);
    this.ctx.storage.sql.exec(CREATE_RATE_SENDS_DDL);
    this.ctx.storage.sql.exec(CREATE_META_DDL);
    this.ctx.storage.sql.exec(CREATE_CALLBACKS_DDL);
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
  /**
   * admin 消息历史查询（03-04，D-36，ADM-03 排障入口）：keyset 倒序翻页
   * （最新在最上），供 Worker 转发（本路由绝不直连公网——X-PH-Verified
   * 前置 + binding 可达性双防线，T-03-17）。
   *  - before === null（或非数字，宽松语义同 limit）：首页最新 limit 条；
   *    否则 WHERE seq < before（绑定参数 ?n 占位，禁 OFFSET，T-03-18）；
   *  - limit 经 clampAdminLimit（缺省 50 / 钳 [1,500]，NaN 归缺省）；
   *  - LIMIT n+1 多取 1 条判 has_more 后裁掉（sendHistory 同款技巧）；
   *  - oldest_kept_seq = MIN(seq)（空表 0——D-10 诚实缺口语义，管理页据此
   *    渲染「更早的消息已被清理」分隔线）；
   *  - 行映射复用 rowToMessageFrame：与扇出帧逐字段同构（含 answered 四
   *    字段）——SC3 回复状态零额外映射（新写映射函数即制造双管道漂移）。
   * 全程同步游标 .toArray()/.one() 即收不跨 await（SQL 纪律，Pitfall 9）。
   */
  private handleHistory(url: URL): Response {
    const limit = clampAdminLimit(url.searchParams.get("limit"));
    const beforeRaw = url.searchParams.get("before");
    const beforeParsed = beforeRaw === null ? null : Number(beforeRaw);
    // 非数字 before 归首页（与 limit 的宽松语义对齐——admin 排障入口不报错）。
    const before =
      beforeParsed !== null && !Number.isNaN(beforeParsed) ? beforeParsed : null;

    const oldestRow = this.ctx.storage.sql
      .exec("SELECT MIN(seq) AS m FROM messages")
      .one() as { m: number | null };

    const fetched = (
      before === null
        ? this.ctx.storage.sql.exec(
            `SELECT ${MESSAGE_COLUMNS} FROM messages ORDER BY seq DESC LIMIT ?1`,
            limit + 1,
          )
        : this.ctx.storage.sql.exec(
            `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE seq < ?1 ORDER BY seq DESC LIMIT ?2`,
            before,
            limit + 1,
          )
    ).toArray() as unknown as MessageRow[];
    const hasMore = fetched.length > limit;
    const rows = hasMore ? fetched.slice(0, limit) : fetched;

    return new Response(
      JSON.stringify({
        messages: rows.map(rowToMessageFrame),
        has_more: hasMore,
        oldest_kept_seq: oldestRow.m ?? 0,
      }),
      {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      },
    );
  }

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
    // set 会覆盖未触发的 alarm，Pitfall 7）。后续节奏由调度器单点
    // scheduleNextAlarm 维持（04-02 重构：本判空播种是 publish 专属，全文件
    // 其余 setAlarm 一律收敛到 scheduleNextAlarm——散落 setAlarm 互相覆盖
    // 吞噬事件，Pitfall 1）。
    if (this.readRetentionDue() === null) {
      this.writeRetentionDue(Date.now() + RETENTION_INTERVAL_MS);
    }
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
   * 首先是 WR-02 代际校验（同步 meta 读，见下），accept 成功后立即推送首拉
   * history 帧（最近 INITIAL_FETCH 条，D-09），帧在返回 101 前入队（DO 无
   * waitUntil——响应返回后浮空 Promise 不可靠，同步入队是唯一可靠的首连
   * 推送点）。
   */
  private handleWebSocketUpgrade(request: Request): Response {
    // WR-02 代际校验：meta 落盘的当前 Channel Key（最近一次 kick-all 携带）
    // 与 Worker 转发头（ch: 解析值）不匹配即 401 拒绝——闭合「重置后 ≤60s
    // 缓存窗口内旧 Key 重挂成功后长存」。未重置过的频道无代际（meta 空行）
    // → 放行（Worker 层 KV 预检仍是第一道防线）；代际在而头缺失（部署
    // 演进窗口的旧 Worker）同判不匹配——从严。
    const genRow = this.ctx.storage.sql
      .exec("SELECT v FROM meta WHERE k = ?1", META_KEY_GEN)
      .toArray() as unknown as { v: string }[];
    if (
      genRow.length > 0 &&
      genRow[0].v !== request.headers.get(CHANNEL_KEY_HEADER)
    ) {
      return errorEnvelope(401, "invalid_key", "Missing or invalid credentials.");
    }
    // 04-02 D-47：频道级 meta 落盘（signing_secret / channel_id）——Worker /ws
    // 转发头携带的 KV 权威值。同步 SQL 零 await（升级路径纪律不变，Pitfall 9）。
    this.writeChannelMeta(request);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server);
    // 每连接状态跨休眠存活（serializeAttachment，上限 16,384 字节——本结构极小）。
    // displayName 为最近一次 reply 自报展示名（04-01 D-52——名字跨休眠存活，
    // 后续 reply 默认复用；初始 null = 未报过名）。
    server.serializeAttachment({
      clientId: crypto.randomUUID(),
      connectedAt: Date.now(),
      displayName: null,
    });
    this.sendHistory(server, null, undefined);
    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * 入站业务帧（01-04 + 04-01 reply）：非 string（ArrayBuffer）直接忽略；
   * string 先过 validateInboundFrame（冻结白名单：v:1 / type 枚举 / 各帧
   * 字段结构，任何入站字符串不直接进 SQL，T-01-07）。
   *  - 校验失败 → 回 WsErrorFrame（invalid_version / invalid_frame）后返回，
   *    连接保持（Flagged Assumption SRV-07：服务端忽略坏帧不断连——
   *    "不识别的 v 即断连"是客户端侧职责，D-07）；
   *  - ping → 防御性忽略（auto-response 零唤醒层已按字节匹配拦截，理论上
   *    收不到；键序不同的 ping 帧落进来也不应导致任何状态变化）；
   *  - sync → keyset 补拉（sendHistory）；
   *  - reply → handleReply（04-01 D-45：回复链——域级校验 + answered 落库
   *    + ack 单发 + answered 全连接扇出；三类错误帧均不断连）。
   */
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") {
      return;
    }
    const validation = validateInboundFrame(message);
    if (!validation.ok) {
      this.sendWsError(ws, validation.code, validation.message);
      return;
    }
    const frame = validation.frame;
    if (frame.type === "ping") {
      return;
    }
    if (frame.type === "reply") {
      await this.handleReply(ws, frame);
      return;
    }
    this.sendHistory(ws, frame.since, frame.limit);
  }

  /** 单发一条 WsErrorFrame（结构/域级拒绝共用出口；不断连）。 */
  private sendWsError(ws: WebSocket, code: ErrorCode, message: string): void {
    const errorFrame: WsErrorFrame = {
      v: PROTOCOL_VERSION,
      type: "error",
      code,
      message,
    };
    ws.send(JSON.stringify(errorFrame));
  }

  /**
   * reply 帧处理（04-01，D-42/D-44/D-45/D-46/D-51~D-53 + 04-02 回调尾部）——
   * 竞态关键区（SELECT→校验→UPDATE + ack/answered 发送）全程同步零 await
   * （Pitfall 5：先到者落库对后到者 SELECT 可见，DO 单线程先到先得的唯一
   * 保证）；UPDATE 与帧发送之后的 await 段（回调投递 + alarm 重排）不再影
   * 响竞态正确性：
   *  1. SELECT 目标行（seq/options/answered/callback_url）——无行回
   *     not_found、已置位回 already_replied（D-42 两域级拒绝严格区分，
   *     均不断连）；
   *  2. selected_option 白名单校验（JSON.parse(options) includes——域级，
   *     需读库故不在 shared 纯函数）；不在白名单回 invalid_frame（结构层
   *     同码，D-46 语义）；
   *  3. UPDATE answered 四列（answered=1 + by/at/content）——一次锁定；
   *  4. ack 单发回复者本人（恰 v/type/wid）；
   *  5. answered 帧全连接扇出（handlePublish 同款遍历 + 死连接收集后
   *     close(1011)）——独立帧而非 message 重发是 SeqDedup 硬约束（D-17）；
   *  6. attachment 演进：by 存在时落 displayName（D-52 跨休眠存活）；
   *  7.（04-02）callback_url 非空 → callbacks 入队（body 预序列化恰一次，
   *     D-43 恰首答触发——被拒回复早在 1~3 就 return，永不抵达此处）→
   *     立即 dispatchDueCallbacks（Q5 单路径：即时首投与到期重试同一函数）
   *     → scheduleNextAlarm 单点重排。
   */
  private async handleReply(ws: WebSocket, frame: ReplyFrame): Promise<void> {
    const rows = this.ctx.storage.sql
      .exec(
        "SELECT seq, options, answered, callback_url FROM messages WHERE wid = ?1",
        frame.wid,
      )
      .toArray() as unknown as ReplyTargetRow[];
    const row = rows[0];
    if (row === undefined) {
      this.sendWsError(ws, "not_found", "Message not found.");
      return;
    }
    if (row.answered !== 0) {
      this.sendWsError(ws, "already_replied", "Message already replied.");
      return;
    }
    if (frame.selected_option !== undefined) {
      const options: string[] =
        row.options !== null ? (JSON.parse(row.options) as string[]) : [];
      if (!options.includes(frame.selected_option)) {
        this.sendWsError(
          ws,
          "invalid_frame",
          "selected_option is not one of the message options.",
        );
        return;
      }
    }

    // 一次锁定（D-42）：同步块内 UPDATE——先到者的 answered 落库对后到者
    // 的 SELECT 可见，竞态无双成功的唯一保证。
    const answeredBy = frame.by ?? null;
    const answeredAt = Date.now();
    const answeredContent = frame.selected_option ?? frame.text ?? null;
    this.ctx.storage.sql.exec(
      "UPDATE messages SET answered = 1, answered_by = ?1, answered_at = ?2, answered_content = ?3 WHERE wid = ?4",
      answeredBy,
      answeredAt,
      answeredContent,
      frame.wid,
    );

    // attachment（D-52）：展示名跨休眠存活（by 缺省不动——保留既往自报名）。
    if (frame.by !== undefined) {
      const attachment = ws.deserializeAttachment() as Record<string, unknown> | null;
      ws.serializeAttachment({ ...(attachment ?? {}), displayName: frame.by });
    }

    // ack 单发（恰 v/type/wid）；回复者连接已死也不影响落库与扇出。
    const ack: AckFrame = { v: PROTOCOL_VERSION, type: "ack", wid: frame.wid };
    try {
      ws.send(JSON.stringify(ack));
    } catch {
      // 死连接由下方扇出遍历统一收集清理。
    }

    // answered 全连接扇出（含回复者本人）；answered_content 原文透传
    // （RPL-02 哑管道——渲染消毒是客户端侧职责）。
    const answered: AnsweredFrame = {
      v: PROTOCOL_VERSION,
      type: "answered",
      wid: frame.wid,
      seq: row.seq,
      answered: true,
      answered_by: answeredBy,
      answered_at: answeredAt,
      answered_content: answeredContent,
    };
    const answeredJson = JSON.stringify(answered);
    const dead: WebSocket[] = [];
    for (const target of this.ctx.getWebSockets()) {
      try {
        target.send(answeredJson);
      } catch {
        dead.push(target);
      }
    }
    for (const target of dead) {
      target.close(1011, "send failed");
    }

    // ---- 04-02 回调尾部（D-43/D-49/D-50 + Q5 单路径）----
    // 恰首答触发一次：被拒回复（not_found/already_replied/白名单外）早在
    // 上方 return，永不入队。body 预序列化恰一次存 callbacks.body——重试
    // 永远发送该字符串（Pitfall 4：重序列化的键序漂移会使接收方验签失败）。
    if (row.callback_url !== null) {
      const callbackBody = JSON.stringify({
        message_id: frame.wid,
        reply: answeredContent,
        replied_by: answeredBy,
        replied_at: answeredAt,
        channel_id: this.readMeta(META_KEY_CHANNEL_ID),
      });
      const now = Date.now();
      this.ctx.storage.sql.exec(
        "INSERT OR REPLACE INTO callbacks (wid, url, body, attempts, next_attempt_at, status, created_at) " +
          "VALUES (?1, ?2, ?3, 0, ?4, 'pending', ?5)",
        frame.wid,
        row.callback_url,
        callbackBody,
        now,
        now,
      );
      // 即时首投与到期重试同一条投递函数（竞态面最小）；随后单点重排 alarm。
      await this.dispatchDueCallbacks();
      await this.scheduleNextAlarm();
    }
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

  // ---- 04-02 回调投递与 alarm 多事件单槽调度器 ----

  /**
   * 回调失败记录查询（04-02，D-50/D-58 + Q3 落点）：status='failed' 行按
   * final_failed_at 倒序 LIMIT 50（固定上界，T-04-12 accept 处置）。公网
   * 经 Worker GET /api/callback-failures（Bearer Channel Key 域）鉴权后转发
   * 到此（D-36 /history 转发同款——本路由绝不直连公网，X-PH-Verified 前置
   * + binding 可达性双防线）。响应 {failures: [...]}（照 handleHistory 模式）。
   * 全程同步游标 .toArray() 即收（SQL 纪律，Pitfall 9）。
   */
  private handleCallbackFailures(): Response {
    const failures = this.ctx.storage.sql
      .exec(
        "SELECT wid, url, last_error, attempts, final_failed_at, created_at FROM callbacks " +
          "WHERE status = 'failed' ORDER BY final_failed_at DESC LIMIT 50",
      )
      .toArray() as unknown as {
      wid: string;
      url: string;
      last_error: string | null;
      attempts: number;
      final_failed_at: number | null;
      created_at: number;
    }[];
    return new Response(JSON.stringify({ failures }), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  /** meta 单行读（miss / 值损坏返回 null——调用方各自兜底）。同步 SQL。 */
  private readMeta(key: string): string | null {
    const rows = this.ctx.storage.sql
      .exec("SELECT v FROM meta WHERE k = ?1", key)
      .toArray() as unknown as { v: string }[];
    return rows.length > 0 ? rows[0].v : null;
  }

  /** retention_due 读（缺省/损坏视为已到期——立即补跑一次清理，自愈节奏）。 */
  private readRetentionDue(): number | null {
    const raw = this.readMeta(META_KEY_RETENTION_DUE);
    if (raw === null) {
      return null;
    }
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }

  /** retention_due 写（INSERT ON CONFLICT 覆盖式，kick-all 代际落盘同款）。 */
  private writeRetentionDue(due: number): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO meta (k, v) VALUES (?1, ?2) ON CONFLICT(k) DO UPDATE SET v = ?2",
      META_KEY_RETENTION_DUE,
      String(due),
    );
  }

  /**
   * 回调签名（D-48，approve-contract 定稿）：HMAC-SHA256(secret,
   * timestamp + "." + rawBody) 的 hex。点分隔消除「timestamp 数字与 body 首
   * 字符」的拼接歧义（Stripe 同款）；timestamp 为毫秒数字符串（协议全域
   * 同口径）。每次投递新生成 timestamp + 新签名（重试天然落在接收方容忍窗
   * 内，重放的旧 ts 在窗外被拒——T-04-06）。
   */
  private async signCallback(
    secret: string,
    timestamp: string,
    body: string,
  ): Promise<string> {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      enc.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const mac = await crypto.subtle.sign(
      "HMAC",
      key,
      enc.encode(`${timestamp}.${body}`),
    );
    return [...new Uint8Array(mac)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  /**
   * 到期回调分发（RPL-03/RPL-04 核心，Pattern 3）：SELECT status=pending 且
   * next_attempt_at 已到期的行，逐条 await 处理（量级极小，A3）：
   *  - attempts 先行递增并按新 attempts 预写 next_attempt_at 档位——fetch
   *    中途崩溃按已消耗计（at-least-once，接收方按 message_id 幂等兜底）；
   *  - meta 无 signing_secret（旧频道未补发，Pitfall 8）→ 直接 status=failed
   *    + last_error="no signing secret"——可见可循补发，不静默消失、零外呼；
   *  - 新 timestamp + 新签名 + 行内预序列化 body 发送；resp.ok 即 delivered；
   *    非 2xx 记 last_error 为 HTTP 状态码摘要且响应体 cancel() 释放连接
   *    （不读响应体）；网络异常 catch 记 String(e).slice(0,200)；
   *  - attempts >= CALLBACK_MAX_ATTEMPTS 时置 failed + final_failed_at。
   */
  private async dispatchDueCallbacks(): Promise<void> {
    const now = Date.now();
    const due = this.ctx.storage.sql
      .exec(
        "SELECT wid, url, body, attempts FROM callbacks WHERE status = 'pending' AND next_attempt_at <= ?1",
        now,
      )
      .toArray() as unknown as {
      wid: string;
      url: string;
      body: string;
      attempts: number;
    }[];
    for (const row of due) {
      // attempts 先行递增 + 预写档位（第 5 次尝试无档可取——封顶后由
      // failAttempt 置 failed，next_attempt_at 写 MAX 使其永不再到期）。
      const attempts = row.attempts + 1;
      const delay = CALLBACK_RETRY_DELAYS_MS[attempts - 1];
      this.ctx.storage.sql.exec(
        "UPDATE callbacks SET attempts = ?2, next_attempt_at = ?3 WHERE wid = ?1",
        row.wid,
        attempts,
        delay !== undefined ? now + delay : Number.MAX_SAFE_INTEGER,
      );

      const secret = this.readMeta(META_KEY_SIGNING_SECRET);
      if (secret === null) {
        this.ctx.storage.sql.exec(
          "UPDATE callbacks SET status = 'failed', final_failed_at = ?2, last_error = ?3 WHERE wid = ?1",
          row.wid,
          Date.now(),
          "no signing secret",
        );
        continue;
      }

      try {
        const ts = String(Date.now());
        const signature = await this.signCallback(secret, ts, row.body);
        const resp = await fetch(row.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "PushHub-Message-Id": row.wid,
            "PushHub-Timestamp": ts,
            "PushHub-Signature": signature,
          },
          body: row.body,
        });
        if (resp.ok) {
          this.ctx.storage.sql.exec(
            "UPDATE callbacks SET status = 'delivered' WHERE wid = ?1",
            row.wid,
          );
          continue;
        }
        this.recordCallbackFailure(row.wid, attempts, `HTTP ${resp.status}`);
        // 不读响应体——cancel 释放连接（官方最佳实践，T-04-08）。
        if (resp.body !== null) {
          await resp.body.cancel();
        }
      } catch (e) {
        this.recordCallbackFailure(row.wid, attempts, String(e).slice(0, 200));
      }
    }
  }

  /** 单次失败落账：记 last_error；attempts 达封顶置 failed + final_failed_at。 */
  private recordCallbackFailure(
    wid: string,
    attempts: number,
    errorSummary: string,
  ): void {
    if (attempts >= CALLBACK_MAX_ATTEMPTS) {
      this.ctx.storage.sql.exec(
        "UPDATE callbacks SET status = 'failed', final_failed_at = ?2, last_error = ?3 WHERE wid = ?1",
        wid,
        Date.now(),
        errorSummary,
      );
    } else {
      this.ctx.storage.sql.exec(
        "UPDATE callbacks SET last_error = ?2 WHERE wid = ?1",
        wid,
        errorSummary,
      );
    }
  }

  /**
   * alarm 单点重排（Pitfall 1 根治，Pattern 2 官方多事件单槽模式）：
   * setAlarm(min(最早到期重试, retention_due))——无 pending 重试时取
   * retention_due（恒存在语义，见下）；retention_due 缺省视为已到期
   * （now → 立即补跑清理）。max(next, now+1) 防 setAlarm 过去时刻报错。
   * 本方法与 publish 判空播种点是全文件仅有的 setAlarm 调用点。
   */
  private async scheduleNextAlarm(): Promise<void> {
    const nextRetryRow = this.ctx.storage.sql
      .exec(
        "SELECT MIN(next_attempt_at) AS m FROM callbacks WHERE status = 'pending'",
      )
      .one() as { m: number | null };
    const next = Math.min(
      nextRetryRow.m ?? Number.MAX_SAFE_INTEGER,
      this.readRetentionDue() ?? Date.now(),
    );
    await this.ctx.storage.setAlarm(Math.max(next, Date.now() + 1));
  }

  /**
   * alarm 双职责调度器（04-02 重构，原 D-08 单职责语义零漂移地搬入到期分支）：
   *  1. dispatchDueCallbacks()——到期回调重试（D-50）；
   *  2. retention_due 到期（缺省视为到期，立即补跑）→ D-08 原清理 SQL +
   *     retention_due = now + RETENTION_INTERVAL_MS 推进；
   *  - catch 吞异常保节奏（alarm 自带重试仅 6 次即放弃——自 catch 才能保住
   *    每日节奏；回调行 attempts 语义自带幂等，异常留给下一次 alarm 重试）；
   *  - finally 单点重排 scheduleNextAlarm()（取代旧的尾部无条件 +24h——
   *    单职责时代的正确模式在双职责下会吞噬分钟级重试档位，Pitfall 1）。
   */
  async alarm(): Promise<void> {
    try {
      await this.dispatchDueCallbacks();
      const now = Date.now();
      if (now >= (this.readRetentionDue() ?? 0)) {
        this.ctx.storage.sql.exec(
          "DELETE FROM messages WHERE seq <= (SELECT MAX(seq) - ?1 FROM messages)",
          RETENTION_KEEP,
        );
        this.ctx.storage.sql.exec(
          "DELETE FROM rate_sends WHERE window_start < ?1",
          now - RETENTION_INTERVAL_MS,
        );
        this.writeRetentionDue(now + RETENTION_INTERVAL_MS);
      }
    } catch {
      // 吞异常：清理/分发失败不阻断重排节奏；数据幂等（下次同条件重做）。
    } finally {
      await this.scheduleNextAlarm();
    }
  }
}
