package app.pushhub.android.protocol

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.decodeFromJsonElement

/**
 * 协议帧解析（06-01 Task 3 tracer，D-59/D-07）。
 *
 * 与 packages/web-sdk/src/frames.ts、packages/desktop/src-tauri/src/protocol/mod.rs
 * 三档语义逐行为对齐（第三端同构移植）：
 *  - Ok(ServerFrame)：合法帧（tracer 帧型：pong/message/history；error/answered/ack
 *    帧型留 06-03 补全——当前作为未知 type 非致命 Drop，D-07 前瞻兼容方向正确）；
 *  - Drop(reason)：非致命丢弃（不可解析/非对象/未知 type/结构违例）——坏帧不毒害连接；
 *  - Fatal(message)：仅 v !== PROTOCOL_VERSION（D-07 客户端严格方向——客户端不识别
 *    的 v 即断连报错；服务端比客户端新，重连无意义）。
 *
 * 协议常量与帧结构对齐 packages/shared/src/index.ts（冻结契约唯一事实源，100-247）。
 * 未知字段一律忽略（D-07：lenientJson.ignoreUnknownKeys，fixtures 的 _note 元数据
 * 字段是活体测试）。
 *
 * 值域校验边界（planned gap，06-03 随帧型补全一并收口）：kotlinx 只做类型层校验，
 * priority 枚举成员/seq 下界/wid 非空等值域守卫（TS isMessageShape / Rust 手写守卫
 * 对应物）在 06-03 全帧型补齐；服务端出站帧经服务端校验，tracer 阶段风险受控。
 */

/** 线协议版本（D-07，shared/src/index.ts:18 verbatim）：所有 WS 帧顶层 v 字段的当前值。 */
const val PROTOCOL_VERSION: Int = 1

/**
 * D-11 sync 补拉 limit 缺省值（shared/src/index.ts:44 verbatim）。
 * 消费面：machine SendSync 动作（handleHistory 首拉无条件补拉）。
 */
const val SYNC_LIMIT_DEFAULT: Int = 200

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
 * 服务端 → 客户端帧全集（tracer 子集）。判别式 classDiscriminator 用默认 "type"
 * （与协议帧 type 字段天然对齐）。
 *
 * v 字段一律无默认值：嵌套（history.messages 元素）缺 v 必须结构违例 Drop——
 * golden 反例 history-frame.negative.json 的 "message element missing v" 用例锚定。
 */
@Serializable
sealed class ServerFrame {

    /** v:1 pong 帧（服务端 auto-response 自动回帧，不唤醒 DO）。 */
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

    // 06-03 填充点：WsErrorFrame（type:"error"）/ AckFrame（type:"ack"）/
    // Answered 解码臂（type:"answered"）——当前按未知 type Drop（D-07 前瞻兼容）。
}

// 词汇表别名（对齐 plan 的 PongFrame/MessageFrame/HistoryFrame 命名）。
typealias PongFrame = ServerFrame.Pong
typealias MessageFrame = ServerFrame.Message
typealias HistoryFrame = ServerFrame.History

/**
 * v:1 answered 帧（04-01 冻结字段集）——本 plan 仅作 EmitAnswered 动作的载荷类型
 * 占位（词汇表完整，11 动作 verbatim）；解码臂与 emitAnswered 分派在 06-03 接通。
 * 不经 SeqDedup 原样透传（D-17 硬约束：独立帧而非 message 重发）。
 */
data class AnsweredFrame(
    val v: Int,
    val wid: String,
    val seq: Long,
    val answered: Boolean,
    val answeredBy: String?,
    val answeredAt: Long,
    val answeredContent: String?,
)

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
 * v:1 reply 帧（客户端 → 服务端回复，04-01 D-45/D-46）。selected_option 与 text
 * 恰提供其一（恰一校验在发送侧，域级校验在服务端 DO）；by 为自报展示名，缺省不
 * 序列化（省略语义——键不出现即匿名回复，D-53）。adapter 的 sendReply 占位消费，
 * 06-06 回复 UI 接线。
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

/**
 * 解析服务端入站帧（两段式——版本门 Fatal 必须在判别式分发之前，方向相反不能合并）。
 *
 * 分流三档见文件头。未知 discriminator 值抛 SerializationException（kotlinx 文档
 * 行为，A2 假设——FramesTracerTest 用未知 type 用例实证）→ 非致命 Drop。
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
    // ① 版本先行（D-07）：v 缺失或不等于当前版本均为版本错误——Fatal。
    val v = (element["v"] as? JsonPrimitive)?.intOrNull
    if (v != PROTOCOL_VERSION) {
        return FrameResult.Fatal("unsupported protocol version")
    }
    // ② 判别式分发：结构违例（必填缺失/类型不符/嵌套元素缺 v）与未知 type 均
    // SerializationException → 非致命丢弃。
    return try {
        FrameResult.Ok(lenientJson.decodeFromJsonElement(ServerFrame.serializer(), element))
    } catch (e: SerializationException) {
        FrameResult.Drop("malformed or unknown frame type")
    }
}
