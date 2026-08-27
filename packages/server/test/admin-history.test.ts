/**
 * ADM-03/D-36 集成测试：管理侧消息历史查询（DO GET /history keyset 倒序
 * 翻页 + Worker GET messages 转发三段链）。
 *
 * 覆盖（behavior 全清单）：
 *  - 首页：seed 3 条（经 /api/send 全链路，非直插 SQL）→ 倒序 [3,2,1]、
 *    has_more false、oldest_kept_seq 1；messages 元素与扇出 MessageFrame
 *    逐字段同构（v/type/wid/seq/title 省略语义/text/priority/answered 四
 *    字段/created_at——SC3 回复状态零额外映射的证据）；
 *  - limit=2 → 恰 2 条 [3,2] + has_more true；
 *  - before 游标两连页：[3,2] → before=2 [1]，无重叠无遗漏；
 *  - limit 钳制：0 → 1（行为断言）；非数字 → 缺省 50；501 → 500
 *    （502 行恰回 500 + has_more true——runInDurableObject 直插播种：
 *    RATE_LIMIT_PER_MIN=30/Send Key 固定窗口使 502 条真实发送在测试窗口
 *    内必触 429，10 Key 上限也只覆盖 300 条；直插是本用例唯一可行播种法，
 *    查询路径仍走真实 Worker → DO 全链）；
 *  - 空频道 → {messages: [], has_more: false, oldest_kept_seq: 0}；
 *  - 边界：不存在 channelId → 404 not_found（id: miss 不触 DO）；
 *    无鉴权 → 401 invalid_key（鉴权先于路由判定）；
 *  - 攻击样本哑管道：含 <script>/<img onerror> 的 text 逐字返回
 *    （SRV-02——服务端不解析不消费；消毒断言在前端，见 03-04 Task 3 E2E）。
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

/** /history 响应体（D-36 契约三键；messages 元素即 MessageFrame 形态）。 */
interface HistoryMessage {
  v: number;
  type: string;
  wid: string;
  seq: number;
  title?: string;
  text: string;
  priority: string;
  answered: boolean;
  answered_by: string | null;
  answered_at: number | null;
  answered_content: string | null;
  created_at: number;
}

interface HistoryBody {
  messages: HistoryMessage[];
  has_more: boolean;
  oldest_kept_seq: number;
}

async function historyRequest(
  channelId: string,
  query = "",
): Promise<HistoryBody> {
  const resp = await adminRequest(
    "GET",
    `/api/admin/channels/${channelId}/messages${query}`,
  );
  expect(resp.status).toBe(200);
  return (await resp.json()) as HistoryBody;
}

/**
 * 经 /api/send 全链路播种消息（计划红线：非直插 SQL——publish 限流/校验/
 * seq 分配全部真实路径），返回按发送序的 seq。
 */
async function seedViaSend(
  sendKey: string,
  bodies: Record<string, unknown>[],
): Promise<number[]> {
  const seqs: number[] = [];
  for (const body of bodies) {
    const resp = await sendRequest(sendKey, body);
    expect(resp.status).toBe(200);
    seqs.push(((await resp.json()) as { seq: number }).seq);
  }
  return seqs;
}

/**
 * 上限钳制用例（limit=501）的直插播种：见文件头注释——限流 30/分/Send Key
 * + 每 Key 窗口内 30 条 + 频道上限 10 Key = 单测试窗口最多 300 条真实发送，
 * 502 条不可行。直插行与 handlePublish 同列同形（answered 恒初始值）。
 */
async function seedRowsDirect(channelId: string, count: number): Promise<void> {
  await runInDurableObject(
    env.CHANNELS.getByName(channelId),
    async (_obj: unknown, state: DurableObjectState) => {
      for (let seq = 1; seq <= count; seq++) {
        state.storage.sql.exec(
          "INSERT INTO messages (seq, wid, title, text, options, callback_url, click_url, priority, answered, answered_by, answered_at, answered_content, created_at) " +
            "VALUES (?1, ?2, NULL, ?3, NULL, NULL, NULL, 'normal', 0, NULL, NULL, NULL, ?4)",
          seq,
          `m_direct${String(seq).padStart(16, "0")}`,
          `direct row ${seq}`,
          1_700_000_000_000 + seq,
        );
      }
    },
  );
}

describe("GET /api/admin/channels/:id/messages（D-36 keyset 倒序翻页）", () => {
  it("首页：seed 3 条 → 倒序 [3,2,1]、has_more false、oldest_kept_seq 1、answered 四字段与 MessageFrame 同构", async () => {
    const channel = await createChannelViaApi(`hist-first-${uniqueSuffix()}`);
    const seqs = await seedViaSend(channel.sendKeys[0].key, [
      { title: "首条", text: "message one" },
      { text: "message two" },
      { title: "末条", text: "message three" },
    ]);
    expect(seqs).toEqual([1, 2, 3]);

    const body = await historyRequest(channel.channelId);
    expect(body.messages).toHaveLength(3);
    expect(body.messages.map((m) => m.seq)).toEqual([3, 2, 1]);
    expect(body.has_more).toBe(false);
    expect(body.oldest_kept_seq).toBe(1);

    // 元素与扇出 MessageFrame 逐字段同构（rowToMessageFrame 复用，无新映射）。
    const first = body.messages[0];
    expect(first.v).toBe(1);
    expect(first.type).toBe("message");
    expect(first.wid).toMatch(/^m_[0-9A-Za-z]{16}$/);
    expect(first.text).toBe("message three");
    expect(first.title).toBe("末条");
    expect(first.priority).toBe("normal");
    expect(Number.isInteger(first.created_at)).toBe(true);
    // answered 四字段（D-03 首帧定全；本 Phase 恒初始值）。
    expect(first.answered).toBe(false);
    expect(first.answered_by).toBeNull();
    expect(first.answered_at).toBeNull();
    expect(first.answered_content).toBeNull();
    // 无 title 消息：键省略（省略语义——未提供时键不出现，永不为空串）。
    expect("title" in body.messages[1]).toBe(false);
    expect(body.messages[1].text).toBe("message two");
  });

  it("?limit=2 → 恰 2 条 [seq3, seq2] 且 has_more true", async () => {
    const channel = await createChannelViaApi(`hist-limit-${uniqueSuffix()}`);
    await seedViaSend(channel.sendKeys[0].key, [
      { text: "one" },
      { text: "two" },
      { text: "three" },
    ]);

    const body = await historyRequest(channel.channelId, "?limit=2");
    expect(body.messages).toHaveLength(2);
    expect(body.messages.map((m) => m.seq)).toEqual([3, 2]);
    expect(body.has_more).toBe(true);
    expect(body.oldest_kept_seq).toBe(1);
  });

  it("before 游标两连页：首页 [3,2] → before=2 [1]，无重叠无遗漏；before=3&limit=2 → [2,1]", async () => {
    const channel = await createChannelViaApi(`hist-cursor-${uniqueSuffix()}`);
    await seedViaSend(channel.sendKeys[0].key, [
      { text: "one" },
      { text: "two" },
      { text: "three" },
    ]);

    // 连页一：limit=2 首页。
    const page1 = await historyRequest(channel.channelId, "?limit=2");
    expect(page1.messages.map((m) => m.seq)).toEqual([3, 2]);
    expect(page1.has_more).toBe(true);

    // 连页二：before = 本页最小 seq（2）→ 恰余 [1]。
    const page2 = await historyRequest(channel.channelId, "?before=2");
    expect(page2.messages.map((m) => m.seq)).toEqual([1]);
    expect(page2.has_more).toBe(false);

    // 无重叠无遗漏：两页并集恰全集、零重复。
    const all = [...page1.messages, ...page2.messages].map((m) => m.seq);
    expect(all).toHaveLength(3);
    expect(new Set(all).size).toBe(3);

    // 计划字面用例：before=3&limit=2 → [2,1] has_more false。
    const body = await historyRequest(channel.channelId, "?before=3&limit=2");
    expect(body.messages.map((m) => m.seq)).toEqual([2, 1]);
    expect(body.has_more).toBe(false);
  });

  it("limit 钳制下界与非数字：?limit=0 → 恰 1 条最新 + has_more true；?limit=abc → 按缺省 50（全量 3 条）", async () => {
    const channel = await createChannelViaApi(`hist-clamp-${uniqueSuffix()}`);
    await seedViaSend(channel.sendKeys[0].key, [
      { text: "one" },
      { text: "two" },
      { text: "three" },
    ]);

    // 0 抬到 1（行为断言：返回恰 1 条最新）。
    const zero = await historyRequest(channel.channelId, "?limit=0");
    expect(zero.messages).toHaveLength(1);
    expect(zero.messages[0].seq).toBe(3);
    expect(zero.has_more).toBe(true);

    // 非数字归缺省 50（宽松语义：错值不 400，归缺省）。
    const abc = await historyRequest(channel.channelId, "?limit=abc");
    expect(abc.messages).toHaveLength(3);
    expect(abc.has_more).toBe(false);
  });

  it("limit 钳制上界：?limit=501 → 恰 500 条 + has_more true（502 行直插播种——限流使真实发送不可行，见文件头）", async () => {
    const channel = await createChannelViaApi(`hist-cap-${uniqueSuffix()}`);
    await seedRowsDirect(channel.channelId, 502);

    const body = await historyRequest(channel.channelId, "?limit=501");
    // 501 压到 500：恰 500 条，最新 seq 502 在首、最旧为 seq 3（500 条窗口）。
    expect(body.messages).toHaveLength(500);
    expect(body.messages[0].seq).toBe(502);
    expect(body.messages[499].seq).toBe(3);
    expect(body.has_more).toBe(true);
    expect(body.oldest_kept_seq).toBe(1);

    // 缺省 50 同频道对照（首页恰 50 条）。
    const def = await historyRequest(channel.channelId);
    expect(def.messages).toHaveLength(50);
    expect(def.messages[0].seq).toBe(502);
    expect(def.has_more).toBe(true);
  });

  it("空频道 → {messages: [], has_more: false, oldest_kept_seq: 0}", async () => {
    const channel = await createChannelViaApi(`hist-empty-${uniqueSuffix()}`);
    const body = await historyRequest(channel.channelId);
    expect(body.messages).toEqual([]);
    expect(body.has_more).toBe(false);
    expect(body.oldest_kept_seq).toBe(0);
  });

  it("不存在 channelId → 404 not_found；无鉴权 → 401 invalid_key", async () => {
    // 格式合法 16 字符但 id: miss（404 不触 DO——KV 读先于转发）。
    await expectErrorEnvelope(
      await adminRequest("GET", `/api/admin/channels/${"q".repeat(16)}/messages`),
      404,
      "not_found",
    );
    // 无 Authorization：鉴权先于路由判定（T-03-17 双防线之 Worker 侧）。
    const channel = await createChannelViaApi(`hist-edge-${uniqueSuffix()}`);
    await expectErrorEnvelope(
      await adminRequest("GET", `/api/admin/channels/${channel.channelId}/messages`, {
        key: null,
      }),
      401,
      "invalid_key",
    );
    // 清理（共享存储不残留）。
    expect(
      (await adminRequest("DELETE", `/api/admin/channels/${channel.channelId}`)).status,
    ).toBe(204);
  });

  it("攻击样本哑管道：<script>/<img onerror> 文本逐字返回（SRV-02——服务端不解析不消费；消毒断言在前端 Task 3 E2E）", async () => {
    const channel = await createChannelViaApi(`hist-attack-${uniqueSuffix()}`);
    const attack =
      '<script>alert("xss")</script>后置文本 <img src=x onerror=alert(1)>';
    await seedViaSend(channel.sendKeys[0].key, [{ text: attack }]);

    const body = await historyRequest(channel.channelId);
    expect(body.messages).toHaveLength(1);
    // 逐字节等值：存储与查询管道均不触碰原文。
    expect(body.messages[0].text).toBe(attack);
  });
});
