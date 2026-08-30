package app.pushhub.android.machine

import app.pushhub.android.protocol.RETENTION_KEEP
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Buffer 环形缓冲测试（06-03 Task 2）——packages/desktop/src-tauri/src/buffer.rs
 * 内嵌 tests 的 Kotlin 镜像（第三端行为一致）。
 */
class BufferTest {

    /** BUFFER_CAP 对齐服务端保留窗口（D-62×D-08——两常量互等硬断言，数值漂移即协议事件）。 */
    @Test
    fun `buffer cap matches server retention`() {
        assertEquals(500, BUFFER_CAP)
        assertEquals(BUFFER_CAP, RETENTION_KEEP)
    }

    /** 容量边界：恰 500 条零淘汰（push 全返回 null）。 */
    @Test
    fun `push within cap no eviction`() {
        val buf = Buffer()
        for (seq in 1..500L) {
            assertNull("seq $seq 不应淘汰", buf.push(msgFrame(seq)))
        }
        assertEquals(500, buf.size)
        assertFalse(buf.isEmpty)
    }

    /** 第 501/502 条分别淘汰最旧两条（严格插入序，最旧先出），容量恒 500。 */
    @Test
    fun `push beyond cap evicts oldest in insertion order`() {
        val buf = Buffer()
        for (seq in 1..500L) buf.push(msgFrame(seq))
        assertEquals(1L, buf.push(msgFrame(501))!!.seq)
        assertEquals(2L, buf.push(msgFrame(502))!!.seq)
        assertEquals(500, buf.size)
    }

    /** snapshot：全量导出按 seq 升序 + 淘汰计数 + 最旧保留 seq；空缓冲元信息。 */
    @Test
    fun `snapshot order and metadata`() {
        val buf = Buffer()
        // 空缓冲。
        val empty = buf.snapshot()
        assertTrue(empty.messages.isEmpty())
        assertEquals(0L, empty.evicted)
        assertNull(empty.oldestKeptSeq)

        for (seq in 1..502L) buf.push(msgFrame(seq))
        val snap = buf.snapshot()
        assertEquals(500, snap.messages.size)
        assertEquals(2L, snap.evicted)
        assertEquals(3L, snap.oldestKeptSeq)
        assertEquals(3L, snap.messages.first().seq)
        assertEquals(502L, snap.messages.last().seq)
        // 严格升序断言。
        val seqs = snap.messages.map { it.seq }
        assertEquals(seqs, seqs.sorted())
    }

    /** 补拉/实时交叠乱序插入——snapshot 导出仍按 seq 升序（展示语义）。 */
    @Test
    fun `snapshot sorts out of order arrivals`() {
        val buf = Buffer()
        buf.push(msgFrame(100))
        for (seq in 60 until 100L) buf.push(msgFrame(seq))
        val snap = buf.snapshot()
        assertEquals(60L, snap.messages.first().seq)
        assertEquals(100L, snap.messages.last().seq)
        assertEquals(60L, snap.oldestKeptSeq)
        assertEquals((60..100L).toList(), snap.messages.map { it.seq })
    }

    /** applyAnswered 命中：answered 系列字段原位更新，条目数不变；幂等重复覆写无害。 */
    @Test
    fun `apply answered hit updates in place idempotent`() {
        val buf = Buffer()
        buf.push(msgFrame(1))
        buf.push(msgFrame(2))
        val before = buf.size

        val frame = (answeredFrame("m_test000000000001", 1) as app.pushhub.android.protocol.FrameResult.Ok)
            .frame as app.pushhub.android.protocol.ServerFrame.Answered
        assertTrue(buf.applyAnswered(frame))
        val snap = buf.snapshot()
        val m = snap.messages.first { it.seq == 1L }
        assertTrue(m.answered)
        assertEquals("alice", m.answeredBy)
        assertEquals(1_700_000_001_000L, m.answeredAt)
        assertEquals("done", m.answeredContent)
        // 原位更新不新增条目；幂等：同 wid 重复扇出重复覆写无害（D-17）。
        assertEquals(before, buf.size)
        assertTrue(buf.applyAnswered(frame))
        assertEquals(before, buf.size)
    }

    /** applyAnswered 未命中：迟到 answered（消息已淘汰/不在此窗口）返回 false，缓冲不变。 */
    @Test
    fun `apply answered miss returns false`() {
        val buf = Buffer()
        buf.push(msgFrame(1))
        val frame = (answeredFrame("unknown_wid", 1) as app.pushhub.android.protocol.FrameResult.Ok)
            .frame as app.pushhub.android.protocol.ServerFrame.Answered
        assertFalse(buf.applyAnswered(frame))
        val snap = buf.snapshot()
        assertFalse(snap.messages[0].answered)
        assertEquals(1, buf.size)
    }
}
