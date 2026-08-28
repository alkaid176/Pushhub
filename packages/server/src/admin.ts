/**
 * Admin API 最小集（D-12/D-13，KEY-01）——01-05；03-02 增 Send Key 生命周期。
 *
 * 路由（index.ts 以 /api/admin/ 前缀分发进入，鉴权先于路由判定——
 * 不鉴权不暴露路径存在性）：
 *   POST /api/admin/channels                            建频道 -> 201 {channelId, channelKey, sendKeys, name, createdAt}
 *   GET  /api/admin/channels                            列频道 -> 200 {channels: [ChannelRecord...]}
 *   POST /api/admin/channels/:channelId/send-keys       建 Send Key -> 201 {key, label, createdAt}（03-02，D-30/D-31）
 *   DELETE /api/admin/channels/:channelId/send-keys/:key 吊销 -> 204（03-02，D-32）
 *   POST /api/admin/channels/:channelId/reset-channel-key 重置 Channel Key -> 201 {channelKey}（03-03，D-33——KV 写先 DO 踢后）
 *   GET  /api/admin/channels/:channelId/signing-secret   查 signing secret -> 200 {signingSecret}（04-02，D-47——旧格式记录 migrate-on-touch 惰性补发）
 *   POST /api/admin/channels/:channelId/signing-secret   重置 signing secret -> 201 {signingSecret}（04-02，D-47/T-04-09——独立轮换，KV 写先 DO meta 更新后）
 *   DELETE /api/admin/channels/:channelId               删除频道 -> 204（03-03，D-34——DO purge 先 KV 键删后，one-way）
 *   GET  /api/admin/channels/:channelId/messages?before=&limit= 消息历史 -> 200 {messages, has_more, oldest_kept_seq}（03-04，D-36——X-PH-Verified 转发 DO /history）
 *
 * Admin Key 鉴权（D-13）：Authorization: Bearer <ADMIN_KEY>（Worker secret，
 * wrangler secret put 写入）。两段式常时比较（Pattern 6）：先比长度（不同直接
 * 401——规避 timingSafeEqual 长度不等抛错的时序泄漏），等长再
 * crypto.subtle.timingSafeEqual 常时比较。401 与业务密钥同码同文案——
 * 不给探测方"接近正确"的区分信号（T-01-03）。
 *
 * ADMIN_KEY 未配置（secret 缺失）-> 500 server_error 通用信封（Flagged
 * Assumption KEY-01：最小信息量原则，不泄漏配置细节）。失败路径不记录
 * 提交的凭据值、响应不回显（Prohibition：密钥不落日志）。
 *
 * 边界（D-13）：删除/重置频道不预建——后续 plan。201 是密钥唯一完整返回点
 * （T-01-04 预期行为：创建时一次性下发——建 Send Key 同延续此先例）。
 */
import {
  createChannel,
  createSendKeyRecord,
  deleteChannelKeys,
  listChannels,
  readChannelRecord,
  readOrProvisionSigningSecret,
  resetChannelKey,
  resetSigningSecret,
  resolveSendKey,
  revokeSendKeyRecord,
  SEND_KEY_LIMIT,
} from "./keys";
import { errorEnvelope } from "./envelope";

/** D-12 契约：频道名上限 64 字符（UTF-16 码元，与 LIMITS 同口径）；label 同限（D-30）。 */
export const CHANNEL_NAME_MAX_LENGTH = 64;

/**
 * channelId 路径段白名单（D-35 参数化路由，T-03-07）：16 字符 base62，与
 * generateChannelId 产出同口径。格式错与不存在同走 404 同文案——防探测。
 */
const CHANNEL_ID_RE = /^[0-9A-Za-z]{16}$/;

/**
 * 参数化路由解析（D-35）：/api/admin/channels/:channelId[/:sub[/:tail]]。
 * sub 白名单限定本阶段已知资源段；其余子路径（含尾段乱形）落入占位 404。
 */
const CHANNELS_PATH_RE =
  /^\/api\/admin\/channels\/([^/]+)(?:\/(send-keys|reset-channel-key|messages|signing-secret))?(?:\/(.+))?$/;

// Worker→DO 内部转发常量（与 index.ts 同名同值约定——该文件不导出，照
// chat-room.ts SEND_KEY_HEADER 同款本地声明）。
const INTERNAL_ORIGIN = "https://do.pushhub.internal";
const VERIFIED_HEADER = "X-PH-Verified";
const SEND_KEY_HEADER = "X-PH-Send-Key";
/** DO 代际校验用的 Channel Key 原值（WR-02；chat-room.ts 同名同值约定）。 */
const CHANNEL_KEY_HEADER = "X-PH-Channel-Key";
/** Worker→DO 可信内部头：signing secret 原值（04-02 D-47；index.ts/chat-room.ts 同名同值约定）。 */
const SIGNING_SECRET_HEADER = "X-PH-Signing-Secret";
/** Worker→DO 可信内部头：频道 ID（04-02 D-49 回调 body 的 channel_id 数据源）。 */
const CHANNEL_ID_HEADER = "X-PH-Channel-Id";

/** 未知 admin 路径/方法与"不存在"统一信封（不扩 D-06 错误码面；T-03-07 防探测）。 */
const NOT_FOUND = () =>
  errorEnvelope(404, "not_found", "The requested resource was not found.");

const INVALID_KEY = () => errorEnvelope(401, "invalid_key", "Missing or invalid credentials.");

/**
 * Admin Key 校验（D-13 两段式常时比较）。通过返回 null；否则返回应直接
 * 回给客户端的信封响应。
 */
function checkAdminAuth(request: Request, env: Env): Response | null {
  const expected = env.ADMIN_KEY;
  if (expected === undefined || expected === "") {
    return errorEnvelope(500, "server_error", "Internal server error.");
  }
  const auth = request.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) {
    return INVALID_KEY();
  }
  const provided = auth.slice("Bearer ".length);
  // 长度前置按 UTF-8 字节数（CR-01）：与 timingSafeEqual 的比较口径一致。
  // 若按 UTF-16 码元长度比较，等码元长度的非 ASCII Bearer 会绕过前置分支，
  // 使 timingSafeEqual 因字节长度不等抛未捕获异常 -> 500（违反"一律 401"）。
  const a = new TextEncoder().encode(provided);
  const b = new TextEncoder().encode(expected);
  if (a.length !== b.length) {
    return INVALID_KEY();
  }
  if (!crypto.subtle.timingSafeEqual(a, b)) {
    return INVALID_KEY();
  }
  return null;
}

/**
 * /api/admin/* 处理器（由 index.ts 前缀分发）。
 *
 * WR-04：顶层异常兜底——KV/DO 意外失败（put 超额/瞬断、DO fetch 网络异常、
 * 生产 KV 同 key 1 写/秒限制触发 429 等）统一映射 D-06 通用 500 信封，不
 * 泄漏内部细节（D-13 最小信息量）。裸 500 文本会破坏「发送方脚本程序化
 * 消费 code」的冻结契约；checkAdminAuth 对 ADMIN_KEY 缺失已映射 500 信封，
 * 此处覆盖其余一切意外路径。
 */
export async function handleAdminApi(request: Request, env: Env): Promise<Response> {
  try {
    return await routeAdminApi(request, env);
  } catch {
    return errorEnvelope(500, "server_error", "Internal server error.");
  }
}

/** 路由分发本体（原 handleAdminApi 主体，由 WR-04 兜底层包裹）。 */
async function routeAdminApi(request: Request, env: Env): Promise<Response> {
  const denied = checkAdminAuth(request, env);
  if (denied !== null) {
    return denied;
  }

  const pathname = new URL(request.url).pathname;

  // ---- 精确匹配：频道集合（既有两路由，D-12） ----
  if (pathname === "/api/admin/channels") {
    if (request.method === "POST") {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return errorEnvelope(400, "invalid_json", "Request body must be valid JSON.");
      }
      const name = (body as { name?: unknown } | null)?.name;
      if (typeof name !== "string") {
        return errorEnvelope(400, "invalid_body", "Field 'name' is required and must be a string.");
      }
      if (name.length > CHANNEL_NAME_MAX_LENGTH) {
        return errorEnvelope(
          400,
          "invalid_body",
          `Field 'name' exceeds the maximum length of ${CHANNEL_NAME_MAX_LENGTH} characters.`,
        );
      }
      const channel = await createChannel(env, name);
      return new Response(JSON.stringify(channel), {
        status: 201,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    if (request.method === "GET") {
      const channels = await listChannels(env);
      return new Response(JSON.stringify({ channels }), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    return NOT_FOUND();
  }

  // ---- 参数化路由（D-35）：/api/admin/channels/:channelId/... ----
  const match = CHANNELS_PATH_RE.exec(pathname);
  if (match === null) {
    return NOT_FOUND();
  }
  const [, channelId, sub, tail] = match;
  // 白名单先行：格式错与不存在同 404 同文案（T-03-07 防探测）。
  if (!CHANNEL_ID_RE.test(channelId)) {
    return NOT_FOUND();
  }

  if (sub === "send-keys" && tail === undefined && request.method === "POST") {
    return handleCreateSendKey(request, env, channelId);
  }
  if (sub === "send-keys" && tail !== undefined && request.method === "DELETE") {
    // 畸形编码（非法 % 序列）与 miss 同路径 404（SRV-03 同裁决）。
    let key: string;
    try {
      key = decodeURIComponent(tail);
    } catch {
      return NOT_FOUND();
    }
    return handleRevokeSendKey(env, channelId, key);
  }
  if (sub === "reset-channel-key" && tail === undefined && request.method === "POST") {
    return handleResetChannelKey(env, channelId);
  }
  if (sub === "signing-secret" && tail === undefined && request.method === "GET") {
    return handleRevealSigningSecret(env, channelId);
  }
  if (sub === "signing-secret" && tail === undefined && request.method === "POST") {
    return handleResetSigningSecret(env, channelId);
  }
  if (sub === undefined && tail === undefined && request.method === "DELETE") {
    return handleDeleteChannel(env, channelId);
  }
  if (sub === "messages" && tail === undefined && request.method === "GET") {
    return handleGetMessages(request, env, channelId);
  }

  return NOT_FOUND();
}

/**
 * POST /api/admin/channels/:channelId/reset-channel-key（D-33，KEY-04）：
 * KV 写先（keys.ts resetChannelKey——删 ch:old + 写 ch:new + 重写 id:，
 * name/sendKeys/createdAt 原样保留）→ DO POST /kick-all 转发后 → 201
 * {channelKey: 新值}（密钥唯一完整返回点先例延续）。
 *
 * 顺序红线（key_links）：KV 写先 DO 踢后——反序（先踢后写）制造旧 Key
 * 无限重挂窗口（被踢客户端立即以边缘缓存的旧 ch: 值重连成功后再无人
 * 踢它）。DO 转发失败不阻断 201：踢连是尽力语义，KV 已切换，生产
 * ≤60s 边缘缓存窗口后旧 Key 自然失效（文档化行为）。
 */
async function handleResetChannelKey(
  env: Env,
  channelId: string,
): Promise<Response> {
  const record = await resetChannelKey(env, channelId);
  if (record === null) {
    return NOT_FOUND();
  }
  try {
    const forward = new Request(`${INTERNAL_ORIGIN}/kick-all`, {
      method: "POST",
      // WR-02 代际落盘：携带 KV 重写后的新 Channel Key——DO 侧 meta 表
      // 记录当前代际，WS 升级路径据此拒绝 ≤60s 缓存窗口内旧 Key 重挂
      //（W-1 修复：此前只声明常量未接线，代际机制失活）。
      headers: {
        [VERIFIED_HEADER]: "1",
        [CHANNEL_KEY_HEADER]: record.channelKey,
      },
    });
    await env.CHANNELS.getByName(channelId).fetch(forward);
  } catch {
    // 见函数头注释：踢连尽力语义，不阻断 201。
  }
  return new Response(JSON.stringify({ channelKey: record.channelKey }), {
    status: 201,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/**
 * GET /api/admin/channels/:channelId/signing-secret（04-02，D-47）：reveal。
 * 读 ch: 记录（id: -> channelKey 定位链在 keys.ts）；signingSecret 缺省时
 * migrate-on-touch 惰性补发（生成 + KV 补写后返回——0.1.12 前遗留频道的零
 * 迁移演进路径）。API 返回完整值给 Admin Key 持有者（D-13 两段式常时比较
 * 前置鉴权已覆盖本分支；掩码显示是前端层职责，本期无 UI——Q1 裁决）。
 */
async function handleRevealSigningSecret(
  env: Env,
  channelId: string,
): Promise<Response> {
  const result = await readOrProvisionSigningSecret(env, channelId);
  if (result === null) {
    return NOT_FOUND();
  }
  return new Response(JSON.stringify({ signingSecret: result.secret }), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/**
 * POST /api/admin/channels/:channelId/signing-secret（04-02，D-47/T-04-09）：
 * 独立轮换 signing secret（Channel Key / Send Key 均不动——KEY-04 分级隔离）。
 * 顺序照 handleResetChannelKey 结构：KV 写先（keys.ts resetSigningSecret 整值
 * 重写 ch:）→ DO POST /set-signing-secret 转发后（尽力更新 meta，try/catch
 * 吞转发失败——下次 /ws 连接会以 KV 权威值重写 meta，窗口自然收敛）→ 201
 * 返回完整新 secret（密钥唯一完整返回点先例延续）。
 */
async function handleResetSigningSecret(
  env: Env,
  channelId: string,
): Promise<Response> {
  const secret = await resetSigningSecret(env, channelId);
  if (secret === null) {
    return NOT_FOUND();
  }
  try {
    const forward = new Request(`${INTERNAL_ORIGIN}/set-signing-secret`, {
      method: "POST",
      headers: {
        [VERIFIED_HEADER]: "1",
        [SIGNING_SECRET_HEADER]: secret,
        [CHANNEL_ID_HEADER]: channelId,
      },
    });
    await env.CHANNELS.getByName(channelId).fetch(forward);
  } catch {
    // 见函数头注释：meta 更新尽力语义，不阻断 201。
  }
  return new Response(JSON.stringify({ signingSecret: secret }), {
    status: 201,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/**
 * DELETE /api/admin/channels/:channelId（D-34 硬删除，one-way）：
 * 读 id:（经 normalize，miss -> 404）→ DO POST /purge 转发先（踢连 +
 * deleteAll + deleteAlarm 成对清库）→ keys.ts deleteChannelKeys 后
 * （ch:old + 全部 sk: + id: 逐键删，id: 最后落）→ 204 空体。
 *
 * 顺序红线（key_links）：DO 先 KV 后——反序产生不可达孤儿 DO（频道从
 * 列表消失、无法重试）；正序部分失败时频道仍在列表，整链重试幂等
 * （KV delete 幂等 + purge 对已清 DO 是 no-op）。DO purge 转发失败时
 * 不落任何 KV 删除（500 server_error，频道完整保留可重试）。
 */
async function handleDeleteChannel(
  env: Env,
  channelId: string,
): Promise<Response> {
  const record = await readChannelRecord(env, channelId);
  if (record === null) {
    return NOT_FOUND();
  }
  let purgeOk = false;
  try {
    const forward = new Request(`${INTERNAL_ORIGIN}/purge`, {
      method: "POST",
      headers: { [VERIFIED_HEADER]: "1" },
    });
    const resp = await env.CHANNELS.getByName(channelId).fetch(forward);
    purgeOk = resp.ok;
  } catch {
    purgeOk = false;
  }
  if (!purgeOk) {
    // 不落 KV 删除：频道完整保留在列表，删除链可整链重试（幂等）。
    return errorEnvelope(500, "server_error", "Internal server error.");
  }
  // CR-01 第 4 点/IN-04：purge 是网络往返——期间可能发生重置（ch: 换代）或
  // 新建 Send Key。purge 后重读 id: 取最新 channelKey；deleteChannelKeys
  // 内部另做 sk: 现扫权威快照并与快照取并集，共同缩窄 TOCTOU 窗口。
  const fresh = await readChannelRecord(env, channelId);
  await deleteChannelKeys(env, fresh ?? record);
  return new Response(null, { status: 204 });
}

/**
 * GET /api/admin/channels/:channelId/messages?before=&limit=（03-04，D-36
 * 最后一条参数化路由，ADM-03 排障入口）：读 id:（经 normalize，miss -> 404
 * 不触 DO——T-03-17 越权读取防线 + T-03-19 探测面统一文案）→ 原查询串
 * 透传转发 DO GET /history（before/limit 原样到达 DO——数值钳制在 DO 层
 * 单点，本层不重复解析避免两处钳制漂移）→ 直接返回 DO 响应。
 * 行映射与响应契约在 DO 侧单点（{messages, has_more, oldest_kept_seq}，
 * messages 元素与扇出 MessageFrame 逐字段同构——含 answered 四字段）。
 */
async function handleGetMessages(
  request: Request,
  env: Env,
  channelId: string,
): Promise<Response> {
  const record = await readChannelRecord(env, channelId);
  if (record === null) {
    return NOT_FOUND();
  }
  const search = new URL(request.url).search;
  const forward = new Request(`${INTERNAL_ORIGIN}/history${search}`, {
    method: "GET",
    headers: { [VERIFIED_HEADER]: "1" },
  });
  return env.CHANNELS.getByName(channelId).fetch(forward);
}

/**
 * POST /api/admin/channels/:channelId/send-keys（D-30/D-31）：
 * label 可选（缺省/null = 无标签）、string、≤64 UTF-16 码元（与 name 校验
 * 三段式对齐）；频道不存在 -> 404；达上限 -> 400 send_key_limit（admin 域
 * 字符串码，不扩 shared 冻结 ErrorCode 枚举——errorEnvelope 接受任意 string
 * 的既有先例）；成功 201 返回 {key, label, createdAt}（密钥唯一完整返回点）。
 */
async function handleCreateSendKey(
  request: Request,
  env: Env,
  channelId: string,
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorEnvelope(400, "invalid_json", "Request body must be valid JSON.");
  }
  const rawLabel = (body as { label?: unknown } | null)?.label;
  let label: string | null;
  if (rawLabel === undefined || rawLabel === null) {
    label = null;
  } else if (typeof rawLabel !== "string") {
    return errorEnvelope(400, "invalid_body", "Field 'label' must be a string when provided.");
  } else if (rawLabel.length > CHANNEL_NAME_MAX_LENGTH) {
    return errorEnvelope(
      400,
      "invalid_body",
      `Field 'label' exceeds the maximum length of ${CHANNEL_NAME_MAX_LENGTH} characters.`,
    );
  } else {
    label = rawLabel;
  }

  const result = await createSendKeyRecord(env, channelId, label);
  if (!result.ok) {
    if (result.reason === "limit") {
      // D-31 公网防线（T-03-06）：读 id: 计数在 KV 写之前（keys.ts 时序红线）。
      return errorEnvelope(
        400,
        "send_key_limit",
        `Send key limit reached (${SEND_KEY_LIMIT}).`,
      );
    }
    return NOT_FOUND();
  }
  return new Response(JSON.stringify(result.record), {
    status: 201,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/**
 * DELETE /api/admin/channels/:channelId/send-keys/:key（D-32）三存储联动：
 *  1. sk: 预检归属（miss 或他人频道 -> 404，防跨频道探测）；
 *  2. KV 单键删除（keys.ts revokeSendKeyRecord——CR-01 后不再重写 id:，
 *     无读-改-写竞态窗口）；
 *  3. DO /cleanup-rate 转发（rate_sends 行即时删除——转发模式照 index.ts
 *     既有先例；失败不阻断 204：残留行无害——键名永不复用 + 每日 alarm
 *     自然清扫兜底）。
 * 成功 204 空体。生产语义：KV cacheTtl 60 -> 吊销后 ≤60s 边缘缓存双活窗口
 * （本地 miniflare 强一致，测试确定性断言的对象）。
 */
async function handleRevokeSendKey(
  env: Env,
  channelId: string,
  key: string,
): Promise<Response> {
  const info = await resolveSendKey(env, key);
  if (info === null || info.channelId !== channelId) {
    return NOT_FOUND();
  }

  await revokeSendKeyRecord(env, key);

  try {
    const forward = new Request(`${INTERNAL_ORIGIN}/cleanup-rate`, {
      method: "POST",
      headers: {
        [VERIFIED_HEADER]: "1",
        [SEND_KEY_HEADER]: key,
      },
    });
    await env.CHANNELS.getByName(channelId).fetch(forward);
  } catch {
    // 见函数头注释第 3 点：清理失败不影响吊销语义（凭据已失效）。
  }

  return new Response(null, { status: 204 });
}
