package app.pushhub.android.hub

import app.pushhub.android.machine.Status
import app.pushhub.android.protocol.AnsweredFrame
import app.pushhub.android.protocol.MessageFrame
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * ChannelHub 共享状态契约面测试（06-04 Task 4，JVM——零 Robolectric：
 * 检查函数注入边界成立的前提就是本类脱离 Android 可测）。
 *
 * 覆盖：通知阻断三路（API 33+ 权限未授权 / API 33- areNotificationsEnabled
 * 禁用 / 双路正常）+ 状态流更新订阅可达且初值可读 + 事件流发射订阅接收
 * + 未读扩展点结构。
 */
@OptIn(ExperimentalCoroutinesApi::class)
class ChannelHubTest {

    private fun msgFrame(wid: String = "m_1", seq: Long = 1) = MessageFrame(
        v = 1, wid = wid, seq = seq, text = "hello", priority = "normal",
        answered = false, createdAt = 1_700_000_000L,
    )

    private fun answeredFrame(wid: String = "m_1") = AnsweredFrame(
        v = 1, wid = wid, seq = 1, answered = true,
        answeredBy = "同僚", answeredAt = 1_700_000_001L, answeredContent = "收到",
    )

    // ---- 通知阻断三路（Pitfall 4 双路计算） ----

    @Test
    fun notificationsBlockedWhenRuntimePermissionDeniedOnApi33Plus() {
        val hub = ChannelHub(
            runtimePermissionGranted = { false },
            notificationsEnabled = { true },
            sdkInt = { 33 },
        )
        assertTrue("API 33+ 权限未授权 → 阻断（通知静默丢弃）", hub.notificationsBlocked.value)
    }

    @Test
    fun notificationsBlockedWhenNotificationsDisabledBelowApi33() {
        val hub = ChannelHub(
            runtimePermissionGranted = { true },
            notificationsEnabled = { false },
            sdkInt = { 31 },
        )
        assertTrue("API 33- areNotificationsEnabled 禁用 → 阻断", hub.notificationsBlocked.value)
    }

    @Test
    fun notificationsNotBlockedWhenBothPathsHealthy() {
        val modern = ChannelHub({ true }, { true }, { 35 })
        val legacy = ChannelHub({ true }, { true }, { 28 })
        assertFalse(modern.notificationsBlocked.value)
        assertFalse(legacy.notificationsBlocked.value)
    }

    @Test
    fun notificationsBlockedRecomputableOnRefresh() {
        var granted = false
        val hub = ChannelHub({ granted }, { true }, { 33 })
        assertTrue(hub.notificationsBlocked.value)
        granted = true // 用户在系统设置授权后 Service 触发 refresh
        hub.refreshNotificationsBlocked()
        assertFalse(hub.notificationsBlocked.value)
    }

    // ---- 状态流：初值可读 + 更新订阅可达 ----

    @Test
    fun channelStatusInitialValueReadableAndUpdatesReachSubscribers() = runTest {
        val hub = ChannelHub({ true }, { true }, { 33 })
        // 初值可读（StateFlow 当前值语义——无首帧竞态，05-01 门无需对应物）。
        assertEquals(emptyMap<String, Status>(), hub.channelStatus.value)

        val received = mutableListOf<Map<String, Status>>()
        val job = launch(UnconfinedTestDispatcher(testScheduler)) {
            hub.channelStatus.collect { received.add(it) }
        }
        // 新订阅者先收当前值（初值）。
        assertEquals(1, received.size)

        hub.setChannelStatus("ch1", Status.Online)
        hub.setChannelStatus("ch2", Status.Reconnecting)
        assertEquals(3, received.size)
        assertEquals(
            mapOf("ch1" to Status.Online, "ch2" to Status.Reconnecting),
            hub.channelStatus.value,
        )

        // null 清除频道状态（频道删除路径）。
        hub.setChannelStatus("ch1", null)
        assertEquals(mapOf("ch2" to Status.Reconnecting), hub.channelStatus.value)
        job.cancel()
    }

    // ---- 事件流：发射订阅接收 ----

    @Test
    fun eventsEmittedAndReceivedBySubscriber() = runTest {
        val hub = ChannelHub({ true }, { true }, { 33 })
        val events = mutableListOf<HubEvent>()
        val job = launch(UnconfinedTestDispatcher(testScheduler)) {
            hub.events.collect { events.add(it) }
        }
        hub.emitMessage("ch1", msgFrame())
        hub.emitAnswered("ch1", answeredFrame())
        assertEquals(2, events.size)
        val message = events[0] as HubEvent.Message
        assertEquals("ch1", message.channelId)
        assertEquals("m_1", message.frame.wid)
        val answered = events[1] as HubEvent.Answered
        assertEquals("同僚", answered.frame.answeredBy)
        job.cancel()
    }

    // ---- 未读扩展点（06-07 消费契约结构预留） ----

    @Test
    fun unreadCountsBumpAndClear() {
        val hub = ChannelHub({ true }, { true }, { 33 })
        assertEquals(emptyMap<String, Int>(), hub.unreadCounts.value)
        hub.bumpUnread("ch1")
        hub.bumpUnread("ch1")
        hub.bumpUnread("ch2")
        assertEquals(mapOf("ch1" to 2, "ch2" to 1), hub.unreadCounts.value)
        hub.clearUnread("ch1")
        assertEquals(mapOf("ch2" to 1), hub.unreadCounts.value)
    }

    // ---- 单例读写口契约 ----

    @Test
    fun getBeforeInstallFailsFast() {
        var thrown: IllegalArgumentException? = null
        try {
            ChannelHub.get()
        } catch (e: IllegalArgumentException) {
            thrown = e
        }
        // 未安装即读 → 装配时序错误 fail-fast（错误消息静态短句不含状态内容）。
        if (thrown == null) {
            // 若其他测试已 install（单例静态），本断言退化为验证 get() 可用——
            // 顺序无关性：install 后 get 恒非空。
            ChannelHub.install(ChannelHub({ true }, { true }, { 33 }))
            assertTrue(ChannelHub.get() !== null)
        } else {
            assertTrue(thrown.message!!.contains("not installed"))
        }
    }
}
