package app.pushhub.android.hub

import app.pushhub.android.machine.Status
import app.pushhub.android.protocol.AnsweredFrame
import app.pushhub.android.protocol.HistoryFrame
import app.pushhub.android.protocol.MessageFrame
import app.pushhub.android.service.ChannelWiring
import app.pushhub.android.service.Notifier
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * ChannelHub 未读计数纯逻辑测试（06-07 Task 2，D-81/Pitfall 9——JVM 零
 * Robolectric：ChannelWiring × ChannelHub 真实例组合，锁定**接线语义**而非仅
 * hub 方法——未读只可能来自 EmitMessage 路径）。
 *
 * 覆盖（06-04 预留扩展点在 06-07 的消费契约）：
 *  - 实时帧到达非当前频道 → +1；到达当前显示频道 → 不计（实时可见豁免）；
 *  - emitHistory / onHistory 路径**结构性零计数**（补拉批次不角标爆炸，
 *    Pitfall 9——D-81 断线恢复不虚增未读）；
 *  - answered 事件零计数（状态更新不属新消息）；
 *  - 切到该频道清零（clearUnread）；切走后新帧重新计。
 */
class ChannelHubUnreadTest {

    private fun hub(current: String? = null): ChannelHub =
        ChannelHub(
            runtimePermissionGranted = { true },
            notificationsEnabled = { true },
            sdkInt = { 30 },
        ).apply { setCurrentChannel(current) }

    private fun msgFrame(wid: String = "m_1", seq: Long = 1) = MessageFrame(
        v = 1, wid = wid, seq = seq, text = "hello", priority = "normal",
        answered = false, createdAt = 1_700_000_000L,
    )

    private fun answeredFrame(wid: String = "m_1") = AnsweredFrame(
        v = 1, wid = wid, seq = 1, answered = true,
        answeredBy = "同僚", answeredAt = 1_700_000_001L, answeredContent = "收到",
    )

    /** 假通知执行口（计数器——两流分离断言数据源）。 */
    private class CountingNotifier : Notifier {
        var shown = 0
        var cancelled = 0
        override fun show(
            channelId: String,
            channelName: String,
            wid: String,
            title: String?,
            text: String,
            priority: String,
            createdAt: Long,
        ) {
            shown++
        }

        override fun cancel(wid: String) {
            cancelled++
        }
    }

    /** 每消息经 ChannelWiring 完整路径（缓冲→hub 事件→未读→通知——生产接线同构）。 */
    private fun wiring(hub: ChannelHub, notifier: CountingNotifier, channelId: String): ChannelWiring =
        ChannelWiring(
            channelId = channelId,
            channelName = { "n-$channelId" },
            buffer = app.pushhub.android.machine.Buffer(),
            notifier = notifier,
            hub = hub,
            spikeLog = app.pushhub.android.service.SpikeLog(
                java.nio.file.Files.createTempDirectory("unread-test").toFile(),
            ),
            refreshBlocked = hub::refreshNotificationsBlocked,
            onStatusChanged = {},
        )

    /** 实时帧到非当前频道：+1/条（D-81 切走频道才角标）。 */
    @Test
    fun `realtime message to background channel bumps unread`() {
        val hub = hub(current = "ch1")
        val wiring = wiring(hub, CountingNotifier(), channelId = "ch2")
        wiring.onMessage(msgFrame(wid = "m_1", seq = 1))
        wiring.onMessage(msgFrame(wid = "m_2", seq = 2))
        assertEquals(mapOf("ch2" to 2), hub.unreadCounts.value)
    }

    /** 实时帧到当前显示频道：不计（实时可见豁免——正在看不角标）。 */
    @Test
    fun `realtime message to current channel no bump`() {
        val hub = hub(current = "ch1")
        val wiring = wiring(hub, CountingNotifier(), channelId = "ch1")
        wiring.onMessage(msgFrame())
        assertTrue(hub.unreadCounts.value.isEmpty())
    }

    /** 首拉/补拉批次（onHistory 路径）：结构性零计数（Pitfall 9——断线恢复不角标爆炸）。 */
    @Test
    fun `history batch never bumps unread`() {
        val hub = hub(current = "ch1")
        val wiring = wiring(hub, CountingNotifier(), channelId = "ch2")
        wiring.onHistory(
            HistoryFrame(
                v = 1,
                messages = List(50) { i -> msgFrame(wid = "m_hist_$i", seq = (i + 1).toLong()) },
                oldestKeptSeq = 1,
                hasMore = true,
            ),
        )
        assertTrue("补拉批次绝不计未读", hub.unreadCounts.value.isEmpty())
    }

    /** answered 事件：零计数（状态更新非新消息）——D-17 语义在未读面的映射。 */
    @Test
    fun `answered event never bumps unread`() {
        val hub = hub(current = "ch1")
        val wiring = wiring(hub, CountingNotifier(), channelId = "ch2")
        wiring.onAnswered(answeredFrame())
        assertTrue(hub.unreadCounts.value.isEmpty())
    }

    /** 切到该频道清零；切走后新帧重新计（豁免跟随 currentChannelId）。 */
    @Test
    fun `switching to channel clears and re-arms exemption`() {
        val hub = hub(current = "ch1")
        val wiringCh2 = wiring(hub, CountingNotifier(), channelId = "ch2")
        wiringCh2.onMessage(msgFrame(seq = 1))
        wiringCh2.onMessage(msgFrame(seq = 2))
        assertEquals(mapOf("ch2" to 2), hub.unreadCounts.value)

        // 切到 ch2（tab 点击）：清零 + 后续实时帧豁免
        hub.setCurrentChannel("ch2")
        hub.clearUnread("ch2")
        assertTrue(hub.unreadCounts.value.isEmpty())
        wiringCh2.onMessage(msgFrame(seq = 3))
        assertTrue("当前频道实时可见不计", hub.unreadCounts.value.isEmpty())

        // 切回 ch1：ch2 新帧重新计
        hub.setCurrentChannel("ch1")
        wiringCh2.onMessage(msgFrame(seq = 4))
        assertEquals(mapOf("ch2" to 1), hub.unreadCounts.value)
    }

    /** 状态回调不改未读（onStatus 路径零未读副作用）。 */
    @Test
    fun `status transition never bumps unread`() {
        val hub = hub(current = "ch1")
        val wiring = wiring(hub, CountingNotifier(), channelId = "ch2")
        wiring.onStatus(Status.Reconnecting)
        wiring.onStatus(Status.Online)
        assertTrue(hub.unreadCounts.value.isEmpty())
    }

    /** 重连倒计时：Schedule(Reconnect) 回调写 deadline；onStatus 离开 Reconnecting 清除（D-81 状态条数据源同源不漂移）。 */
    @Test
    fun `reconnect deadline set on schedule and cleared on status exit`() {
        val hub = hub(current = "ch1")
        val wiring = wiring(hub, CountingNotifier(), channelId = "ch2")
        wiring.onStatus(Status.Reconnecting)
        hub.setReconnectDeadline("ch2", 30_000)
        val deadline = hub.reconnectDeadlines.value["ch2"]
        org.junit.Assert.assertNotNull(deadline)
        assertTrue(
            "deadline ≈ now + delayMs",
            deadline!! > System.currentTimeMillis() + 25_000,
        )
        wiring.onStatus(Status.Online)
        assertTrue("离开 Reconnecting 即清除", hub.reconnectDeadlines.value.isEmpty())
    }
}
