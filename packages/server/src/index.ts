/**
 * PushHub Worker 入口（无状态，10ms CPU 预算）。
 *
 * 路由（01-01 切片 + 01-03 校验链）：
 *  - POST /api/send        Bearer Send Key -> KV sk: 预检 -> validateSendBody
 *                          入口即拒（413/400，不触 DO）-> DO /publish 转发
 *  - GET  /api/ws/:key     路径段 Channel Key -> KV ch: 预检 -> DO /ws 升级转发
 *
 * 鉴权原则（Pattern 6/8）：无效密钥在 Worker 层即拒绝、不创建 DO stub
 * （省额度 + 防 DoS，T-01-02）；DO 只信 Worker 转发的 X-PH-Verified: 1 内部头。
 *
 * 日志原则（Prohibition #2）：结构化日志不打印完整 URL query 与任何密钥
 * （Channel Key 在路径段、Send Key 在 Bearer 头——密钥即身份）。
 */
import { ChatRoom } from "./chat-room";
import { resolveSendKey, resolveChannelKey } from "./keys";
import { validateSendBody } from "@pushhub/shared/validators";

// wrangler.jsonc exports 声明的 DO 类必须由入口模块导出（ChatRoom 类名部署即定型）。
export { ChatRoom };

const INTERNAL_ORIGIN = "https://do.pushhub.internal";
const VERIFIED_HEADER = "X-PH-Verified";
/** Worker→DO 可信内部头：限流分键（KEY-05）用的 Send Key 原值，不外泄响应。 */
const SEND_KEY_HEADER = "X-PH-Send-Key";

/** D-06 错误信封：HTTP 状态码 + 机器可读 code；message 为通用文案，不含堆栈与内部键名。 */
function errorEnvelope(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

const INVALID_KEY = () => errorEnvelope(401, "invalid_key", "Missing or invalid credentials.");

/**
 * POST /api/send：Send Key 预检 -> validateSendBody 入口即拒 -> 转发内部 publish。
 *
 * 校验链（SRV-01，D-02/D-04/D-06，T-01-05）：KV sk: 预检通过后、DO 转发前，
 * validateSendBody 直接吃原始请求体字符串（非 JSON → 400 invalid_json；
 * 超限 → 413 payload_too_large；结构/类型/枚举违例 → 400 invalid_body），
 * 在 Worker 层完成、不唤醒 DO（10ms CPU 预算内）。
 * 错误信封 JSON 形态与 fixtures 的 error-envelope 例逐字节同构（D-06）。
 * 合法载荷以 normalized 形态转发：title/text/priority/options/callback_url/
 * click_url 原样透传——服务端不解析 Markdown、不消费 URL（SRV-02 哑管道）。
 */
async function handleSend(request: Request, env: Env): Promise<Response> {
  const auth = request.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) {
    return INVALID_KEY();
  }
  const sendKey = auth.slice("Bearer ".length);
  const info = await resolveSendKey(env, sendKey);
  if (info === null) {
    return INVALID_KEY();
  }

  // 入口即拒：校验失败不触 DO（防超大载荷撑爆 CPU/存储，T-01-05）。
  const validation = validateSendBody(await request.text());
  if (!validation.ok) {
    return errorEnvelope(validation.status, validation.code, validation.message);
  }

  // 归一化载荷作为内部 publish 请求体；Send Key 经可信内部头透传供 DO 限流分键。
  const forward = new Request(`${INTERNAL_ORIGIN}/publish`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [VERIFIED_HEADER]: "1",
      [SEND_KEY_HEADER]: sendKey,
    },
    body: JSON.stringify(validation.normalized),
  });
  return env.CHANNELS.getByName(info.channelId).fetch(forward);
}

/**
 * GET /api/ws/:channelKey：Channel Key 预检（浏览器 WS 无法带鉴权头——密钥走路径段）。
 * 无效密钥不创建 DO stub（防 DoS，T-01-02）；命中则转发 WS 升级。
 */
async function handleWebSocket(request: Request, env: Env, channelKey: string): Promise<Response> {
  const info = await resolveChannelKey(env, channelKey);
  if (info === null) {
    return INVALID_KEY();
  }

  // 复制原请求（保留 Upgrade 头）重写内部 URL，附加可信内部头。
  const forward = new Request(`${INTERNAL_ORIGIN}/ws`, request);
  forward.headers.set(VERIFIED_HEADER, "1");
  return env.CHANNELS.getByName(info.channelId).fetch(forward);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;

    if (pathname === "/api/send" && request.method === "POST") {
      return handleSend(request, env);
    }

    const wsMatch = /^\/api\/ws\/([^/]+)$/.exec(pathname);
    if (wsMatch !== null && request.method === "GET") {
      // 畸形编码（非法 % 序列）与 KV miss 同路径处理：401 信封（Flagged Assumption SRV-03）。
      let channelKey: string;
      try {
        channelKey = decodeURIComponent(wsMatch[1]);
      } catch {
        return INVALID_KEY();
      }
      return handleWebSocket(request, env, channelKey);
    }

    return errorEnvelope(404, "not_found", "The requested resource was not found.");
  },
};
