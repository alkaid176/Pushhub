package app.pushhub.android.machine

import app.pushhub.android.protocol.FrameResult
import app.pushhub.android.protocol.HistoryFrame
import app.pushhub.android.protocol.MessageFrame
import app.pushhub.android.protocol.ServerFrame

/**
 * machine 测试家族共享构造器（06-03 Task 2）——Rust machine/tests/mod.rs 的
 * Kotlin 同构：机器测试直接构造 ServerFrame 结构体（绕过 parseServerFrame——
 * 后者的契约由 FixturesContractTest 吃 golden fixtures 独立锁定）；常量在断言
 * 中以字面量出现（250/60000/30000/10000/5000/100——数值漂移即测试红）。
 */

/** 最小合法 message 帧（D-03 冻结 13 字段；可选字段走省略语义 null）。 */
internal fun msgFrame(seq: Long): MessageFrame = MessageFrame(
    v = 1,
    wid = "m_test%012d".format(seq),
    seq = seq,
    title = null,
    text = "message #$seq",
    callbackUrl = null,
    clickUrl = null,
    options = null,
    priority = "normal",
    answered = false,
    answeredBy = null,
    answeredAt = null,
    answeredContent = null,
    createdAt = 1_700_000_000_000 + seq,
)

/** message 帧事件（FrameResult.Ok 包装）。 */
internal fun msg(seq: Long): FrameResult = FrameResult.Ok(msgFrame(seq))

/** history 帧事件（oldestKeptSeq / hasMore 由调用方指定——原样透传断言用）。 */
internal fun history(seqs: List<Long>, oldestKeptSeq: Long, hasMore: Boolean): FrameResult =
    FrameResult.Ok(
        HistoryFrame(
            v = 1,
            messages = seqs.map { msgFrame(it) },
            oldestKeptSeq = oldestKeptSeq,
            hasMore = hasMore,
        ),
    )

/** pong 帧事件。 */
internal fun pong(): FrameResult = FrameResult.Ok(ServerFrame.Pong(v = 1))

/** answered 帧事件（by/content 可指定——透传与 Buffer 覆写断言用）。 */
internal fun answeredFrame(wid: String, seq: Long): FrameResult =
    FrameResult.Ok(
        ServerFrame.Answered(
            v = 1,
            wid = wid,
            seq = seq,
            answered = true,
            answeredBy = "alice",
            answeredAt = 1_700_000_001_000,
            answeredContent = "done",
        ),
    )

/** 在线机器（随机源恒 0.5——退避相关断言的确定性基准）。 */
internal fun onlineHalf(): ConnectionMachine = onlineWithSeen()

/** 在线机器 + 预置已见 seq（实时 message 帧逐条喂入）。 */
internal fun onlineWithSeen(vararg seqs: Long): ConnectionMachine {
    val m = ConnectionMachine(random = { 0.5 })
    m.input(MachineEvent.Connect)
    m.input(MachineEvent.WsOpen)
    for (seq in seqs) {
        m.input(MachineEvent.Frame(msg(seq)))
    }
    return m
}
