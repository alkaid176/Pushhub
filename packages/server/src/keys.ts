/**
 * KV 密钥读写路径封装（Pattern 6）。
 *
 * KV 键表（三前缀，写路径唯一入口 createChannel——01-05；03-01 id:/sk: 值结构演进 D-30/D-35）：
 *   ch:<channel_key> -> {channelId, name, createdAt}
 *   sk:<send_key>    -> {channelId, label?, createdAt?}（label/createdAt 纯增量可选字段，旧值天然合法）
 *   id:<channelId>   -> {channelKey, name, createdAt}（频道级反向索引，供 admin 列表/重置/删除）
 *
 * CR-01 修复（KV 读-改-写竞态）：Send Key 的权威数据源是 sk: 单键记录——建 =
 * 1 次 put、吊销 = 1 次 delete，绝不重写 id:。KV 是最终一致存储（写后跨 PoP
 * 传播 ≤60s，读侧默认 60s 边缘缓存）且无事务/CAS：「读 id: → 内存改 → 整条
 * 重写」会让同频道 60s 内的第二次管理写基于过期基线互踩（Send Key 静默丢失/
 * 已吊销 Key 幽灵复活/重置回退/删除链残留孤儿凭据）。id: 只承载频道级低频
 * 字段（channelKey 仅重置时换、name/createdAt 恒定）；列表/上限计数/删除链
 * 经 sk: 前缀现扫聚合（KV 读 100k/天额度充裕），旧格式 id:.sendKeys 数组仅
 * 作显示元数据兼容并入（migrate-on-read，重置/删除触碰后自然消失）。
 *
 * 读路径 cacheTtl 60（KV 默认值，显式标注意图）：
 * 负查询同样进边缘缓存——无效密钥轰击大多命中缓存，不产生穿透。
 * 已知取舍：重置密钥后最长约 60s 双活窗口（Pitfall 8，文档化行为——连接层
 * 由 DO 代际校验兜底拒绝，见 chat-room.ts WR-02 注释）。
 */

export const KEY_PREFIX_CH = "ch:";
export const KEY_PREFIX_SEND = "sk:";
export const KEY_PREFIX_ID = "id:";

/**
 * sk:<key> 命中后的值结构。label 是 Phase 3 新增可选字段（D-30）——旧值无此键
 * 天然合法；createdAt 随 CR-01 一并落入 sk:（per-key 权威记录自带元数据，
 * 旧值缺省由 id: 旧格式数组兼容补齐显示）。
 */
export interface SendKeyInfo {
  channelId: string;
  label?: string | null;
  createdAt?: number;
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

/**
 * id: 值的存储形态（CR-01 起新写恒为频道级三字段；sendKeys 数组仅存在于
 * CR-01 前的旧值中，作显示元数据兼容读——新写路径不再写入）。
 */
interface IdRecordStored {
  channelKey: string;
  name: string;
  createdAt: number;
  sendKeys?: SendKeyRecord[];
}

/** id: 值的旧格式（Phase 3 前单 Send Key：顶层 sendKey 字符串字段）。 */
interface IdRecordLegacy {
  channelKey: string;
  sendKey: string;
  name: string;
  createdAt: number;
}

/** normalize 后的 id: 视图：sendKeys 恒为数组（旧格式元数据或空）。 */
interface NormalizedIdRecord {
  channelKey: string;
  name: string;
  createdAt: number;
  sendKeys: SendKeyRecord[];
}

/**
 * id: 记录 normalize 兼容层（D-30/D-35，migrate-on-read）。
 *
 * 三种入参形态归一：Phase 3 前旧格式（顶层 sendKey 字符串）映射为 sendKeys
 * 单元素数组（label: null、createdAt 取顶层值）；CR-01 前中间格式（含
 * sendKeys 数组）原样保留数组（仅作显示元数据）；CR-01 后新格式（纯频道级
 * 三字段）归一为空数组（凭据权威在 sk: 现扫）。生产 0.1.0~0.1.11 的旧值
 * 经此层照常列出；被重置/删除触碰的频道在写路径升级为新格式（不写迁移
 * 脚本、不直改生产键空间——normalize 是永久防御）。listChannels 逐键 get
 * 之后统一走本函数。
 */
function normalizeIdRecord(stored: IdRecordStored | IdRecordLegacy): NormalizedIdRecord {
  if (Array.isArray((stored as IdRecordStored).sendKeys)) {
    const s = stored as IdRecordStored;
    return {
      channelKey: s.channelKey,
      name: s.name,
      createdAt: s.createdAt,
      sendKeys: s.sendKeys as SendKeyRecord[],
    };
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
  // 既无 sendKeys 数组也无顶层 sendKey：CR-01 后新格式（频道级三字段）或
  // 数据损坏——归一为零 Send Key 视图（凭据权威在 sk:，此处仅显示层）。
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
  // sk: 恒写新格式（含 label/createdAt 键，D-30 + CR-01 per-key 权威元数据）：
  // 旧读代码无此键不破坏，新读代码可显示标签与创建时间。
  await env.KV.put(
    KEY_PREFIX_SEND + sendKey,
    JSON.stringify({ channelId, label: null, createdAt }),
  );
  // id: 恒写 CR-01 后新格式（纯频道级三字段，不含 sendKeys 数组）。
  await env.KV.put(
    KEY_PREFIX_ID + channelId,
    JSON.stringify({ channelKey, name, createdAt }),
  );

  return { channelId, channelKey, sendKeys, name, createdAt };
}

/**
 * 扫描全部 sk: 单键记录，按频道归属聚合（CR-01：Send Key 权威枚举路径）。
 * KV list 以 "sk:" 前缀枚举 + 逐键 get（读 100k/天额度充裕；get 默认 60s
 * 边缘缓存——枚举 freshness ≤60s，仅影响显示/计数时效，不影响凭据正确性：
 * 凭据写删是单键操作，无互踩窗口）。pageSize 仅测试用途（压缩分页路径）。
 */
async function scanSendKeys(
  env: Env,
  options?: { pageSize?: number },
): Promise<Map<string, SendKeyRecord[]>> {
  const byChannel = new Map<string, SendKeyRecord[]>();
  let cursor: string | undefined;
  for (;;) {
    const page = await env.KV.list({
      prefix: KEY_PREFIX_SEND,
      limit: options?.pageSize,
      cursor,
    });
    for (const entry of page.keys) {
      const info = await env.KV.get<SendKeyInfo>(entry.name, { type: "json" });
      if (info === null || typeof info.channelId !== "string") continue;
      const rec: SendKeyRecord = {
        key: entry.name.slice(KEY_PREFIX_SEND.length),
        label: info.label ?? null,
        createdAt: typeof info.createdAt === "number" ? info.createdAt : 0,
      };
      const list = byChannel.get(info.channelId);
      if (list === undefined) {
        byChannel.set(info.channelId, [rec]);
      } else {
        list.push(rec);
      }
    }
    if (page.list_complete) break;
    cursor = page.cursor;
  }
  return byChannel;
}

/**
 * sk: 现扫结果与旧格式 id:.sendKeys 数组的显示层合并（CR-01 兼容读）：
 * 按 key 去重取并集；元数据（label/createdAt）优先取 sk: 侧（权威），缺失时
 * 回退旧数组侧（旧 sk: 值无 createdAt；测试直种的旧格式频道可能根本没有
 * sk: 记录——数组侧条目独立成立）。
 */
function mergeSendKeys(live: SendKeyRecord[], legacy: SendKeyRecord[]): SendKeyRecord[] {
  const byKey = new Map<string, SendKeyRecord>();
  for (const rec of legacy) {
    byKey.set(rec.key, rec);
  }
  for (const rec of live) {
    const old = byKey.get(rec.key);
    byKey.set(rec.key, {
      key: rec.key,
      label: rec.label ?? old?.label ?? null,
      createdAt: rec.createdAt !== 0 ? rec.createdAt : old?.createdAt ?? 0,
    });
  }
  return [...byKey.values()];
}

/**
 * 列全部频道：KV list 以 "id:" 前缀枚举 + 逐键 get 汇总（频道级字段），
 * sendKeys 经 sk: 全量现扫聚合合并（CR-01 权威数据源）。单页上限 1000——
 * list_complete/cursor 游标循环拉全（频道数超单页不漏）。pageSize 仅测试
 * 用途（压缩分页路径的验证成本）；生产路径不传。读路径统一经
 * normalizeIdRecord（旧格式兼容，D-30/D-35）。
 */
export async function listChannels(
  env: Env,
  options?: { pageSize?: number },
): Promise<ChannelRecord[]> {
  const sendKeysByChannel = await scanSendKeys(env, options);
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
        const normalized = normalizeIdRecord(stored);
        // WR-05：损坏记录（channelKey 缺失或非非空字符串——手工种键/半写
        // 损坏）不进列表——管理页 renderDetail -> buildKeyRow(undefined) ->
        // maskKey 的 key.slice 直接抛 TypeError，详情面板不可达即不可崩。
        if (typeof normalized.channelKey !== "string" || normalized.channelKey === "") {
          continue;
        }
        const channelId = key.name.slice(KEY_PREFIX_ID.length);
        records.push({
          channelId,
          channelKey: normalized.channelKey,
          name: normalized.name,
          createdAt: normalized.createdAt,
          sendKeys: mergeSendKeys(
            sendKeysByChannel.get(channelId) ?? [],
            normalized.sendKeys,
          ),
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
): Promise<NormalizedIdRecord | null> {
  const stored = await env.KV.get<IdRecordStored | IdRecordLegacy>(
    KEY_PREFIX_ID + channelId,
    { type: "json" },
  );
  return stored === null ? null : normalizeIdRecord(stored);
}

/**
 * 单频道 Send Key 权威枚举（CR-01）：sk: 现扫过滤 + 旧格式数组元数据合并。
 * 供建 Key 上限计数与删除链权威快照消费。
 */
async function listSendKeysForChannel(
  env: Env,
  channelId: string,
  legacy: SendKeyRecord[] = [],
): Promise<SendKeyRecord[]> {
  const all = await scanSendKeys(env);
  return mergeSendKeys(all.get(channelId) ?? [], legacy);
}

/**
 * 建 Send Key（D-30，CR-01 per-key 权威路径）：读 id:（存在性判定）→ sk:
 * 现扫计数上限判定 → KV 写 sk: 单键（值含 label/createdAt）。每次恰 1 次
 * KV 写、零 id: 重写——同频道任意频率的并发建 Key 互不互踩（额度核算表：
 * 远低于 1,000/天）。
 *
 * 时序红线（D-31 key_link）：上限判定必须在 KV 写之前——防超限 Key 已落盘
 * 后才拒绝（现扫计数在 ≤60s 缓存窗口内可能略偏旧，公网防线语义下可接受：
 * 竞态超额上界为并发请求数，非循环放大）。
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
  const existing = await listSendKeysForChannel(env, channelId, stored.sendKeys);
  if (existing.length >= SEND_KEY_LIMIT) {
    return { ok: false, reason: "limit" };
  }
  const key = generateSendKey();
  const createdAt = Date.now();
  await env.KV.put(
    KEY_PREFIX_SEND + key,
    JSON.stringify({ channelId, label, createdAt }),
  );
  return { ok: true, record: { key, label, createdAt } };
}

/**
 * 吊销 Send Key（D-32，CR-01 per-key 权威路径）：KV delete sk:<key> 单键。
 * 幂等（KV delete 对不存在的 key 同样返回成功，流程天然可重试），且不再
 * 重写 id:——最终一致存储上的读-改-写整条重写正是幽灵复活竞态的根源。
 * 第三环（DO rate_sends 行即时删除）由调用方转发 /cleanup-rate 完成。
 *
 * 兼容注记：旧格式 id:.sendKeys 数组不再被吊销触碰——CR-01 前旧频道的已吊销
 * Key 可能在管理列表残留显示（凭据已失效：/api/send 401），首次重置或删除
 * 频道后随 id: 升级为新格式而消失；属显示层残留，非凭据复活。
 */
export async function revokeSendKeyRecord(env: Env, key: string): Promise<void> {
  await env.KV.delete(KEY_PREFIX_SEND + key);
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
 * 均不动）：读 id: → 内部顺序恒定：KV delete ch:<旧> → KV put ch:<新>
 * （值 {channelId, name, createdAt} 原样）→ KV 重写 id:（新 channelKey，
 * 纯频道级三字段——CR-01 后无数组可失，Send Key 不受任何影响）。miss 返回
 * null（上游 404）。
 *
 * 顺序红线（key_links）：调用方必须先完成本函数的 KV 写、后转发 DO
 * /kick-all——反序（先踢后写）制造旧 Key 无限重挂窗口（被踢客户端立即
 * 以边缘缓存的旧 ch: 值重连成功后再无人踢它）。「窗口内重挂后长存」由
 * DO 代际校验闭合（WR-02，chat-room.ts）：kick-all 携带新 Key 落代际，
 * 旧 Key 重连在 DO 侧被拒。
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
      name: stored.name,
      createdAt: stored.createdAt,
    }),
  );
  // sendKeys 不再随 id: 承载（D-33 响应只用 channelKey；列表数据源已迁 sk: 现扫）。
  return { channelId, channelKey, sendKeys: [], name: stored.name, createdAt: stored.createdAt };
}

/**
 * 删除频道全部 KV 键（D-34 + CR-01 第 4 点/IN-04 TOCTOU 收敛）：ch:<旧
 * channelKey> → sk: 现扫权威枚举与入参快照取并集后逐键删（purge 是网络
 * 往返，期间新建的 Send Key 不在快照内——现扫补齐；不同 key 无 1 写/秒
 * 限制，顺序 await 逐键删即可）→ id:<channelId> 最后删（与 createChannel
 * 写序 "id: 反向索引最后落" 对称：部分失败时频道仍在列表，删除链可整链
 * 重试；KV delete 幂等保证重放安全）。
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
  const fresh = await scanSendKeys(env);
  const live = fresh.get(record.channelId) ?? [];
  const keys = new Set([...record.sendKeys, ...live].map((r) => r.key));
  for (const key of keys) {
    await env.KV.delete(KEY_PREFIX_SEND + key);
  }
  await env.KV.delete(KEY_PREFIX_ID + record.channelId);
}
