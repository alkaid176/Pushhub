package app.pushhub.android.machine

import app.pushhub.android.protocol.RETENTION_KEEP
import app.pushhub.android.protocol.ServerFrame

/**
 * 每频道本地消息环形缓冲（06-03 Task 2，D-60/D-62）——
 * packages/desktop/src-tauri/src/buffer.rs 的 Kotlin 同构（第三端）。
 *
 * 职责：客户端持有频道消息历史（服务端 DO 只保留 500 条——客户端存更多无意义，
 * D-62 对齐 RETENTION_KEEP=500/D-08），作为界面重建消息列表的全量数据源。
 *
 * 语义锁定（buffer.rs 同款）：
 *  - 容量 500 环形：push 满时淘汰最旧一条（严格插入序，最旧先出）并返回被淘汰项；
 *  - snapshot() 返回当前全部消息（按 seq 升序）与元信息（累计淘汰数、最旧保留
 *    seq）——补拉/实时交叠时插入序可乱序，展示语义要求 seq 升序，导出时排序；
 *  - applyAnswered：answered 状态原位更新（不新增条目——D-17 answered 独立成帧
 *    正是为此）；找不到对应 wid 返回 false（迟到 answered 容忍，消息可能已被
 *    环形淘汰或属于其他会话前窗口）；幂等：同 wid 重复扇出重复覆写无害。
 *
 * 零平台依赖纯逻辑（ArrayDeque——机器串行化纪律下仅单线程访问，不设同步原语）。
 */

/**
 * 每频道缓冲上限（D-62；与服务端 DO 保留窗口 RETENTION_KEEP=500/D-08 对齐——
 * BufferTest 硬断言两常量互等，数值漂移即协议事件。单点声明：唯一改法是同时
 * 改 shared/src/index.ts 与本处并被四端 fixtures 契约测试抓出）。
 */
const val BUFFER_CAP: Int = 500

/** snapshot 全量导出（界面重建消息列表的数据源，D-60）。 */
data class BufferSnapshot(
    /** 当前保留消息（按 seq 升序——插入序在补拉/实时交叠时可能乱序，导出时排序）。 */
    val messages: List<ServerFrame.Message>,
    /** 自缓冲创建以来累计淘汰条数（观测元数据）。 */
    val evicted: Long,
    /** 当前保留的最旧 seq（空缓冲为 null）。 */
    val oldestKeptSeq: Long?,
)

/** 环形消息缓冲（MessageFrame 特化——answered 原位更新与 seq 元信息）。 */
class Buffer {
    private val deque = ArrayDeque<ServerFrame.Message>(BUFFER_CAP)
    private var evictedCount = 0L

    /** 入缓冲；容量满时淘汰最旧一条（插入序）并返回被淘汰项（未满返回 null）。 */
    fun push(msg: ServerFrame.Message): ServerFrame.Message? {
        val evicted = if (deque.size >= BUFFER_CAP) deque.removeFirst() else null
        if (evicted != null) evictedCount += 1
        deque.addLast(msg)
        return evicted
    }

    /** 当前保留条数。 */
    val size: Int
        get() = deque.size

    /** 是否为空。 */
    val isEmpty: Boolean
        get() = deque.isEmpty()

    /** 全量快照：消息按 seq 升序 + 淘汰计数 + 最旧保留 seq。 */
    fun snapshot(): BufferSnapshot {
        val messages = deque.sortedBy { it.seq }
        return BufferSnapshot(
            messages = messages,
            evicted = evictedCount,
            oldestKeptSeq = messages.firstOrNull()?.seq,
        )
    }

    /**
     * answered 原位更新（D-17）：按 wid 定位缓冲内消息，answered 系列字段以帧
     * 为准覆写；找不到返回 false（迟到 answered 容忍——消息可能已被环形淘汰）。
     * 幂等：同 wid 重复扇出重复覆写无害。
     */
    fun applyAnswered(frame: ServerFrame.Answered): Boolean {
        for (i in deque.indices) {
            val m = deque[i]
            if (m.wid == frame.wid) {
                deque[i] = m.copy(
                    answered = frame.answered,
                    answeredBy = frame.answeredBy,
                    answeredAt = frame.answeredAt,
                    answeredContent = frame.answeredContent,
                )
                return true
            }
        }
        return false
    }

    /** 当前缓冲内全部 seq（测试观测口——恰缺零重断言用）。 */
    fun seqs(): List<Long> = deque.map { it.seq }
}
