/**
 * SRV-05 seq 单调与幂等去重语义集成测试（01-04 Task 2）。
 *
 * 覆盖：
 *  - 并发安全：20 个 /api/send 经 Promise.all 并发（真实 Worker 入口），
 *    全部 200 后返回的 seq 集合恰为 1..20——无重复无空洞。证据链：
 *    DO 单线程 + seq 分配/INSERT 同步块零 await（自动原子提交，Pattern 3），
 *    并发/重试 publish 不产生重复 seq（SRV-04 探针消解）。
 *  - 无服务端幂等去重：同一文本重发产生新 seq 与新 wid（wid 每条唯一，
 *    D-05——去重是客户端按 seq 的职责）。
 *
 * 限流策略（测试内注明）：20 并发 << 30/min 单键窗口，无需 Send Key 轮换。
 *
 * 隔离策略：--max-workers=1 --no-isolate 共享存储——两个 it 各自经
 * crypto.randomUUID() 派生唯一频道，seq 期望互不干扰。
 */
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { KEY_PREFIX_CH, KEY_PREFIX_SEND } from "../src/keys";

const CONCURRENT_SENDS = 20;

function uniqueId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

async function seedChannel(): Promise<{ channelId: string; sendKey: string }> {
  const channelId = uniqueId().slice(0, 16);
  const channelKey = `tch_${uniqueId()}`;
  const sendKey = `tsk_${uniqueId()}`;
  await env.KV.put(
    KEY_PREFIX_CH + channelKey,
    JSON.stringify({ channelId, name: "seq-monotonic", createdAt: Date.now() }),
  );
  await env.KV.put(KEY_PREFIX_SEND + sendKey, JSON.stringify({ channelId }));
  return { channelId, sendKey };
}

function sendRequest(sendKey: string, text: string): Promise<Response> {
  return exports.default.fetch(
    new Request("https://example.com/api/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${sendKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ text }),
    }),
    env,
  );
}

describe("seq monotonic & no server-side dedupe (SRV-05)", () => {
  it("20 个并发 /api/send：全部 200，seq 集合恰为 1..20（无重复无空洞）", async () => {
    const { sendKey } = await seedChannel();

    const responses = await Promise.all(
      Array.from({ length: CONCURRENT_SENDS }, (_, i) =>
        sendRequest(sendKey, `concurrent ${i + 1}`),
      ),
    );

    const seqs: number[] = [];
    for (const resp of responses) {
      expect(resp.status).toBe(200);
      const body = (await resp.json()) as { id: string; seq: number };
      expect(body.id.startsWith("m_")).toBe(true);
      seqs.push(body.seq);
    }

    // 集合恰为 1..20：Set 消重后大小 20（无重复）且排序后逐项等于区间（无空洞）。
    expect(new Set(seqs).size).toBe(CONCURRENT_SENDS);
    expect(seqs.slice().sort((a, b) => a - b)).toEqual(
      Array.from({ length: CONCURRENT_SENDS }, (_, i) => i + 1),
    );
  });

  it("同一文本重发：新 seq、唯一 wid（无幂等去重服务端语义）", async () => {
    const { sendKey } = await seedChannel();
    const sameText = "identical payload";

    const resp1 = await sendRequest(sendKey, sameText);
    expect(resp1.status).toBe(200);
    const body1 = (await resp1.json()) as { id: string; seq: number };

    const resp2 = await sendRequest(sendKey, sameText);
    expect(resp2.status).toBe(200);
    const body2 = (await resp2.json()) as { id: string; seq: number };

    expect(body2.seq).toBe(body1.seq + 1); // 单调推进，不重用
    expect(body2.id).not.toBe(body1.id); // wid 每条唯一
  });
});
