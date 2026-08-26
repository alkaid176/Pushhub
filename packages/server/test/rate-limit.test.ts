/**
 * KEY-05 限流行为集成测试（01-03 Task 2）。
 *
 * 覆盖（经 exports.default.fetch 走真实 Worker 入口，Retry-After 头透传
 * 一并验证）：同一 Send Key 固定窗口 30 条/min——前 30 条全 200、第 31 条
 * 429 + rate_limited 信封（与 fixture 逐字节一致）+ Retry-After 正整数头；
 * 分键隔离（另一 Send Key 同频道不受首键计数影响）；被拒消息不消耗 seq
 * （后续消息 seq 连续无空洞）；窗口滚动（直接操作 DO 内 rate_sends 表将
 * window_start 回拨 61 秒代替真实等待，恢复 200）。
 */
import { env, exports } from "cloudflare:workers";
// runInDurableObject 等测试专用工具经 cloudflare:test 提供（env/exports 在
// cloudflare:workers——插件将二者分离，运行时实证）。
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { RATE_LIMIT_PER_MIN } from "@pushhub/shared";
import envelopeRateLimited from "@pushhub/shared/fixtures/error-envelope.rate-limited.json";

import { KEY_PREFIX_CH, KEY_PREFIX_SEND } from "../src/keys";

function uniqueId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

/** 种入唯一频道 + 两把 Send Key（同频道，供分键隔离断言）。 */
async function seedChannel(): Promise<{
  channelId: string;
  sendKeyA: string;
  sendKeyB: string;
}> {
  const channelId = uniqueId().slice(0, 16);
  const channelKey = `tch_${uniqueId()}`;
  const sendKeyA = `tsk_${uniqueId()}`;
  const sendKeyB = `tsk_${uniqueId()}`;
  await env.KV.put(
    KEY_PREFIX_CH + channelKey,
    JSON.stringify({ channelId, name: "rate-limit", createdAt: Date.now() }),
  );
  await env.KV.put(KEY_PREFIX_SEND + sendKeyA, JSON.stringify({ channelId }));
  await env.KV.put(KEY_PREFIX_SEND + sendKeyB, JSON.stringify({ channelId }));
  return { channelId, sendKeyA, sendKeyB };
}

function sendRequest(sendKey: string, body: unknown): Promise<Response> {
  return exports.default.fetch(
    new Request("https://example.com/api/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${sendKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
    env,
  );
}

describe("KEY-05 rate limit (fixed window per Send Key)", () => {
  it("同一 Send Key 连发 30 条全 200 → 第 31 条 429 + rate_limited + Retry-After", async () => {
    const { sendKeyA } = await seedChannel();

    for (let i = 1; i <= RATE_LIMIT_PER_MIN; i++) {
      const resp = await sendRequest(sendKeyA, { text: `msg ${i}` });
      expect(resp.status, `send #${i}`).toBe(200);
      const body = (await resp.json()) as { seq: number };
      expect(body.seq, `send #${i}`).toBe(i);
    }

    const resp31 = await sendRequest(sendKeyA, { text: "one too many" });
    expect(resp31.status).toBe(429);
    const body31 = (await resp31.json()) as { error: { code: string } };
    // 严格信封 + 与冻结 fixture 逐字节一致（含 Retry-After 语义：头而非信封字段）。
    expect(Object.keys(body31).sort()).toEqual(["error"]);
    expect(body31.error).toEqual(envelopeRateLimited.error);
    const retryAfter = resp31.headers.get("Retry-After");
    expect(retryAfter).not.toBeNull();
    const seconds = Number(retryAfter);
    expect(Number.isInteger(seconds), `Retry-After not integer: ${retryAfter}`).toBe(true);
    expect(seconds >= 1 && seconds <= 60, `Retry-After out of range: ${retryAfter}`).toBe(true);
  });

  it("分键隔离 + 被拒消息不消耗 seq：另一 Send Key 同频道正常发送且 seq 连续无空洞", async () => {
    const { sendKeyA, sendKeyB } = await seedChannel();

    for (let i = 0; i < RATE_LIMIT_PER_MIN; i++) {
      const resp = await sendRequest(sendKeyA, { text: "from A" });
      expect(resp.status).toBe(200);
    }
    const rejected = await sendRequest(sendKeyA, { text: "A overflow" });
    expect(rejected.status).toBe(429);

    // skB 不受 skA 计数影响；且 seq = 31 证明被拒的 31 条未分配 seq、未写 messages。
    const respB = await sendRequest(sendKeyB, { text: "from B" });
    expect(respB.status).toBe(200);
    const bodyB = (await respB.json()) as { seq: number };
    expect(bodyB.seq).toBe(RATE_LIMIT_PER_MIN + 1);

    // skA 仍被拒（skB 的成功不影响 skA 的窗口计数）。
    const rejectedAgain = await sendRequest(sendKeyA, { text: "A still limited" });
    expect(rejectedAgain.status).toBe(429);
  });

  it("窗口滚动：rate_sends.window_start 回拨 61 秒后 skA 恢复 200（表操作代替真实等待）", async () => {
    const { channelId, sendKeyA } = await seedChannel();

    for (let i = 0; i < RATE_LIMIT_PER_MIN; i++) {
      await sendRequest(sendKeyA, { text: "w" });
    }
    const rejected = await sendRequest(sendKeyA, { text: "w31" });
    expect(rejected.status).toBe(429);

    // 直接操作 DO 内表：窗口回拨 61 秒 → 下一发送命中重置分支。
    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(channelId));
    await runInDurableObject(stub, (_obj: unknown, state: DurableObjectState) => {
      state.storage.sql.exec("UPDATE rate_sends SET window_start = window_start - 61000");
    });

    const resp = await sendRequest(sendKeyA, { text: "new window" });
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { seq: number };
    expect(body.seq).toBe(RATE_LIMIT_PER_MIN + 1); // 旧窗口 30 条 + 新窗口 1 条
  });
});
