/**
 * KEY-03/D-30/D-31/D-32 集成测试：Send Key 全生命周期（创建/上限/吊销三存储联动）。
 *
 * 覆盖（must_haves 全量）：
 *  - D-30 创建：POST /api/admin/channels/:channelId/send-keys -> 201
 *    {key: phs_+32, label, createdAt}；label 缺省/null -> label: null；
 *    非 string / 超 64 码元 -> 400 invalid_body；非 JSON -> 400 invalid_json；
 *    列表 API 该频道 sendKeys 含新 Key。
 *  - D-31 上限：第 11 个 POST -> 400 send_key_limit（body.error.code 断言）；
 *    上限检查在 KV 写之前——超限后列表仍恰 10 个，无第 11 个 Key 落盘。
 *  - D-32 吊销：DELETE .../send-keys/:key -> 204 空体；该 Key 下次 /api/send
 *    -> 401 invalid_key；同频道其余 Key 照常 200（泄露不互伤）；三存储联动
 *    ——KV sk: 删除（401 即证）+ id: 重写移除（列表断言）+ DO rate_sends 行
 *    即时删除（runInDurableObject 直读，仅该 Key 行被删）。
 *  - T-03-07 防探测：channelId 段非法（15 字符）与不存在同 404 同文案；
 *    DELETE 不存在的 Key / 属于其他频道的 Key / 不存在的 channelId -> 404。
 *  - 两路由无 Authorization -> 401 invalid_key（checkAdminAuth 先于路由判定
 *    ——不鉴权不暴露路径存在性）。
 *
 * 「吊销后立即 401」确定性说明：本地 miniflare KV 无缓存层（源码实证 cacheTtl
 * 只校验不生效），断言确定性成立；生产语义为 ≤60s 边缘缓存双活窗口
 * （keys.ts 文档化行为，非测试覆盖目标）。
 *
 * 隔离策略：--max-workers=1 --no-isolate 共享存储——频道名经
 * crypto.randomUUID() 派生唯一（admin-channels 同款）。
 */
import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

/** 必须与 vitest.config.ts miniflare.bindings 注入值一致（测试专用，非生产 secret）。 */
const TEST_ADMIN_KEY = "test-admin-key-0123456789abcdef";

function uniqueSuffix(): string {
  return crypto.randomUUID().slice(0, 8);
}

/** 经真实 Worker 入口发 Admin API 请求（覆盖 index.ts 前缀分发 + admin.ts 路由）。 */
function adminRequest(
  method: string,
  path: string,
  options?: { body?: string; key?: string | null },
): Promise<Response> {
  const headers: Record<string, string> = {};
  const key = options?.key === undefined ? TEST_ADMIN_KEY : options.key;
  if (key !== null) headers.Authorization = `Bearer ${key}`;
  if (options?.body !== undefined) headers["content-type"] = "application/json";
  return exports.default.fetch(
    new Request(`https://example.com${path}`, {
      method,
      headers,
      body: options?.body,
    }),
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
): Promise<{ code: string; message: string }> {
  expect(resp.status).toBe(status);
  const body = (await resp.json()) as { error: { code: string; message: string } };
  expect(body.error.code).toBe(code);
  return body.error;
}

interface CreatedChannel {
  channelId: string;
  channelKey: string;
  sendKeys: { key: string; label: string | null; createdAt: number }[];
  name: string;
  createdAt: number;
}

async function createChannelViaApi(name: string): Promise<CreatedChannel> {
  const resp = await adminRequest("POST", "/api/admin/channels", {
    body: JSON.stringify({ name }),
  });
  expect(resp.status).toBe(201);
  return (await resp.json()) as CreatedChannel;
}

async function createSendKeyViaApi(
  channelId: string,
  label?: string,
): Promise<Response> {
  return adminRequest("POST", `/api/admin/channels/${channelId}/send-keys`, {
    body: label === undefined ? "{}" : JSON.stringify({ label }),
  });
}

/** GET 列表中找该频道（id: 反向索引数据源）。 */
async function findChannelInList(channelId: string): Promise<CreatedChannel> {
  const resp = await adminRequest("GET", "/api/admin/channels");
  expect(resp.status).toBe(200);
  const body = (await resp.json()) as { channels: CreatedChannel[] };
  const found = body.channels.find((c) => c.channelId === channelId);
  expect(found).toBeDefined();
  return found!;
}

/** DO rate_sends 表全部 send_key（runInDurableObject 直读——三存储联动第三环）。 */
function readRateSendKeys(channelId: string): Promise<string[]> {
  return runInDurableObject(
    env.CHANNELS.getByName(channelId),
    (_obj: unknown, state: DurableObjectState) =>
      (
        state.storage.sql
          .exec("SELECT send_key FROM rate_sends")
          .toArray() as unknown as { send_key: string }[]
      ).map((r) => r.send_key),
  );
}

describe("POST send-keys 创建（D-30）", () => {
  it("201 {key,label,createdAt}：phs_ 前缀恰 32 字符、label 回显、列表含新 Key", async () => {
    const channel = await createChannelViaApi(`sk-create-${uniqueSuffix()}`);
    const resp = await createSendKeyViaApi(channel.channelId, "deploy-bot");
    expect(resp.status).toBe(201);
    const rec = (await resp.json()) as {
      key: string;
      label: string | null;
      createdAt: number;
    };
    expect(rec.key).toMatch(/^phs_[0-9A-Za-z]{32}$/);
    expect(rec.key.length).toBe(4 + 32);
    expect(rec.label).toBe("deploy-bot");
    expect(Number.isInteger(rec.createdAt)).toBe(true);

    const listed = await findChannelInList(channel.channelId);
    expect(
      listed.sendKeys.some((r) => r.key === rec.key && r.label === "deploy-bot"),
    ).toBe(true);
  });

  it("label 缺省（{}）或 null -> 201 label: null（可留空标签）", async () => {
    const channel = await createChannelViaApi(`sk-null-${uniqueSuffix()}`);

    const r1 = await createSendKeyViaApi(channel.channelId);
    expect(r1.status).toBe(201);
    expect(((await r1.json()) as { label: string | null }).label).toBeNull();

    const r2 = await adminRequest(
      "POST",
      `/api/admin/channels/${channel.channelId}/send-keys`,
      { body: JSON.stringify({ label: null }) },
    );
    expect(r2.status).toBe(201);
    expect(((await r2.json()) as { label: string | null }).label).toBeNull();
  });

  it("label 非 string / 超 64 码元 -> 400 invalid_body；非 JSON -> 400 invalid_json", async () => {
    const channel = await createChannelViaApi(`sk-bad-${uniqueSuffix()}`);
    const base = `/api/admin/channels/${channel.channelId}/send-keys`;

    await expectErrorEnvelope(
      await adminRequest("POST", base, { body: JSON.stringify({ label: 42 }) }),
      400,
      "invalid_body",
    );
    await expectErrorEnvelope(
      await adminRequest("POST", base, {
        body: JSON.stringify({ label: "x".repeat(65) }),
      }),
      400,
      "invalid_body",
    );
    await expectErrorEnvelope(
      await adminRequest("POST", base, { body: "not-json{{{" }),
      400,
      "invalid_json",
    );
  });
});

describe("上限 10（D-31——防公网脚本循环建 Key 烧 KV 写额度）", () => {
  it("第 11 个 POST -> 400 send_key_limit 且无第 11 个 Key 落盘（检查在写前）", async () => {
    const channel = await createChannelViaApi(`sk-limit-${uniqueSuffix()}`);
    // 建频道自带 1 个 Key；再 API 建 9 个 -> 恰 10。
    for (let i = 0; i < 9; i++) {
      const resp = await createSendKeyViaApi(channel.channelId, `bot-${i}`);
      expect(resp.status).toBe(201);
    }

    const resp11 = await createSendKeyViaApi(channel.channelId, "eleventh");
    const err = await expectErrorEnvelope(resp11, 400, "send_key_limit");
    expect(err.message).toContain("10");

    // 上限检查必须在 KV 写之前（key_links）：列表仍恰 10 个。
    const listed = await findChannelInList(channel.channelId);
    expect(listed.sendKeys).toHaveLength(10);
  });
});

describe("吊销 Send Key（D-32 / KEY-03 泄露不互伤）", () => {
  it("204 空体；被吊销 Key 下次 /api/send 401；同频道其余 Key 照常 200", async () => {
    const channel = await createChannelViaApi(`sk-revoke-${uniqueSuffix()}`);
    const revokedKey = channel.sendKeys[0].key;
    const sibling = await createSendKeyViaApi(channel.channelId, "monitor-script");
    expect(sibling.status).toBe(201);
    const siblingKey = ((await sibling.json()) as { key: string }).key;

    // 先证明两 Key 均可用（同时制造 rate_sends 行，供联动测试消费语义完整）。
    expect((await sendRequest(revokedKey, { text: "before revoke" })).status).toBe(200);
    expect((await sendRequest(siblingKey, { text: "sibling alive" })).status).toBe(200);

    const del = await adminRequest(
      "DELETE",
      `/api/admin/channels/${channel.channelId}/send-keys/${revokedKey}`,
    );
    expect(del.status).toBe(204);
    expect(await del.text()).toBe("");

    // 本地 miniflare KV 强一致（见文件头注释）：吊销后立即 401；
    // 生产语义为 ≤60s 边缘缓存双活窗口（文档化，非测试覆盖目标）。
    await expectErrorEnvelope(
      await sendRequest(revokedKey, { text: "should be rejected" }),
      401,
      "invalid_key",
    );
    // 同频道其余 Key 照常可发——KEY-03 核心：单独吊销不互伤。
    expect((await sendRequest(siblingKey, { text: "still works" })).status).toBe(200);
  });

  it("吊销三存储联动：rate_sends 仅该 Key 行即时删除 + id: 列表移除该 Key", async () => {
    const channel = await createChannelViaApi(`sk-link-${uniqueSuffix()}`);
    const initialKey = channel.sendKeys[0].key;
    const created = await createSendKeyViaApi(channel.channelId, "gone-bot");
    const target = ((await created.json()) as { key: string }).key;

    // 两 Key 均发一条 -> rate_sends 两行在位。
    expect((await sendRequest(initialKey, { text: "seed a" })).status).toBe(200);
    expect((await sendRequest(target, { text: "seed b" })).status).toBe(200);
    const before = await readRateSendKeys(channel.channelId);
    expect(before).toContain(target);
    expect(before).toContain(initialKey);

    const del = await adminRequest(
      "DELETE",
      `/api/admin/channels/${channel.channelId}/send-keys/${target}`,
    );
    expect(del.status).toBe(204);

    // 第三环：DO rate_sends 目标行即时删除，其余行不动（D-32 planner 裁定即时清理）。
    const after = await readRateSendKeys(channel.channelId);
    expect(after).not.toContain(target);
    expect(after).toContain(initialKey);

    // 第二环：id: 反向索引重写移除该 Key（migrate-on-write），初始 Key 保留。
    const listed = await findChannelInList(channel.channelId);
    expect(listed.sendKeys.map((r) => r.key)).toEqual([initialKey]);
  });
});

describe("404 防探测（T-03-07：格式错与不存在同信封同文案）", () => {
  it("DELETE 不存在的 Key / 属于其他频道的 Key / 不存在的 channelId -> 404 not_found", async () => {
    const channelA = await createChannelViaApi(`sk-404a-${uniqueSuffix()}`);
    const channelB = await createChannelViaApi(`sk-404b-${uniqueSuffix()}`);

    // 不存在的 Key（格式合法但 sk: miss）。
    await expectErrorEnvelope(
      await adminRequest(
        "DELETE",
        `/api/admin/channels/${channelA.channelId}/send-keys/phs_${"z".repeat(32)}`,
      ),
      404,
      "not_found",
    );
    // 属于其他频道的 Key（sk: 命中但 channelId 不匹配）。
    await expectErrorEnvelope(
      await adminRequest(
        "DELETE",
        `/api/admin/channels/${channelA.channelId}/send-keys/${channelB.sendKeys[0].key}`,
      ),
      404,
      "not_found",
    );
    // 不存在的 channelId（格式合法 16 字符但 id: miss；用 B 的真 Key 制造归属错配）。
    await expectErrorEnvelope(
      await adminRequest(
        "DELETE",
        `/api/admin/channels/${"q".repeat(16)}/send-keys/${channelB.sendKeys[0].key}`,
      ),
      404,
      "not_found",
    );
  });

  it("channelId 段非法（15 字符）与不存在（16 字符）同 404 同文案（防探测）", async () => {
    const malformed = await adminRequest(
      "POST",
      `/api/admin/channels/${"a".repeat(15)}/send-keys`,
      { body: "{}" },
    );
    const err1 = await expectErrorEnvelope(malformed, 404, "not_found");

    const nonexistent = await createSendKeyViaApi("b".repeat(16));
    const err2 = await expectErrorEnvelope(nonexistent, 404, "not_found");

    // 统一信封同文案：两者 code/message 逐字一致，不给探测方区分信号。
    expect(err2).toEqual(err1);
  });
});

describe("鉴权先于路由判定（T-03-07：不鉴权不暴露路径存在性）", () => {
  it("两路由无 Authorization -> 401 invalid_key", async () => {
    const channel = await createChannelViaApi(`sk-auth-${uniqueSuffix()}`);
    await expectErrorEnvelope(
      await adminRequest(
        "POST",
        `/api/admin/channels/${channel.channelId}/send-keys`,
        { body: "{}", key: null },
      ),
      401,
      "invalid_key",
    );
    await expectErrorEnvelope(
      await adminRequest(
        "DELETE",
        `/api/admin/channels/${channel.channelId}/send-keys/${channel.sendKeys[0].key}`,
        { key: null },
      ),
      401,
      "invalid_key",
    );
  });
});
