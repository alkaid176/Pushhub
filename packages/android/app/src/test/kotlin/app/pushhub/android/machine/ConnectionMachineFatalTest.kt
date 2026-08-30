package app.pushhub.android.machine

import app.pushhub.android.protocol.FrameResult
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * fatal 停机序列测试（06-03 Task 2）——Rust machine/tests/fatal.rs 同名先例；
 * connection-machine.ts:200-211（fatal 帧）/332-345（WsFail）。
 *
 * fatal 族（v!==1 帧 / 畸形 URL 的 WsFail）：EmitError(fatal) + 停机 + 零复活
 * ——此后任意事件（含 Timer）零动作；仅 Connect 显式复位（宿主主动重连语义）。
 */
class ConnectionMachineFatalTest {

    /** v!==1 帧 → fatal 停机：cancelAll + EmitError(fatal) + CloseSocket(Fatal) + Offline。 */
    @Test
    fun `fatal frame stops machine with fatal close`() {
        val m = onlineHalf() // WsOpen 武装了 Heartbeat
        val actions = m.input(
            MachineEvent.Frame(FrameResult.Fatal("unsupported protocol version: 2")),
        )
        assertEquals(
            listOf(
                MachineAction.Cancel(TimerKind.Heartbeat),
                MachineAction.EmitError(
                    ErrorPayload(message = "unsupported protocol version: 2", fatal = true),
                ),
                MachineAction.CloseSocket(CloseReason.Fatal),
                MachineAction.EmitStatus(Status.Offline),
            ),
            actions,
        )
        assertEquals(Status.Offline, m.status)
    }

    /**
     * fatal 停机后任意事件零动作（不复活、不武装定时器）——含 Timer 事件
     * （武装集已清空，幽灵过滤）与 WsOpen/WsClose/Frame/Visibility/Disconnect。
     */
    @Test
    fun `after fatal stop every subsequent event yields zero actions`() {
        val m = onlineHalf()
        m.input(MachineEvent.Frame(FrameResult.Fatal("unsupported protocol version: 2")))

        assertEquals(emptyList<MachineAction>(), m.input(MachineEvent.WsClose))
        assertEquals(emptyList<MachineAction>(), m.input(MachineEvent.WsOpen))
        assertEquals("Timer(Reconnect) 不复活", emptyList<MachineAction>(), m.input(MachineEvent.Timer(TimerKind.Reconnect)))
        assertEquals("Timer(Heartbeat) 不复活", emptyList<MachineAction>(), m.input(MachineEvent.Timer(TimerKind.Heartbeat)))
        assertEquals("Timer(PongDeadline) 不复活", emptyList<MachineAction>(), m.input(MachineEvent.Timer(TimerKind.PongDeadline)))
        assertEquals(emptyList<MachineAction>(), m.input(MachineEvent.Frame(pong())))
        assertEquals(emptyList<MachineAction>(), m.input(MachineEvent.Frame(msg(1))))
        assertEquals(emptyList<MachineAction>(), m.input(MachineEvent.Frame(FrameResult.Drop("unparseable"))))
        assertEquals(emptyList<MachineAction>(), m.input(MachineEvent.Visibility(true)))
        assertEquals(emptyList<MachineAction>(), m.input(MachineEvent.Visibility(false)))
        assertEquals(emptyList<MachineAction>(), m.input(MachineEvent.Disconnect))
        assertEquals(Status.Offline, m.status)
    }

    /** WsFail fatal 族同停机语义（畸形 URL——确定性配置错误，重试无意义）。 */
    @Test
    fun `ws fail fatal family same stop semantics`() {
        val m = ConnectionMachine(random = { 0.5 })
        m.input(MachineEvent.Connect)
        val actions = m.input(MachineEvent.WsFail("failed to construct WebSocket for serverUrl"))
        assertEquals(
            listOf(
                MachineAction.EmitError(
                    ErrorPayload(
                        message = "failed to construct WebSocket for serverUrl",
                        code = "connect_failed",
                        fatal = true,
                    ),
                ),
                MachineAction.EmitStatus(Status.Offline),
            ),
            actions,
        )
        assertEquals(emptyList<MachineAction>(), m.input(MachineEvent.Timer(TimerKind.Reconnect)))
        assertEquals(emptyList<MachineAction>(), m.input(MachineEvent.WsOpen))
    }

    /** Connect 显式复位 fatal 停机（TS 语义：宿主主动重连是唯一复活通道）。 */
    @Test
    fun `connect explicitly resets fatal stop`() {
        val m = onlineHalf()
        m.input(MachineEvent.Frame(FrameResult.Fatal("unsupported protocol version: 2")))
        assertEquals(Status.Offline, m.status)
        val actions = m.input(MachineEvent.Connect)
        assertEquals(
            "复位后正常连接序列",
            listOf(
                MachineAction.EmitStatus(Status.Connecting),
                MachineAction.CreateSocket,
            ),
            actions,
        )
        assertEquals(Status.Connecting, m.status)
    }

    /** Destroy 终态：销毁后任意事件零动作（含 Connect——Destroyed 不可复活）。 */
    @Test
    fun `destroy is terminal state no revival`() {
        val m = onlineHalf()
        val actions = m.input(MachineEvent.Destroy)
        assertEquals(
            listOf(
                MachineAction.Cancel(TimerKind.Heartbeat),
                MachineAction.CloseSocket(CloseReason.Manual),
                MachineAction.EmitStatus(Status.Offline), // destroyed 标签折叠为 Offline
            ),
            actions,
        )
        assertEquals(Status.Offline, m.status)
        assertEquals(emptyList<MachineAction>(), m.input(MachineEvent.Connect))
        assertEquals(emptyList<MachineAction>(), m.input(MachineEvent.WsOpen))
        assertEquals(emptyList<MachineAction>(), m.input(MachineEvent.Timer(TimerKind.Reconnect)))
        assertEquals(emptyList<MachineAction>(), m.input(MachineEvent.Destroy))
    }

    /** Drop 帧静默零动作（坏帧不毒害连接——连接保持）。 */
    @Test
    fun `drop frame is silent connection stays`() {
        val m = onlineHalf()
        assertEquals(
            emptyList<MachineAction>(),
            m.input(MachineEvent.Frame(FrameResult.Drop("malformed message frame"))),
        )
        assertEquals(Status.Online, m.status)
        assertTrue(m.input(MachineEvent.Frame(msg(1))).isNotEmpty())
    }
}
