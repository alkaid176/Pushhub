/**
 * parseServerFrame —— WS 接收侧帧 guard（02-01，D-07 客户端侧职责；04-03 扩
 * answered/ack 分支）。
 *
 * 职责边界（与 @pushhub/shared/validators.ts 的 validateInboundFrame 方向镜像）：
 *  - 服务端 → 客户端帧（message/history/pong/error/answered/ack）的结构与
 *    版本检查；
 *  - 版本先行：帧顶层 v !== PROTOCOL_VERSION（含缺失）→ fatal（断连不重连，
 *    D-07："客户端不识别的 v 即断连报错"——服务端比客户端新，重连无意义；
 *    方向对照：服务端收到坏帧只回 WsErrorFrame 不断连，chat-room.ts 注释）；
 *  - 未知 type → 非致命丢弃（D-07 前瞻兼容：只加字段/类型不改语义）；
 *  - 已知 type 的结构违例 → 非致命丢弃（坏帧不毒害连接）；
 *  - 未知字段一律忽略（D-07，如 fixtures 的 _note 元数据）。
 *
 * 帧类型与协议常量一律 import 自 @pushhub/shared（冻结契约单一来源，
 * 包内零复制定义——复制即协议漂移，违反 01-02 冻结契约）。
 */
import { PROTOCOL_VERSION, type ServerFrame } from "@pushhub/shared";

/** parseServerFrame 结果判别联合（仓库统一 ok/code|fatal/message 风格）。 */
export type FrameResult =
  | { ok: true; frame: ServerFrame }
  | { ok: false; fatal: boolean; message: string };

/** D-04 优先级三档枚举的运行时校验表（结构检查用，非线协议常量）。 */
const PRIORITIES: readonly string[] = ["low", "normal", "high"];

function drop(message: string): FrameResult {
  return { ok: false, fatal: false, message };
}

function fatal(message: string): FrameResult {
  return { ok: false, fatal: true, message };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 可选字符串字段：缺省或 string 均合法（省略语义）。 */
function optionalString(v: unknown): boolean {
  return v === undefined || typeof v === "string";
}

/** 可选 string[] 字段。 */
function optionalStringArray(v: unknown): boolean {
  if (v === undefined) return true;
  if (!Array.isArray(v)) return false;
  return v.every((item) => typeof item === "string");
}

function isStringOrNull(v: unknown): boolean {
  return v === null || typeof v === "string";
}

function isIntegerOrNull(v: unknown): boolean {
  return v === null || (typeof v === "number" && Number.isInteger(v));
}

/**
 * MessageFrame 结构深校验（冻结 13 字段集，D-03）。v 检查内含——history.messages
 * 的元素必须各自带 v:1（golden 反例：元素缺 v 即 malformed）。
 */
function isMessageShape(v: unknown): boolean {
  if (!isObject(v)) return false;
  if (v.v !== PROTOCOL_VERSION) return false;
  if (typeof v.wid !== "string" || v.wid.length === 0) return false;
  if (typeof v.seq !== "number" || !Number.isInteger(v.seq) || v.seq < 1) {
    return false;
  }
  if (!optionalString(v.title)) return false;
  if (typeof v.text !== "string") return false;
  if (!optionalStringArray(v.options)) return false;
  if (!optionalString(v.callback_url) || !optionalString(v.click_url)) {
    return false;
  }
  if (typeof v.priority !== "string" || !PRIORITIES.includes(v.priority)) {
    return false;
  }
  if (typeof v.answered !== "boolean") return false;
  if (!isStringOrNull(v.answered_by)) return false;
  if (!isIntegerOrNull(v.answered_at)) return false;
  if (!isStringOrNull(v.answered_content)) return false;
  if (typeof v.created_at !== "number" || !Number.isInteger(v.created_at)) {
    return false;
  }
  if (v.type !== "message") return false;
  return true;
}

/** HistoryFrame 结构深校验（messages 数组 + oldest_kept_seq + has_more）。 */
function isHistoryShape(v: Record<string, unknown>): boolean {
  if (!Array.isArray(v.messages)) return false;
  if (!v.messages.every((m) => isMessageShape(m))) return false;
  if (
    typeof v.oldest_kept_seq !== "number" ||
    !Number.isInteger(v.oldest_kept_seq) ||
    v.oldest_kept_seq < 0
  ) {
    return false;
  }
  if (typeof v.has_more !== "boolean") return false;
  return true;
}

/** WsErrorFrame 结构校验（code/message 双 string）。 */
function isErrorShape(v: Record<string, unknown>): boolean {
  return typeof v.code === "string" && typeof v.message === "string";
}

/**
 * AnsweredFrame 结构深校验（04-01 冻结字段集，04-03 SDK 侧消费——照
 * isMessageShape 逐字段检查，未知字段忽略照 D-07）。answered 恒 true 的
 * 语义由服务端保证（字段留给未来撤答扩展的形态稳定，D-45），守卫按冻结
 * 形态查 boolean。answered_at 为非空 number（帧只在成功回复后发射，
 * approve-freeze 裁量点 3）。
 */
function isAnsweredShape(v: Record<string, unknown>): boolean {
  if (v.v !== PROTOCOL_VERSION) return false;
  if (v.type !== "answered") return false;
  if (typeof v.wid !== "string") return false;
  if (typeof v.seq !== "number" || !Number.isInteger(v.seq) || v.seq < 0) {
    return false;
  }
  if (typeof v.answered !== "boolean") return false;
  if (!isStringOrNull(v.answered_by)) return false;
  if (typeof v.answered_at !== "number") return false;
  if (!isStringOrNull(v.answered_content)) return false;
  return true;
}

/**
 * 解析服务端入站帧。
 *
 * 分流三档：
 *  - ok:true    合法 ServerFrame（未知字段保留在对象上但消费侧只读协议字段）；
 *  - ok:false + fatal:true   v 不匹配（D-07 客户端断连不重连）；
 *  - ok:false + fatal:false  不可解析 / 非对象 / 未知 type / 结构违例 → 丢弃。
 */
export function parseServerFrame(raw: string): FrameResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return drop("unparseable frame");
  }
  if (!isObject(parsed)) {
    return drop("non-object frame");
  }

  // 版本先行（D-07）：v 缺失或不等于当前版本均为版本错误——fatal。
  if (parsed.v !== PROTOCOL_VERSION) {
    return fatal(`unsupported protocol version: ${String(parsed.v)}`);
  }

  switch (parsed.type) {
    case "message":
      return isMessageShape(parsed)
        ? { ok: true, frame: parsed as unknown as ServerFrame }
        : drop("malformed message frame");
    case "history":
      return isHistoryShape(parsed)
        ? { ok: true, frame: parsed as unknown as ServerFrame }
        : drop("malformed history frame");
    case "pong":
      return { ok: true, frame: parsed as unknown as ServerFrame };
    case "answered":
      return isAnsweredShape(parsed)
        ? { ok: true, frame: parsed as unknown as ServerFrame }
        : drop("malformed answered frame");
    case "ack":
      // 宽松直通照 pong 模式（04-01 Q4）：恰查 v/type/wid 三键——v 已由
      // 版本门检查、type 已由 switch 匹配，此处只查 wid 为 string。
      return typeof parsed.wid === "string"
        ? { ok: true, frame: parsed as unknown as ServerFrame }
        : drop("malformed ack frame");
    case "error":
      return isErrorShape(parsed)
        ? { ok: true, frame: parsed as unknown as ServerFrame }
        : drop("malformed error frame");
    default:
      // 未知 type：D-07 前瞻兼容，非致命丢弃。
      return drop(`unknown frame type: ${String(parsed.type)}`);
  }
}
