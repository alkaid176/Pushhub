/**
 * KV 密钥读写路径封装（Pattern 6）。
 *
 * KV 键表（三前缀，写路径唯一入口 createChannel——01-05；03-01 id:/sk: 值结构演进 D-30/D-35）：
 *   ch:<channel_key> -> {channelId, name, createdAt}
 *   sk:<send_key>    -> {channelId, label?}（label 纯增量可选字段，旧值 {channelId} 天然合法）
 *   id:<channelId>   -> {channelKey, sendKeys: SendKeyRecord[], name, createdAt}（反向索引，供 admin 列表/重置清理）
 *
 * 读路径 cacheTtl 60（KV 默认值，显式标注意图）：
 * 负查询同样进边缘缓存——无效密钥轰击大多命中缓存，不产生穿透。
 * 已知取舍：重置密钥后最长约 60s 双活窗口（Pitfall 8，文档化行为）。
 */

export const KEY_PREFIX_CH = "ch:";
export const KEY_PREFIX_SEND = "sk:";
export const KEY_PREFIX_ID = "id:";

/** sk:<key> 命中后的值结构。label 是 Phase 3 新增可选字段（D-30）——旧值无此键天然合法。 */
export interface SendKeyInfo {
  channelId: string;
  label?: string | null;
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

/** 单个 Send Key 的记录形态（D-30/D-35：id: 值 sendKeys 数组元素 / API 响应元素）。 */
export interface SendKeyRecord {
  /** phs_ + 32 字符密钥本体。 */
  key: string;
  /** 人类可读标签（可选，建频道初始 Key 恒 null）。 */
  label: string | null;
  createdAt: number;
}

/** id:<channelId> 反向索引的值结构（GET /api/admin/channels 列表数据源）。 */
export interface ChannelRecord {
  channelId: string;
  channelKey: string;
  sendKeys: SendKeyRecord[];
  name: string;
  createdAt: number;
}

/** 建频道返回的三件套（含 name/createdAt，即 201 响应体）。 */
export interface CreatedChannel extends ChannelRecord {}

/** id: 值的新格式存储形态（03-01 起恒写）。 */
interface IdRecordStored {
  channelKey: string;
  sendKeys: SendKeyRecord[];
  name: string;
  createdAt: number;
}

/** id: 值的旧格式（Phase 3 前单 Send Key：顶层 sendKey 字符串字段）。 */
interface IdRecordLegacy {
  channelKey: string;
  sendKey: string;
  name: string;
  createdAt: number;
}

/**
 * id: 记录 normalize 兼容层（D-30/D-35，migrate-on-write 读侧半边）。
 *
 * 旧格式（顶层 sendKey 字符串）映射为 sendKeys 单元素数组（label: null、
 * createdAt 取顶层值）；新格式（sendKeys 数组）原样通过。生产 0.1.0~0.1.10
 * 的旧格式冒烟频道经此层照常列出；任何被管理操作触碰的频道在写路径升级为
 * 新格式（不写迁移脚本、不直改生产键空间——normalize 是永久防御，保护漏删
 * 的旧频道）。listChannels 逐键 get 之后统一走本函数。
 */
function normalizeIdRecord(stored: IdRecordStored | IdRecordLegacy): IdRecordStored {
  if (Array.isArray((stored as IdRecordStored).sendKeys)) {
    return stored as IdRecordStored;
  }
  const legacy = stored as IdRecordLegacy;
  if (typeof legacy.sendKey === "string") {
    return {
      channelKey: legacy.channelKey,
      sendKeys: [{ key: legacy.sendKey, label: null, createdAt: legacy.createdAt }],
      name: legacy.name,
      createdAt: legacy.createdAt,
    };
  }
  // 既无 sendKeys 数组也无顶层 sendKey：数据损坏兜底——按零 Send Key 记录
  // 带出其余字段（列表形态完整，消费方 sendKeys 遍历零异常）。
  return {
    channelKey: legacy.channelKey,
    sendKeys: [],
    name: legacy.name,
    createdAt: legacy.createdAt,
  };
}

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
  const sendKeys: SendKeyRecord[] = [{ key: sendKey, label: null, createdAt }];

  await env.KV.put(
    KEY_PREFIX_CH + channelKey,
    JSON.stringify({ channelId, name, createdAt }),
  );
  // sk: 恒写新格式（含 label 键，D-30）：旧读代码无此键不破坏，新读代码可显示标签。
  await env.KV.put(
    KEY_PREFIX_SEND + sendKey,
    JSON.stringify({ channelId, label: null }),
  );
  // id: 恒写新格式（sendKeys 数组，D-30/D-35）。
  await env.KV.put(
    KEY_PREFIX_ID + channelId,
    JSON.stringify({ channelKey, sendKeys, name, createdAt }),
  );

  return { channelId, channelKey, sendKeys, name, createdAt };
}

/**
 * 列全部频道：KV list 以 "id:" 前缀枚举 + 逐键 get 汇总。
 * 单页上限 1000——list_complete/cursor 游标循环拉全（频道数超单页不漏）。
 * pageSize 仅测试用途（压缩分页路径的验证成本）；生产路径不传。
 * 读路径统一经 normalizeIdRecord（旧格式兼容，D-30/D-35）。
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
      const stored = await env.KV.get<IdRecordStored | IdRecordLegacy>(key.name, {
        type: "json",
      });
      if (stored !== null) {
        records.push({
          channelId: key.name.slice(KEY_PREFIX_ID.length),
          ...normalizeIdRecord(stored),
        });
      }
    }
    if (page.list_complete) break;
    cursor = page.cursor;
  }
  return records;
}

// ---------------------------------------------------------------------------
// 写路径二（03-02，KEY-03/D-30/D-31/D-32）：Send Key 增删
// ---------------------------------------------------------------------------

/** 每频道 Send Key 上限（D-31——公网防线：防循环建 Key 烧 KV 写额度）。 */
export const SEND_KEY_LIMIT = 10;

/** 建 Send Key 结果：not_found = id: miss；limit = 已达每频道上限（写入前判定）。 */
export type CreateSendKeyResult =
  | { ok: true; record: SendKeyRecord }
  | { ok: false; reason: "not_found" | "limit" };

/** 读 id: 记录（normalize 兼容；miss 返回 null）。写路径共用读点。 */
async function readIdRecord(
  env: Env,
  channelId: string,
): Promise<IdRecordStored | null> {
  const stored = await env.KV.get<IdRecordStored | IdRecordLegacy>(
    KEY_PREFIX_ID + channelId,
    { type: "json" },
  );
  return stored === null ? null : normalizeIdRecord(stored);
}

/**
 * 建 Send Key（D-30）：读 id:（经 normalize，migrate-on-write）→ 上限判定 →
 * KV 写 sk:（值含 label）→ KV 重写 id:（sendKeys 追加，channelKey/name/
 * createdAt 原样保留）。每次 2 KV 写（额度核算表：远低于 1,000/天）。
 *
 * 时序红线（D-31 key_link）：上限判定必须在任何 KV 写之前——防第 11 个 Key
 * 已落盘后才拒绝。
 */
export async function createSendKeyRecord(
  env: Env,
  channelId: string,
  label: string | null,
): Promise<CreateSendKeyResult> {
  const stored = await readIdRecord(env, channelId);
  if (stored === null) {
    return { ok: false, reason: "not_found" };
  }
  if (stored.sendKeys.length >= SEND_KEY_LIMIT) {
    return { ok: false, reason: "limit" };
  }
  const key = generateSendKey();
  const createdAt = Date.now();
  await env.KV.put(
    KEY_PREFIX_SEND + key,
    JSON.stringify({ channelId, label }),
  );
  await env.KV.put(
    KEY_PREFIX_ID + channelId,
    JSON.stringify({
      channelKey: stored.channelKey,
      sendKeys: [...stored.sendKeys, { key, label, createdAt }],
      name: stored.name,
      createdAt: stored.createdAt,
    }),
  );
  return { ok: true, record: { key, label, createdAt } };
}

/**
 * 吊销 Send Key（D-32）三存储联动的前两环：KV delete sk:<key>（幂等——
 * KV delete 对不存在的 key 同样返回成功，流程天然可重试）→ KV 重写 id:
 * （sendKeys 过滤移除该 key，migrate-on-write）。第三环（DO rate_sends 行
 * 即时删除）由调用方转发 /cleanup-rate 完成。
 */
export async function revokeSendKeyRecord(
  env: Env,
  channelId: string,
  key: string,
): Promise<void> {
  await env.KV.delete(KEY_PREFIX_SEND + key);
  const stored = await readIdRecord(env, channelId);
  if (stored === null) {
    // 防御兜底：sk: 已删（凭据已失效），id: 缺席只影响列表完整性。
    return;
  }
  await env.KV.put(
    KEY_PREFIX_ID + channelId,
    JSON.stringify({
      channelKey: stored.channelKey,
      sendKeys: stored.sendKeys.filter((r) => r.key !== key),
      name: stored.name,
      createdAt: stored.createdAt,
    }),
  );
}

// ---------------------------------------------------------------------------
// 写路径三（03-03，KEY-02/KEY-04/D-33/D-34）：Channel Key 重置 / 频道删除
// ---------------------------------------------------------------------------

/** 读单频道记录（id: 反向索引，经 normalize；miss 返回 null）。admin 参数化路由共用读点。 */
export async function readChannelRecord(
  env: Env,
  channelId: string,
): Promise<ChannelRecord | null> {
  const stored = await readIdRecord(env, channelId);
  return stored === null ? null : { channelId, ...stored };
}

/**
 * 重置 Channel Key（D-33，KEY-04——重置只动 Channel Key，历史与 Send Key
 * 均不动）：读 id:（经 normalize，migrate-on-write）→ 内部顺序恒定：
 * KV delete ch:<旧> → KV put ch:<新>（值 {channelId, name, createdAt} 原样）
 * → KV 重写 id:（新 channelKey，sendKeys/name/createdAt 不变）。miss 返回
 * null（上游 404）。
 *
 * 顺序红线（key_links）：调用方必须先完成本函数的 KV 写、后转发 DO
 * /kick-all——反序（先踢后写）制造旧 Key 无限重挂窗口（被踢客户端立即
 * 以边缘缓存的旧 ch: 值重连成功后再无人踢它）。
 */
export async function resetChannelKey(
  env: Env,
  channelId: string,
): Promise<ChannelRecord | null> {
  const stored = await readIdRecord(env, channelId);
  if (stored === null) {
    return null;
  }
  const channelKey = generateChannelKey();
  await env.KV.delete(KEY_PREFIX_CH + stored.channelKey);
  await env.KV.put(
    KEY_PREFIX_CH + channelKey,
    JSON.stringify({
      channelId,
      name: stored.name,
      createdAt: stored.createdAt,
    }),
  );
  await env.KV.put(
    KEY_PREFIX_ID + channelId,
    JSON.stringify({
      channelKey,
      sendKeys: stored.sendKeys,
      name: stored.name,
      createdAt: stored.createdAt,
    }),
  );
  return { channelId, channelKey, sendKeys: stored.sendKeys, name: stored.name, createdAt: stored.createdAt };
}

/**
 * 删除频道全部 KV 键（D-34）：ch:<旧 channelKey> → 每个 sk:<key>（全列表，
 * 最多 12 次删除——不同 key 无 1 写/秒限制，顺序 await 逐键删即可）→
 * id:<channelId> 最后删（与 createChannel 写序"id: 反向索引最后落"对称：
 * 部分失败时频道仍在列表，删除链可整链重试；KV delete 幂等保证重放安全）。
 *
 * 顺序红线（key_links）：调用方必须先完成 DO /purge 转发、再调本函数——
 * 反序（先删 KV 后 purge DO）在 purge 失败时产生不可达孤儿 DO（频道从
 * 列表消失、无键指向、无法重试）。
 */
export async function deleteChannelKeys(
  env: Env,
  record: ChannelRecord,
): Promise<void> {
  await env.KV.delete(KEY_PREFIX_CH + record.channelKey);
  for (const rec of record.sendKeys) {
    await env.KV.delete(KEY_PREFIX_SEND + rec.key);
  }
  await env.KV.delete(KEY_PREFIX_ID + record.channelId);
}
