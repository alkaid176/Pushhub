/**
 * Admin API 最小集（D-12/D-13，KEY-01）——01-05；03-02 增 Send Key 生命周期。
 *
 * 路由（index.ts 以 /api/admin/ 前缀分发进入，鉴权先于路由判定——
 * 不鉴权不暴露路径存在性）：
 *   POST /api/admin/channels                            建频道 -> 201 {channelId, channelKey, sendKeys, name, createdAt}
 *   GET  /api/admin/channels                            列频道 -> 200 {channels: [ChannelRecord...]}
 *   POST /api/admin/channels/:channelId/send-keys       建 Send Key -> 201 {key, label, createdAt}（03-02，D-30/D-31）
 *   DELETE /api/admin/channels/:channelId/send-keys/:key 吊销 -> 204（03-02，D-32）
 *   参数化骨架的 reset-channel-key / messages / DELETE 频道分支占位 404（后续 plan 扩展）
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
  listChannels,
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
  /^\/api\/admin\/channels\/([^/]+)(?:\/(send-keys|reset-channel-key|messages))?(?:\/(.+))?$/;

// Worker→DO 内部转发常量（与 index.ts 同名同值约定——该文件不导出，照
// chat-room.ts SEND_KEY_HEADER 同款本地声明）。
const INTERNAL_ORIGIN = "https://do.pushhub.internal";
const VERIFIED_HEADER = "X-PH-Verified";
const SEND_KEY_HEADER = "X-PH-Send-Key";

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

/** /api/admin/* 处理器（由 index.ts 前缀分发）。 */
export async function handleAdminApi(request: Request, env: Env): Promise<Response> {
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

  // reset-channel-key / messages / DELETE 频道本体：路由骨架已定型，分支留
  // 占位 404 由后续 plan 扩展（本任务只实现 send-keys 两分支）。
  return NOT_FOUND();
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
 *  2. KV 前两环（sk: delete + id: 重写，keys.ts revokeSendKeyRecord）；
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

  await revokeSendKeyRecord(env, channelId, key);

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
