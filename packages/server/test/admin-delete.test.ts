/**
 * KEY-02/D-34 集成测试：删除频道（三前缀键全清 + DO 数据清空 + alarm 删除）。
 *
 * 覆盖（must_haves 后 5 条全量）：
 *  - DELETE /api/admin/channels/:channelId -> 204 空体；
 *  - KV 三前缀全清：listChannels 不含该频道、resolveChannelKey(旧值) 与
 *    resolveSendKey(每个已建 Key) 均 null；
 *  - DO 直达断言（runInDurableObject，01-03 先例）：删除前频道发过消息
 *    （alarm 已设），删除后 storage.getAlarm() === null（不再每日唤醒烧
 *    额度，Pitfall 1）且 messages 表行数为 0（deleteAll 清整库）；
 *  - 边界：DELETE 不存在 channelId -> 404 not_found；无鉴权 -> 401；
 *  - 幂等重放：purge 对已清空 DO 是 no-op——二次 DELETE 同频道 404
 *    （id: 已删，miss 路径）不抛错（重试安全，key_links）。
 *
 * 隔离策略：--max-workers=1 --no-isolate 共享存储——频道名经
 * crypto.randomUUID() 派生唯一（admin-channels 同款）。
 */
import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { listChannels, resolveChannelKey, resolveSendKey } from "../src/keys";

/** 必须与 vitest.config.ts miniflare.bindings 注入值一致（测试专用，非生产 secret）。 */
const TEST_ADMIN_KEY = "test-admin-key-0123456789abcdef";

function uniqueSuffix(): string {
  return crypto.randomUUID().slice(0, 8);
}

/** 经真实 Worker 入口发 Admin API 请求（覆盖 index.ts 前缀分发 + admin.ts 路由）。 */
function adminRequest(
  method: string,
  path: string,
  options?: { key?: string | null },
): Promise<Response> {
  const headers: Record<string, string> = {};
  const key = options?.key === undefined ? TEST_ADMIN_KEY : options.key;
  if (key !== null) headers.Authorization = `Bearer ${key}`;
  return exports.default.fetch(
    new Request(`https://example.com${path}`, { method, headers }),
    env,
  );
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

async function expectErrorEnvelope(
  resp: Response,
  status: number,
  code: string,
): Promise<void> {
  expect(resp.status).toBe(status);
  const body = (await resp.json()) as { error: { code: string } };
  expect(body.error.code).toBe(code);
}

interface CreatedChannel {
  channelId: string;
  channelKey: string;
  sendKeys: { key: string; label: string | null; createdAt: number }[];
  name: string;
  createdAt: number;
}

async function createChannelViaApi(name: string): Promise<CreatedChannel> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${TEST_ADMIN_KEY}`,
    "content-type": "application/json",
  };
  const resp = await exports.default.fetch(
    new Request("https://example.com/api/admin/channels", {
      method: "POST",
      headers,
      body: JSON.stringify({ name }),
    }),
    env,
  );
  expect(resp.status).toBe(201);
  return (await resp.json()) as CreatedChannel;
}

/** DO 直达状态快照（runInDurableObject）：alarm 时间戳与 messages 行数。 */
function readDoState(
  channelId: string,
): Promise<{ alarm: number | null; messageCount: number }> {
  return runInDurableObject(
    env.CHANNELS.getByName(channelId),
    async (_obj: unknown, state: DurableObjectState) => {
      const alarm = await state.storage.getAlarm();
      let messageCount = 0;
      try {
        const row = state.storage.sql
          .exec("SELECT COUNT(*) AS n FROM messages")
          .one() as { n: number };
        messageCount = row.n;
      } catch {
        // deleteAll 清整库后驻留内存的 DO 未重跑构造器（表不存在）——
        // 语义即 0 行；若已被逐出重建则命中空表分支（COUNT 为 0）。
        // 两态对「messages 表行数为 0」断言等价。
        messageCount = 0;
      }
      return { alarm, messageCount };
    },
  );
}

describe("DELETE /api/admin/channels/:channelId（D-34 硬删除）", () => {
  it("204 空体 + KV 三前缀全清 + DO 数据清空且 alarm 删除（Pitfall 1 三断言）", async () => {
    const channel = await createChannelViaApi(`del-full-${uniqueSuffix()}`);
    // 追加第二个 Key：三前缀清理断言覆盖多 sk: 键。
    const headers: Record<string, string> = {
      Authorization: `Bearer ${TEST_ADMIN_KEY}`,
      "content-type": "application/json",
    };
    const extra = await exports.default.fetch(
      new Request(
        `https://example.com/api/admin/channels/${channel.channelId}/send-keys`,
        { method: "POST", headers, body: JSON.stringify({ label: "extra" }) },
      ),
      env,
    );
    expect(extra.status).toBe(201);
    const extraKey = ((await extra.json()) as { key: string }).key;

    // 发消息：DO 内 messages 落行 + 首个 retention alarm 设置（publish 路径）。
    expect(
      (await sendRequest(channel.sendKeys[0].key, { text: "purge target 1" })).status,
    ).toBe(200);
    expect((await sendRequest(extraKey, { text: "purge target 2" })).status).toBe(200);
    const before = await readDoState(channel.channelId);
    expect(before.messageCount).toBe(2);
    expect(before.alarm).not.toBeNull(); // alarm 已设（deleteAlarm 断言的前置证明）

    const del = await adminRequest("DELETE", `/api/admin/channels/${channel.channelId}`);
    expect(del.status).toBe(204);
    expect(await del.text()).toBe("");

    // KV 三前缀全清。
    const channels = await listChannels(env);
    expect(channels.find((c) => c.channelId === channel.channelId)).toBeUndefined();
    expect(await resolveChannelKey(env, channel.channelKey)).toBeNull();
    expect(await resolveSendKey(env, channel.sendKeys[0].key)).toBeNull();
    expect(await resolveSendKey(env, extraKey)).toBeNull();

    // DO 直达（deleteAll 后构造器重建空表）：messages 0 行 + alarm 为 null。
    const after = await readDoState(channel.channelId);
    expect(after.messageCount).toBe(0);
    expect(after.alarm).toBeNull();
  });

  it("不存在 channelId -> 404 not_found；无鉴权 -> 401 invalid_key", async () => {
    const channel = await createChannelViaApi(`del-edge-${uniqueSuffix()}`);
    // 不存在的 channelId（格式合法 16 字符但 id: miss）。
    await expectErrorEnvelope(
      await adminRequest("DELETE", `/api/admin/channels/${"q".repeat(16)}`),
      404,
      "not_found",
    );
    // 无 Authorization：鉴权先于路由判定。
    await expectErrorEnvelope(
      await adminRequest("DELETE", `/api/admin/channels/${channel.channelId}`, {
        key: null,
      }),
      401,
      "invalid_key",
    );
    // 清理（本用例的建频道不删除会残留共享存储——顺手删净）。
    expect(
      (await adminRequest("DELETE", `/api/admin/channels/${channel.channelId}`)).status,
    ).toBe(204);
  });

  it("purge 幂等重放：二次 DELETE 同频道 404 不抛错（重试安全，key_links）", async () => {
    const channel = await createChannelViaApi(`del-idem-${uniqueSuffix()}`);
    expect(
      (await adminRequest("DELETE", `/api/admin/channels/${channel.channelId}`)).status,
    ).toBe(204);

    // 二次 DELETE：id: 已删 -> 读 id: miss -> 404 not_found（不抛错、不再触 DO）。
    await expectErrorEnvelope(
      await adminRequest("DELETE", `/api/admin/channels/${channel.channelId}`),
      404,
      "not_found",
    );
  });
});
