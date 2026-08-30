package app.pushhub.android.machine

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * VISIBILITY 探活序列测试（06-03 Task 2）——Rust machine/tests/visibility.rs
 * 同名先例；connection-machine.ts:373-388（TS 权威源方向，见 ConnectionMachine
 * 臂位注释——计划 Task 2c 文字与 TS 相反，按 canonical 逐行为对齐目标实现）。
 *
 * D-27：回前台（visible=true）→ 立即 ping + 5s 探活死线 + 心跳接管恢复；
 * 离后台（visible=false）→ 取消心跳与探活（冻结省额度，恢复时探活接管）；
 * Probe 到期 → forceReconnect。
 */
class ConnectionMachineVisibilityTest {

    private fun hasSchedule(actions: List<MachineAction>, timer: TimerKind, delayMs: Long) =
        actions.any { it is MachineAction.Schedule && it.timer == timer && it.delayMs == delayMs }

    /** visible=true：SendPing + Probe(5s) + 心跳接管恢复；不断连不变状态。 */
    @Test
    fun `visible sends ping arms probe keeps connection`() {
        val m = onlineHalf()
        val actions = m.input(MachineEvent.Visibility(true))
        assertTrue("立即 ping: $actions", actions.any { it is MachineAction.SendPing })
        assertTrue("探活死线 5s: $actions", hasSchedule(actions, TimerKind.Probe, 5_000))
        assertTrue("心跳接管恢复 30s: $actions", hasSchedule(actions, TimerKind.Heartbeat, 30_000))
        assertTrue("不断连: $actions", actions.none { it is MachineAction.CloseSocket })
        assertTrue("不变状态: $actions", actions.none { it is MachineAction.EmitStatus })
        assertEquals(Status.Online, m.status)
    }

    /** 探活 5s 内 pong → cancel(probe)，保持 online 无重连；解除后幽灵零动作。 */
    @Test
    fun `probe pong within deadline cancels no reconnect`() {
        val m = onlineHalf()
        m.input(MachineEvent.Visibility(true))
        val actions = m.input(MachineEvent.Frame(pong()))
        assertTrue("取消探活: $actions", actions.any { it is MachineAction.Cancel && it.timer == TimerKind.Probe })
        assertTrue("不重连: $actions", actions.none { it is MachineAction.CloseSocket })
        assertEquals(emptyList<MachineAction>(), m.input(MachineEvent.Timer(TimerKind.Probe)))
    }

    /** 探活超时 → forceReconnect（closeSocket(deadline) + reconnecting + 退避 250）。 */
    @Test
    fun `probe timeout forces reconnect`() {
        val m = onlineHalf() // 0.5 × 500 = 250
        m.input(MachineEvent.Visibility(true))
        val actions = m.input(MachineEvent.Timer(TimerKind.Probe))
        assertTrue(
            "死线关闭: $actions",
            actions.any { it is MachineAction.CloseSocket && it.reason == CloseReason.Deadline },
        )
        assertTrue(
            "重连态: $actions",
            actions.any { it is MachineAction.EmitStatus && it.status == Status.Reconnecting },
        )
        assertTrue("退避 250: $actions", hasSchedule(actions, TimerKind.Reconnect, 250))
    }

    /** 强制重连恢复 online 后探活路径可重复使用。 */
    @Test
    fun `probe path reusable after force reconnect recovery`() {
        val m = onlineHalf()
        m.input(MachineEvent.Visibility(true))
        m.input(MachineEvent.Timer(TimerKind.Probe)) // 判死线
        m.input(MachineEvent.Timer(TimerKind.Reconnect)) // 退避到点重试
        m.input(MachineEvent.WsOpen) // 恢复 online（attempt 归零）
        val actions = m.input(MachineEvent.Visibility(true))
        assertTrue(actions.any { it is MachineAction.SendPing })
        assertTrue(hasSchedule(actions, TimerKind.Probe, 5_000))
    }

    /** 探活 ping 期间消息帧照常投递（探活不阻塞业务）。 */
    @Test
    fun `probe ping does not block message delivery`() {
        val m = onlineHalf()
        m.input(MachineEvent.Visibility(true))
        val actions = m.input(MachineEvent.Frame(msg(1)))
        assertTrue("照常投递: $actions", actions.any { it is MachineAction.EmitMessage })
    }

    /** visible=false（hidden）：取消心跳与探活；幽灵不产 ping；连接保持。 */
    @Test
    fun `hidden cancels heartbeat and pending probe keeps online`() {
        val m = onlineHalf() // WsOpen 已武装 Heartbeat
        m.input(MachineEvent.Visibility(true)) // 武装 Probe
        val actions = m.input(MachineEvent.Visibility(false))
        assertTrue("取消心跳: $actions", actions.any { it is MachineAction.Cancel && it.timer == TimerKind.Heartbeat })
        assertTrue("取消探活: $actions", actions.any { it is MachineAction.Cancel && it.timer == TimerKind.Probe })
        assertEquals("hidden 只取消定时器，连接保持", Status.Online, m.status)
        // 迟到的 heartbeat/probe 幽灵零动作。
        assertEquals(emptyList<MachineAction>(), m.input(MachineEvent.Timer(TimerKind.Heartbeat)))
        assertEquals(emptyList<MachineAction>(), m.input(MachineEvent.Timer(TimerKind.Probe)))
    }

    /** 非 online 态的 VISIBILITY 零动作（reconnecting 期间探活无意义）。 */
    @Test
    fun `non online visibility zero actions`() {
        val m = ConnectionMachine(random = { 0.5 })
        m.input(MachineEvent.Connect)
        m.input(MachineEvent.WsClose) // → Reconnecting
        assertEquals(emptyList<MachineAction>(), m.input(MachineEvent.Visibility(true)))
        assertEquals(emptyList<MachineAction>(), m.input(MachineEvent.Visibility(false)))
    }

    /** 探活常量锚定（connection-machine.ts:69-70 verbatim）。 */
    @Test
    fun `probe constants locked`() {
        assertEquals(5_000L, PROBE_DEADLINE_MS)
    }
}
