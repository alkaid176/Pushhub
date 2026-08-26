/**
 * SRV-01 基线集成测试：POST /api/send happy path + 401（01-03 Task 1）。
 *
 * 经 exports.default.fetch 走真实 Worker 入口（cloudflare:workers 路径），
 * 覆盖：合法载荷 → 200 精确 {id, seq} 响应（SendResult 冻结结构）；
 * wid 形态（m_ + 16 字符，D-05）；seq 频道内单调；无效 Send Key → 401
 * + invalid_key 信封（信封文案与 fixtures 逐字一致，D-06）。
 *
 * 隔离策略：套件整体 --max-workers=1 --no-isolate 共享存储——本文件以
 * crypto.randomUUID() 派生唯一频道名/key 做隔离。
 */
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import envelopeInvalidKey from "@pushhub/shared/fixtures/error-envelope.invalid-key.json";

import { KEY_PREFIX_CH, KEY_PREFIX_SEND } from "../src/keys";

function uniqueId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

/** 种入唯一频道（ch:/sk: 两键指向同一 channelId），返回发送用凭据。 */
async function seedChannel(): Promise<{ sendKey: string }> {
  const channelId = uniqueId().slice(0, 16);
  const channelKey = `tch_${uniqueId()}`;
  const sendKey = `tsk_${uniqueId()}`;
  await env.KV.put(
    KEY_PREFIX_CH + channelKey,
    JSON.stringify({ channelId, name: "send-basic", createdAt: Date.now() }),
  );
  await env.KV.put(KEY_PREFIX_SEND + sendKey, JSON.stringify({ channelId }));
  return { sendKey };
}

function sendRequest(sendKey: string, body: string): Promise<Response> {
  return exports.default.fetch(
    new Request("https://example.com/api/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${sendKey}`,
        "content-type": "application/json",
      },
      body,
    }),
    env,
  );
}

describe("POST /api/send baseline (SRV-01)", () => {
  it("合法载荷 → 200 且响应体精确为 {id: wid(m_+16), seq: 频道内单调}", async () => {
    const { sendKey } = await seedChannel();

    const resp1 = await sendRequest(sendKey, JSON.stringify({ text: "first" }));
    expect(resp1.status).toBe(200);
    const body1 = (await resp1.json()) as { id: string; seq: number };
    // SendResult 冻结结构：恰好 id/seq 两键，无多余键。
    expect(Object.keys(body1).sort()).toEqual(["id", "seq"]);
    expect(body1.id.startsWith("m_")).toBe(true); // D-05 wid 前缀
    expect(body1.id.length).toBe(18); // m_ + 16 字符
    expect(body1.seq).toBe(1);

    const resp2 = await sendRequest(sendKey, JSON.stringify({ text: "second" }));
    expect(resp2.status).toBe(200);
    const body2 = (await resp2.json()) as { id: string; seq: number };
    expect(Object.keys(body2).sort()).toEqual(["id", "seq"]);
    expect(body2.seq).toBe(2); // seq 频道内单调
    expect(body2.id).not.toBe(body1.id); // wid 全局唯一
  });

  it("无效 Send Key → 401 + invalid_key 信封（与 fixture 逐字一致，严格结构）", async () => {
    const resp = await sendRequest(
      `nope_${uniqueId()}`,
      JSON.stringify({ text: "should be rejected" }),
    );
    expect(resp.status).toBe(401);
    const body = (await resp.json()) as {
      error: { code: string; message: string };
    };
    // 严格信封结构：顶层仅 error，error 仅 code/message（无多余键）。
    expect(Object.keys(body).sort()).toEqual(["error"]);
    expect(Object.keys(body.error).sort()).toEqual(["code", "message"]);
    expect(body.error.code).toBe("invalid_key");
    // 文案与冻结 fixture 逐字节一致（D-06）。
    expect(body.error).toEqual(envelopeInvalidKey.error);
  });

  it("缺失 Authorization 头 → 401 + invalid_key 信封（Bearer 前缀缺失同路径）", async () => {
    const resp = await exports.default.fetch(
      new Request("https://example.com/api/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "no auth header" }),
      }),
      env,
    );
    expect(resp.status).toBe(401);
    const body = (await resp.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_key");
    expect(Object.keys(body).sort()).toEqual(["error"]);
  });
});
