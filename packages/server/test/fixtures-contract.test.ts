/**
 * golden fixtures 逐字节契约测试（01-02 Task 3，SRV-07 / D-06 / Pitfall 10）。
 *
 * fixtures 是四端契约基线：本文件以严格相等与全键断言锁定其结构
 * （排序后 Object.keys toEqual 期望数组 + 逐字段精确断言），
 * 全文件禁止一切子集匹配式宽松断言（部分对象匹配 / 子串包含 /
 * 通配类型期望等——golden 的意义在逐字节冻结，只用严格相等与全键断言）。
 *
 * 反例闭环：message 反例驱动 validateSendBody、sync 反例驱动
 * validateInboundFrame，拒绝 code 与 _violation 元数据尾段逐例匹配；
 * history 反例由本文件的结构检查器拒绝（服务端发射帧无入站校验器）。
 *
 * fixtures 经 workspace 静态 import（resolveJsonModule）——
 * 编译期依赖而非运行时读取。
 */
import { describe, expect, it } from "vitest";

import {
  INITIAL_FETCH,
  LIMITS,
  PROTOCOL_VERSION,
  SYNC_LIMIT_MAX,
} from "@pushhub/shared";
import {
  validateInboundFrame,
  validateSendBody,
} from "@pushhub/shared/validators";

import envelopeInvalidBody from "@pushhub/shared/fixtures/error-envelope.invalid-body.json";
import envelopeInvalidKey from "@pushhub/shared/fixtures/error-envelope.invalid-key.json";
import envelopePayloadTooLarge from "@pushhub/shared/fixtures/error-envelope.payload-too-large.json";
import envelopeRateLimited from "@pushhub/shared/fixtures/error-envelope.rate-limited.json";
import historyFrameNegative from "@pushhub/shared/fixtures/history-frame.negative.json";
import historyFramePositive from "@pushhub/shared/fixtures/history-frame.positive.json";
import messageFrameNegative from "@pushhub/shared/fixtures/message-frame.negative.json";
import messageFramePositive from "@pushhub/shared/fixtures/message-frame.positive.json";
import pongFramePositive from "@pushhub/shared/fixtures/pong-frame.positive.json";
import syncFrameNegative from "@pushhub/shared/fixtures/sync-frame.negative.json";
import syncFramePositive from "@pushhub/shared/fixtures/sync-frame.positive.json";
import wsErrorFrame from "@pushhub/shared/fixtures/ws-error-frame.json";

type Json = Record<string, unknown>;

/** MessageFrame 必需键（冻结全集，排序无关地逐键存在性断言）。 */
const MESSAGE_REQUIRED_KEYS = [
  "answered", "answered_at", "answered_by", "answered_content",
  "created_at", "priority", "seq", "text", "type", "v", "wid",
] as const;
/** MessageFrame 可选键（省略语义：未提供时不出现）。 */
const MESSAGE_OPTIONAL_KEYS = ["callback_url", "click_url", "options", "title"] as const;

/**
 * HistoryFrame 正例结构检查器（含逐条 MessageFrame 检查）——
 * history 为服务端发射帧、无入站校验器，契约由本检查器锁定；
 * 反例断言本检查器对其抛出。
 */
function assertValidMessageFrame(msg: Json): void {
  for (const key of MESSAGE_REQUIRED_KEYS) {
    expect(msg[key] !== undefined, `message missing key: ${key}`).toBe(true);
  }
  expect(msg.v).toBe(PROTOCOL_VERSION);
  expect(msg.type).toBe("message");
  expect(typeof msg.wid).toBe("string");
  expect((msg.wid as string).startsWith("m_")).toBe(true);
  expect((msg.wid as string).length).toBe("m_".length + 16);
  expect(Number.isInteger(msg.seq)).toBe(true);
  expect((msg.seq as number) > 0).toBe(true);
  expect(typeof msg.text).toBe("string");
  expect((msg.text as string).length <= LIMITS.TEXT_MAX).toBe(true);
  expect(typeof msg.priority).toBe("string");
  expect(["low", "normal", "high"].includes(msg.priority as string)).toBe(true);
  expect(typeof msg.answered).toBe("boolean");
  expect(msg.answered_by === null || typeof msg.answered_by === "string").toBe(true);
  expect(msg.answered_at === null || Number.isInteger(msg.answered_at)).toBe(true);
  expect(
    msg.answered_content === null || typeof msg.answered_content === "string",
  ).toBe(true);
  expect(Number.isInteger(msg.created_at)).toBe(true);
  if (msg.options !== undefined) {
    expect(Array.isArray(msg.options)).toBe(true);
    const options = msg.options as unknown[];
    // 省略语义冻结：帧中 options 一旦出现必为非空数组（永不为空数组）
    expect(options.length > 0).toBe(true);
    expect(options.length <= LIMITS.OPTIONS_MAX_COUNT).toBe(true);
    for (const item of options) {
      expect(typeof item).toBe("string");
      expect((item as string).length <= LIMITS.OPTIONS_ITEM_MAX).toBe(true);
    }
  }
  if (msg.title !== undefined) {
    expect(typeof msg.title).toBe("string");
    expect((msg.title as string).length <= LIMITS.TITLE_MAX).toBe(true);
  }
  if (msg.callback_url !== undefined) {
    expect(typeof msg.callback_url).toBe("string");
    expect((msg.callback_url as string).length <= LIMITS.URL_MAX).toBe(true);
  }
  if (msg.click_url !== undefined) {
    expect(typeof msg.click_url).toBe("string");
    expect((msg.click_url as string).length <= LIMITS.URL_MAX).toBe(true);
  }
  // 键集恰好冻结：正例不得含协议外键（防 fixture 自身漂移；_ 前缀是元数据）
  const allowed = new Set<string>([...MESSAGE_REQUIRED_KEYS, ...MESSAGE_OPTIONAL_KEYS]);
  for (const key of Object.keys(msg)) {
    expect(allowed.has(key), `unexpected key in message fixture: ${key}`).toBe(true);
  }
}

function assertValidHistoryFrame(frame: Json): void {
  expect(frame.v).toBe(PROTOCOL_VERSION);
  expect(frame.type).toBe("history");
  expect(Array.isArray(frame.messages)).toBe(true);
  const messages = frame.messages as Json[];
  let prevSeq = 0;
  for (const msg of messages) {
    assertValidMessageFrame(msg);
    const seq = msg.seq as number;
    expect(seq > prevSeq, "history messages must be seq-ascending").toBe(true);
    prevSeq = seq;
  }
  expect(Number.isInteger(frame.oldest_kept_seq)).toBe(true);
  expect(typeof frame.has_more).toBe("boolean");
  const allowed = new Set(["v", "type", "messages", "oldest_kept_seq", "has_more"]);
  for (const key of Object.keys(frame)) {
    expect(
      allowed.has(key) || key.startsWith("_"),
      `unexpected key in history fixture: ${key}`,
    ).toBe(true);
  }
}

/** 从反例 _violation 元数据尾段解析期望错误码（"reason -> code"）。 */
function expectedCodeFrom(violation: string): string {
  return violation.split("-> ").pop() as string;
}

describe("message-frame fixtures", () => {
  it("positive: 全字段正例——排序键集 toEqual + 逐字段精确断言 + 结构检查器通过", () => {
    const f = messageFramePositive as unknown as Json;
    expect(Object.keys(f).sort()).toEqual([
      "answered", "answered_at", "answered_by", "answered_content",
      "callback_url", "click_url", "created_at", "options",
      "priority", "seq", "text", "title", "type", "v", "wid",
    ]);
    expect(f.v).toBe(1);
    expect(f.type).toBe("message");
    expect(f.wid).toBe("m_2E9fKm3PqR7vXyZa");
    expect(f.seq).toBe(42);
    expect(f.title).toBe("Deploy finished");
    expect(f.text).toBe(
      "# Build OK\n\nAll **3** checks passed. See [run log](https://ci.example.com/runs/8123).",
    );
    expect(f.options).toEqual(["Acknowledge", "Retry deploy", "Escalate"]);
    expect(f.callback_url).toBe("https://ci.example.com/hooks/pushhub-callback");
    expect(f.click_url).toBe("https://ci.example.com/runs/8123");
    expect(f.priority).toBe("high");
    expect(f.answered).toBe(false);
    expect(f.answered_by).toBe(null);
    expect(f.answered_at).toBe(null);
    expect(f.answered_content).toBe(null);
    expect(f.created_at).toBe(1756185600000);
    assertValidMessageFrame(f);
  });

  it("positive 与校验器闭环：帧字段回灌 validateSendBody 全量通过且归一结果精确", () => {
    const f = messageFramePositive as unknown as Json;
    const result = validateSendBody({
      title: f.title,
      text: f.text,
      options: f.options,
      callback_url: f.callback_url,
      click_url: f.click_url,
      priority: f.priority,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.normalized).toEqual({
        title: "Deploy finished",
        text: f.text,
        options: ["Acknowledge", "Retry deploy", "Escalate"],
        callback_url: "https://ci.example.com/hooks/pushhub-callback",
        click_url: "https://ci.example.com/runs/8123",
        priority: "high",
      });
    }
  });

  it("negative: 8 例逐一驱动 validateSendBody 拒绝，code 与 _violation 尾段匹配", () => {
    const cases = messageFrameNegative as unknown as Array<{
      _violation: string;
      body: unknown;
    }>;
    expect(cases.length).toBe(8);
    const codes: string[] = [];
    for (const entry of cases) {
      const result = validateSendBody(entry.body);
      expect(result.ok, entry._violation).toBe(false);
      if (!result.ok) {
        const expected = expectedCodeFrom(entry._violation);
        expect(result.code).toBe(expected);
        expect(result.status).toBe(expected === "payload_too_large" ? 413 : 400);
        codes.push(result.code);
      }
    }
    // 5 例超限 413 + 3 例结构/枚举 400——反例矩阵与 D-02/D-04 全路径闭环
    expect(codes.sort()).toEqual([
      "invalid_body", "invalid_body", "invalid_body",
      "payload_too_large", "payload_too_large", "payload_too_large",
      "payload_too_large", "payload_too_large",
    ]);
  });

  it("negative: text 超长例的 413 文案逐字冻结（指明超长字段）", () => {
    const first = (messageFrameNegative as unknown as Array<{ body: unknown }>)[0];
    const result = validateSendBody(first.body);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toBe(
        `Field 'text' exceeds the maximum length of ${LIMITS.TEXT_MAX} characters.`,
      );
    }
  });
});

describe("sync-frame fixtures", () => {
  it("positive: 三形态均通过 validateInboundFrame 且返回帧与冻结形态精确相等", () => {
    const cases = syncFramePositive as unknown as Array<Json>;
    expect(cases.length).toBe(3);
    const expected = [
      { v: 1, type: "sync", since: null },
      { v: 1, type: "sync", since: 123 },
      { v: 1, type: "sync", since: 123, limit: SYNC_LIMIT_MAX },
    ];
    for (let i = 0; i < cases.length; i++) {
      const frame = { ...cases[i] } as Json;
      delete frame._note;
      const result = validateInboundFrame(JSON.stringify(frame));
      expect(result.ok, `case ${i}`).toBe(true);
      if (result.ok) {
        expect(result.frame).toEqual(expected[i]);
      }
    }
    // 键集断言（首形态）：协议键 + _note 元数据
    expect(Object.keys(cases[0]).sort()).toEqual(["_note", "since", "type", "v"]);
  });

  it("negative: 5 例逐一驱动 validateInboundFrame 拒绝，code 与 _violation 尾段匹配", () => {
    const cases = syncFrameNegative as unknown as Array<{
      _violation: string;
      frame: unknown;
    }>;
    expect(cases.length).toBe(5);
    for (const entry of cases) {
      const result = validateInboundFrame(JSON.stringify(entry.frame));
      expect(result.ok, entry._violation).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(expectedCodeFrom(entry._violation));
      }
    }
  });
});

describe("history-frame fixtures", () => {
  it("positive: 翻页例与首拉 50 条截断例均过结构检查器，语义字段精确断言", () => {
    const frames = historyFramePositive as unknown as Array<Json>;
    expect(frames.length).toBe(2);
    assertValidHistoryFrame(frames[0]);
    assertValidHistoryFrame(frames[1]);
    // 例一：翻页——两帧 + has_more:true + oldest_kept_seq 语义
    expect(frames[0].has_more).toBe(true);
    expect((frames[0].messages as Json[]).length).toBe(2);
    expect(frames[0].oldest_kept_seq).toBe(41);
    // 例二：首拉截断——恰好 INITIAL_FETCH(50) 条 + has_more:false + 无缺口
    expect(frames[1].has_more).toBe(false);
    expect((frames[1].messages as Json[]).length).toBe(INITIAL_FETCH);
    expect(frames[1].oldest_kept_seq).toBe(1);
  });

  it("negative: 3 例结构反例均被结构检查器拒绝（帧结构冻结）", () => {
    const cases = historyFrameNegative as unknown as Array<{
      _violation: string;
      frame: unknown;
    }>;
    expect(cases.length).toBe(3);
    for (const entry of cases) {
      expect(
        () => assertValidHistoryFrame(entry.frame as Json),
        entry._violation,
      ).toThrow();
    }
  });
});

describe("error-envelope fixtures（D-06 逐 code 一例）", () => {
  const envelopes: Array<[Json, string, number]> = [
    [envelopeInvalidKey as unknown as Json, "invalid_key", 401],
    [envelopePayloadTooLarge as unknown as Json, "payload_too_large", 413],
    [envelopeRateLimited as unknown as Json, "rate_limited", 429],
    [envelopeInvalidBody as unknown as Json, "invalid_body", 400],
  ];

  it("四例：顶层键集 [error,_meta]；error 子对象仅 code/message 两键；code 与 http_status 精确", () => {
    for (const [fixture, code, status] of envelopes) {
      expect(Object.keys(fixture).sort()).toEqual(["_meta", "error"]);
      const err = fixture.error as Json;
      expect(Object.keys(err).sort()).toEqual(["code", "message"]);
      expect(err.code).toBe(code);
      expect(typeof err.message).toBe("string");
      expect((err.message as string).length > 0).toBe(true);
      const meta = fixture._meta as Json;
      expect(meta.http_status).toBe(status);
    }
  });

  it("rate_limited 例冻结 Retry-After 语义（HTTP 响应头而非信封字段）", () => {
    const meta = (envelopeRateLimited as unknown as Json)._meta as Json;
    expect(Object.keys(meta).sort()).toEqual(["headers", "http_status", "note"]);
    expect(Object.keys(meta.headers as Json)).toEqual(["Retry-After"]);
  });

  it("payload_too_large 例 message 指明超长字段（通用文案，无内部细节）", () => {
    const err = (envelopePayloadTooLarge as unknown as Json).error as Json;
    expect(err.message).toBe(
      `Field 'text' exceeds the maximum length of ${LIMITS.TEXT_MAX} characters.`,
    );
  });
});

describe("ws-error-frame 与 pong fixtures", () => {
  it("WsErrorFrame 两例：键集 [code,message,type,v] 精确、code 顺序冻结、message 与 validators 文案逐字一致", () => {
    const frames = wsErrorFrame as unknown as Array<Json>;
    expect(frames.length).toBe(2);
    expect(frames.map((f) => f.code)).toEqual(["invalid_version", "invalid_frame"]);
    for (const f of frames) {
      expect(Object.keys(f).sort()).toEqual(["code", "message", "type", "v"]);
      expect(f.v).toBe(PROTOCOL_VERSION);
      expect(f.type).toBe("error");
      expect(typeof f.message).toBe("string");
      expect((f.message as string).length > 0).toBe(true);
    }
    expect(frames[0].message).toBe(
      `Unsupported protocol version: expected ${PROTOCOL_VERSION}.`,
    );
    expect(frames[1].message).toBe(
      "Malformed frame: not a recognized v:1 client frame.",
    );
  });

  it("pong 帧：auto-response 回帧冻结（v:1 + type:pong，键集含 _note 元数据）", () => {
    const f = pongFramePositive as unknown as Json;
    expect(Object.keys(f).sort()).toEqual(["_note", "type", "v"]);
    expect(f.v).toBe(PROTOCOL_VERSION);
    expect(f.type).toBe("pong");
    expect(typeof f._note).toBe("string");
    expect((f._note as string).length > 0).toBe(true);
  });
});
