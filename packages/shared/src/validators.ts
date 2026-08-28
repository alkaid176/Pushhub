/**
 * 纯函数校验器（01-02 冻结）——零运行时依赖，可被 server 与未来 SDK 复用。
 *
 * 职责边界：
 *  - validateSendBody：/api/send 请求体（D-02 全部上限 + D-04 枚举 + 结构检查）。
 *    长度一律按 JS string.length（UTF-16 码元）判定；超限 413、结构/类型/枚举
 *    违例 400；未知字段一律忽略不报错（D-07 演进规则）。
 *  - validateInboundFrame：WS 入站客户端帧（ping/sync/reply）的结构与版本
 *    检查，供 webSocketMessage 处理器使用（reply 分支 04-01 新增——结构层
 *    恰一/长度校验；白名单等域级校验在 DO）。
 *
 * 所有阈值经 index.ts 常量引用，本文件不出现裸数字阈值（可移植性禁令：
 * 上限变更只改 index.ts，四端常量同源）。
 */
import {
  BY_MAX,
  LIMITS,
  PROTOCOL_VERSION,
  SYNC_LIMIT_MAX,
  type ClientFrame,
  type Priority,
  type ReplyFrame,
} from "./index";

/** validateSendBody 归一化结果：可选字段经省略语义归一（空数组/缺省/null → 不出现）。 */
export interface NormalizedSendBody {
  title?: string;
  text: string;
  priority: Priority;
  options?: string[];
  callback_url?: string;
  click_url?: string;
}

/** validateSendBody 结果判别联合。 */
export type SendBodyValidation =
  | { ok: true; normalized: NormalizedSendBody }
  | {
      ok: false;
      status: 400 | 413;
      code: "invalid_body" | "invalid_json" | "payload_too_large";
      message: string;
    };

/** validateInboundFrame 结果判别联合（供 01-04 消费解析后的帧）。 */
export type InboundFrameValidation =
  | { ok: true; frame: ClientFrame }
  | {
      ok: false;
      code: "invalid_frame" | "invalid_version";
      message: string;
    };

/** D-04 三档枚举（枚举匹配，非自由字符串）。 */
const PRIORITIES: readonly Priority[] = ["low", "normal", "high"];

// TextDecoder 是 Web 标准（Workers / 浏览器 / Node>=11 均内置），但不在
// ESNext 类型库中；此处声明模块级最小 ambient 类型，避免为运行时无关的
// 契约包引入整个 DOM lib。
declare const TextDecoder: {
  new (label?: string): { decode(input: ArrayBuffer): string };
};

function invalidBody(message: string): SendBodyValidation {
  return { ok: false, status: 400, code: "invalid_body", message };
}

function tooLarge(field: string, max: number): SendBodyValidation {
  return {
    ok: false,
    status: 413,
    code: "payload_too_large",
    message: `Field '${field}' exceeds the maximum length of ${max} characters.`,
  };
}

function invalidFrame(): InboundFrameValidation {
  return {
    ok: false,
    code: "invalid_frame",
    message: "Malformed frame: not a recognized v:1 client frame.",
  };
}

/**
 * 校验 /api/send 请求体。
 *
 * 入参两种形态：已解析的 unknown（对象）或原始 JSON 字符串
 * （入口可直接传 `await request.text()`；解析失败 → invalid_json）。
 *
 * 省略语义（SRV-02 边界）：可选字段的 null 与缺省均视为未提供、不报错；
 * options 空数组归一为 undefined（存储 NULL、帧中不出现该字段），
 * 单元素数组合法。
 */
export function validateSendBody(body: unknown): SendBodyValidation {
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      return {
        ok: false,
        status: 400,
        code: "invalid_json",
        message: "Request body must be valid JSON.",
      };
    }
  }

  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return invalidBody("Request body must be a JSON object.");
  }
  const raw = body as Record<string, unknown>;

  // text：必填 string（长度按 UTF-16 码元，D-02）。
  if (typeof raw.text !== "string") {
    return invalidBody("Field 'text' is required and must be a string.");
  }
  if (raw.text.length > LIMITS.TEXT_MAX) {
    return tooLarge("text", LIMITS.TEXT_MAX);
  }

  // title：可选 string；null/缺省视为未提供。
  let title: string | undefined;
  if (raw.title !== undefined && raw.title !== null) {
    if (typeof raw.title !== "string") {
      return invalidBody("Field 'title' must be a string.");
    }
    if (raw.title.length > LIMITS.TITLE_MAX) {
      return tooLarge("title", LIMITS.TITLE_MAX);
    }
    title = raw.title;
  }

  // options：可选 string[]；null/缺省/空数组归一为省略。
  let options: string[] | undefined;
  if (raw.options !== undefined && raw.options !== null) {
    if (!Array.isArray(raw.options)) {
      return invalidBody("Field 'options' must be an array of strings.");
    }
    if (raw.options.length > LIMITS.OPTIONS_MAX_COUNT) {
      return {
        ok: false,
        status: 413,
        code: "payload_too_large",
        message: `Field 'options' exceeds the maximum of ${LIMITS.OPTIONS_MAX_COUNT} items.`,
      };
    }
    for (const item of raw.options) {
      if (typeof item !== "string") {
        return invalidBody("Field 'options' must contain only strings.");
      }
      if (item.length > LIMITS.OPTIONS_ITEM_MAX) {
        return tooLarge("options item", LIMITS.OPTIONS_ITEM_MAX);
      }
    }
    if (raw.options.length > 0) {
      options = raw.options;
    }
  }

  // callback_url / click_url：可选 string，共用 URL_MAX 上限；null/缺省视为未提供。
  // callback_url 额外受 scheme 白名单约束（04-02，Pitfall 6 SSRF 面收窄）：
  // 它是服务端 DO 外呼 fetch 的发送方可控目标——非空时必须以 http:// 或
  // https:// 开头（严格小写匹配，协议字面量口径）。click_url 是客户端展示
  // 链接、服务端不 fetch，不适用本白名单。
  let callbackUrl: string | undefined;
  if (raw.callback_url !== undefined && raw.callback_url !== null) {
    if (typeof raw.callback_url !== "string") {
      return invalidBody("Field 'callback_url' must be a string.");
    }
    if (raw.callback_url.length > LIMITS.URL_MAX) {
      return tooLarge("callback_url", LIMITS.URL_MAX);
    }
    if (
      raw.callback_url !== "" &&
      !raw.callback_url.startsWith("http://") &&
      !raw.callback_url.startsWith("https://")
    ) {
      return invalidBody(
        "Field 'callback_url' must use the http:// or https:// scheme.",
      );
    }
    callbackUrl = raw.callback_url;
  }
  let clickUrl: string | undefined;
  if (raw.click_url !== undefined && raw.click_url !== null) {
    if (typeof raw.click_url !== "string") {
      return invalidBody("Field 'click_url' must be a string.");
    }
    if (raw.click_url.length > LIMITS.URL_MAX) {
      return tooLarge("click_url", LIMITS.URL_MAX);
    }
    clickUrl = raw.click_url;
  }

  // priority：三枚举之一（D-04 枚举匹配）；null/缺省填 normal。
  let priority: Priority = "normal";
  if (raw.priority !== undefined && raw.priority !== null) {
    if (
      typeof raw.priority !== "string" ||
      !PRIORITIES.includes(raw.priority as Priority)
    ) {
      return invalidBody(
        "Field 'priority' must be one of: low, normal, high.",
      );
    }
    priority = raw.priority as Priority;
  }

  // 未知字段一律忽略（D-07）；归一结果只含协议字段。
  const normalized: NormalizedSendBody = { text: raw.text, priority };
  if (title !== undefined) {
    normalized.title = title;
  }
  if (options !== undefined) {
    normalized.options = options;
  }
  if (callbackUrl !== undefined) {
    normalized.callback_url = callbackUrl;
  }
  if (clickUrl !== undefined) {
    normalized.click_url = clickUrl;
  }
  return { ok: true, normalized };
}

/**
 * 校验 WS 入站客户端帧（ping / sync）。
 *
 * 检查顺序：JSON 解析（失败 → invalid_frame）→ v 版本（不等于
 * PROTOCOL_VERSION → invalid_version）→ type 与 sync 字段结构（→ invalid_frame）。
 * 未知字段忽略（D-07）。
 *
 * 注意（Flagged Assumption，SRV-07）：服务端收到 v 不匹配的业务帧时
 * 回 WsErrorFrame 并忽略该帧、不断连——"不识别的 v 即断连"是客户端侧
 * 职责（D-07 原文）；01-04 按此处理。
 */
export function validateInboundFrame(
  raw: string | ArrayBuffer,
): InboundFrameValidation {
  let text: string;
  if (typeof raw === "string") {
    text = raw;
  } else {
    try {
      text = new TextDecoder().decode(raw);
    } catch {
      return invalidFrame();
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return invalidFrame();
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed)
  ) {
    return invalidFrame();
  }
  const frame = parsed as Record<string, unknown>;

  // 版本先行（D-07）：v 缺失或非 1 均为版本错误。
  if (frame.v !== PROTOCOL_VERSION) {
    return {
      ok: false,
      code: "invalid_version",
      message: `Unsupported protocol version: expected ${PROTOCOL_VERSION}.`,
    };
  }

  if (frame.type === "ping") {
    return { ok: true, frame: { v: PROTOCOL_VERSION, type: "ping" } };
  }

  if (frame.type === "sync") {
    const since = frame.since;
    if (
      since !== null &&
      (typeof since !== "number" ||
        !Number.isInteger(since) ||
        since < 0)
    ) {
      return invalidFrame();
    }
    const limit = frame.limit;
    if (limit !== undefined && limit !== null) {
      if (
        typeof limit !== "number" ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > SYNC_LIMIT_MAX
      ) {
        return invalidFrame();
      }
      return {
        ok: true,
        frame: { v: PROTOCOL_VERSION, type: "sync", since, limit },
      };
    }
    return { ok: true, frame: { v: PROTOCOL_VERSION, type: "sync", since } };
  }

  // reply 分支（04-01 D-45/D-46/D-53，结构层）：wid 非空 string；
  // selected_option 与 text 恰提供其一（null 与缺省均视为未提供——省略语义
  // 与 SRV-02 同源）；两者长度同受 LIMITS.TEXT_MAX 约束；by 可缺省，
  // 上限 BY_MAX。selected_option 是否在原消息 options 白名单内**不在本
  // 纯函数**——需读库，属 DO 域级校验（D-46 分层）。
  if (frame.type === "reply") {
    const wid = frame.wid;
    if (typeof wid !== "string" || wid.length === 0) {
      return invalidFrame();
    }
    const optionProvided =
      frame.selected_option !== undefined && frame.selected_option !== null;
    const textProvided = frame.text !== undefined && frame.text !== null;
    if (optionProvided === textProvided) {
      // 同真（都提供）或同假（都不提供）——恰一违例（D-46）。
      return invalidFrame();
    }
    if (
      optionProvided &&
      (typeof frame.selected_option !== "string" ||
        frame.selected_option.length > LIMITS.TEXT_MAX)
    ) {
      return invalidFrame();
    }
    if (
      textProvided &&
      (typeof frame.text !== "string" || frame.text.length > LIMITS.TEXT_MAX)
    ) {
      return invalidFrame();
    }
    let by: string | undefined;
    if (frame.by !== undefined && frame.by !== null) {
      if (typeof frame.by !== "string" || frame.by.length > BY_MAX) {
        return invalidFrame();
      }
      by = frame.by;
    }
    const reply: ReplyFrame = { v: PROTOCOL_VERSION, type: "reply", wid };
    if (optionProvided) {
      reply.selected_option = frame.selected_option as string;
    } else {
      reply.text = frame.text as string;
    }
    if (by !== undefined) {
      reply.by = by;
    }
    return { ok: true, frame: reply };
  }

  return invalidFrame();
}
