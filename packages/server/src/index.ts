/**
 * PushHub Worker 入口（无状态，10ms CPU 预算）。
 *
 * 路由（01-01 切片）：
 *  - POST /api/send        Bearer Send Key -> KV sk: 预检 -> DO /publish 转发
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

// wrangler.jsonc exports 声明的 DO 类必须由入口模块导出（ChatRoom 类名部署即定型）。
export { ChatRoom };

const INTERNAL_ORIGIN = "https://do.pushhub.internal";
const VERIFIED_HEADER = "X-PH-Verified";

/** D-06 错误信封：HTTP 状态码 + 机器可读 code；message 为通用文案，不含堆栈与内部键名。 */
function errorEnvelope(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

const INVALID_KEY = () => errorEnvelope(401, "invalid_key", "Missing or invalid credentials.");

/** POST /api/send：Send Key 预检 -> 转发内部 publish（原样透传请求体）。 */
async function handleSend(request: Request, env: Env): Promise<Response> {
  const auth = request.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) {
    return INVALID_KEY();
  }
  const info = await resolveSendKey(env, auth.slice("Bearer ".length));
  if (info === null) {
    return INVALID_KEY();
  }

  // 重写内部 URL 转发；剥离 Authorization（Send Key 不进 DO），附加可信内部头。
  const forward = new Request(`${INTERNAL_ORIGIN}/publish`, request);
  forward.headers.delete("Authorization");
  forward.headers.set(VERIFIED_HEADER, "1");
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
