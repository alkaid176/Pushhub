package app.pushhub.android.machine

import app.pushhub.android.protocol.FrameResult
import app.pushhub.android.protocol.ServerFrame
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 重连补拉确定序列测试（06-03 Task 2）——Rust machine/tests/resync.rs 同名先例；
 * connection-machine.ts:246-273 handleHistory 逐行 + 288-297 manuallyClosed。
 *
 * D-16×D-17 交集："EmitHistory 载荷的 messages 永远只含宿主未见消息"；帧结构
 * （oldest_kept_seq/has_more）原样透传。首拉 → 无条件 sendSync(since=syncBase
 * 快照)；has_more 以 dedup.last 续翻；连续 SYNC_PAGE_MAX=100 页 EmitError 且
 * 连接保持（T-02-06 防服务端异常死循环）。
 */
class ConnectionMachineResyncTest {

    /** 抽取动作流中的全部 SendSync(since, limit)。 */
    private fun syncsOf(actions: List<MachineAction>): List<Pair<Long, Int>> =
        actions.filterIsInstance<MachineAction.SendSync>().map { it.since to it.limit }

    /** 抽取动作流中的首条 EmitHistory 载荷 seq 列表。 */
    private fun historySeqsOf(actions: List<MachineAction>): List<Long> =
        actions.filterIsInstance<MachineAction.EmitHistory>().single().frame.messages.map { it.seq }

    /** 首拉：fresh 过滤 EmitHistory + 无条件 SendSync(since=syncBase, limit=200)。 */
    @Test
    fun `initial history filtered batch and unconditional sync from snapshot`() {
        val m = onlineHalf() // syncBase = dedup.last 快照 = 0（连接前游标）
        // 实时帧先到（seq=7）——dedup 窗口记录。
        assertEquals(1, m.input(MachineEvent.Frame(msg(7))).size)
        // 首拉批次含已见（7 → 过滤）与未见（8/9）。
        val actions = m.input(MachineEvent.Frame(history(listOf(7, 8, 9), 1, hasMore = false)))
        assertEquals(listOf(8L, 9L), historySeqsOf(actions))
        // 无条件 SendSync since=连接前游标快照（缺口可深于首拉 50 条，Pitfall 5）。
        assertEquals(listOf(0L to 200), syncsOf(actions))
        // 重复 seq 的实时帧被 dedup 静默吞（D-17 第二道防线）。
        assertEquals(emptyList<MachineAction>(), m.input(MachineEvent.Frame(msg(7))))
    }

    /** 重连场景：第二段连接 syncBase=断连前游标，首拉无条件补拉以该快照为基准。 */
    @Test
    fun `reconnect first pull syncs from pre disconnect cursor`() {
        val m = onlineWithSeen(*(1L..10L).toList().toLongArray()) // 第一段实时见过 seq 1..10
        m.input(MachineEvent.WsClose)
        m.input(MachineEvent.Timer(TimerKind.Reconnect))
        m.input(MachineEvent.WsOpen) // syncBase = dedup.last = 10 快照
        // 服务端 accept 即重推最近若干条（8..15，交叠 8..10 已见）。
        val actions = m.input(MachineEvent.Frame(history((8L..15L).toList(), 8, hasMore = false)))
        assertEquals("只投递未见消息", listOf(11L, 12L, 13L, 14L, 15L), historySeqsOf(actions))
        assertEquals("sendSync(since=syncBase=10, limit=200)", listOf(10L to 200), syncsOf(actions))
    }

    /** 翻页：has_more=true 的后续 history → SendSync(since=dedup.last) 续翻；追平不再 sync。 */
    @Test
    fun `paging continues with dedup last until caught up`() {
        val m = onlineHalf()
        // 首拉（has_more=true）→ 无条件 sync since=syncBase=0。
        assertEquals(listOf(0L to 200), syncsOf(m.input(MachineEvent.Frame(history(listOf(1, 2), 1, hasMore = true)))))
        // 翻页响应（3..5，has_more=true）→ 以本批最大 seq 为新 since。
        assertEquals(listOf(5L to 200), syncsOf(m.input(MachineEvent.Frame(history(listOf(3, 4, 5), 1, hasMore = true)))))
        // 追平（has_more=false）→ 不再 sync，仍投递。
        val final = m.input(MachineEvent.Frame(history(listOf(6), 1, hasMore = false)))
        assertTrue(final.any { it is MachineAction.EmitHistory })
        assertFalse("追平不再续翻", final.any { it is MachineAction.SendSync })
    }

    /**
     * 连续 SYNC_PAGE_MAX=100 页放弃：EmitError(sync_page_limit) 且连接保持
     * （后续 Heartbeat 仍产生动作——连接未被断开）。
     */
    @Test
    fun `hundred page sync limit emits error and keeps connection`() {
        val m = onlineHalf()
        // 首拉（syncCount=1）。
        m.input(MachineEvent.Frame(history(listOf(1), 1, hasMore = true)))
        // 续翻 98 次（syncCount 2..99）→ 每次 has_more=true 续翻。
        repeat(98) { batch ->
            val seq = 2L + batch
            assertEquals(
                "第 ${batch + 2} 页续翻 since=dedup.last",
                listOf(seq to 200),
                syncsOf(m.input(MachineEvent.Frame(history(listOf(seq), 1, hasMore = true)))),
            )
        }
        // 第 100 页（syncCount=99 → 检查 99 >= 100 否 → syncCount=100 + 续翻）。
        assertEquals(listOf(100L to 200), syncsOf(m.input(MachineEvent.Frame(history(listOf(100), 1, hasMore = true)))))
        // 第 101 个 history 响应（has_more 仍 true）：syncCount=100 >= 100 →
        // EmitError(sync_page_limit) 且无 SendSync——连接保持。
        val overLimit = m.input(MachineEvent.Frame(history(listOf(101), 1, hasMore = true)))
        val error = overLimit.filterIsInstance<MachineAction.EmitError>().single()
        assertEquals("sync_page_limit", error.error.code)
        assertFalse("非致命（连接保持）", error.error.fatal == true)
        assertTrue(
            "放弃补拉：无续翻 SendSync",
            overLimit.none { it is MachineAction.SendSync },
        )
        // 连接保持：后续心跳照常产生动作（SC4 连接保持语义）。
        assertEquals(
            listOf(
                MachineAction.SendPing,
                MachineAction.Schedule(TimerKind.PongDeadline, 10_000),
                MachineAction.Schedule(TimerKind.Heartbeat, 30_000),
            ),
            m.input(MachineEvent.Timer(TimerKind.Heartbeat)),
        )
        assertEquals(Status.Online, m.status)
    }

    /** manuallyClosed 抑制重连：Disconnect 后 WsClose 零退避；Connect 复位后恢复。 */
    @Test
    fun `manually closed suppresses reconnect until next connect`() {
        val m = onlineHalf()
        m.input(MachineEvent.Disconnect)
        // CloseSocket(Manual) 的 onClosed 回调 → WsClose：offline 态零动作。
        assertEquals(emptyList<MachineAction>(), m.input(MachineEvent.WsClose))
        assertEquals(Status.Offline, m.status)
        // Connect 复位 manuallyClosed → 正常连接序列。
        assertEquals(
            listOf(
                MachineAction.EmitStatus(Status.Connecting),
                MachineAction.CreateSocket,
            ),
            m.input(MachineEvent.Connect),
        )
    }

    /** answered 帧不经 SeqDedup 原样透传（D-17 硬约束）；ack 静默零动作。 */
    @Test
    fun `answered bypasses dedup ack is silent`() {
        val m = onlineHalf()
        m.input(MachineEvent.Frame(msg(7))) // dedup 已见 7
        // answered 帧（seq=7 同游标）——若走 SeqDedup 会被吞（同 seq 已见），
        // D-17 独立成帧正是为此：必须原样 EmitAnswered。
        val answered = answeredFrame("m_test000000000007", 7) as FrameResult.Ok
        assertEquals(listOf(MachineAction.EmitAnswered(answered.frame as ServerFrame.Answered)), m.input(MachineEvent.Frame(answered)))
        // 同 wid 重复扇出照常透传（幂等消化归宿主按 wid 判定）。
        assertEquals(1, m.input(MachineEvent.Frame(answered)).size)
        // ack 静默零动作（Q4：answered 扇出即公共确认）。
        assertEquals(
            emptyList<MachineAction>(),
            m.input(
                MachineEvent.Frame(FrameResult.Ok(ServerFrame.Ack(v = 1, wid = "m_x"))),
            ),
        )
    }

    /** error 帧非致命透传（invalid_frame 等——连接保持，SC4 坏帧不毒害连接）。 */
    @Test
    fun `error frame passes through non fatally`() {
        val m = onlineHalf()
        val actions = m.input(
            MachineEvent.Frame(FrameResult.Ok(ServerFrame.Error(v = 1, code = "invalid_frame", message = "Malformed frame."))),
        )
        assertEquals(
            listOf(
                MachineAction.EmitError(ErrorPayload(message = "Malformed frame.", code = "invalid_frame")),
            ),
            actions,
        )
        assertEquals(Status.Online, m.status)
    }

    /** 翻页上限常量锚定（connection-machine.ts:73 verbatim）。 */
    @Test
    fun `sync page max constant locked`() {
        assertEquals(100, SYNC_PAGE_MAX)
    }
}
