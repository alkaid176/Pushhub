package app.pushhub.android

import app.pushhub.android.adapter.ChannelEvents
import app.pushhub.android.adapter.OkHttpChannelAdapter
import app.pushhub.android.adapter.PING
import app.pushhub.android.adapter.buildWsUrl
import app.pushhub.android.machine.ConnectionMachine
import app.pushhub.android.machine.ErrorPayload
import app.pushhub.android.machine.Status
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
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * adapter 端到端切片测试（06-01 Task 3）——mockwebserver3 真实 WS 模拟：
 * 服务端 accept 即推 history → 实时 message 帧 → adapter（单线程 feed）→ 纯状态机
 * → ChannelEvents 回调序全链路 JVM 锁定（零 Android 依赖）。
 *
 * 另含：PING 字节常量断言（Pitfall 1）、buildWsUrl 四例（https→wss / http→ws /
 * 尾斜杠规整 / 密钥保留字符编码）、服务端收到机器补拉 sync 帧的回环断言。
 */
class AdapterEndToEndTest {

    // ---- PING 字节常量（Pitfall 1：逐字节等于服务端 auto-response 匹配串）----

    @Test
    fun `ping constant byte-exact matches server auto-response string`() {
        // 服务端匹配串（packages/server/src/chat-room.ts PING_FRAME）。
        val expected = byteArrayOf(
            0x7B, 0x22, 0x76, 0x22, 0x3A, 0x31, 0x2C, 0x22, 0x74, 0x79, 0x70, 0x65,
            0x22, 0x3A, 0x22, 0x70, 0x69, 0x6E, 0x67, 0x22, 0x7D,
        )
        val actual = PING.toByteArray(Charsets.UTF_8)
        assertEquals(21, actual.size)
        assertTrue("PING 必须逐字节等于服务端匹配串", actual.contentEquals(expected))
    }

    // ---- buildWsUrl 四例（pushhub.ts:101-105 同构 + Rust adapter 测试同款）----

    @Test
    fun `build ws url four cases`() {
        assertEquals(
            "wss://pushhub.dyun.org/api/ws/phc_abc",
            buildWsUrl("https://pushhub.dyun.org/", "phc_abc"),
        )
        assertEquals(
            "ws://127.0.0.1:4911/api/ws/phc_abc",
            buildWsUrl("http://127.0.0.1:4911", "phc_abc"),
        )
        assertEquals(
            "ws://example.com/api/ws/k",
            buildWsUrl("http://example.com//", "k"),
        )
        // 密钥含保留字符：encodeURIComponent 语义（空格 %20 非 '+'——URLEncoder
        // 修正；'/' '?' '=' '&' 转义）。
        assertTrue(
            buildWsUrl("http://s", "a/b?c=d&e f").endsWith("/api/ws/a%2Fb%3Fc%3Dd%26e%20f"),
        )
    }

    // ---- 端到端：mockwebserver3 真实 WS → adapter → machine → 回调序 ----

    @Test
    fun `server pushes history then message and client callbacks fire in order`() {
        val historyJson = """
            {"v":1,"type":"history","messages":[
              {"v":1,"type":"message","wid":"m_hist1","seq":1,"text":"first","priority":"normal",
               "answered":false,"answered_by":null,"answered_at":null,"answered_content":null,
               "created_at":1700000000000}
            ],"oldest_kept_seq":1,"has_more":false}
        """.trimIndent()
        val messageJson = """
            {"v":1,"type":"message","wid":"m_live1","seq":2,"text":"live","priority":"high",
             "answered":false,"answered_by":null,"answered_at":null,"answered_content":null,
             "created_at":1700000001000}
        """.trimIndent()

        val serverReceived = Collections.synchronizedList(mutableListOf<String>())
        val server = MockWebServer()
        val serverListener = object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                // 服务端 accept 即推首拉 history（chat-room.ts:700-741 行为锚点）
                // 再推实时 message 帧。
                webSocket.send(historyJson)
                webSocket.send(messageJson)
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                serverReceived += text
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                // 06-03 修复：OkHttp 服务端默认 onClosing 不回应——客户端机器
                // Destroy 臂发起 ws.close(1000) 后等不到服务端 close 回应，
                // mockwebserver3 队列挂起导致 server.close() 超时（06-01 时
                // Destroy 空臂不关 ws 故未暴露）。标准 OkHttp 服务端模式：回
                // close 完成优雅握手。
                webSocket.close(code, reason)
            }
        }
        // mockwebserver3 5.5.0 实际 API 为 webSocketUpgrade(listener) 方法
        //（RESEARCH 示例写的 webSocketListener 是私有属性——本会话 javap 实查修正）。
        server.enqueue(
            MockResponse.Builder().webSocketUpgrade(serverListener).build(),
        )
        server.start()

        // 回调序记录（单线程消费协程调用——synchronizedList 防御性记录）。
        val callbackTrace = Collections.synchronizedList(mutableListOf<String>())
        val done = CountDownLatch(4) // Connecting + Online + history + message

        val machine = ConnectionMachine(random = { 0.5 })
        val adapter = OkHttpChannelAdapter(
            machine = machine,
            serverUrl = server.url("/").toString(),
            channelKey = "test-key",
            events = object : ChannelEvents {
                override fun onStatus(status: Status) {
                    callbackTrace += "status:${status.name.lowercase()}"
                    done.countDown()
                }

                override fun onMessage(message: MessageFrame) {
                    callbackTrace += "message:${message.wid}"
                    done.countDown()
                }

                override fun onHistory(frame: HistoryFrame) {
                    callbackTrace += "history:${frame.messages.map { it.seq }}"
                    done.countDown()
                }

                override fun onError(error: ErrorPayload) {
                    callbackTrace += "error:${error.message}"
                }
            },
        )

        try {
            adapter.connect()
            assertTrue("回调链 4 跳超时（当前: $callbackTrace）", done.await(10, TimeUnit.SECONDS))
            // 回调序：Connecting → Online → history → message（服务端发送序经单线程
            // feed 保持，机器分派序确定）。
            assertEquals(
                listOf("status:connecting", "status:online", "history:[1]", "message:m_live1"),
                callbackTrace,
            )
            // 回环断言：机器 handleHistory 首拉无条件 SendSync(since=syncBase=0,
            // limit=200) 经 adapter 到达服务端（服务端 JSON.parse 键序无关）。
            // 帧从客户端到服务端 listener 的 onMessage 是异步路径——轮询等待。
            val expectedSync = """{"v":1,"type":"sync","since":0,"limit":200}"""
            val syncDeadline = System.currentTimeMillis() + 5_000
            while (!serverReceived.contains(expectedSync) && System.currentTimeMillis() < syncDeadline) {
                Thread.sleep(20)
            }
            assertTrue(
                "服务端应收到机器补拉 sync 帧（当前: $serverReceived）",
                serverReceived.contains(expectedSync),
            )
        } finally {
            adapter.destroy()
            server.close()
        }
    }

    // ---- 畸形 serverUrl → WsFail fatal 族（确定性配置错误）----

    @Test
    fun `malformed server url maps to ws fail fatal`() {
        val errors = Collections.synchronizedList(mutableListOf<ErrorPayload>())
        val statuses = Collections.synchronizedList(mutableListOf<Status>())
        val machine = ConnectionMachine(random = { 0.5 })
        val adapter = OkHttpChannelAdapter(
            machine = machine,
            serverUrl = "://not-a-url", // Request.Builder().url() 抛 IllegalArgumentException
            channelKey = "k",
            events = object : ChannelEvents {
                override fun onStatus(status: Status) {
                    statuses += status
                }

                override fun onMessage(message: MessageFrame) = Unit
                override fun onHistory(frame: HistoryFrame) = Unit
                override fun onError(error: ErrorPayload) {
                    errors += error
                }
            },
        )
        try {
            adapter.connect()
            // fatal 停机确定性输出——轮询等待串行队列消费完成。
            val deadline = System.currentTimeMillis() + 5_000
            while (errors.isEmpty() && System.currentTimeMillis() < deadline) Thread.sleep(20)
            assertEquals(1, errors.size)
            assertEquals(true, errors[0].fatal)
            assertEquals("connect_failed", errors[0].code)
            assertTrue("错误文案为静态英文短句（不含 URL/密钥）", errors[0].message.isNotBlank())
            assertEquals(listOf(Status.Connecting, Status.Offline), statuses)
        } finally {
            adapter.destroy()
        }
    }
}
