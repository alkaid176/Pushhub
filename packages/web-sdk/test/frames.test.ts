/**
 * parseServerFrame 帧契约测试（02-01，D-07 客户端侧职责）。
 *
 * 输入为 @pushhub/shared 全部 12 个 golden fixtures（01-02 逐字节冻结，
 * 静态 import——shared package.json exports "./fixtures/*" 已映射）：
 *  - 服务端帧正例（message/history/pong/error）→ ok:true，_note 等未知字段忽略；
 *  - 反例按 fatal/丢弃两档正确分流：v!==1（含缺失）→ fatal；结构违例 /
 *    未知 type（含客户端专属的 sync 帧）→ 非致命丢弃。
 */
import { describe, it, expect } from "vitest";
import { parseServerFrame } from "../src/frames";

import messagePositive from "@pushhub/shared/fixtures/message-frame.positive.json";
import historyPositive from "@pushhub/shared/fixtures/history-frame.positive.json";
import historyNegative from "@pushhub/shared/fixtures/history-frame.negative.json";
import pongPositive from "@pushhub/shared/fixtures/pong-frame.positive.json";
import wsErrorFrames from "@pushhub/shared/fixtures/ws-error-frame.json";
import syncPositive from "@pushhub/shared/fixtures/sync-frame.positive.json";
import syncNegative from "@pushhub/shared/fixtures/sync-frame.negative.json";
import envelopeInvalidKey from "@pushhub/shared/fixtures/error-envelope.invalid-key.json";
import envelopeInvalidBody from "@pushhub/shared/fixtures/error-envelope.invalid-body.json";
import envelopeTooLarge from "@pushhub/shared/fixtures/error-envelope.payload-too-large.json";
import envelopeRateLimited from "@pushhub/shared/fixtures/error-envelope.rate-limited.json";
import messageNegative from "@pushhub/shared/fixtures/message-frame.negative.json";

describe("正例：合法服务端帧 ok:true，未知字段忽略（D-07）", () => {
  it("message-frame.positive：13 字段全量帧", () => {
    const r = parseServerFrame(JSON.stringify(messagePositive));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.frame.type).toBe("message");
      const m = r.frame as { seq: number; wid: string; priority: string };
      expect(m.seq).toBe(42);
      expect(m.wid).toBe("m_2E9fKm3PqR7vXyZa");
      expect(m.priority).toBe("high");
    }
  });

  it("history-frame.positive ×2：_note 未知字段不致拒（翻页例 + 首拉例）", () => {
    for (const frame of historyPositive) {
      const r = parseServerFrame(JSON.stringify(frame));
      expect(r.ok).toBe(true);
      if (r.ok) {
        const h = r.frame as { messages: unknown[]; oldest_kept_seq: number; has_more: boolean };
        expect(h.messages.length).toBeGreaterThan(0);
        expect(typeof h.oldest_kept_seq).toBe("number");
        expect(typeof h.has_more).toBe("boolean");
      }
    }
    // 翻页例与首拉例的具体值（fixtures 冻结值）。
    const paging = parseServerFrame(JSON.stringify(historyPositive[0]));
    if (paging.ok) {
      const h = paging.frame as { messages: unknown[]; oldest_kept_seq: number; has_more: boolean };
      expect(h.messages.length).toBe(2);
      expect(h.oldest_kept_seq).toBe(41);
      expect(h.has_more).toBe(true);
    }
    const first = parseServerFrame(JSON.stringify(historyPositive[1]));
    if (first.ok) {
      const h = first.frame as { messages: unknown[]; oldest_kept_seq: number; has_more: boolean };
      expect(h.messages.length).toBe(50);
      expect(h.oldest_kept_seq).toBe(1);
      expect(h.has_more).toBe(false);
    }
  });

  it("pong-frame.positive：_note 忽略，ok:true", () => {
    const r = parseServerFrame(JSON.stringify(pongPositive));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.frame.type).toBe("pong");
  });

  it("ws-error-frame ×2：invalid_version / invalid_frame", () => {
    for (const frame of wsErrorFrames) {
      const r = parseServerFrame(JSON.stringify(frame));
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.frame.type).toBe("error");
        const e = r.frame as { code: string; message: string };
        expect(typeof e.code).toBe("string");
        expect(typeof e.message).toBe("string");
      }
    }
    const codes = wsErrorFrames.map((f) => f.code);
    expect(codes).toEqual(["invalid_version", "invalid_frame"]);
  });
});

describe("反例分流：fatal（v 不匹配）/ 丢弃（结构与未知 type）", () => {
  it("history-frame.negative ×3：结构违例 → 非致命丢弃", () => {
    for (const { _violation, frame } of historyNegative) {
      const r = parseServerFrame(JSON.stringify(frame));
      expect(r.ok, _violation).toBe(false);
      if (!r.ok) expect(r.fatal, _violation).toBe(false);
    }
  });

  it("sync-frame.negative ×5：v:2 → fatal；其余（含缺 type）→ 丢弃", () => {
    for (const { _violation, frame } of syncNegative) {
      const r = parseServerFrame(JSON.stringify(frame));
      expect(r.ok, _violation).toBe(false);
      if (!r.ok) {
        if (frame.v === 2) {
          expect(r.fatal, _violation).toBe(true);
          expect(r.message).toContain("unsupported protocol version");
        } else {
          expect(r.fatal, _violation).toBe(false);
        }
      }
    }
  });

  it("sync-frame.positive ×3：sync 是客户端帧——服务端方向未知 type → 丢弃", () => {
    for (const frame of syncPositive) {
      const r = parseServerFrame(JSON.stringify(frame));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.fatal).toBe(false);
    }
  });

  it("error-envelope ×4：HTTP 信封非帧形态（无 v 字段）→ fatal（D-07 版本门先行）", () => {
    for (const envelope of [
      envelopeInvalidKey,
      envelopeInvalidBody,
      envelopeTooLarge,
      envelopeRateLimited,
    ]) {
      const r = parseServerFrame(JSON.stringify(envelope));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.fatal).toBe(true);
    }
  });

  it("message-frame.negative ×8：请求体反例（无 v 字段）→ fatal", () => {
    for (const { _violation, body } of messageNegative) {
      const r = parseServerFrame(JSON.stringify(body));
      expect(r.ok, _violation).toBe(false);
      if (!r.ok) expect(r.fatal).toBe(true);
    }
  });
});

describe("guard 基础行为", () => {
  it("不可解析 JSON → 非致命丢弃", () => {
    const r = parseServerFrame("not json {{{");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.fatal).toBe(false);
  });

  it("非对象（数组/数字/null 文本）→ 非致命丢弃", () => {
    for (const raw of ['[1,2,3]', "42", "null"]) {
      const r = parseServerFrame(raw);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.fatal).toBe(false);
    }
  });

  it("未知 type 且 v 合法 → 非致命丢弃（D-07 前瞻兼容）", () => {
    const r = parseServerFrame('{"v":1,"type":"future-thing","x":1}');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.fatal).toBe(false);
      expect(r.message).toContain("unknown frame type");
    }
  });
});
