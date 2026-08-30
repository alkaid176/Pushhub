package app.pushhub.android.protocol

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.longOrNull

/**
 * 协议帧解析（06-01 tracer → 06-03 全帧型补全，D-59/D-07）。
 *
 * 与 packages/web-sdk/src/frames.ts、packages/desktop/src-tauri/src/protocol/mod.rs
 * 三档语义逐行为对齐（第三端同构移植）：
 *  - Ok(ServerFrame)：合法帧（六帧型全集：pong/message/history/error/ack/answered）；
 *  - Drop(reason)：非致命丢弃（不可解析/非对象/未知 type/结构违例/域违例）——
 *    坏帧不毒害连接；
 *  - Fatal(message)：仅 v !== PROTOCOL_VERSION（D-07 客户端严格方向——客户端不识别
 *    的 v 即断连报错；服务端比客户端新，重连无意义）。
 *
 * 协议常量与帧结构对齐 packages/shared/src/index.ts（冻结契约唯一事实源）。
 * 未知字段一律忽略（D-07：lenientJson.ignoreUnknownKeys，fixtures 的 _note 元数据
 * 字段是活体测试）。
 *
 * 深校验守卫（06-03 Task 1，对齐 frames.ts:64-130 isXxxShape 与 Rust 手写守卫
 * 先例——"serde/kotlinx 默认行为不可信"）：decode 前在 JsonObject 层做逐字段
 * shape 检查（键存在性/类型/值域），覆盖 kotlinx 类型层之外的语义——
 *  - 可空字段（answered_by 等）键必须存在、值可 null（TS isStringOrNull(undefined)
 *    === false 的对应物——kotlinx explicitNulls=false 下缺键与显式 null 解码同值，
 *    唯一区分点在 JsonObject 层）；
 *  - 数值字段拒绝字符串数字（JsonPrimitive.longOrNull 会解析带引号的 "1"——
 *    strict 包装先验 isString，对齐 TS parsed.v !== 1 与 Rust v:"1" fatal 用例）；
 *  - message 域校验：seq 正整数、priority ∈ {low,normal,high}、options 字符串
 *    数组且长度上限 OPTIONS_MAX_COUNT=4（计划锁定；服务端 /api/send 已强制，
 *    客户端侧是纵深防线）。
 */

/** 线协议版本（D-07，shared/src/index.ts:18 verbatim）：所有 WS 帧顶层 v 字段的当前值。 */
const val PROTOCOL_VERSION: Int = 1

/**
 * D-11 sync 补拉 limit 缺省值（shared/src/index.ts:44 verbatim）。
 * 消费面：machine SendSync 动作（handleHistory 首拉无条件补拉）。
 */
const val SYNC_LIMIT_DEFAULT: Int = 200

/**
 * D-11 sync 补拉 limit 上限（shared/src/index.ts:47 verbatim）。
 * 消费面：常量锚定测试（Kotlin 客户端不发送越界 limit——机器恒用缺省值）。
 */
const val SYNC_LIMIT_MAX: Int = 500

/**
 * D-08 每频道保留窗口（shared/src/index.ts:38 verbatim）。
 * 消费面：Buffer BUFFER_CAP 互等硬断言（06-03 Task 2——数值漂移即协议事件）。
 */
const val RETENTION_KEEP: Int = 500

/**
 * D-09 首拉条数（shared/src/index.ts:41 verbatim）。
 * 消费面：常量锚定测试（首拉行为由服务端执行，客户端只感知 history 帧）。
 */
const val INITIAL_FETCH: Int = 50

/**
 * D-53 回复展示名上限（shared/src/index.ts:54 verbatim）。
 * 消费面：常量锚定测试（发送侧 UI 校验在 06-06；服务端权威）。
 */
const val BY_MAX: Int = 64

/**
 * LIMITS.OPTIONS_MAX_COUNT（shared/src/index.ts:30 verbatim）。
 * 消费面：message 帧深校验（options 数组长度上限——超出即结构违例 Drop）。
 */
const val OPTIONS_MAX_COUNT: Int = 4

/**
 * parseServerFrame 结果判别（对齐 TS FrameResult / Rust FrameResult 的三档）。
 * Ok/Drop/Fatal 语义见文件头注释。
 */
sealed class FrameResult {
    data class Ok(val frame: ServerFrame) : FrameResult()
    data class Drop(val reason: String) : FrameResult()
    data class Fatal(val message: String) : FrameResult()
}

/**
 * 服务端 → 客户端帧全集（06-03 全帧型：六类）。判别式 classDiscriminator 用默认
 * "type"（与协议帧 type 字段天然对齐）。
 *
 * v 字段一律无默认值：嵌套（history.messages 元素）缺 v 必须结构违例 Drop——
 * golden 反例 history-frame.negative.json 的 "message element missing v" 用例锚定。
 */
@Serializable
sealed class ServerFrame {

    /** v:1 pong 帧（服务端 auto-response 自动回帧，不唤醒 DO）——宽松直通零校验。 */
    @Serializable
    @SerialName("pong")
    data class Pong(
        val v: Int,
    ) : ServerFrame()

    /**
     * v:1 message 帧（冻结 13 字段集，D-03；可空字段对应协议省略语义——
     * 未提供时键不出现，永不为空数组/空串）。
     */
    @Serializable
    @SerialName("message")
    data class Message(
        val v: Int,
        val wid: String,
        val seq: Long,
        val title: String? = null,
        val text: String,
        @SerialName("callback_url") val callbackUrl: String? = null,
        @SerialName("click_url") val clickUrl: String? = null,
        val options: List<String>? = null,
        val priority: String,
        val answered: Boolean,
        @SerialName("answered_by") val answeredBy: String? = null,
        @SerialName("answered_at") val answeredAt: Long? = null,
        @SerialName("answered_content") val answeredContent: String? = null,
        @SerialName("created_at") val createdAt: Long,
    ) : ServerFrame()

    /**
     * v:1 history 帧（messages 按 seq 升序；oldest_kept_seq/has_more 原样透传，
     * D-10/D-11）。
     */
    @Serializable
    @SerialName("history")
    data class History(
        val v: Int,
        val messages: List<Message>,
        @SerialName("oldest_kept_seq") val oldestKeptSeq: Long,
        @SerialName("has_more") val hasMore: Boolean,
    ) : ServerFrame()

    /**
     * v:1 error 帧（WS 侧错误）。code 为 string 不枚举——未知 code 天然兼容
     * （D-07 前瞻兼容：服务端新增错误码不破坏旧客户端；invalid_frame /
     * invalid_version / already_replied / not_found 为 04-01 冻结集）。
     */
    @Serializable
    @SerialName("error")
    data class Error(
        val v: Int,
        val code: String,
        val message: String,
    ) : ServerFrame()

    /**
     * v:1 ack 帧（服务端 → 回复者本人，04-01 D-45）——恰 v/type/wid 三键语义
     * （不携带 seq/时间等冗余，answered 帧已含全量；未知字段照 D-07 忽略）。
     * 机器分派：静默零动作（Q4：answered 扇出即公共确认）。
     */
    @Serializable
    @SerialName("ack")
    data class Ack(
        val v: Int,
        val wid: String,
    ) : ServerFrame()

    /**
     * v:1 answered 帧（服务端 → 全连接扇出，04-01 D-45/RPL-05）。
     * answered_at 非空 number（帧只在成功回复后发射）；answered_by 可空（匿名，
     * D-53）；answered_content 为回复原文透传不转义（RPL-02——渲染消毒是客户端
     * 侧职责）。不经 SeqDedup 原样透传（D-17 硬约束：独立帧而非 message 重发）。
     */
    @Serializable
    @SerialName("answered")
    data class Answered(
        val v: Int,
        val wid: String,
        val seq: Long,
        val answered: Boolean,
        @SerialName("answered_by") val answeredBy: String? = null,
        @SerialName("answered_at") val answeredAt: Long,
        @SerialName("answered_content") val answeredContent: String? = null,
    ) : ServerFrame()
}

// 词汇表别名（对齐 plan 的 PongFrame/MessageFrame/HistoryFrame/AckFrame/
// AnsweredFrame/WsErrorFrame 命名）。
typealias PongFrame = ServerFrame.Pong
typealias MessageFrame = ServerFrame.Message
typealias HistoryFrame = ServerFrame.History
typealias WsErrorFrame = ServerFrame.Error
typealias AckFrame = ServerFrame.Ack
typealias AnsweredFrame = ServerFrame.Answered

/**
 * v:1 sync 帧（客户端 → 服务端补拉请求，D-11）。运行时序列化合法——服务端
 * JSON.parse 键序无关；唯一字节常量约束是 adapter 的 PING（Pitfall 4）。
 * adapter 的 SendSync 动作分派消费。
 */
@Serializable
data class SyncFrame(
    val v: Int,
    val type: String,
    val since: Long,
    val limit: Int,
)

/**
 * v:1 reply 帧（客户端 → 服务端回复，04-01 D-45/D-46）——出站帧型
 * （plan 命名 ReplyClientFrame）。selected_option 与 text 恰提供其一（恰一校验
 * 在发送侧，域级校验在服务端 DO）；by 为自报展示名，缺省不序列化（省略语义——
 * 键不出现即匿名回复，D-53）。reply 出站不进状态机（WEB-03 Pattern 7），adapter
 * 的 sendReply 序列化消费；06-06 回复 UI 接线。
 */
@Serializable
data class ReplyFrame(
    val v: Int,
    val type: String,
    val wid: String,
    @SerialName("selected_option") val selectedOption: String? = null,
    val text: String? = null,
    val by: String? = null,
)

/** 出站帧型别名（plan 词汇表命名 ReplyClientFrame 的对应物）。 */
typealias ReplyClientFrame = ReplyFrame

/**
 * lenientJson 配置（对齐 RESEARCH Pattern 2）：
 *  - ignoreUnknownKeys=true：D-07 未知字段忽略；
 *  - explicitNulls=false：null 编码省略 + 缺失解码为 null（协议省略语义 + D-72 by 缺省）；
 *  - encodeDefaults=false：默认值不编码（reply/sync 客户端帧的可空/可选字段省略语义；
 *    v/type 无默认值故恒编码）；
 *  - classDiscriminator 默认 "type"。
 */
val lenientJson = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
    encodeDefaults = false
}

// ---- 深校验守卫（JsonObject 层 shape 检查，frames.ts:36-130 同构）----

/**
 * 严格整数读取：拒绝字符串数字（JsonPrimitive.longOrNull 会解析带引号的 "1"——
 * 必须先验 isString；对齐 TS `parsed.v !== 1` 与 Rust v:"1" → Fatal 用例）。
 */
private fun JsonObject.strictLong(key: String): Long? {
    val p = this[key] as? JsonPrimitive ?: return null
    return if (p.isString) null else p.longOrNull
}

private fun JsonObject.strictInt(key: String): Int? {
    val p = this[key] as? JsonPrimitive ?: return null
    return if (p.isString) null else p.intOrNull
}

private fun JsonObject.strictBoolean(key: String): Boolean? =
    (this[key] as? JsonPrimitive)?.booleanOrNull

/** 可选字符串字段：缺省或 string 均合法（省略语义，TS optionalString）。 */
private fun JsonObject.optionalString(key: String): Boolean {
    val p = this[key] ?: return true
    return p is JsonPrimitive && p.isString
}

/** 可空字符串字段：键必须存在，值为 null 或 string（TS isStringOrNull——
 *  undefined 拒绝；kotlinx explicitNulls=false 下缺键与显式 null 解码同值，
 *  唯一区分点在此层。注意 JsonNull 是 JsonPrimitive 子类且 isString=false，
 *  必须先行短路）。 */
private fun JsonObject.stringOrNullKeyRequired(key: String): Boolean {
    val p = this[key] ?: return false // 键缺失（undefined）
    if (p is kotlinx.serialization.json.JsonNull) return true // 显式 null 合法
    return p is JsonPrimitive && p.isString
}

/** 可空整数字段：键必须存在，值为 null 或整数（TS isIntegerOrNull）。 */
private fun JsonObject.intOrNullKeyRequired(key: String): Boolean {
    val p = this[key] ?: return false
    if (p is kotlinx.serialization.json.JsonNull) return true
    return p is JsonPrimitive && !p.isString && p.longOrNull != null
}

private val PRIORITIES = setOf("low", "normal", "high")

/**
 * MessageFrame 结构深校验（冻结 13 字段集，D-03；frames.ts isMessageShape 逐条件
 * 对齐 + options 长度上限）。history.messages 元素复用本函数（元素各自带 v:1）。
 */
private fun isMessageShape(obj: JsonObject): Boolean {
    if (obj.strictInt("v") != PROTOCOL_VERSION) return false
    val wid = obj["wid"] as? JsonPrimitive ?: return false
    if (!wid.isString || wid.content.isEmpty()) return false
    val seq = obj.strictLong("seq") ?: return false
    if (seq < 1) return false
    if (!obj.optionalString("title")) return false
    val text = obj["text"] as? JsonPrimitive ?: return false
    if (!text.isString) return false
    val options = obj["options"]
    if (options != null) {
        if (options !is JsonArray) return false
        if (options.size > OPTIONS_MAX_COUNT) return false
        if (!options.all { it is JsonPrimitive && it.isString }) return false
    }
    if (!obj.optionalString("callback_url") || !obj.optionalString("click_url")) return false
    val priority = obj["priority"] as? JsonPrimitive ?: return false
    if (!priority.isString || priority.content !in PRIORITIES) return false
    if (obj.strictBoolean("answered") == null) return false
    if (!obj.stringOrNullKeyRequired("answered_by")) return false
    if (!obj.intOrNullKeyRequired("answered_at")) return false
    if (!obj.stringOrNullKeyRequired("answered_content")) return false
    if (obj.strictLong("created_at") == null) return false
    return true
}

/** HistoryFrame 结构深校验（messages 数组逐元素 isMessageShape + 元字段）。 */
private fun isHistoryShape(obj: JsonObject): Boolean {
    val messages = obj["messages"] ?: return false
    if (messages !is JsonArray) return false
    if (!messages.all { it is JsonObject && isMessageShape(it as JsonObject) }) return false
    val oldest = obj.strictLong("oldest_kept_seq") ?: return false
    if (oldest < 0) return false
    if (obj.strictBoolean("has_more") == null) return false
    return true
}

/**
 * AnsweredFrame 结构深校验（04-01 冻结字段集；frames.ts isAnsweredShape 逐条件）。
 * answered 恒 true 语义由服务端保证（守卫按冻结形态查 boolean）；answered_at
 * 非空 number（approve-freeze 裁量点 3）；seq 允许 0 拒绝负。
 */
private fun isAnsweredShape(obj: JsonObject): Boolean {
    if (obj.strictInt("v") != PROTOCOL_VERSION) return false
    val wid = obj["wid"] as? JsonPrimitive ?: return false
    if (!wid.isString) return false
    val seq = obj.strictLong("seq") ?: return false
    if (seq < 0) return false
    if (obj.strictBoolean("answered") == null) return false
    if (!obj.stringOrNullKeyRequired("answered_by")) return false
    if (obj.strictLong("answered_at") == null) return false
    if (!obj.stringOrNullKeyRequired("answered_content")) return false
    return true
}

/** WsErrorFrame 结构校验（code/message 双 string；code 不枚举——未知值兼容）。 */
private fun isErrorShape(obj: JsonObject): Boolean {
    val code = obj["code"] as? JsonPrimitive ?: return false
    if (!code.isString) return false
    val message = obj["message"] as? JsonPrimitive ?: return false
    return message.isString
}

/** AckFrame 校验：恰查 wid 为 string（v 已由版本门检查、type 已由分流匹配）。 */
private fun isAckShape(obj: JsonObject): Boolean {
    val wid = obj["wid"] as? JsonPrimitive ?: return false
    return wid.isString
}

/**
 * 解析服务端入站帧（两段式——版本门 Fatal 必须在判别式分发之前，方向相反不能合并）。
 *
 * 分流三档见文件头。未知 discriminator 抛 SerializationException（kotlinx 文档
 * 行为，A2 假设——FixturesContractTest 首条实证）→ 非致命 Drop；深校验 shape
 * 预检不通过的已知 type 同样 Drop（decode 只承担类型转换，语义守卫在本层）。
 */
fun parseServerFrame(raw: String): FrameResult {
    val element = try {
        lenientJson.parseToJsonElement(raw)
    } catch (e: Exception) {
        return FrameResult.Drop("unparseable")
    }
    if (element !is JsonObject) {
        return FrameResult.Drop("non-object")
    }
    // ① 版本先行（D-07）：v 缺失/类型混淆（字符串 "1"）/不等于当前版本均 fatal。
    if (element.strictInt("v") != PROTOCOL_VERSION) {
        return FrameResult.Fatal("unsupported protocol version: ${element["v"]}")
    }
    // ② 按 type 分流：已知 type 先深校验 shape 再 decode；未知 type 非致命丢弃
    //    （D-07 前瞻兼容）。
    val type = (element["type"] as? JsonPrimitive)?.takeIf { it.isString }?.content
    val shapeOk = when (type) {
        "pong" -> true // 宽松直通（TS 同款：v 已查，无更多结构要求）
        "message" -> isMessageShape(element)
        "history" -> isHistoryShape(element)
        "answered" -> isAnsweredShape(element)
        "ack" -> isAckShape(element)
        "error" -> isErrorShape(element)
        else -> return FrameResult.Drop("unknown frame type")
    }
    if (!shapeOk) {
        return FrameResult.Drop("malformed $type frame")
    }
    return try {
        FrameResult.Ok(lenientJson.decodeFromJsonElement(ServerFrame.serializer(), element))
    } catch (e: SerializationException) {
        // shape 预检漏网的残余结构违例兜底（防御层，正常不可达）。
        FrameResult.Drop("malformed $type frame")
    }
}
