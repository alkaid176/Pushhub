/**
 * @pushhub/shared — PushHub v1 线协议唯一事实源（冻结版，01-02）。
 *
 * 本文件是四端（TS 服务端 / Web SDK / Rust 桌面 / Kotlin 安卓）的协议契约：
 * 全部 WS 帧类型、/api/send 请求体与响应、错误码枚举、上限与窗口常量。
 * golden fixtures 见 packages/shared/fixtures/（正反例逐字节冻结）。
 *
 * D-07 协议演进规则（冻结后生效，详见 README.md）：
 *  - 所有 WS 帧顶层带 v:1（整数递增）
 *  - 只加字段不改语义；未知字段必须忽略（Rust serde 禁用 deny_unknown_fields）
 *  - 客户端不识别的 v 即断连报错
 *
 * 注意：KV 键前缀（ch:/sk:/id:）是服务端实现细节而非线协议——
 * 唯一来源为 packages/server/src/keys.ts，不上提到本包。
 */

/** 线协议版本（D-07）：所有 WS 帧顶层 `v` 字段的当前值。 */
export const PROTOCOL_VERSION = 1;

/**
 * D-02 消息体大小上限（宽松档）。长度一律按 JS string.length
 * （UTF-16 码元）判定——不按字节、码点或字素簇；超限 413。
 */
export const LIMITS = {
  /** text 最大长度（32KB 档）。 */
  TEXT_MAX: 32768,
  /** title 最大长度。 */
  TITLE_MAX: 256,
  /** options 最多项数。 */
  OPTIONS_MAX_COUNT: 4,
  /** options 单项最大长度。 */
  OPTIONS_ITEM_MAX: 64,
  /** callback_url / click_url 最大长度。 */
  URL_MAX: 2048,
} as const;

/** D-08 每频道保留窗口：最近 500 条（alarm 每日批量清理）。 */
export const RETENTION_KEEP = 500;

/** D-09 新客户端首次连接（since: null）默认拉取的最近消息条数。 */
export const INITIAL_FETCH = 50;

/** D-11 sync 补拉 limit 缺省值。 */
export const SYNC_LIMIT_DEFAULT = 200;

/** D-11 sync 补拉 limit 上限（一次拉不完以 has_more 翻页）。 */
export const SYNC_LIMIT_MAX = 500;

/** KEY-05 每 Send Key 每分钟限发条数（可配置常量，默认 30，超限 429）。 */
export const RATE_LIMIT_PER_MIN = 30;

/** KEY-05 固定窗口长度（毫秒，60 秒）。窗口滚动后计数重置；阈值/窗口改动只改本文件。 */
export const RATE_WINDOW_MS = 60_000;

/** D-05 对外消息 ID（wid）前缀：m_ 表消息。 */
export const WID_PREFIX = "m_";

/** D-05 wid 随机段长度（前缀后 16 字符，URL 安全不可猜测）。 */
export const WID_LENGTH = 16;

/** 消息优先级三档枚举（D-04），缺省 normal。 */
export type Priority = "low" | "normal" | "high";

/**
 * 错误码枚举（D-06）。
 * HTTP 侧（错误信封）：invalid_key / payload_too_large / rate_limited /
 *   invalid_body / invalid_json / server_error；
 * WS 帧侧（WsErrorFrame）：invalid_frame / invalid_version。
 */
export type ErrorCode =
  | "invalid_key"
  | "payload_too_large"
  | "rate_limited"
  | "invalid_body"
  | "invalid_json"
  | "server_error"
  | "invalid_frame"
  | "invalid_version";

/**
 * v:1 message 帧（D-03 字段集一次定全，与 messages 表 13 列一一对应）。
 * wid：对外消息 ID（m_ + 16 字符，D-05）；
 * seq：频道内单调游标（补拉与幂等去重的依据，D-05 职责分离）；
 * answered 四字段 Phase 1 恒为初始值（false / null），Phase 4 只加逻辑不改 schema；
 * options / callback_url / click_url 未提供时字段不出现（省略语义，永不为空数组）。
 */
export interface MessageFrame {
  v: typeof PROTOCOL_VERSION;
  type: "message";
  wid: string;
  seq: number;
  title?: string;
  text: string;
  options?: string[];
  callback_url?: string;
  click_url?: string;
  priority: Priority;
  answered: boolean;
  answered_by: string | null;
  answered_at: number | null;
  answered_content: string | null;
  created_at: number;
}

/** v:1 ping 帧（客户端心跳；经 setWebSocketAutoResponse 零唤醒自动回 pong）。 */
export interface PingFrame {
  v: typeof PROTOCOL_VERSION;
  type: "ping";
}

/** v:1 pong 帧（服务端 auto-response 自动回帧，不唤醒 DO）。 */
export interface PongFrame {
  v: typeof PROTOCOL_VERSION;
  type: "pong";
}

/**
 * v:1 sync 帧（客户端 → 服务端补拉请求，D-11：补拉全部走 WS）。
 * since: null 表示首次连接（服务端按 INITIAL_FETCH 拉最近消息）；
 * since: n 表示拉 seq > n 的增量；limit 缺省 SYNC_LIMIT_DEFAULT。
 */
export interface SyncFrame {
  v: typeof PROTOCOL_VERSION;
  type: "sync";
  since: number | null;
  limit?: number;
}

/** 客户端 → 服务端帧全集（当前 v:1 仅 ping / sync 两种）。 */
export type ClientFrame = PingFrame | SyncFrame;

/**
 * v:1 history 帧（服务端 → 客户端补拉响应，D-10/D-11）。
 * messages 按 seq 升序；oldest_kept_seq 为频道现存最老 seq——
 * 客户端发现请求的 since < oldest_kept_seq 时呈现"更早消息已清理"
 * 分隔线，不报错不断连（保留窗口缺口语义）；
 * has_more: true 表示一次未拉完，客户端续翻。
 */
export interface HistoryFrame {
  v: typeof PROTOCOL_VERSION;
  type: "history";
  messages: MessageFrame[];
  oldest_kept_seq: number;
  has_more: boolean;
}

/** v:1 error 帧（WS 侧错误：invalid_frame / invalid_version）。 */
export interface WsErrorFrame {
  v: typeof PROTOCOL_VERSION;
  type: "error";
  code: ErrorCode;
  message: string;
}

/** 服务端 → 客户端帧全集。 */
export type ServerFrame = MessageFrame | HistoryFrame | PongFrame | WsErrorFrame;

/** D-06 HTTP 错误信封（结构冻结：{"error":{"code":"...","message":"..."}}）。 */
export interface ErrorEnvelope {
  error: {
    code: ErrorCode;
    message: string;
  };
}

/** POST /api/send 请求体（发送方言文案；可选字段未提供时不出现）。 */
export interface SendBody {
  title?: string;
  text: string;
  priority?: Priority;
  options?: string[];
  callback_url?: string;
  click_url?: string;
}

/** POST /api/send 成功响应体。id 即 wid（D-05）。 */
export interface SendResult {
  id: string;
  seq: number;
}
