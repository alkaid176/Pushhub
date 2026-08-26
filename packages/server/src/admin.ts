/**
 * Admin API 最小集（D-12/D-13，KEY-01）——01-05。
 *
 * 路由（index.ts 以 /api/admin/ 前缀分发进入，鉴权先于路由判定——
 * 不鉴权不暴露路径存在性）：
 *   POST /api/admin/channels  建频道 -> 201 {channelId, channelKey, sendKey, name, createdAt}
 *   GET  /api/admin/channels  列频道 -> 200 {channels: [ChannelRecord...]}
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
 * 边界（D-13）：删除/重置/吊销不预建——Phase 3 随管理页一起做。
 * 201 是密钥唯一完整返回点（T-01-04 预期行为：创建时一次性下发）。
 */
import { createChannel, listChannels } from "./keys";
import { errorEnvelope } from "./envelope";

/** D-12 契约：频道名上限 64 字符（UTF-16 码元，与 LIMITS 同口径）。 */
export const CHANNEL_NAME_MAX_LENGTH = 64;

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
  if (provided.length !== expected.length) {
    return INVALID_KEY();
  }
  const a = new TextEncoder().encode(provided);
  const b = new TextEncoder().encode(expected);
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
  if (pathname !== "/api/admin/channels") {
    // 未知 admin 路径与未知方法（如 PUT）一律 404 信封——不扩 D-06 错误码面。
    return errorEnvelope(404, "not_found", "The requested resource was not found.");
  }

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

  return errorEnvelope(404, "not_found", "The requested resource was not found.");
}
