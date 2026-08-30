package app.pushhub.android.adapter

import app.pushhub.android.machine.ConnectionMachine
import app.pushhub.android.machine.ErrorPayload
import app.pushhub.android.machine.MachineEvent
import app.pushhub.android.machine.Status
import app.pushhub.android.machine.TimerKind
import app.pushhub.android.protocol.AnsweredFrame
import app.pushhub.android.protocol.HistoryFrame
import app.pushhub.android.protocol.MessageFrame
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Collections
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * adapter 故障转移映射测试（06-03 Task 3）——三种断连路径的 adapter 映射：
 *  - failHandshake 握手失败 → WsClose 语义（EmitStatus(Reconnecting) + 退避重连，
 *    非 fatal 停机——05-01 实证语义回归锁定：connect 失败走退避，防服务端闪断
 *    永久停机）；
 *  - 畸形 serverUrl → WsFail fatal 族（确定性配置错误，EmitError(fatal) + Offline）；
 *  - 心跳死线到期（Timer(PongDeadline) 事件注入模拟——不等真实 10s）→
 *    CloseSocket(Deadline) 映射 close code 4000（pushhub.ts:353-367 三档映射），
 *    服务端 onClosed 观测到 4000 且重连动作序列成立。
 */
class AdapterFailoverTest {

    private class Recorder : ChannelEvents {
        val statuses = Collections.synchronizedList(mutableListOf<Status>())
        val errors = Collections.synchronizedList(mutableListOf<ErrorPayload>())

        override fun onStatus(status: Status) {
            statuses += status
        }

        override fun onMessage(message: MessageFrame) = Unit
        override fun onHistory(frame: HistoryFrame) = Unit
        override fun onAnswered(frame: AnsweredFrame) = Unit
        override fun onError(error: ErrorPayload) {
            errors += error
        }
    }

    /**
     * 握手失败 → 退避重连（非 fatal）：failHandshake 响应使 OkHttp onFailure；
     * adapter 映射 WsClose → Reconnecting + Schedule(Reconnect)（随机 0.0 →
     * delay 0ms）→ 二次连接成功的完整恢复路径。
     */
    @Test
    fun `handshake failure maps to ws close semantics with backoff reconnect not fatal`() {
        val server = MockWebServer()
        // 第一次：握手失败（failHandshake——RESEARCH §Code Examples 用法之二）。
        server.enqueue(MockResponse.Builder().failHandshake().build())
        // 第二次：正常升级（恢复路径）。
        val reopened = AtomicInteger(0)
        server.enqueue(
            MockResponse.Builder().webSocketUpgrade(object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    reopened.incrementAndGet()
                }

                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                    webSocket.close(code, reason)
                }
            }).build(),
        )
        server.start()

        val recorder = Recorder()
        val adapter = OkHttpChannelAdapter(
            machine = ConnectionMachine(random = { 0.0 }),
            serverUrl = server.url("/").toString(),
            channelKey = "failover-key",
            events = recorder,
        )

        try {
            adapter.connect()
            // 断言序列：Connecting → （握手失败）Reconnecting → （退避 0ms 立即）
            // Connecting → （二次升级成功无帧——机器等 WsOpen）…
            val deadline = System.currentTimeMillis() + 10_000
            while (!recorder.statuses.contains(Status.Reconnecting) && System.currentTimeMillis() < deadline) {
                Thread.sleep(20)
            }
            assertTrue(
                "握手失败必须映射 WsClose 族（Reconnecting），当前: ${recorder.statuses}",
                recorder.statuses.contains(Status.Reconnecting),
            )
            // 非 fatal：零 fatal 错误（连接保持重试——服务端闪断不永久停机）。
            assertTrue("握手失败非 fatal（零 fatal 错误）: ${recorder.errors}", recorder.errors.none { it.fatal == true })

            // 退避 0ms → 立即重试 → 二次升级成功（服务端 onOpen 观测）。
            val deadline2 = System.currentTimeMillis() + 10_000
            while (reopened.get() < 1 && System.currentTimeMillis() < deadline2) {
                Thread.sleep(20)
            }
            assertEquals("二次连接成功（恢复路径成立）", 1, reopened.get())
        } finally {
            adapter.destroy()
            server.close()
        }
    }

    /** 畸形 serverUrl → WsFail fatal 停机（EmitError(fatal) + Offline，不重试）。 */
    @Test
    fun `malformed server url maps to ws fail fatal stop`() {
        val recorder = Recorder()
        val adapter = OkHttpChannelAdapter(
            machine = ConnectionMachine(random = { 0.0 }),
            serverUrl = "://not-a-url",
            channelKey = "k",
            events = recorder,
        )
        try {
            adapter.connect()
            val deadline = System.currentTimeMillis() + 5_000
            while (recorder.errors.isEmpty() && System.currentTimeMillis() < deadline) {
                Thread.sleep(20)
            }
            assertEquals(1, recorder.errors.size)
            assertEquals(true, recorder.errors[0].fatal)
            assertEquals("connect_failed", recorder.errors[0].code)
            assertEquals(listOf(Status.Connecting, Status.Offline), recorder.statuses)
        } finally {
            adapter.destroy()
        }
    }

    /**
     * 心跳死线路径（adapter 映射验证——常量本体行为已由 HeartbeatTest 锁定）：
     * Timer(Heartbeat) 注入 → SendPing（服务端观测 PING 字节常量）→ 武装
     * PongDeadline；Timer(PongDeadline) 注入（模拟到期，不等真实 10s）→
     * CloseSocket(Deadline) → ws.close(4000, "heartbeat deadline")——服务端
     * onClosed 观测 code=4000；随后退避重连动作序列成立。
     */
    @Test
    fun `pong deadline maps to close code 4000 and reconnect sequence`() {
        val server = MockWebServer()
        val serverReceived = Collections.synchronizedList(mutableListOf<String>())
        val serverClosedCode = AtomicInteger(-1)
        server.enqueue(
            MockResponse.Builder().webSocketUpgrade(object : WebSocketListener() {
                override fun onMessage(webSocket: WebSocket, text: String) {
                    serverReceived += text
                }

                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    serverClosedCode.set(code)
                }

                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                    webSocket.close(code, reason)
                }
            }).build(),
        )
        server.start()

        val recorder = Recorder()
        val adapter = OkHttpChannelAdapter(
            machine = ConnectionMachine(random = { 0.0 }),
            serverUrl = server.url("/").toString(),
            channelKey = "deadline-key",
            events = recorder,
        )

        try {
            adapter.connect()
            // 等 Online（WsOpen 经 feed 串行队列异步到达）。
            val deadline = System.currentTimeMillis() + 10_000
            while (recorder.statuses.lastOrNull() != Status.Online && System.currentTimeMillis() < deadline) {
                Thread.sleep(20)
            }
            assertEquals(Status.Online, recorder.statuses.lastOrNull())

            // 心跳到期注入 → SendPing 到达服务端（PING 字节常量——Pitfall 1）。
            adapter.feedEvent(MachineEvent.Timer(TimerKind.Heartbeat))
            val pingDeadline = System.currentTimeMillis() + 5_000
            while (serverReceived.none { it == PING } && System.currentTimeMillis() < pingDeadline) {
                Thread.sleep(20)
            }
            assertTrue("服务端收到 PING 字节常量: $serverReceived", serverReceived.contains(PING))

            // 死线到期注入（PongDeadline 已由心跳武装）→ close(4000) 路径。
            adapter.feedEvent(MachineEvent.Timer(TimerKind.PongDeadline))
            val closeDeadline = System.currentTimeMillis() + 5_000
            while (serverClosedCode.get() == -1 && System.currentTimeMillis() < closeDeadline) {
                Thread.sleep(20)
            }
            assertEquals(
                "死线关闭映射 close code 4000（heartbeat deadline）",
                4000,
                serverClosedCode.get(),
            )
            // 重连动作序列：Reconnecting → （退避 0ms）Connecting。
            val reconnectDeadline = System.currentTimeMillis() + 5_000
            while (!recorder.statuses.contains(Status.Reconnecting) && System.currentTimeMillis() < reconnectDeadline) {
                Thread.sleep(20)
            }
            assertTrue("死线后进入重连态: ${recorder.statuses}", recorder.statuses.contains(Status.Reconnecting))
            assertTrue("非 fatal 停机: ${recorder.errors}", recorder.errors.none { it.fatal == true })
        } finally {
            adapter.destroy()
            server.close()
        }
    }
}
