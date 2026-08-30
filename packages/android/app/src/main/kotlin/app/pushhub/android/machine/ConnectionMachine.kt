package app.pushhub.android.machine

import app.pushhub.android.protocol.AnsweredFrame
import app.pushhub.android.protocol.FrameResult
import app.pushhub.android.protocol.HistoryFrame
import app.pushhub.android.protocol.MessageFrame
import app.pushhub.android.protocol.ServerFrame
import app.pushhub.android.protocol.SYNC_LIMIT_DEFAULT

/**
 * 连接生命周期纯状态机（06-01 Task 3 tracer，D-59 第三端）。
 *
 * packages/web-sdk/src/connection-machine.ts（58-73 常量、84-107 词汇表、246-273
 * handleHistory、200-211/332-345 fatal 语义）的 Kotlin 同构移植，结构对齐
 * packages/desktop/src-tauri/src/machine/mod.rs（Rust 第二端先例）。
 *
 * 形态：输入事件流 → input() → 输出动作流。模块纯逻辑：零 OkHttp/协程/Android
 * 依赖——随机数经构造注入（测试确定性）、定时器经 Timer 事件回喂（adapter 按
 * Schedule 动作创建）。**机器自身零并发防线**：adapter 的单线程 feed 收敛是唯一
 * 并发防线（Pitfall 8，TS→Kotlin 移植唯一新增防线——本模块不设任何同步原语）。
 *
 * tracer 臂位子集（完整词汇表 + 六条 tracer 序列；其余臂位返回空动作并注释
 * 06-03 填充——计划内功能性缺口，非架构缺口）：
 *  - Connect → EmitStatus(Connecting) + CreateSocket
 *  - WsOpen → attempt 归零 + syncBase=dedup.last 快照 + awaitingInitialHistory
 *    + 武装 Heartbeat(30s) + EmitStatus(Online)
 *  - WsClose → cancelAll；manuallyClosed/fatalStopped → Offline，否则
 *    EmitStatus(Reconnecting) + Schedule(Reconnect, full jitter)
 *  - WsFail → fatal 族（仅 Connecting 态消费：cancelAll + EmitError(fatal) +
 *    Offline 停机，不武装任何定时器；此后任意事件零动作）
 *  - Timer(Reconnect) → CreateSocket + EmitStatus(Connecting)（武装集过滤幽灵）
 *  - Timer(Heartbeat) → SendPing + 武装 PongDeadline(10s) + 重武装 Heartbeat
 *  - Frame(Ok: pong) → 取消两类死线；message → shouldDeliver 过滤 EmitMessage；
 *    history → fresh 过滤 EmitHistory + 首拉无条件 SendSync(since=syncBase)
 *  - Frame(Fatal) → EmitError(fatal) + CloseSocket(Fatal) + Offline 停机
 */

// ---- 常量（connection-machine.ts:58-73 逐条 verbatim；数值变更即协议事件——
//      四端一致性由 golden fixtures 与常量锚定测试保障）----

/** full jitter 退避 base（首失败重连延迟上限 500ms 量级）。 */
const val BACKOFF_BASE_MS: Long = 500

/** full jitter 退避 cap（SC2 锁定 60s——服务端部署断连后的最长静默重连间隔）。 */
const val BACKOFF_CAP_MS: Long = 60_000

/** 心跳周期：每 30s 一应用层 ping（经服务端 auto-response 零计费保活）。 */
const val HEARTBEAT_INTERVAL_MS: Long = 30_000

/** pong 死线：ping 后 10s 无 pong 判连接假死，强制重连。 */
const val PONG_DEADLINE_MS: Long = 10_000

/** 探活死线（D-27）：页面回前台 ping 后 5s 无 pong 判死线，强制重连续补拉。 */
const val PROBE_DEADLINE_MS: Long = 5_000

/** has_more 连续翻页硬上限（T-02-06：服务端异常循环 has_more 时不无限翻页）。 */
const val SYNC_PAGE_MAX: Int = 100

// ---- 词汇表（connection-machine.ts:84-107 verbatim）----

/** 定时器种类（Schedule/Cancel/Timer 三处共用；语义上互不重叠）。 */
enum class TimerKind { Reconnect, Heartbeat, PongDeadline, Probe }

/** CloseSocket 的发起方（adapter 据此选择 WS close code）。 */
enum class CloseReason { Manual, Fatal, Deadline }

/** 状态标签（adapter 原样转发 UI；idle/offline/destroyed 内部态均为 Offline）。 */
enum class Status { Connecting, Online, Reconnecting, Offline }

/** 输入事件：adapter 把 WS 回调 / 定时器到点 / 生命周期事件翻译成这些。 */
sealed class MachineEvent {
    data object Connect : MachineEvent()
    data object Disconnect : MachineEvent()
    data object Destroy : MachineEvent()
    data object WsOpen : MachineEvent()
    data object WsClose : MachineEvent()
    data class WsFail(val message: String) : MachineEvent()
    data class Frame(val result: FrameResult) : MachineEvent()
    data class Visibility(val visible: Boolean) : MachineEvent()
    data class Timer(val timer: TimerKind) : MachineEvent()
}

/** 错误载荷（对齐 TS PushHubErrorPayload：message + 可选 code/fatal）。 */
data class ErrorPayload(
    val message: String,
    val code: String? = null,
    val fatal: Boolean? = null,
)

/** 输出动作：adapter 把这些映射到真实 WebSocket / 协程定时器 / ChannelEvents 回调。 */
sealed class MachineAction {
    data object CreateSocket : MachineAction()
    data class CloseSocket(val reason: CloseReason) : MachineAction()
    data object SendPing : MachineAction()
    data class SendSync(val since: Long, val limit: Int) : MachineAction()
    data class Schedule(val timer: TimerKind, val delayMs: Long) : MachineAction()
    data class Cancel(val timer: TimerKind) : MachineAction()
    data class EmitStatus(val status: Status) : MachineAction()
    data class EmitMessage(val message: MessageFrame) : MachineAction()
    data class EmitHistory(val frame: HistoryFrame) : MachineAction()
    data class EmitAnswered(val frame: AnsweredFrame) : MachineAction()
    data class EmitError(val error: ErrorPayload) : MachineAction()
}

/** 内部全量状态（idle/offline/destroyed 的 status 标签均为 Offline）。 */
private enum class MachineState { Idle, Connecting, Online, Reconnecting, Offline, Destroyed }

private fun statusOf(state: MachineState): Status = when (state) {
    MachineState.Connecting -> Status.Connecting
    MachineState.Online -> Status.Online
    MachineState.Reconnecting -> Status.Reconnecting
    MachineState.Idle, MachineState.Offline, MachineState.Destroyed -> Status.Offline
}

/**
 * 纯状态机。用法与 TS createMachine / Rust Machine 同构：adapter 逐事件喂 input，
 * 按返回动作序列执行副作用；同一事件的动作按序完整执行（状态先迁移、动作随迁移
 * 产生），机器自身无并发（串行化纪律由 adapter 的单线程 feed 承担）。
 *
 * @param random 随机源注入（full jitter）——测试确定性；缺省 Math.random。
 */
class ConnectionMachine(
    private val random: () -> Double = { Math.random() },
) {
    private var state: MachineState = MachineState.Idle
    private var lastStatus: Status? = null
    private var attempt = 0

    /** WsOpen 瞬间的游标快照——首拉后无条件 sync 的基准（02-01 决策 #5）。 */
    private var syncBase = 0L
    private var awaitingInitialHistory = false
    private var syncCount = 0
    private var manuallyClosed = false
    private var fatalStopped = false

    /** 实时帧与补拉帧交叠去重（SeqDedup；answered 帧不经此——06-03 接通时保持例外）。 */
    private val dedup = SeqDedup()

    /** 已武装（未取消/未到点）的定时器集合——Timer 事件据此过滤迟到幽灵。 */
    private val timers = mutableSetOf<TimerKind>()

    /** 当前状态标签（只读观测口，非宿主 API）。 */
    val status: Status
        get() = statusOf(state)

    fun input(event: MachineEvent): List<MachineAction> {
        val out = mutableListOf<MachineAction>()
        handle(event, out)
        return out
    }

    private fun handle(event: MachineEvent, out: MutableList<MachineAction>) {
        when (event) {
            is MachineEvent.Connect -> {
                if (state == MachineState.Destroyed) return
                manuallyClosed = false
                fatalStopped = false
                cancelTimer(TimerKind.Reconnect, out)
                if (state == MachineState.Connecting || state == MachineState.Online) return // 已在连
                enter(MachineState.Connecting, out)
                out += MachineAction.CreateSocket
            }
            is MachineEvent.Disconnect -> {
                // 06-03 填充：手动关停（cancelAll + CloseSocket(Manual) + Offline 可再连）
            }
            is MachineEvent.Destroy -> {
                // 06-03 填充：终局销毁（cancelAll + CloseSocket(Manual) + Destroyed 终态）
            }
            is MachineEvent.WsOpen -> {
                if (state != MachineState.Connecting) return
                attempt = 0
                // 连接前游标快照（Pitfall 5 中段缺口零丢失的关键）。
                syncBase = dedup.last
                awaitingInitialHistory = true
                syncCount = 0
                armTimer(TimerKind.Heartbeat, HEARTBEAT_INTERVAL_MS, out)
                enter(MachineState.Online, out)
            }
            is MachineEvent.WsClose -> {
                if (state == MachineState.Online || state == MachineState.Connecting) {
                    cancelAllTimers(out)
                    if (manuallyClosed || fatalStopped) {
                        enter(MachineState.Offline, out)
                        return
                    }
                    // 意外断开（部署断连/网络闪断/握手失败）→ full jitter 退避重连。
                    enter(MachineState.Reconnecting, out)
                    armTimer(TimerKind.Reconnect, backoffDelay(), out)
                    attempt += 1
                }
                // reconnecting（deadline 路径已自行调度）/offline/destroyed：零动作。
            }
            is MachineEvent.WsFail -> {
                // WR-04（02-04）TS 语义：确定性配置错误（畸形 serverUrl 使构造器同步
                // 抛）——fatal 语义与 v!==1 同族（报错 + 停止 + 不复活，D-07 方向），
                // 不武装任何定时器。仅 connecting 态消费；其余态防御性忽略零动作。
                if (state != MachineState.Connecting) return
                cancelAllTimers(out)
                out += MachineAction.EmitError(
                    ErrorPayload(message = event.message, code = "connect_failed", fatal = true),
                )
                enter(MachineState.Offline, out)
            }
            is MachineEvent.Timer -> {
                if (!timers.remove(event.timer)) return // 未武装的迟到幽灵定时器
                when (event.timer) {
                    TimerKind.Reconnect -> {
                        if (state == MachineState.Reconnecting) {
                            enter(MachineState.Connecting, out)
                            out += MachineAction.CreateSocket
                        }
                    }
                    TimerKind.Heartbeat -> {
                        if (state == MachineState.Online) {
                            out += MachineAction.SendPing
                            armTimer(TimerKind.PongDeadline, PONG_DEADLINE_MS, out)
                            armTimer(TimerKind.Heartbeat, HEARTBEAT_INTERVAL_MS, out)
                        }
                    }
                    TimerKind.PongDeadline, TimerKind.Probe -> {
                        // 06-03 填充：死线超时 forceReconnect（CloseSocket(Deadline) +
                        // 退避重连，不等 WsClose——假活连接不会自己产生事件）
                    }
                }
            }
            is MachineEvent.Visibility -> {
                // 06-03 填充（D-27 探活：visible → SendPing + Probe(5s) + 心跳接管；
                // hidden → 取消心跳与探活）
            }
            is MachineEvent.Frame -> handleFrame(event.result, out)
        }
    }

    private fun handleFrame(result: FrameResult, out: MutableList<MachineAction>) {
        if (state != MachineState.Online) return // 帧只在已建连状态消费（含断开后迟到帧）
        when (result) {
            is FrameResult.Fatal -> {
                // D-07 客户端侧职责：断连 + 报错 + 不再重连（此后零动作）。
                fatalStopped = true
                cancelAllTimers(out)
                out += MachineAction.EmitError(ErrorPayload(message = result.message, fatal = true))
                out += MachineAction.CloseSocket(CloseReason.Fatal)
                enter(MachineState.Offline, out)
            }
            is FrameResult.Drop -> {
                // 非致命（不可解析/非对象/未知 type/结构违例）：静默丢弃。
            }
            is FrameResult.Ok -> when (val frame = result.frame) {
                is ServerFrame.Pong -> {
                    // auto-response 回帧：两类死线一并解除（pong 即"连接活着"的唯一证据）。
                    cancelTimer(TimerKind.PongDeadline, out)
                    cancelTimer(TimerKind.Probe, out)
                }
                is ServerFrame.Message -> {
                    // D-16×D-17：shouldDeliver 是唯一投递闸门（重复 seq 静默吞）。
                    if (dedup.shouldDeliver(frame.seq)) {
                        out += MachineAction.EmitMessage(frame)
                    }
                }
                is ServerFrame.History -> handleHistory(frame, out)
            }
        }
    }

    /**
     * 补拉确定序列 tracer 版（connection-machine.ts handleHistory 对齐）：
     *  - 帧结构原样（oldest_kept_seq/has_more 透传），messages 只含宿主未见消息
     *    （shouldDeliver 唯一过滤闸门）；
     *  - 首拉 → 无条件 SendSync since=连接前游标（缺口可深于首拉 50 条，Pitfall 5）。
     *    has_more 续翻与 SYNC_PAGE_MAX 上限逻辑 06-03 补。
     */
    private fun handleHistory(frame: HistoryFrame, out: MutableList<MachineAction>) {
        val fresh = frame.messages.filter { dedup.shouldDeliver(it.seq) }
        out += MachineAction.EmitHistory(frame.copy(messages = fresh))
        if (awaitingInitialHistory) {
            // 首拉 → 无条件 sync since=连接前游标（缺口可深于首拉 50 条，Pitfall 5）。
            awaitingInitialHistory = false
            syncCount = 1
            out += MachineAction.SendSync(since = syncBase, limit = SYNC_LIMIT_DEFAULT)
            return
        }
        // 06-03 填充：has_more 以 dedup.last 续翻；连续 SYNC_PAGE_MAX=100 页放弃并
        // EmitError（T-02-06 防服务端异常死循环）
    }

    /** 武装定时器（替换语义：同种已武装则先 cancel 再 schedule）。 */
    private fun armTimer(timer: TimerKind, delayMs: Long, out: MutableList<MachineAction>) {
        cancelTimer(timer, out)
        timers.add(timer)
        out += MachineAction.Schedule(timer, delayMs)
    }

    private fun cancelTimer(timer: TimerKind, out: MutableList<MachineAction>) {
        if (timers.remove(timer)) {
            out += MachineAction.Cancel(timer)
        }
    }

    private fun cancelAllTimers(out: MutableList<MachineAction>) {
        for (timer in timers.toList()) cancelTimer(timer, out)
    }

    private fun enter(next: MachineState, out: MutableList<MachineAction>) {
        state = next
        val label = statusOf(next)
        if (label != lastStatus) {
            lastStatus = label
            out += MachineAction.EmitStatus(label)
        }
    }

    /** full jitter：delay = random() * min(60_000, 500 * 2^attempt)。 */
    private fun backoffDelay(): Long {
        val window = minOf(BACKOFF_CAP_MS, BACKOFF_BASE_MS shl attempt.coerceAtMost(32))
        return (random() * window).toLong()
    }
}
