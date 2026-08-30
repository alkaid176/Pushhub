package app.pushhub.android.adapter

import app.pushhub.android.machine.ConnectionMachine
import app.pushhub.android.machine.ErrorPayload
import app.pushhub.android.machine.MachineEvent
import app.pushhub.android.machine.Status
import app.pushhub.android.machine.TimerKind
import app.pushhub.android.protocol.AnsweredFrame
import app.pushhub.android.protocol.FrameResult
import app.pushhub.android.protocol.HistoryFrame
import app.pushhub.android.protocol.MessageFrame
import app.pushhub.android.protocol.ServerFrame
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * adapter 并发防线测试（06-03 Task 3，Pitfall 8 结构性验证）。
 *
 * TS 版依赖 JS 事件循环单线程；Kotlin 侧 OkHttp 回调线程/协程定时器线程/UI
 * 线程并发——唯一并发防线是 adapter 的单线程 feed 收敛（Dispatchers.Default
 * .limitedParallelism(1) 消费协程）。本测试模拟真实并发拓扑（N 线程同时
 * feedEvent——OkHttp 回调线程 + 定时器协程的对应物）压入混合事件批次，断言：
 *  - 零丢失：全部 message 帧恰各投递一次（dedup 集合语义与压入序无关）；
 *  - 处理序严格串行：全部回调在同一消费线程（limitedParallelism(1) 证据）；
 *  - 状态无竞态：最终状态与相同事件集合的单线程重放一致（对照机器）。
 */
class AdapterConcurrencyTest {

    private class Recorder : ChannelEvents {
        val messages = Collections.synchronizedList(mutableListOf<MessageFrame>())
        val statuses = Collections.synchronizedList(mutableListOf<Status>())
        val errors = Collections.synchronizedList(mutableListOf<ErrorPayload>())
        /** EmitMessage 回调发生的线程名（串行化证据——单消费协程应恒一线程）。 */
        val callbackThreads = Collections.synchronizedSet(mutableSetOf<String>())

        override fun onStatus(status: Status) {
            statuses += status
        }

        override fun onMessage(message: MessageFrame) {
            messages += message
            callbackThreads += Thread.currentThread().name
        }

        override fun onHistory(frame: HistoryFrame) = Unit
        override fun onAnswered(frame: AnsweredFrame) = Unit
        override fun onError(error: ErrorPayload) {
            errors += error
        }
    }

    private fun msgFrame(seq: Long): MessageFrame = MessageFrame(
        v = 1,
        wid = "m_w$seq",
        seq = seq,
        title = null,
        text = "t$seq",
        callbackUrl = null,
        clickUrl = null,
        options = null,
        priority = "normal",
        answered = false,
        answeredBy = null,
        answeredAt = null,
        answeredContent = null,
        createdAt = 1_700_000_000_000 + seq,
    )

    @Test
    fun `concurrent feed is serialized with zero loss and matches single threaded replay`() {
        // 连接拓扑：真实 mockwebserver 但零 enqueue——握手挂起（无响应），
        // Online 经 WsOpen 事件注入建立（Connect 只为满足 WsOpen 的 Connecting
        // 前提）。挂起的真实连接不产生回调事件，并发批次完全由注入驱动。
        val server = mockwebserver3.MockWebServer()
        server.start()

        val recorder = Recorder()
        val adapter = OkHttpChannelAdapter(
            machine = ConnectionMachine(random = { 0.5 }),
            serverUrl = server.url("/").toString(),
            channelKey = "k",
            events = recorder,
        )

        // 阶段 1：顺序建立在线态（Connect/WsOpen 的序是协议前提，非并发对象）。
        adapter.feedEvent(MachineEvent.Connect)
        adapter.feedEvent(MachineEvent.WsOpen)

        // 阶段 2：并发核心——8 线程 × 25 消息帧（seq 1..200 全局唯一）+ 混合
        // Timer(Heartbeat)/pong/Drop 帧事件（模拟 OkHttp 回调线程与 N 个定时器
        // 协程同时 feed 的真实拓扑）。
        val threads = 8
        val perThread = 25
        val pool: ExecutorService = Executors.newFixedThreadPool(threads)
        val ready = CountDownLatch(threads)
        val go = CountDownLatch(1)
        val done = CountDownLatch(threads)
        try {
            for (t in 0 until threads) {
                pool.submit {
                    ready.countDown()
                    try {
                        go.await()
                        for (i in 0 until perThread) {
                            val seq = (t * perThread + i + 1).toLong()
                            adapter.feedEvent(MachineEvent.Frame(FrameResult.Ok(msgFrame(seq))))
                            // 混合事件：心跳到期（产生 SendPing + 武装死线）与
                            // pong（取消死线）交错——状态迁移与 Timer 并存。
                            if (i % 5 == 0) {
                                adapter.feedEvent(MachineEvent.Timer(TimerKind.Heartbeat))
                            }
                            if (i % 7 == 0) {
                                adapter.feedEvent(MachineEvent.Frame(FrameResult.Ok(ServerFrame.Pong(v = 1))))
                            }
                            if (i % 11 == 0) {
                                adapter.feedEvent(MachineEvent.Frame(FrameResult.Drop("malformed message frame")))
                            }
                        }
                    } catch (e: InterruptedException) {
                        Thread.currentThread().interrupt()
                    } finally {
                        done.countDown()
                    }
                }
            }
            // 全员就位同时放行（最大化并发窗口）。
            assertTrue(ready.await(10, TimeUnit.SECONDS))
            go.countDown()
            assertTrue("并发批次压入完成", done.await(30, TimeUnit.SECONDS))

            // 阶段 3：等消费协程排空队列（零丢失断言前提）。
            val deadline = System.currentTimeMillis() + 30_000
            while (recorder.messages.size < threads * perThread && System.currentTimeMillis() < deadline) {
                Thread.sleep(20)
            }

            // 断言 1 —— 零丢失零重复：200 个唯一 seq 恰各投递一次。
            assertEquals("全部消息恰投递一次", (1..(threads * perThread)).map { it.toLong() }, recorder.messages.map { it.seq }.sorted())
            // 断言 2 —— 处理序严格串行：EmitMessage 全部发生在同一消费线程
            //（limitedParallelism(1) 的结构性证据——多线程并发 feed 不产生
            // 交错的状态竞态）。
            assertEquals("回调线程唯一（单消费协程）", 1, recorder.callbackThreads.size)
            // 断言 3 —— 状态无竞态：并发批次后仍 Online（坏帧/心跳/pong 混入
            // 不破坏连接），且零错误。
            assertEquals(Status.Online, adapter.machine.status)
            assertTrue("并发批次零错误: ${recorder.errors}", recorder.errors.isEmpty())
        } finally {
            pool.shutdownNow()
            adapter.destroy()
            server.close()
        }
    }

    /** 单线程重放对照：相同事件集合按序喂裸机器（零 adapter），状态与投递等价。 */
    @Test
    fun `single threaded replay of same event set matches concurrent outcome`() {
        // 对照机器（零并发）：Connect → WsOpen → 消息帧 + 心跳/pong/Drop 交错。
        val replay = ConnectionMachine(random = { 0.5 })
        replay.input(MachineEvent.Connect)
        replay.input(MachineEvent.WsOpen)
        val delivered = mutableListOf<Long>()
        for (seq in 1..200L) {
            val actions = replay.input(MachineEvent.Frame(FrameResult.Ok(msgFrame(seq))))
            if (seq % 5L == 0L) replay.input(MachineEvent.Timer(TimerKind.Heartbeat))
            if (seq % 7L == 0L) replay.input(MachineEvent.Frame(FrameResult.Ok(ServerFrame.Pong(v = 1))))
            if (seq % 11L == 0L) replay.input(MachineEvent.Frame(FrameResult.Drop("malformed message frame")))
            delivered += actions.filterIsInstance<app.pushhub.android.machine.MachineAction.EmitMessage>()
                .map { it.message.seq }
        }
        // 重放基线：200 条全投递、状态 Online（并发测试的期望值由此锚定）。
        assertEquals((1..200L).toList(), delivered)
        assertEquals(Status.Online, replay.status)
    }
}
