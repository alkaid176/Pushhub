package app.pushhub.android.machine

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 连接/退避曲线序列测试（06-03 Task 2）——Rust machine/tests/backoff.rs 同名先例。
 *
 * full jitter（connection-machine.ts:160-161）：delay = random() * min(60_000,
 * 500 * 2^attempt)。随机源注入伪随机序列 → 多拍退避窗口确定性断言；WS_OPEN
 * 成功后 attempt 归零（曲线回到首拍窗口）。
 */
class ConnectionMachineBackoffTest {

    /** 随机数队列注入（消费序 = backoffDelay 调用序）。 */
    private fun machineWith(vararg randoms: Double): ConnectionMachine {
        val queue = ArrayDeque(randoms.toList())
        return ConnectionMachine(random = { queue.removeFirst() })
    }

    /**
     * 多拍退避窗口曲线：attempt n 的窗口 = min(60_000, 500 * 2^n)，full jitter
     * 采样 delay = random * 窗口。随机源恒 0.5 → 逐拍断言 250/500/1000/.../cap。
     * 驱动方式：WsClose（产退避）→ Timer(Reconnect)（恢复 Connecting）→ 下一拍
     * WsClose 在 Connecting 态断连（attempt 继续累计，不经 WsOpen 归零）。
     */
    @Test
    fun `multi beat backoff windows follow full jitter curve to cap`() {
        val m = machineWith(*DoubleArray(20) { 0.5 })
        m.input(MachineEvent.Connect)
        m.input(MachineEvent.WsOpen) // Online 基线（attempt=0）

        val expectedDelays = listOf(
            250L, 500L, 1_000L, 2_000L, 4_000L, 8_000L, 16_000L,
            30_000L, 30_000L, 30_000L, 30_000L, // attempt=7 起 500*2^7=64000 > cap 60000 → 0.5*60000
        )
        for ((attemptIndex, expectedDelay) in expectedDelays.withIndex()) {
            val actions = m.input(MachineEvent.WsClose)
            val schedule = actions.filterIsInstance<MachineAction.Schedule>()
                .single { it.timer == TimerKind.Reconnect }
            assertEquals("attempt=$attemptIndex full jitter 延迟", expectedDelay, schedule.delayMs)
            m.input(MachineEvent.Timer(TimerKind.Reconnect)) // Reconnecting → Connecting
        }
    }

    /** WS_OPEN 成功后 attempt 归零：失败爬升窗口后连上，再断连回到首拍 250。 */
    @Test
    fun `ws open resets attempt to zero`() {
        val m = machineWith(0.5, 0.5, 0.5)
        m.input(MachineEvent.Connect)
        m.input(MachineEvent.WsClose) // attempt=0 → 250
        m.input(MachineEvent.Timer(TimerKind.Reconnect)) // → Connecting
        m.input(MachineEvent.WsClose) // attempt=1 → 500
        m.input(MachineEvent.Timer(TimerKind.Reconnect)) // → Connecting
        m.input(MachineEvent.WsOpen) // 成功 → attempt 归零
        val closeActions = m.input(MachineEvent.WsClose)
        val schedule = closeActions.filterIsInstance<MachineAction.Schedule>()
            .single { it.timer == TimerKind.Reconnect }
        assertEquals("归零后回到首拍窗口 0.5*500=250", 250L, schedule.delayMs)
    }

    /** full jitter 抖动上下界：random=0 → delay 0；random→1 → delay 贴窗口上界。 */
    @Test
    fun `jitter bounds zero to window`() {
        for (randomValue in listOf(0.0, 0.999999)) {
            val m = machineWith(randomValue)
            m.input(MachineEvent.Connect)
            m.input(MachineEvent.WsOpen)
            val actions = m.input(MachineEvent.WsClose)
            val schedule = actions.filterIsInstance<MachineAction.Schedule>()
                .single { it.timer == TimerKind.Reconnect }
            assertTrue(
                "delay ∈ [0, 500)（random=$randomValue → ${schedule.delayMs}）",
                schedule.delayMs in 0 until 500,
            )
        }
    }

    /** 手动断连分流：Disconnect → CloseSocket(Manual) + Offline，后续 WsClose 零退避武装。 */
    @Test
    fun `manually closed ws close does not arm reconnect`() {
        val m = machineWith(0.5)
        m.input(MachineEvent.Connect)
        m.input(MachineEvent.WsOpen)
        val disconnect = m.input(MachineEvent.Disconnect)
        assertEquals(
            listOf<MachineAction>(
                MachineAction.Cancel(TimerKind.Heartbeat),
                MachineAction.CloseSocket(CloseReason.Manual),
                MachineAction.EmitStatus(Status.Offline),
            ),
            disconnect,
        )
        // CloseSocket(Manual) 触发的 onClosed → WsClose：offline 态零动作
        //（重连抑制——直到下一次 Connect 复位 manuallyClosed）。
        assertEquals(emptyList<MachineAction>(), m.input(MachineEvent.WsClose))
        assertEquals(Status.Offline, m.status)
    }

    /** 首拍常量锚定（connection-machine.ts:58-61 verbatim）。 */
    @Test
    fun `backoff constants locked`() {
        assertEquals(500L, BACKOFF_BASE_MS)
        assertEquals(60_000L, BACKOFF_CAP_MS)
    }
}
