package app.pushhub.android.adapter

import app.pushhub.android.machine.ConnectionMachine
import app.pushhub.android.machine.ErrorPayload
import app.pushhub.android.machine.MachineAction
import app.pushhub.android.machine.MachineEvent
import app.pushhub.android.machine.Status
import app.pushhub.android.machine.TimerKind
import app.pushhub.android.machine.CloseReason
import app.pushhub.android.protocol.AnsweredFrame
import app.pushhub.android.protocol.HistoryFrame
import app.pushhub.android.protocol.MessageFrame
import app.pushhub.android.protocol.PROTOCOL_VERSION
import app.pushhub.android.protocol.ReplyFrame
import app.pushhub.android.protocol.SyncFrame
import app.pushhub.android.protocol.lenientJson
import app.pushhub.android.protocol.parseServerFrame
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.encodeToString
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.net.URLEncoder
import java.util.concurrent.atomic.AtomicLong

/**
 * ChannelEvents 回调接口——通知路由与 UI 的同口订阅点（06-05 NotificationRouter /
 * 06-06 消息界面均挂此口扩展）。
 *
 * 两流分离不变量（D-61/D-63，adapter/mod.rs:17-21 先例）：回调语义按机器动作
 * 分型，adapter 内不合并不转发混装——
 *  - onMessage 仅来自 EmitMessage（实时帧 → 通知路径）；
 *  - onHistory 仅来自 EmitHistory（首拉/补拉批次 → 缓冲路径，绝不触发通知）；
 *  - onAnswered 仅来自 EmitAnswered（answered 扇出 → D-69 cancel(tag=wid) 路径）。
 * 双计数器测试锁定（AdapterResyncTest）。
 */
interface ChannelEvents {
    fun onStatus(status: Status)
    fun onMessage(message: MessageFrame)
    fun onHistory(frame: HistoryFrame)
    fun onAnswered(frame: AnsweredFrame)
    fun onError(error: ErrorPayload)
}

/**
 * 心跳出站帧（Pitfall 1，最高优先）：逐字节等于服务端 setWebSocketAutoResponse
 * 匹配串（packages/server/src/chat-room.ts PING_FRAME 字面量）——字节常量直发，
 * **禁运行时序列化构造**（键序/空格不受控即失配 → ping 被当作普通入站消息唤醒
 * DO 计费处理 → 免费额度加速耗尽 + pong 死线误判假死循环重连）。
 * 与 web-sdk pushhub.ts PING / 桌面端 adapter PING 三端一致。
 */
const val PING: String = """{"v":1,"type":"ping"}"""

/**
 * 连接 URL 构造（pushhub.ts 同构，Pitfall 6）。
 *
 * 前缀替换顺序：先 https→wss 后 http→ws（"http"→"ws" 后 s 保留的顺序坑）；
 * 尾斜杠全部规整；密钥经 URL 编码（服务端路由 /api/ws/:key 逐段 decodeURIComponent，
 * 键含保留字符必须先编码）。URLEncoder 的空格编码是 '+' 而路径段语义要求 %20——
 * 编码后替换（encodeURIComponent 语义对齐）。
 */
fun buildWsUrl(serverUrl: String, channelKey: String): String {
    val base = serverUrl.trim().trimEnd('/')
    val wsBase = when {
        base.startsWith("https") -> "wss" + base.removePrefix("https")
        base.startsWith("http") -> "ws" + base.removePrefix("http")
        else -> base
    }
    val encodedKey = URLEncoder.encode(channelKey, "UTF-8").replace("+", "%20")
    return "$wsBase/api/ws/$encodedKey"
}

/**
 * OkHttp WS + 协程定时器接线层（06-01 Task 3 tracer，D-59/D-60）——pushhub.ts /
 * 桌面端 adapter/mod.rs 的 Kotlin 同构。
 *
 * 职责边界：连接生命周期语义全部在纯状态机（machine/ConnectionMachine）——本类
 * 只做事件翻译与动作执行：
 *  - **feed 单线程收敛（Pitfall 8，Kotlin 唯一新增防线）**：OkHttp 回调线程、
 *    协程定时器线程只向 Channel send 入队；由 Dispatchers.Default
 *    .limitedParallelism(1) 上的单消费协程串行调 machine.input 与动作分派——
 *    机器自身零同步原语（TS 版依赖 JS 事件循环，Kotlin 必须显式串行化）；
 *  - OkHttp 客户端不配置协议层心跳参数（应用层心跳由机器独占——双机制不互替，
 *    机器死线逻辑只认应用层 pong）；
 *  - 陈旧 socket 防护（代际号）：CreateSocket 自增 AtomicLong 代际；listener
 *    回调先比对代际再 feed（旧连接的迟到事件不上机器）；
 *  - onClosed/onFailure 一律 WsClose（握手失败/TLS/网络断——05-01 实证语义：
 *    connect 失败走退避而非 fatal）；仅 Request URL 构造抛 IllegalArgumentException
 *    （畸形 URL，确定性配置错误）时映射 WsFail（fatal 族停机）；
 *  - close code 三档（pushhub.ts:353-367）：Fatal→1002 / Deadline→4000 / Manual→1000；
 *  - 错误文案静态英文短句，不含 URL/密钥子串（密钥在路径段——T-06-01-01）。
 */
@OptIn(ExperimentalCoroutinesApi::class)
class OkHttpChannelAdapter(
    /** internal：测试观测最终状态（Concurrency 测试与单线程重放对照）。 */
    internal val machine: ConnectionMachine,
    serverUrl: String,
    channelKey: String,
    private val events: ChannelEvents,
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val client = OkHttpClient()

    private val wsUrl: String = buildWsUrl(serverUrl, channelKey)

    /** 事件串行队列（UNLIMITED——feed 只入队永不阻塞回调线程）。 */
    private val eventQueue = Channel<MachineEvent>(Channel.UNLIMITED)

    /** 单线程消费派发器（Pitfall 8：机器串行化的唯一并发防线）。 */
    private val feedDispatcher = Dispatchers.Default.limitedParallelism(1)

    /** 当前连接代际号（CreateSocket 自增；listener 回调据此过滤陈旧）。 */
    private val generation = AtomicLong(0)

    /**
     * 当前代际的 WebSocket 句柄（消费协程写——feed 串行化保证；sendReply 由 UI
     * 主线程、destroy 由调用方线程跨线程读——@Volatile 保证可见性，WR-01 修复：
     * 此前字段注释声明「仅消费协程读写」，非 volatile 跨线程读无 happens-before，
     * 违背自身并发模型声明）。
     */
    @Volatile
    private var ws: WebSocket? = null

    /** destroy 已置位（openSocket 建连竞态兜底——CR-01：destroy 读取 ws 后才赋值的新句柄补取消）。 */
    @Volatile
    private var destroyed = false

    /** Schedule 动作产生的定时器 Job（同种替换：先 cancel 再武装）。 */
    private val timers = mutableMapOf<TimerKind, Job>()

    init {
        scope.launch(feedDispatcher) {
            for (event in eventQueue) {
                for (action in machine.input(event)) {
                    apply(action)
                }
            }
        }
    }

    /** 连接生命周期入口（Service 装配后调用）。 */
    fun connect() = feed(MachineEvent.Connect)

    /** 主动断开（Disconnect 臂位 06-03 填充；feed 通道保持开放）。 */
    fun disconnect() = feed(MachineEvent.Disconnect)

    /**
     * 探活广播入口（D-27——06-07 增补）：ChannelManager.setVisibility 逐频道
     * 转发的生产注入口（此前唯一入口是 internal feedEvent 测试通道——06-07
     * ChannelRuntime.setVisibility 接线所需的最小增补，Rule 3）。
     */
    fun setVisibility(visible: Boolean) = feed(MachineEvent.Visibility(visible))

    /**
     * 终局销毁：Destroy 事件入队 + 串行队列关闭 + **同步强制断连** + scope 取消
     * （定时器一并收敛）。
     *
     * CR-01 修复：scope.cancel() 是同步取消——消费协程挂起在 receive 时，已入队
     * 的 Destroy 在恢复点直接抛 CancellationException 被丢弃，状态机收不到
     * Destroy → CloseSocket(Manual) 不执行 → 幽灵连接（FGS 停止后服务端视角
     * 连接仍在线并继续推送）。断连因此**不依赖事件队列排空**：close 尽力走
     * 优雅关闭，cancel 立即强制断开（不等优雅关闭握手）；OkHttpClient 的
     * dispatcher 线程池一并 shutdown（不 shutdown 则空闲线程驻留进程）。
     */
    fun destroy() {
        destroyed = true
        feed(MachineEvent.Destroy)
        eventQueue.close()
        val (code, reason) = closeCodeOf(CloseReason.Manual)
        ws?.close(code, reason)
        ws?.cancel()
        scope.cancel()
        client.dispatcher.executorService.shutdown()
    }

    /** 事件入队（任意线程可调——OkHttp 回调线程/定时器协程/UI 线程）。 */
    private fun feed(event: MachineEvent) {
        eventQueue.trySend(event)
    }

    /**
     * 动作观察钩子（06-07 增补）：消费协程在 apply 后回调（仅消费协程线程调用，
     * 钩子自身须线程安全）。生产消费面 = OkHttpChannelRuntime 转发
     * Schedule(Reconnect) 的剩余毫秒（重连倒计时发布——D-81 状态条数据源）；
     * null = 无观察（缺省零开销）。
     */
    internal var onActionHook: ((MachineAction) -> Unit)? = null

    /**
     * 事件注入口（JVM 测试专用——internal 同 module 可见）：模拟定时器到期/
     * WS 回调到达，直接向 feed 通道压入事件（AdapterFailover 死线路径与
     * AdapterConcurrency 并发防线测试消费；生产代码不得调用）。
     */
    internal fun feedEvent(event: MachineEvent) = feed(event)

    // ---- 动作分派（仅消费协程调用——串行化保证） ----

    private fun apply(action: MachineAction) {
        when (action) {
            is MachineAction.CreateSocket -> openSocket()
            is MachineAction.CloseSocket -> {
                val (code, reason) = closeCodeOf(action.reason)
                ws?.close(code, reason)
            }
            is MachineAction.SendPing -> ws?.send(PING) // 字节常量直发（Pitfall 1）
            is MachineAction.SendSync -> {
                // sync 帧允许运行时序列化（服务端 JSON.parse 键序无关；唯一字节
                // 常量约束是 PING）。
                val frame = SyncFrame(v = PROTOCOL_VERSION, type = "sync", since = action.since, limit = action.limit)
                ws?.send(lenientJson.encodeToString(frame))
            }
            is MachineAction.Schedule -> {
                // 替换语义：同种已武装先取消（机器 armTimer 的 cancel+schedule 对应物）；
                // 幽灵定时器由机器武装集过滤（双保险，同 TS setTimeout 模式）。
                timers.remove(action.timer)?.cancel()
                val timer = action.timer
                timers[timer] = scope.launch {
                    delay(action.delayMs)
                    feed(MachineEvent.Timer(timer))
                }
            }
            is MachineAction.Cancel -> timers.remove(action.timer)?.cancel()
            is MachineAction.EmitStatus -> events.onStatus(action.status)
            is MachineAction.EmitMessage -> events.onMessage(action.message)
            is MachineAction.EmitHistory -> events.onHistory(action.frame)
            is MachineAction.EmitAnswered -> events.onAnswered(action.frame)
            is MachineAction.EmitError -> events.onError(action.error)
        }
        onActionHook?.invoke(action)
    }

    private fun openSocket() {
        val gen = generation.incrementAndGet()
        // 陈旧 socket 防护：新连接尝试开始即弃旧句柄（迟到事件由代际号拦截）。
        ws = null
        val request = try {
            Request.Builder().url(wsUrl).build()
        } catch (e: IllegalArgumentException) {
            // 畸形 serverUrl（唯一同步抛出源，确定性配置错误）→ WsFail fatal 族
            // （报错 + 停止 + 不复活）。错误文案静态英文，不内嵌 URL（密钥在路径段）。
            feed(MachineEvent.WsFail("failed to construct WebSocket for serverUrl"))
            return
        }
        ws = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                if (gen == generation.get()) feed(MachineEvent.WsOpen)
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                if (gen == generation.get()) {
                    feed(MachineEvent.Frame(parseServerFrame(text)))
                }
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                if (gen == generation.get()) feed(MachineEvent.WsClose)
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                // 06-03 修复：OkHttp 默认 onClosing 不回应——服务端优雅关闭时
                // 客户端挂在半关闭态（onClosed 永不触发 → 机器收不到 WsClose →
                // 连接泄漏）。标准 OkHttp 客户端模式：回 close 完成握手，随后
                // onClosed 走 WsClose 族。
                webSocket.close(code, reason)
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                // 握手失败/TLS/网络断全收口于此（05-01 实证：connect 失败映射
                // WsClose 走退避，非 fatal）。onFailure 不发事件载荷（文案可能含
                // URL——密钥在路径段，绝不外泄）。
                if (gen == generation.get()) feed(MachineEvent.WsClose)
            }
        })
        // destroy 竞态兜底（CR-01）：destroy() 读取 ws 之后本行才赋值的新句柄会
        // 逃过 destroy 的同步断连（executor 已 shutdown 的同步拒绝由 OkHttp
        // executeOn 内部转 onFailure，代际过滤后事件随关闭队列丢弃）——补一次
        // 检查立即取消。
        if (destroyed) ws?.cancel()
    }

    /**
     * 回复出站直发（WEB-03 Pattern 7：reply 不进连接状态机词汇表——连接层
     * 只管连接生命周期）。06-06 回复 UI 消费。
     *
     * @return false = not_connected（未建连 fail-fast——不排队不重试，用户重试
     *   语义属 UI 业务层）；载荷恰一校验由服务端权威执行（域级拒绝经 WsErrorFrame
     *   → onError 回调透传）。
     * @param by 自报展示名（D-72——06-06 UI 层从 ConfigStore.displayName 自动
     *   携带；null/空白缺省不序列化即匿名回复，上限 BY_MAX 由 UI 层裁剪后传入）。
     *   06-06 Task 3 增补：计划要求 sendReply 内部自动携带 displayName——原签名
     *   无该参数（Rule 3 偏差修复，默认值保零调用方兼容）。
     */
    fun sendReply(
        channelId: String,
        wid: String,
        selectedOption: String? = null,
        text: String? = null,
        by: String? = null,
    ): Boolean {
        // channelId 为 06-06 多频道路由参数占位（reply 帧本身无 channel 字段）。
        val socket = ws ?: return false
        val frame = ReplyFrame(
            v = PROTOCOL_VERSION,
            type = "reply",
            wid = wid,
            selectedOption = selectedOption,
            text = text,
            by = by?.takeIf { it.isNotBlank() },
        )
        return socket.send(lenientJson.encodeToString(frame))
    }
}

/** close code 映射（pushhub.ts:355-367 verbatim）；文案静态英文不含 URL/密钥。 */
private fun closeCodeOf(reason: CloseReason): Pair<Int, String> = when (reason) {
    CloseReason.Fatal -> 1002 to "protocol version mismatch"
    CloseReason.Deadline -> 4000 to "heartbeat deadline"
    CloseReason.Manual -> 1000 to "client disconnect"
}
