/**
 * D-08 保留清理 alarm 集成测试（01-04 Task 3，SRV-05/额度防线）。
 *
 * 覆盖：
 *  - 600 条 → alarm 触发后恰存最近 500 条，oldest_kept_seq=101（600-500=100
 *    条被删，seq 1..100 清除，101..600 保留）——DELETE 条件严格小于当前
 *    max（永不删 max 行，Pitfall 5）；
 *  - alarm 幂等：再次触发不重复删、不删 max 行；
 *  - 单调不回退：清理后继续发送 seq 仍为 601（显式赋值 + max 行健在的证据）；
 *  - 限流桶清扫：过期（>24h）rate_sends 行被删、活跃行保留；
 *  - alarm 自愈重设：执行后 getAlarm 为未来 24h 内某时刻（runInDurableObject
 *    内读取对照）。
 *
 * 发送策略（测试内注明，计划许可）：600 条经 DO /publish 内部端点直调 +
 * Send Key 以 i%20 轮换（每键恰 30 条 = 限流阈值上限内全放行）。
 *
 * 隔离策略：--max-workers=1 --no-isolate 共享存储——频道名经
 * crypto.randomUUID() 派生唯一。帧监听遵循 attach-then-trigger 铁律
 * （message 事件不排队，workerd 同 isolate 实证）。
 */
import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { RETENTION_KEEP, SYNC_LIMIT_MAX } from "@pushhub/shared";

interface MessageLike {
  v: number;
  type: string;
  seq: number;
  text: string;
}

interface HistoryLike {
  v: number;
  type: string;
  messages: MessageLike[];
  oldest_kept_seq: number;
  has_more: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function uniqueId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

function getResponseWebSocket(response: Response): WebSocket {
  const socket = response.webSocket;
  if (socket === null || socket === undefined) {
    throw new TypeError("Expected WebSocket response");
  }
  return socket;
}

function nextFrame<T = Record<string, unknown>>(socket: WebSocket, timeoutMs = 10_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout waiting for WS frame")), timeoutMs);
    socket.addEventListener(
      "message",
      (event) => {
        clearTimeout(timer);
        resolve(JSON.parse(event.data as string) as T);
      },
      { once: true },
    );
  });
}

/** DO /publish 内部端点直调（可信头 + Send Key 轮换避开 30/min 限流窗口）。 */
function directPublish(stub: DurableObjectStub, text: string, sendKey: string): Promise<Response> {
  return stub.fetch("https://do.pushhub.internal/publish", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-PH-Verified": "1",
      "X-PH-Send-Key": sendKey,
    },
    body: JSON.stringify({ text }),
  });
}

describe("retention alarm (D-08)", () => {
  it("600 条 → alarm 清至 500（oldest=101）→ 幂等 → seq=601 单调 → 桶清扫 → 重设 24h", async () => {
    const channelId = uniqueId().slice(0, 16);
    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(channelId));

    // 1. 发 600 条（20 批 × 20 并发；i%20 轮换 → 每键恰 30 条，全部放行）。
    const TOTAL = 600;
    for (let base = 0; base < TOTAL; base += 20) {
      const results = await Promise.all(
        Array.from({ length: Math.min(20, TOTAL - base) }, (_, j) => {
          const i = base + j;
          return directPublish(stub, `retention ${i + 1}`, `tsk-ret-${i % 20}`);
        }),
      );
      for (const r of results) {
        expect(r.status).toBe(200);
      }
    }

    // 2. 连接客户端（accept 后同步预挂首帧监听）——清理前首拉：最近 50 条、
    //    oldest_kept_seq=1（尚未清理）。
    const socket = getResponseWebSocket(
      await stub.fetch("https://do.pushhub.internal/ws", {
        headers: { Upgrade: "websocket", "X-PH-Verified": "1" },
      }),
    );
    socket.accept();
    const initialPromise = nextFrame<HistoryLike>(socket);
    const initial = await initialPromise;
    expect(initial.messages.length).toBe(50);
    expect(initial.oldest_kept_seq).toBe(1);
    expect(initial.messages[49]!.seq).toBe(600);

    // 3. 种入一个过期限流桶（>24h）供清扫断言；并确认活跃桶存在。
    await runInDurableObject(stub, (_obj: unknown, state: DurableObjectState) => {
      state.storage.sql.exec(
        "INSERT OR REPLACE INTO rate_sends (send_key, window_start, count) VALUES (?1, ?2, 5)",
        "tsk-expired-probe",
        Date.now() - DAY_MS - 3_600_000,
      );
    });

    // 4. 触发 alarm（首个 alarm 已由第 1 条 publish 判空设置）。
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    // 5. 清理后：sync since=0 limit=500 恰返回最近 500 条（101..600），
    //    oldest_kept_seq=101，单页收完 has_more=false。
    const after1Promise = nextFrame<HistoryLike>(socket);
    socket.send(
      JSON.stringify({ v: 1, type: "sync", since: 0, limit: SYNC_LIMIT_MAX }),
    );
    const after1 = await after1Promise;
    expect(after1.messages.length).toBe(RETENTION_KEEP);
    expect(after1.oldest_kept_seq).toBe(101);
    expect(after1.messages[0]!.seq).toBe(101);
    expect(after1.messages[499]!.seq).toBe(600);
    expect(after1.has_more).toBe(false);

    // 6. 限流桶清扫断言：过期桶已删、活跃桶保留。
    const buckets = await runInDurableObject(
      stub,
      (_obj: unknown, state: DurableObjectState) =>
        state.storage.sql
          .exec("SELECT send_key FROM rate_sends ORDER BY send_key")
          .toArray() as unknown as { send_key: string }[],
    );
    const bucketKeys = buckets.map((b) => b.send_key);
    expect(bucketKeys).not.toContain("tsk-expired-probe");
    expect(bucketKeys).toContain("tsk-ret-0");

    // 7. alarm 幂等：再次触发（finally 已重设）→ 仍是 500 条、oldest=101
    //    （不重复删、不删 max 行）。
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const after2Promise = nextFrame<HistoryLike>(socket);
    socket.send(
      JSON.stringify({ v: 1, type: "sync", since: 0, limit: SYNC_LIMIT_MAX }),
    );
    const after2 = await after2Promise;
    expect(after2.messages.length).toBe(RETENTION_KEEP);
    expect(after2.oldest_kept_seq).toBe(101);
    expect(after2.messages[499]!.seq).toBe(600);

    // 8. 单调不回退：清理后继续发送，seq = 601（max 行从未被删的证据）。
    const resp601 = await directPublish(stub, "post-cleanup", `tsk-final-${uniqueId()}`);
    expect(resp601.status).toBe(200);
    const body601 = (await resp601.json()) as { seq: number };
    expect(body601.seq).toBe(601);

    // 9. 自愈重设：getAlarm 为未来 24h 内某时刻（第二次 alarm 的 finally 所设）。
    const alarm = await runInDurableObject(
      stub,
      (_obj: unknown, state: DurableObjectState) => state.storage.getAlarm(),
    );
    expect(alarm).not.toBeNull();
    expect(alarm!).toBeGreaterThan(Date.now());
    expect(alarm!).toBeLessThanOrEqual(Date.now() + DAY_MS + 60_000);

    socket.close(1000, "done");
  });
});
