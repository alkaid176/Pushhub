/**
 * KV 密钥读写路径封装（Pattern 6）。
 *
 * KV 键表（三前缀，写路径唯一入口 createChannel——01-05）：
 *   ch:<channel_key> -> {channelId, name, createdAt}
 *   sk:<send_key>    -> {channelId}
 *   id:<channelId>   -> {channelKey, sendKey, name, createdAt}（反向索引，供 admin 列表/重置清理）
 *
 * 读路径 cacheTtl 60（KV 默认值，显式标注意图）：
 * 负查询同样进边缘缓存——无效密钥轰击大多命中缓存，不产生穿透。
 * 已知取舍：重置密钥后最长约 60s 双活窗口（Pitfall 8，文档化行为）。
 */

export const KEY_PREFIX_CH = "ch:";
export const KEY_PREFIX_SEND = "sk:";
export const KEY_PREFIX_ID = "id:";

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

// ---------------------------------------------------------------------------
// 写路径（01-05，KEY-01/D-12）
// ---------------------------------------------------------------------------

const BASE62_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
/** 256 % 62 == 8：丢弃 >= 248 的字节消除取模偏差（每字节 97% 可用）。 */
const BASE62_USABLE_BYTES = 248;

export const CHANNEL_KEY_PREFIX = "phc_";
export const SEND_KEY_PREFIX = "phs_";
export const KEY_LENGTH = 32;
export const CHANNEL_ID_LENGTH = 16;

/**
 * crypto.getRandomValues 派生 base62 随机串（不引外部 ID 库——Pattern 6）。
 * 拒绝采样消除 256->62 的取模偏差：密钥凭据的字符分布必须均匀。
 */
export function generateRandomString(length: number): string {
  let out = "";
  while (out.length < length) {
    const bytes = crypto.getRandomValues(new Uint8Array(length * 2));
    for (let i = 0; i < bytes.length && out.length < length; i++) {
      if (bytes[i] < BASE62_USABLE_BYTES) {
        out += BASE62_ALPHABET[bytes[i] % BASE62_ALPHABET.length];
      }
    }
  }
  return out;
}

/** Channel Key：phc_ + 32 字符（D-12 三件套之一）。 */
export function generateChannelKey(): string {
  return CHANNEL_KEY_PREFIX + generateRandomString(KEY_LENGTH);
}

/** Send Key：phs_ + 32 字符。 */
export function generateSendKey(): string {
  return SEND_KEY_PREFIX + generateRandomString(KEY_LENGTH);
}

/** channelId：16 字符（getByName 吃任意字符串名，短名无碍）。 */
export function generateChannelId(): string {
  return generateRandomString(CHANNEL_ID_LENGTH);
}

/** id:<channelId> 反向索引的值结构（GET /api/admin/channels 列表数据源）。 */
export interface ChannelRecord {
  channelId: string;
  channelKey: string;
  sendKey: string;
  name: string;
  createdAt: number;
}

/** 建频道返回的三件套（含 name/createdAt，即 201 响应体）。 */
export interface CreatedChannel extends ChannelRecord {}

/**
 * 建频道：生成 channelId + 双密钥，三前缀各一次 KV 写（KEY-01/D-12）。
 *
 * 键空间红线（threat model）：本函数是三前缀 KV 写的唯一入口——Admin 级
 * 凭据永远不进这个可列举键空间。写序 ch: -> sk: -> id:（反向索引最后落，
 * 部分失败时 id: 缺席只影响列表完整性，不影响已写密钥的可用性）。
 */
export async function createChannel(env: Env, name: string): Promise<CreatedChannel> {
  const channelId = generateChannelId();
  const channelKey = generateChannelKey();
  const sendKey = generateSendKey();
  const createdAt = Date.now();

  await env.KV.put(
    KEY_PREFIX_CH + channelKey,
    JSON.stringify({ channelId, name, createdAt }),
  );
  await env.KV.put(KEY_PREFIX_SEND + sendKey, JSON.stringify({ channelId }));
  await env.KV.put(
    KEY_PREFIX_ID + channelId,
    JSON.stringify({ channelKey, sendKey, name, createdAt }),
  );

  return { channelId, channelKey, sendKey, name, createdAt };
}

/**
 * 列全部频道：KV list 以 "id:" 前缀枚举 + 逐键 get 汇总。
 * 单页上限 1000——list_complete/cursor 游标循环拉全（频道数超单页不漏）。
 * pageSize 仅测试用途（压缩分页路径的验证成本）；生产路径不传。
 */
export async function listChannels(
  env: Env,
  options?: { pageSize?: number },
): Promise<ChannelRecord[]> {
  const records: ChannelRecord[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await env.KV.list({
      prefix: KEY_PREFIX_ID,
      limit: options?.pageSize,
      cursor,
    });
    for (const key of page.keys) {
      const stored = await env.KV.get<{
        channelKey: string;
        sendKey: string;
        name: string;
        createdAt: number;
      }>(key.name, { type: "json" });
      if (stored !== null) {
        records.push({ channelId: key.name.slice(KEY_PREFIX_ID.length), ...stored });
      }
    }
    if (page.list_complete) break;
    cursor = page.cursor;
  }
  return records;
}
