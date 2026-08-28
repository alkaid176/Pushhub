/**
 * PushHub Worker 入口（无状态，10ms CPU 预算）。
 *
 * 路由（01-01 切片 + 01-03 校验链 + 01-05 Admin API）：
 *  - POST /api/send        Bearer Send Key -> KV sk: 预检 -> validateSendBody
 *                          入口即拒（413/400，不触 DO）-> DO /publish 转发
 *  - GET  /api/ws/:key     路径段 Channel Key -> KV ch: 预检 -> DO /ws 升级转发
 *  - ANY  /api/admin/*     Bearer Admin Key 常时比较（D-13）-> admin.ts
 *                          （POST/GET /api/admin/channels，D-12）
 *
 * 鉴权原则（Pattern 6/8）：无效密钥在 Worker 层即拒绝、不创建 DO stub
 * （省额度 + 防 DoS，T-01-02）；DO 只信 Worker 转发的 X-PH-Verified: 1 内部头。
 *
 * 日志原则（Prohibition #2）：结构化日志不打印完整 URL query 与任何密钥
 * （Channel Key 在路径段、Send Key 在 Bearer 头——密钥即身份）。
 */
import { ChatRoom } from "./chat-room";
import { resolveSendKey, resolveChannelKey } from "./keys";
import { handleAdminApi } from "./admin";
import { errorEnvelope } from "./envelope";
import { validateSendBody } from "@pushhub/shared/validators";

// wrangler.jsonc exports 声明的 DO 类必须由入口模块导出（ChatRoom 类名部署即定型）。
export { ChatRoom };

const INTERNAL_ORIGIN = "https://do.pushhub.internal";
const VERIFIED_HEADER = "X-PH-Verified";
/** Worker→DO 可信内部头：限流分键（KEY-05）用的 Send Key 原值，不外泄响应。 */
const SEND_KEY_HEADER = "X-PH-Send-Key";
/** Worker→DO 可信内部头：DO 代际校验用的 Channel Key 原值（WR-02，不外泄响应）。 */
const CHANNEL_KEY_HEADER = "X-PH-Channel-Key";
/** Worker→DO 可信内部头：每频道 signing secret（04-02 D-47——ch: 记录已解析，
 * 零额外 KV 读；DO 侧落 meta 表供回调签名，不外泄响应）。 */
const SIGNING_SECRET_HEADER = "X-PH-Signing-Secret";
/** Worker→DO 可信内部头：频道 ID（04-02 D-49 回调 body 的 channel_id 数据源）。 */
const CHANNEL_ID_HEADER = "X-PH-Channel-Id";

/**
 * SC4 可观测标记（02-03 Task 3，Rule 3 偏差）：Worker 实际处理的响应一律带
 * `x-ph-worker: 1`。asset-first 下静态资产命中不触发 Worker，故 /pushhub.js、
 * /viewer.js、index.html 的响应没有此头——"这条响应是否经 Worker"从此一条
 * curl 可判（本机 wrangler tail 的 WebSocket 通道被 DNS 污染阻断时的不依赖
 * 网络的 SC4 证据）。不影响任何冻结契约（错误信封/WS 协议/资产字节）。
 */
const WORKER_MARKER_HEADER = "x-ph-worker";

/** D-06 错误信封（唯一实现在 envelope.ts，index/admin 共用）。 */
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
  // WR-02：随转发携带 KV 解析出的 channelKey 本值（覆盖客户端可能透传的
  // 同名头——值取自 ch: 查询结果而非客户端输入，伪造不可能）。DO 侧与
  // kick-all 落盘的代际比对：重置后旧 Key 在 ≤60s KV 缓存窗口内重挂在此
  // 被拒（401 信封），窗口彻底闭合。
  forward.headers.set(CHANNEL_KEY_HEADER, channelKey);
  // 04-02 D-47（RESEARCH Pattern 5）：随转发携带 ch: 解析出的 signingSecret
  // 与 channelId——DO 侧 /ws 升级路径落 meta 表。零额外 KV 读（info 已在手）；
  // 旧格式频道无 signingSecret（undefined）时不设头，DO 侧 meta 缺行即
  // "no signing secret" 失败可查路径（Pitfall 8，04-02 Task 3）。
  // 正确性论证：回调仅在回复后发生、回复必经已鉴权 WS、该连接升级时 secret
  // 已落 meta——secret 永远先于任何回调就位。
  forward.headers.set(CHANNEL_ID_HEADER, info.channelId);
  if (typeof info.signingSecret === "string" && info.signingSecret !== "") {
    forward.headers.set(SIGNING_SECRET_HEADER, info.signingSecret);
  }
  return env.CHANNELS.getByName(info.channelId).fetch(forward);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    let response: Response;
    try {
      response = await routeRequest(request, env);
    } catch {
      // WR-04：入口兜底——任何穿透业务处理器的意外异常统一 D-06 500 信封
      //（与 admin.ts handleAdminApi 同款；不泄漏内部细节，D-13 最小信息量）。
      response = errorEnvelope(500, "server_error", "Internal server error.");
    }
    return stampMarker(response);
  },
};

/** 路由分发本体（原 fetch 主体，由 WR-04 兜底层包裹）。 */
async function routeRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const pathname = url.pathname;

  // Admin API（D-12/D-13）：前缀分发，鉴权在 admin.ts 内完成。
  if (pathname.startsWith("/api/admin/")) {
    return handleAdminApi(request, env);
  }
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
}

/** SC4 标记盖章：复制构造新 Response（DO 子请求响应的头不可变，原地 set 会抛
 * TypeError）；跳过 101 升级响应（WS 握手不参与资产对照）。 */
function stampMarker(response: Response): Response {
  if (response.status === 101) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.set(WORKER_MARKER_HEADER, "1");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
