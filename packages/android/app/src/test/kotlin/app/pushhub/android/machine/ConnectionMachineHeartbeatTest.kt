package app.pushhub.android.machine

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 心跳死线序列测试（06-03 Task 2）——Rust machine/tests/heartbeat.rs 同名先例。
 *
 * 心跳周期 30s → SendPing + 武装 PongDeadline(10s) + 重武装心跳；pong 取消两类
 * 死线；PongDeadline 到期 → forceReconnect（CloseSocket(Deadline) + 退避族，
 * 不等 WsClose——假活连接不会自己产生事件）。
 */
class ConnectionMachineHeartbeatTest {

    /** Timer(Heartbeat) 在线到期：SendPing + PongDeadline(10s) + 重武装 Heartbeat(30s)。 */
    @Test
    fun `heartbeat expiry sends ping and arms pong deadline`() {
        val m = onlineHalf()
        assertEquals(
            listOf(
                MachineAction.SendPing,
                MachineAction.Schedule(TimerKind.PongDeadline, 10_000),
                MachineAction.Schedule(TimerKind.Heartbeat, 30_000),
            ),
            m.input(MachineEvent.Timer(TimerKind.Heartbeat)),
        )
    }

    /** pong 取消 pongDeadline（与未武装的 probe——两死线一并解除）。 */
    @Test
    fun `pong cancels pong deadline and pending probe`() {
        val m = onlineHalf()
        m.input(MachineEvent.Timer(TimerKind.Heartbeat)) // 武装 PongDeadline
        m.input(MachineEvent.Visibility(true)) // 再武装 Probe
        assertEquals(
            listOf(
                MachineAction.Cancel(TimerKind.PongDeadline),
                MachineAction.Cancel(TimerKind.Probe),
            ),
            m.input(MachineEvent.Frame(pong())),
        )
        // 死线解除后幽灵 Timer(PongDeadline) 零动作（连接保活）。
        assertEquals(emptyList<MachineAction>(), m.input(MachineEvent.Timer(TimerKind.PongDeadline)))
        assertEquals(Status.Online, m.status)
    }

    /**
     * PongDeadline 到期 → forceReconnect（connection-machine.ts:189-196/362-369）：
     * cancelAllTimers + CloseSocket(Deadline) + Reconnecting + 退避 250（0.5×500）
     * —— adapter 映射 close code 4000（heartbeat deadline）。
     */
    @Test
    fun `pong deadline expiry forces reconnect with deadline close`() {
        val m = onlineHalf()
        m.input(MachineEvent.Timer(TimerKind.Heartbeat)) // 武装 PongDeadline + 重武装 Heartbeat
        assertEquals(
            listOf(
                MachineAction.Cancel(TimerKind.Heartbeat),
                MachineAction.CloseSocket(CloseReason.Deadline),
                MachineAction.EmitStatus(Status.Reconnecting),
                MachineAction.Schedule(TimerKind.Reconnect, 250),
            ),
            m.input(MachineEvent.Timer(TimerKind.PongDeadline)),
        )
        assertEquals(Status.Reconnecting, m.status)
        // 恢复路径：退避到点 → Connecting → WsOpen 恢复 Online（attempt 归零）。
        assertEquals(
            listOf(
                MachineAction.EmitStatus(Status.Connecting),
                MachineAction.CreateSocket,
            ),
            m.input(MachineEvent.Timer(TimerKind.Reconnect)),
        )
        assertEquals(
            listOf(
                MachineAction.Schedule(TimerKind.Heartbeat, 30_000),
                MachineAction.EmitStatus(Status.Online),
            ),
            m.input(MachineEvent.WsOpen),
        )
    }

    /** 非在线态 Timer(Heartbeat)/Timer(PongDeadline) 零动作（幽灵或离线心跳）。 */
    @Test
    fun `non online heartbeat timers yield zero actions`() {
        val m = ConnectionMachine(random = { 0.5 })
        m.input(MachineEvent.Connect) // Connecting
        assertEquals(emptyList<MachineAction>(), m.input(MachineEvent.Timer(TimerKind.Heartbeat)))
        assertEquals(emptyList<MachineAction>(), m.input(MachineEvent.Timer(TimerKind.PongDeadline)))
    }

    /** 心跳常量锚定（connection-machine.ts:64-70 verbatim）。 */
    @Test
    fun `heartbeat constants locked`() {
        assertEquals(30_000L, HEARTBEAT_INTERVAL_MS)
        assertEquals(10_000L, PONG_DEADLINE_MS)
    }
}
