/**
 * D-02/D-04/D-06 校验反例矩阵集成测试（01-03 Task 1，SRV-01）。
 *
 * 反例用例逐条取自 packages/shared/fixtures/message-frame.negative.json
 * （冻结反例矩阵——不自行发明用例）：全部反例经 HTTP 入口
 * （exports.default.fetch）驱动，断言响应 status 与 error.code 与
 * fixtures _violation 元数据一致；错误响应体为严格信封结构（无多余键）。
 *
 * 另覆盖：非 JSON 请求体 → 400 invalid_json（Flagged Assumption SRV-01）；
 * JSON 但非对象（数组）→ 400 invalid_body；text 超限的 413 文案与
 * error-envelope.payload-too-large fixture 逐字节一致。
 */
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import envelopePayloadTooLarge from "@pushhub/shared/fixtures/error-envelope.payload-too-large.json";
import messageFrameNegative from "@pushhub/shared/fixtures/message-frame.negative.json";

import { KEY_PREFIX_CH, KEY_PREFIX_SEND } from "../src/keys";

function uniqueId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

async function seedChannel(): Promise<{ sendKey: string }> {
  const channelId = uniqueId().slice(0, 16);
  const channelKey = `tch_${uniqueId()}`;
  const sendKey = `tsk_${uniqueId()}`;
  await env.KV.put(
    KEY_PREFIX_CH + channelKey,
    JSON.stringify({ channelId, name: "send-validation", createdAt: Date.now() }),
  );
  await env.KV.put(KEY_PREFIX_SEND + sendKey, JSON.stringify({ channelId }));
  return { sendKey };
}

function sendRequest(sendKey: string, rawBody: string): Promise<Response> {
  return exports.default.fetch(
    new Request("https://example.com/api/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${sendKey}`,
        "content-type": "application/json",
      },
      body: rawBody,
    }),
    env,
  );
}

/** 反例 _violation 元数据尾段即期望错误码（"reason -> code"）。 */
function expectedCodeFrom(violation: string): string {
  return violation.split("-> ").pop() as string;
}

describe("POST /api/send validation matrix (D-02/D-04/D-06)", () => {
  it("fixtures 全部反例经 HTTP 入口驱动：status 与 code 与 _violation 元数据一致", async () => {
    const { sendKey } = await seedChannel();
    const cases = messageFrameNegative as unknown as Array<{
      _violation: string;
      body: unknown;
    }>;
    // 反例全部被驱动（验收标准：用例数不少于 fixtures 反例数）。
    expect(cases.length).toBe(8);

    for (const entry of cases) {
      const resp = await sendRequest(sendKey, JSON.stringify(entry.body));
      const expectedCode = expectedCodeFrom(entry._violation);
      const expectedStatus = expectedCode === "payload_too_large" ? 413 : 400;
      expect(resp.status, entry._violation).toBe(expectedStatus);
      const body = (await resp.json()) as {
        error: { code: string; message: string };
      };
      // 严格信封结构：顶层仅 error，error 仅 code/message（无多余键）。
      expect(Object.keys(body).sort(), entry._violation).toEqual(["error"]);
      expect(Object.keys(body.error).sort(), entry._violation).toEqual([
        "code",
        "message",
      ]);
      expect(body.error.code, entry._violation).toBe(expectedCode);
      expect(typeof body.error.message, entry._violation).toBe("string");
      expect((body.error.message as string).length, entry._violation).toBeGreaterThan(0);
    }
  });

  it("非 JSON 请求体 → 400 + invalid_json 信封", async () => {
    const { sendKey } = await seedChannel();
    const resp = await sendRequest(sendKey, "this is { not json");
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error: { code: string } };
    expect(Object.keys(body).sort()).toEqual(["error"]);
    expect(body.error.code).toBe("invalid_json");
  });

  it("JSON 但非对象（数组）→ 400 + invalid_body 信封", async () => {
    const { sendKey } = await seedChannel();
    const resp = await sendRequest(sendKey, '["text"]');
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_body");
  });

  it("text 超限的 413 信封文案与 fixture 逐字节一致（指明超长字段）", async () => {
    const { sendKey } = await seedChannel();
    const first = (messageFrameNegative as unknown as Array<{ body: unknown }>)[0];
    const resp = await sendRequest(sendKey, JSON.stringify(first.body));
    expect(resp.status).toBe(413);
    const body = (await resp.json()) as { error: { code: string; message: string } };
    expect(body.error).toEqual(envelopePayloadTooLarge.error);
  });
});
