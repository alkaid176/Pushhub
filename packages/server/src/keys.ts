/**
 * KV 密钥读路径封装（Pattern 6）。
 *
 * KV 键表（写路径与 id: 前缀归 01-05）：
 *   ch:<channel_key> -> {channelId, name, createdAt}
 *   sk:<send_key>    -> {channelId}
 *
 * 读路径 cacheTtl 60（KV 默认值，显式标注意图）：
 * 负查询同样进边缘缓存——无效密钥轰击大多命中缓存，不产生穿透。
 * 已知取舍：重置密钥后最长约 60s 双活窗口（Pitfall 8，文档化行为）。
 */

export const KEY_PREFIX_CH = "ch:";
export const KEY_PREFIX_SEND = "sk:";

/** sk:<key> 命中后的值结构。 */
export interface SendKeyInfo {
  channelId: string;
}

/** ch:<key> 命中后的值结构。 */
export interface ChannelKeyInfo {
  channelId: string;
  name: string;
  createdAt: number;
}

/** 解析 Send Key -> 频道归属；miss 返回 null（调用方据此在 Worker 层即拒绝，不创建 DO stub）。 */
export async function resolveSendKey(
  env: Env,
  key: string,
): Promise<SendKeyInfo | null> {
  const info = await env.KV.get<SendKeyInfo>(KEY_PREFIX_SEND + key, {
    type: "json",
    cacheTtl: 60,
  });
  return info ?? null;
}

/** 解析 Channel Key -> 频道归属；miss 返回 null（同上，Worker 层即拒绝，防 DoS T-01-02）。 */
export async function resolveChannelKey(
  env: Env,
  key: string,
): Promise<ChannelKeyInfo | null> {
  const info = await env.KV.get<ChannelKeyInfo>(KEY_PREFIX_CH + key, {
    type: "json",
    cacheTtl: 60,
  });
  return info ?? null;
}
