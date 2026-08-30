package app.pushhub.android

import app.pushhub.android.machine.ConnectionMachine
import app.pushhub.android.machine.ErrorPayload
import app.pushhub.android.machine.MachineAction
import app.pushhub.android.machine.MachineEvent
import app.pushhub.android.machine.Status
import app.pushhub.android.machine.TimerKind
import app.pushhub.android.protocol.FrameResult
import app.pushhub.android.protocol.ServerFrame
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 状态机 tracer 测试（06-01 Task 3，D-59 第三端初证）。
 *
 * 随机源注入恒 0.5 → full jitter 退避确定性：WsClose 后首拍恰 250ms
 * （0.5 * min(60_000, 500 * 2^0)——窗口中点）。对应 must_haves truth。
 */
class MachineTracerTest {

    private fun machine(): ConnectionMachine = ConnectionMachine(random = { 0.5 })

    /** D-59 第三端初证：注入随机源恒 0.5 → WsClose 后首拍退避恰 250ms。 */
    @Test
    fun `random 0_5 first backoff after ws close is exactly 250ms`() {
        val m = machine()
        // Connect → EmitStatus(Connecting) + CreateSocket
        val connectActions = m.input(MachineEvent.Connect)
        assertEquals(
            listOf<MachineAction>(
                MachineAction.EmitStatus(Status.Connecting),
                MachineAction.CreateSocket,
            ),
            connectActions,
        )
        // WsOpen → 武装 Heartbeat(30s) + EmitStatus(Online)
        assertEquals(
            listOf<MachineAction>(
                MachineAction.Schedule(TimerKind.Heartbeat, 30_000),
                MachineAction.EmitStatus(Status.Online),
            ),
            m.input(MachineEvent.WsOpen),
        )
        // WsClose → Cancel(Heartbeat) + EmitStatus(Reconnecting) +
        // Schedule(Reconnect, 0.5 * min(60_000, 500 * 2^0) = 250)
        assertEquals(
            listOf<MachineAction>(
                MachineAction.Cancel(TimerKind.Heartbeat),
                MachineAction.EmitStatus(Status.Reconnecting),
                MachineAction.Schedule(TimerKind.Reconnect, 250),
            ),
            m.input(MachineEvent.WsClose),
        )
    }

    /** WsFail fatal 族：停机后任意事件零动作（不复活、不武装定时器）。 */
    @Test
    fun `ws fail fatal stops machine any subsequent event yields zero actions`() {
        val m = machine()
        m.input(MachineEvent.Connect)
        assertEquals(
            listOf<MachineAction>(
                MachineAction.EmitError(
                    ErrorPayload(
                        message = "failed to construct WebSocket for serverUrl",
                        code = "connect_failed",
                        fatal = true,
                    ),
                ),
                MachineAction.EmitStatus(Status.Offline),
            ),
            m.input(MachineEvent.WsFail("failed to construct WebSocket for serverUrl")),
        )
        assertEquals(Status.Offline, m.status)
        // 此后任意事件零动作（WsClose/WsOpen/Timer/Frame/Connect 前 fatal 停机语义：
        // Connect 复位 fatalStopped 是 06-03 前的例外——tracer 验证核心是停机不武装）。
        assertEquals(emptyList<MachineAction>(), m.input(MachineEvent.WsClose))
        assertEquals(emptyList<MachineAction>(), m.input(MachineEvent.WsOpen))
        assertEquals(emptyList<MachineAction>(), m.input(MachineEvent.Timer(TimerKind.Reconnect)))
        assertEquals(
            emptyList<MachineAction>(),
            m.input(MachineEvent.Frame(FrameResult.Ok(ServerFrame.Pong(1)))),
        )
    }

    /** 武装集过滤：未武装的 Timer 事件（迟到幽灵）零动作。 */
    @Test
    fun `non-armed timer events are filtered as ghosts`() {
        val m = machine()
        // 全新机器：无任何已武装定时器。
        assertEquals(emptyList<MachineAction>(), m.input(MachineEvent.Timer(TimerKind.Reconnect)))
        assertEquals(emptyList<MachineAction>(), m.input(MachineEvent.Timer(TimerKind.Heartbeat)))
        assertEquals(emptyList<MachineAction>(), m.input(MachineEvent.Timer(TimerKind.PongDeadline)))
        assertEquals(emptyList<MachineAction>(), m.input(MachineEvent.Timer(TimerKind.Probe)))

        // 在线态武装了 Heartbeat：未武装的 Probe 仍是幽灵。
        m.input(MachineEvent.Connect)
        m.input(MachineEvent.WsOpen)
        assertEquals(emptyList<MachineAction>(), m.input(MachineEvent.Timer(TimerKind.Probe)))
    }

    /** Timer(Reconnect) 到期 → CreateSocket + EmitStatus(Connecting)（重连臂位）。 */
    @Test
    fun `reconnect timer expiry recreates socket`() {
        val m = machine()
        m.input(MachineEvent.Connect)
        m.input(MachineEvent.WsOpen)
        m.input(MachineEvent.WsClose) // 武装 Reconnect
        assertEquals(
            listOf<MachineAction>(
                MachineAction.EmitStatus(Status.Connecting),
                MachineAction.CreateSocket,
            ),
            m.input(MachineEvent.Timer(TimerKind.Reconnect)),
        )
    }

    /** Timer(Heartbeat) 到期 → SendPing + 武装 PongDeadline(10s) + 重武装 Heartbeat。 */
    @Test
    fun `heartbeat timer sends ping and arms pong deadline`() {
        val m = machine()
        m.input(MachineEvent.Connect)
        m.input(MachineEvent.WsOpen)
        assertEquals(
            listOf<MachineAction>(
                MachineAction.SendPing,
                MachineAction.Schedule(TimerKind.PongDeadline, 10_000),
                MachineAction.Schedule(TimerKind.Heartbeat, 30_000),
            ),
            m.input(MachineEvent.Timer(TimerKind.Heartbeat)),
        )
    }

    /** Frame(Fatal)（v!==1）→ EmitError(fatal) + CloseSocket(Fatal) + Offline 停机。 */
    @Test
    fun `fatal frame stops machine with fatal close`() {
        val m = machine()
        m.input(MachineEvent.Connect)
        m.input(MachineEvent.WsOpen)
        val actions = m.input(MachineEvent.Frame(FrameResult.Fatal("unsupported protocol version")))
        assertEquals(
            listOf<MachineAction>(
                // cancelAllTimers 先行（WsOpen 武装的 Heartbeat 解除）。
                MachineAction.Cancel(TimerKind.Heartbeat),
                MachineAction.EmitError(
                    ErrorPayload(message = "unsupported protocol version", fatal = true),
                ),
                MachineAction.CloseSocket(app.pushhub.android.machine.CloseReason.Fatal),
                MachineAction.EmitStatus(Status.Offline),
            ),
            actions,
        )
        // 停机后零动作。
        assertEquals(emptyList<MachineAction>(), m.input(MachineEvent.WsClose))
    }

    /** handleHistory tracer 版：首拉 fresh 过滤 EmitHistory + 无条件 SendSync(since=syncBase 快照)。 */
    @Test
    fun `initial history emits filtered batch and unconditional sync from snapshot`() {
        val m = machine()
        m.input(MachineEvent.Connect)
        m.input(MachineEvent.WsOpen) // syncBase = dedup.last 快照 = 0（连接前游标）

        fun msg(seq: Long) = ServerFrame.Message(
            v = 1, wid = "m_w$seq", seq = seq, text = "t$seq", priority = "normal",
            answered = false, answeredBy = null, answeredAt = null, answeredContent = null,
            createdAt = 1_700_000_000_000 + seq, title = null, options = null,
            callbackUrl = null, clickUrl = null,
        )
        // 实时帧先到（seq=7）——dedup 窗口记录。
        val realtime = m.input(MachineEvent.Frame(FrameResult.Ok(msg(7))))
        assertEquals(1, realtime.size)
        assertTrue(realtime[0] is MachineAction.EmitMessage)
        // 首拉批次含已见（7 → 过滤）与未见（8/9）。
        val history = ServerFrame.History(
            v = 1, messages = listOf(msg(7), msg(8), msg(9)), oldestKeptSeq = 1, hasMore = false,
        )
        val actions = m.input(MachineEvent.Frame(FrameResult.Ok(history)))
        assertEquals(2, actions.size)
        val emitHistory = actions[0] as MachineAction.EmitHistory
        assertEquals(listOf(8L, 9L), emitHistory.frame.messages.map { it.seq })
        // 无条件 SendSync since=连接前游标快照（WsOpen 瞬间的 dedup.last=0——
        // 缺口可深于首拉 50 条，Pitfall 5）、limit=SYNC_LIMIT_DEFAULT(200)。
        assertEquals(MachineAction.SendSync(since = 0, limit = 200), actions[1])
        // 重复 seq 的实时帧被 dedup 静默吞（D-17 第二道防线）。
        assertEquals(
            emptyList<MachineAction>(),
            m.input(MachineEvent.Frame(FrameResult.Ok(msg(7)))),
        )
    }

    /** 六常量 verbatim 锚定（connection-machine.ts:58-73——数值变更即协议事件）。 */
    @Test
    fun `six constants match ts source verbatim`() {
        assertEquals(500L, app.pushhub.android.machine.BACKOFF_BASE_MS)
        assertEquals(60_000L, app.pushhub.android.machine.BACKOFF_CAP_MS)
        assertEquals(30_000L, app.pushhub.android.machine.HEARTBEAT_INTERVAL_MS)
        assertEquals(10_000L, app.pushhub.android.machine.PONG_DEADLINE_MS)
        assertEquals(5_000L, app.pushhub.android.machine.PROBE_DEADLINE_MS)
        assertEquals(100, app.pushhub.android.machine.SYNC_PAGE_MAX)
    }
}
