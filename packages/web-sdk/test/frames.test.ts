/**
 * parseServerFrame 帧契约测试（02-01，D-07 客户端侧职责；04-03 扩 answered/ack）。
 *
 * 输入为 @pushhub/shared golden fixtures（01-02 逐字节冻结 + 04-01 approve-freeze
 * 追加，静态 import——shared package.json exports "./fixtures/*" 已映射）：
 *  - 服务端帧正例（message/history/pong/error/answered）→ ok:true，_note 等
 *    未知字段忽略；ack 三键帧本地构造验证（宽松直通照 pong 模式）；
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
import answeredPositive from "@pushhub/shared/fixtures/answered-frame.positive.json";

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

  it("ws-error-frame ×4：invalid_version / invalid_frame / already_replied / not_found", () => {
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
    // 04-01 协议事件：追加 already_replied / not_found 两例（用户裁决
    // approve-freeze 冻结；SDK parseServerFrame 的 error 守卫不枚举 code，
    // 天然兼容——reply/answered 帧 SDK 侧消费在 04-03）。
    const codes = wsErrorFrames.map((f) => f.code);
    expect(codes).toEqual([
      "invalid_version", "invalid_frame", "already_replied", "not_found",
    ]);
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

describe("04-03：answered/ack 帧守卫（reply 闭环服务端帧）", () => {
  it("answered-frame.positive ×2：深校验通过，字段逐项透传（wid/seq/answered_by/answered_at/answered_content）", () => {
    for (const frame of answeredPositive) {
      const r = parseServerFrame(JSON.stringify(frame));
      expect(r.ok, frame._note ?? frame.wid).toBe(true);
      if (r.ok) {
        expect(r.frame.type).toBe("answered");
        const a = r.frame as {
          wid: string;
          seq: number;
          answered: boolean;
          answered_by: string | null;
          answered_at: number;
          answered_content: string | null;
        };
        expect(a.wid).toBe(frame.wid);
        expect(a.seq).toBe(frame.seq);
        expect(a.answered).toBe(true); // 冻结形态恒 true（D-45）
        expect(a.answered_by).toBe(frame.answered_by);
        expect(a.answered_at).toBe(frame.answered_at);
        expect(a.answered_content).toBe(frame.answered_content);
      }
    }
    // 两形态在位：自报展示名 + 匿名（answered_by null）。
    expect(answeredPositive.map((f) => f.answered_by)).toEqual(["运维笔记本", null]);
  });

  it("ack 三键帧 {v:1,type:ack,wid} → ok:true（宽松直通，pong 模式恰查三键）", () => {
    const r = parseServerFrame('{"v":1,"type":"ack","wid":"m_2E9fKm3PqR7vXyZa"}');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.frame.type).toBe("ack");
      expect((r.frame as { wid: string }).wid).toBe("m_2E9fKm3PqR7vXyZa");
    }
  });

  it("ack 结构违例（wid 缺失 / wid 非字符串）→ 非致命丢弃", () => {
    for (const raw of ['{"v":1,"type":"ack"}', '{"v":1,"type":"ack","wid":42}']) {
      const r = parseServerFrame(raw);
      expect(r.ok, raw).toBe(false);
      if (!r.ok) expect(r.fatal, raw).toBe(false);
    }
  });

  it("answered 结构违例（answered_by 数字 / answered_content 缺失）→ 非致命丢弃", () => {
    const bad1 =
      '{"v":1,"type":"answered","wid":"m_x","seq":1,"answered":true,"answered_by":42,"answered_at":1756185660000,"answered_content":"x"}';
    const bad2 =
      '{"v":1,"type":"answered","wid":"m_x","seq":1,"answered":true,"answered_by":null,"answered_at":1756185660000}';
    for (const raw of [bad1, bad2]) {
      const r = parseServerFrame(raw);
      expect(r.ok, raw).toBe(false);
      if (!r.ok) {
        expect(r.fatal, raw).toBe(false);
        expect(r.message, raw).not.toContain("unsupported protocol version");
      }
    }
  });

  it("type 拼错（answeered）→ 未知 type 非致命丢弃（非 invalid_version 路径）", () => {
    const r = parseServerFrame('{"v":1,"type":"answeered","wid":"m_x","seq":1}');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.fatal).toBe(false);
      expect(r.message).toContain("unknown frame type");
    }
  });
});
