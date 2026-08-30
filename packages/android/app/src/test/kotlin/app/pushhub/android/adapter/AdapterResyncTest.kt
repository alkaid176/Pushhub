package app.pushhub.android.adapter

import app.pushhub.android.machine.ConnectionMachine
import app.pushhub.android.machine.ErrorPayload
import app.pushhub.android.machine.MachineEvent
import app.pushhub.android.machine.Status
import app.pushhub.android.protocol.AnsweredFrame
import app.pushhub.android.protocol.HistoryFrame
import app.pushhub.android.protocol.MessageFrame
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * adapter 断连→退避→重连→补拉测试（06-03 Task 3，AND-04 核心）——
 * mockwebserver3 真实 WS 模拟（服务端 webSocket.cancel() 断连；RESEARCH
 * §Code Examples 三用法之一）。
 *
 * 关键断言（plan must_haves truth #3）：断连后重连的 sync 帧 since 恰等于
 * 断连前游标（dedup.last 快照）；缓冲恰缺零重（补拉与实时交叠去重）。
 * 退避节奏压缩：随机源注入恒 0.0 → full jitter delay = 0ms → 立即重连。
 */
class AdapterResyncTest {

    private fun historyJson(seqs: LongRange, hasMore: Boolean): String {
        val messages = seqs.joinToString(",") { seq ->
            """{"v":1,"type":"message","wid":"m_w$seq","seq":$seq,"text":"t$seq","priority":"normal",""" +
                """"answered":false,"answered_by":null,"answered_at":null,"answered_content":null,""" +
                """"created_at":${1_700_000_000_000 + seq}}"""
        }
        return """{"v":1,"type":"history","messages":[$messages],"oldest_kept_seq":${seqs.first},"has_more":$hasMore}"""
    }

    private fun messageJson(seq: Long): String =
        """{"v":1,"type":"message","wid":"m_w$seq","seq":$seq,"text":"live $seq","priority":"high",""" +
            """"answered":false,"answered_by":null,"answered_at":null,"answered_content":null,""" +
            """"created_at":${1_700_000_000_000 + seq}}"""

    /** 事件记录器（synchronized——feed 单线程协程调用 + 主线程读）。 */
    private class Recorder : ChannelEvents {
        val statuses = Collections.synchronizedList(mutableListOf<Status>())
        val messages = Collections.synchronizedList(mutableListOf<MessageFrame>())
        val histories = Collections.synchronizedList(mutableListOf<HistoryFrame>())
        val answered = Collections.synchronizedList(mutableListOf<AnsweredFrame>())
        val errors = Collections.synchronizedList(mutableListOf<ErrorPayload>())

        override fun onStatus(status: Status) {
            statuses += status
        }

        override fun onMessage(message: MessageFrame) {
            messages += message
        }

        override fun onHistory(frame: HistoryFrame) {
            histories += frame
        }

        override fun onAnswered(frame: AnsweredFrame) {
            answered += frame
        }

        override fun onError(error: ErrorPayload) {
            errors += error
        }
    }

    @Test
    fun `disconnect then reconnect syncs from pre disconnect cursor with zero loss zero duplicate`() {
        val server = MockWebServer()
        val serverReceived = Collections.synchronizedList(mutableListOf<String>())

        // 服务端 socket 持有（主线程在确认客户端已消费实时帧后触发 cancel——
        // TCP RST 会丢弃未读数据，竞态断连会让 seq 4 丢失）。
        val firstSocket = java.util.concurrent.atomic.AtomicReference<WebSocket?>()

        // 第一段连接：推首拉（1..3）→ 实时帧（4）；断连由主线程择机 cancel()。
        val firstListener = object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                firstSocket.set(webSocket)
                webSocket.send(historyJson(1L..3L, hasMore = false))
                webSocket.send(messageJson(4))
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                serverReceived += "one:$text"
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(code, reason)
            }
        }
        // 第二段连接（重连后同队列二次监听）：服务端 accept 重推最近若干（3..6，
        // 交叠 3/4 已见）→ 记录客户端随后发来的 sync 帧并回补缺口。
        val secondListener = object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                webSocket.send(historyJson(3L..6L, hasMore = false))
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                serverReceived += "two:$text"
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(code, reason)
            }
        }
        server.enqueue(MockResponse.Builder().webSocketUpgrade(firstListener).build())
        server.enqueue(MockResponse.Builder().webSocketUpgrade(secondListener).build())
        server.start()

        val recorder = Recorder()
        // 随机源恒 0.0：退避 delay = 0 * window = 0ms（压缩节奏，不等真实退避）。
        val adapter = OkHttpChannelAdapter(
            machine = ConnectionMachine(random = { 0.0 }),
            serverUrl = server.url("/").toString(),
            channelKey = "resync-key",
            events = recorder,
        )

        try {
            adapter.connect()
            // 等第一段完整消费：Online + 首拉 history + 实时帧（seq 4 已进 dedup
            // ——这是"断连前游标 = 4"的确定性前提）。
            val deadline = System.currentTimeMillis() + 10_000
            while (recorder.messages.size < 1 && System.currentTimeMillis() < deadline) {
                Thread.sleep(20)
            }
            assertEquals("实时帧 seq 4 已消费（断连前游标就位）", listOf(4L), recorder.messages.map { it.seq })
            assertEquals(1, recorder.histories.size)

            // 确认消费后模拟服务端断连（服务端主动关闭——客户端 onClosed →
            // WsClose。不用服务端 socket.cancel()：mockwebserver3 bridge 的
            // 服务端 RealWebSocket cancel 路径 NPE（5.5.0 实证），优雅关闭等价
            // 触发客户端 WsClose 族语义）。
            firstSocket.get()!!.close(1011, "server going away")

            // 断连 → Reconnecting（随机 0.0 → delay 0ms）→ 立即重连 → 第二段
            // 首拉 3..6 fresh 过滤（5/6 未见）→ 无条件 SendSync(since=syncBase=4)。
            val deadline2 = System.currentTimeMillis() + 10_000
            while (recorder.histories.size < 2 && System.currentTimeMillis() < deadline2) {
                Thread.sleep(20)
            }
            assertEquals("两段 history（首拉 + 重连首拉）", 2, recorder.histories.size)
            assertTrue("经过重连态", recorder.statuses.contains(Status.Reconnecting))
            assertEquals("重连恢复 Online", Status.Online, recorder.statuses.last())

            // 关键断言：重连后 sync 帧 since == 断连前游标 4（恰缺零重的依据）。
            val syncFrames = serverReceived.filter { it.startsWith("two:") && it.contains(""""type":"sync"""") }
            assertTrue("服务端应收到重连后的 sync 帧（当前: $serverReceived）", syncFrames.isNotEmpty())
            val syncJson = Json.parseToJsonElement(syncFrames.first().removePrefix("two:")).jsonObject
            assertEquals("sync since == 断连前 dedup.last", 4L, syncJson["since"]!!.jsonPrimitive.longOrNull)

            // 恰缺零重：全部回调消息的 seq 恰 [1,2,3,4] + [5,6] 全集零重复。
            val deliveredSeqs = recorder.histories.flatMap { it.messages.map { m -> m.seq } } +
                recorder.messages.map { it.seq }
            assertEquals("恰缺零重（首拉 1-3 + 实时 4 + 重连补拉 5-6）", listOf(1L, 2L, 3L, 4L, 5L, 6L), deliveredSeqs.sorted())
            assertEquals("实时帧恰 1 条（seq 4）", listOf(4L), recorder.messages.map { it.seq })
        } finally {
            adapter.destroy()
            server.close()
        }
    }

    /**
     * 双计数器测试（两流分离不变量，D-61/D-63——05-04 桌面先例）：灌混合
     * history+message 帧序列，onHistory 调用数恰等于 history 帧数、onMessage
     * 恰等于 message 帧数（answered 走第三流）——adapter 不合并不转发混装。
     */
    @Test
    fun `dual counter history and message callbacks map frame types one to one`() {
        val server = MockWebServer()
        val serverListener = object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                // 混合序列：history → message → history → message → answered。
                webSocket.send(historyJson(1L..2L, hasMore = false))
                webSocket.send(messageJson(3))
                webSocket.send(historyJson(4L..5L, hasMore = false))
                webSocket.send(messageJson(6))
                webSocket.send(
                    """{"v":1,"type":"answered","wid":"m_w6","seq":6,"answered":true,""" +
                        """"answered_by":"alice","answered_at":1700000001000,"answered_content":"done"}""",
                )
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(code, reason)
            }
        }
        server.enqueue(MockResponse.Builder().webSocketUpgrade(serverListener).build())
        server.start()

        val recorder = Recorder()
        val adapter = OkHttpChannelAdapter(
            machine = ConnectionMachine(random = { 0.0 }),
            serverUrl = server.url("/").toString(),
            channelKey = "counter-key",
            events = recorder,
        )

        try {
            adapter.connect()
            // history(1,2) + message(3) + history(4,5) + message(6) + answered
            // → 回调计数：onHistory 2 + onMessage 2 + onAnswered 1 = 5。
            val done = CountDownLatch(1)
            val watcher = Thread {
                while (recorder.histories.size + recorder.messages.size + recorder.answered.size < 5) {
                    Thread.sleep(10)
                }
                done.countDown()
            }
            watcher.isDaemon = true
            watcher.start()
            assertTrue("混合序列回调超时", done.await(10, TimeUnit.SECONDS))

            // 双计数器：onHistory 恰 2（两个 history 帧）、onMessage 恰 2（两个
            // message 帧）、onAnswered 恰 1——帧型与回调一一对应零混装。
            assertEquals("onHistory 调用数 == history 帧数", 2, recorder.histories.size)
            assertEquals("onHistory 载荷只含批次消息", listOf(1L, 2L, 4L, 5L), recorder.histories.flatMap { h -> h.messages.map { it.seq } })
            assertEquals("onMessage 调用数 == message 帧数", 2, recorder.messages.size)
            assertEquals(listOf(3L, 6L), recorder.messages.map { it.seq })
            assertEquals("onAnswered 独立第三流", 1, recorder.answered.size)
            assertEquals("m_w6", recorder.answered[0].wid)
        } finally {
            adapter.destroy()
            server.close()
        }
    }
}
