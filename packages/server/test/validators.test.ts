/**
 * validators 纯函数单测（01-02 Task 2）。
 *
 * 覆盖 D-02 全部上限的通过/拒绝边界对（恰好上限通过、超一字符拒绝 413）、
 * D-04 枚举、SRV-02 省略语义（空数组/null/缺省）与 D-07 未知字段忽略。
 * 阈值经 @pushhub/shared 常量引用，与实现同源。
 */
import { describe, expect, it } from "vitest";

import {
  BY_MAX,
  LIMITS,
  PROTOCOL_VERSION,
  SYNC_LIMIT_MAX,
  type NormalizedSendBody,
} from "@pushhub/shared";
import {
  validateInboundFrame,
  validateSendBody,
  type SendBodyValidation,
} from "@pushhub/shared/validators";

/** ok 判别联合收窄辅助。 */
function expectRejected(
  result: SendBodyValidation,
  status: 400 | 413,
  code: "invalid_body" | "invalid_json" | "payload_too_large",
): void {
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.status).toBe(status);
    expect(result.code).toBe(code);
    expect(typeof result.message).toBe("string");
    expect(result.message.length > 0).toBe(true);
  }
}

function expectNormalized(
  result: SendBodyValidation,
  expected: NormalizedSendBody,
): void {
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.normalized).toEqual(expected);
  }
}

const repeat = (ch: string, n: number): string => ch.repeat(n);

describe("validateSendBody — D-02 上限边界对（UTF-16 码元口径）", () => {
  it("text 恰 32768 通过，32769 拒 413", () => {
    expectNormalized(
      validateSendBody({ text: repeat("a", LIMITS.TEXT_MAX) }),
      { text: repeat("a", LIMITS.TEXT_MAX), priority: "normal" },
    );
    expectRejected(
      validateSendBody({ text: repeat("a", LIMITS.TEXT_MAX + 1) }),
      413,
      "payload_too_large",
    );
  });

  it("title 恰 256 通过，257 拒 413", () => {
    expectNormalized(
      validateSendBody({ text: "ok", title: repeat("t", LIMITS.TITLE_MAX) }),
      { text: "ok", title: repeat("t", LIMITS.TITLE_MAX), priority: "normal" },
    );
    expectRejected(
      validateSendBody({ text: "ok", title: repeat("t", LIMITS.TITLE_MAX + 1) }),
      413,
      "payload_too_large",
    );
  });

  it("options 恰 4 项各 64 字符通过；5 项拒 413；单项 65 字符拒 413", () => {
    const items = Array.from(
      { length: LIMITS.OPTIONS_MAX_COUNT },
      () => repeat("o", LIMITS.OPTIONS_ITEM_MAX),
    );
    expectNormalized(
      validateSendBody({ text: "ok", options: items }),
      { text: "ok", options: items, priority: "normal" },
    );
    expectRejected(
      validateSendBody({
        text: "ok",
        options: ["a", "b", "c", "d", "e"],
      }),
      413,
      "payload_too_large",
    );
    expectRejected(
      validateSendBody({
        text: "ok",
        options: [repeat("o", LIMITS.OPTIONS_ITEM_MAX + 1)],
      }),
      413,
      "payload_too_large",
    );
  });

  it("callback_url 与 click_url 恰 2048 通过，2049 拒 413", () => {
    const urlOk = `https://example.com/${repeat("u", LIMITS.URL_MAX - 20)}`;
    expect(urlOk.length).toBe(LIMITS.URL_MAX);
    const urlBad = `https://example.com/${repeat("u", LIMITS.URL_MAX - 19)}`;
    expect(urlBad.length).toBe(LIMITS.URL_MAX + 1);

    expectNormalized(
      validateSendBody({ text: "ok", callback_url: urlOk, click_url: urlOk }),
      { text: "ok", callback_url: urlOk, click_url: urlOk, priority: "normal" },
    );
    expectRejected(
      validateSendBody({ text: "ok", callback_url: urlBad }),
      413,
      "payload_too_large",
    );
    expectRejected(
      validateSendBody({ text: "ok", click_url: urlBad }),
      413,
      "payload_too_large",
    );
  });
});

describe("validateSendBody — 省略语义与枚举（SRV-02 / D-04）", () => {
  it("options 空数组归一为省略；null 与缺省均视为未提供不报错；单元素合法", () => {
    expectNormalized(validateSendBody({ text: "ok", options: [] }), {
      text: "ok",
      priority: "normal",
    });
    expectNormalized(validateSendBody({ text: "ok", options: null }), {
      text: "ok",
      priority: "normal",
    });
    expectNormalized(validateSendBody({ text: "ok" }), {
      text: "ok",
      priority: "normal",
    });
    expectNormalized(validateSendBody({ text: "ok", options: ["solo"] }), {
      text: "ok",
      options: ["solo"],
      priority: "normal",
    });
  });

  it("priority 缺省与 null 归一 normal；三枚举字面量通过；urgent 拒 400", () => {
    expectNormalized(validateSendBody({ text: "ok", priority: null }), {
      text: "ok",
      priority: "normal",
    });
    for (const p of ["low", "normal", "high"] as const) {
      expectNormalized(validateSendBody({ text: "ok", priority: p }), {
        text: "ok",
        priority: p,
      });
    }
    expectRejected(
      validateSendBody({ text: "ok", priority: "urgent" }),
      400,
      "invalid_body",
    );
    expectRejected(
      validateSendBody({ text: "ok", priority: 3 }),
      400,
      "invalid_body",
    );
  });

  it("可选字段 null 归一为省略（title / callback_url / click_url）", () => {
    expectNormalized(
      validateSendBody({ text: "ok", title: null, callback_url: null, click_url: null }),
      { text: "ok", priority: "normal" },
    );
  });
});

describe("validateSendBody — 结构检查与 D-07 未知字段", () => {
  it("非对象（null / 数组 / JSON 数组字符串 / 数字）拒 400 invalid_body", () => {
    expectRejected(validateSendBody(null), 400, "invalid_body");
    expectRejected(validateSendBody(["text"]), 400, "invalid_body");
    // 字符串输入按原始 JSON 解析：合法 JSON 但非对象（数组）→ invalid_body；
    // 非合法 JSON 的拒收路径在 invalid_json 专测覆盖。
    expectRejected(validateSendBody('["text"]'), 400, "invalid_body");
    expectRejected(validateSendBody(42), 400, "invalid_body");
  });

  it("缺 text 或 text 非 string 拒 400 invalid_body", () => {
    expectRejected(validateSendBody({ title: "no text" }), 400, "invalid_body");
    expectRejected(validateSendBody({ text: 123 }), 400, "invalid_body");
  });

  it("未知字段被忽略且不影响结果（D-07）", () => {
    expectNormalized(
      validateSendBody({
        text: "ok",
        future_field: { nested: true },
        another: 1,
      }),
      { text: "ok", priority: "normal" },
    );
  });

  it("字符串输入按原始 JSON 解析；非 JSON 字符串拒 400 invalid_json", () => {
    expectNormalized(validateSendBody(`{"text":"ok"}`), {
      text: "ok",
      priority: "normal",
    });
    expectRejected(validateSendBody("not json {"), 400, "invalid_json");
  });
});

describe("validateInboundFrame — 入站帧版本与结构（D-07 / D-11）", () => {
  it("合法 ping 帧通过且返回规范化帧", () => {
    const result = validateInboundFrame(`{"v":1,"type":"ping"}`);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.frame).toEqual({ v: PROTOCOL_VERSION, type: "ping" });
    }
  });

  it("合法 sync 帧（since:null / since:n / limit）通过", () => {
    const r1 = validateInboundFrame(`{"v":1,"type":"sync","since":null}`);
    expect(r1.ok).toBe(true);
    if (r1.ok) {
      expect(r1.frame).toEqual({ v: 1, type: "sync", since: null });
    }
    const r2 = validateInboundFrame(
      `{"v":1,"type":"sync","since":123,"limit":${SYNC_LIMIT_MAX}}`,
    );
    expect(r2.ok).toBe(true);
    if (r2.ok) {
      expect(r2.frame).toEqual({
        v: 1,
        type: "sync",
        since: 123,
        limit: SYNC_LIMIT_MAX,
      });
    }
  });

  it("v:2 帧返回 invalid_version；v 缺失同样 invalid_version", () => {
    const r1 = validateInboundFrame(`{"v":2,"type":"sync","since":null}`);
    expect(r1.ok).toBe(false);
    if (!r1.ok) {
      expect(r1.code).toBe("invalid_version");
    }
    const r2 = validateInboundFrame(`{"type":"sync","since":null}`);
    expect(r2.ok).toBe(false);
    if (!r2.ok) {
      expect(r2.code).toBe("invalid_version");
    }
  });

  it("非 JSON 与非对象帧返回 invalid_frame", () => {
    for (const raw of ["not json", "42", '"str"', "null", "[]"]) {
      const r = validateInboundFrame(raw);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.code).toBe("invalid_frame");
      }
    }
  });

  it("type 非 ping/sync、缺 type、since/limit 非法均返回 invalid_frame", () => {
    const cases = [
      `{"v":1,"type":"message","text":"x"}`,
      `{"v":1,"since":null}`,
      `{"v":1,"type":"sync","since":-1}`,
      `{"v":1,"type":"sync","since":1.5}`,
      `{"v":1,"type":"sync","since":"123"}`,
      `{"v":1,"type":"sync","since":5,"limit":0}`,
      `{"v":1,"type":"sync","since":5,"limit":${SYNC_LIMIT_MAX + 1}}`,
      `{"v":1,"type":"sync","since":5,"limit":"200"}`,
    ];
    for (const raw of cases) {
      const r = validateInboundFrame(raw);
      expect(r.ok, `expected rejection for: ${raw}`).toBe(false);
      if (!r.ok) {
        expect(r.code).toBe("invalid_frame");
      }
    }
  });
});

describe("validateInboundFrame — reply 分支（D-45/D-46/D-53，04-01）", () => {
  it("恰一通过：selected_option 或 text 单独提供均合法（by 可选），返回规范化帧", () => {
    const r1 = validateInboundFrame(
      `{"v":1,"type":"reply","wid":"m_2E9fKm3PqR7vXyZa","selected_option":"OK"}`,
    );
    expect(r1.ok).toBe(true);
    if (r1.ok) {
      expect(r1.frame).toEqual({
        v: PROTOCOL_VERSION,
        type: "reply",
        wid: "m_2E9fKm3PqR7vXyZa",
        selected_option: "OK",
      });
    }
    const r2 = validateInboundFrame(
      `{"v":1,"type":"reply","wid":"m_2E9fKm3PqR7vXyZa","text":"hi","by":"dev"}`,
    );
    expect(r2.ok).toBe(true);
    if (r2.ok) {
      expect(r2.frame).toEqual({
        v: PROTOCOL_VERSION,
        type: "reply",
        wid: "m_2E9fKm3PqR7vXyZa",
        text: "hi",
        by: "dev",
      });
    }
  });

  it("同真拒绝：selected_option 与 text 同时提供 → invalid_frame", () => {
    const r = validateInboundFrame(
      `{"v":1,"type":"reply","wid":"m_2E9fKm3PqR7vXyZa","selected_option":"OK","text":"both"}`,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("invalid_frame");
    }
  });

  it("同假拒绝：两者都不提供 → invalid_frame", () => {
    const r = validateInboundFrame(`{"v":1,"type":"reply","wid":"m_2E9fKm3PqR7vXyZa"}`);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("invalid_frame");
    }
  });

  it("可选字段 null 视为未提供（省略语义与 SRV-02 同源）：text 侧单真即合法", () => {
    const r = validateInboundFrame(
      `{"v":1,"type":"reply","wid":"m_2E9fKm3PqR7vXyZa","selected_option":null,"text":"only text"}`,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.frame).toEqual({
        v: PROTOCOL_VERSION,
        type: "reply",
        wid: "m_2E9fKm3PqR7vXyZa",
        text: "only text",
      });
    }
  });

  it("text 恰 LIMITS.TEXT_MAX 通过，超一字符拒绝", () => {
    const ok = validateInboundFrame(
      JSON.stringify({
        v: 1,
        type: "reply",
        wid: "m_2E9fKm3PqR7vXyZa",
        text: repeat("a", LIMITS.TEXT_MAX),
      }),
    );
    expect(ok.ok).toBe(true);
    const bad = validateInboundFrame(
      JSON.stringify({
        v: 1,
        type: "reply",
        wid: "m_2E9fKm3PqR7vXyZa",
        text: repeat("a", LIMITS.TEXT_MAX + 1),
      }),
    );
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.code).toBe("invalid_frame");
    }
  });

  it("by 恰 BY_MAX 通过，BY_MAX+1 拒绝（UTF-16 码元口径，D-53）", () => {
    const ok = validateInboundFrame(
      JSON.stringify({
        v: 1,
        type: "reply",
        wid: "m_2E9fKm3PqR7vXyZa",
        text: "hi",
        by: repeat("b", BY_MAX),
      }),
    );
    expect(ok.ok).toBe(true);
    const bad = validateInboundFrame(
      JSON.stringify({
        v: 1,
        type: "reply",
        wid: "m_2E9fKm3PqR7vXyZa",
        text: "hi",
        by: repeat("b", BY_MAX + 1),
      }),
    );
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.code).toBe("invalid_frame");
    }
  });

  it("wid 缺失 / 非字符串 / 空串 → invalid_frame", () => {
    for (const raw of [
      `{"v":1,"type":"reply","text":"no wid"}`,
      `{"v":1,"type":"reply","wid":123,"text":"numeric wid"}`,
      `{"v":1,"type":"reply","wid":"","text":"empty wid"}`,
    ]) {
      const r = validateInboundFrame(raw);
      expect(r.ok, `expected rejection for: ${raw}`).toBe(false);
      if (!r.ok) {
        expect(r.code).toBe("invalid_frame");
      }
    }
  });
});
