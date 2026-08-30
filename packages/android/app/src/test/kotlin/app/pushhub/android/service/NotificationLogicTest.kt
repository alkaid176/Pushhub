package app.pushhub.android.service

import app.pushhub.android.hub.ChannelHub
import app.pushhub.android.hub.HubEvent
import app.pushhub.android.machine.Buffer
import app.pushhub.android.machine.Status
import app.pushhub.android.protocol.AnsweredFrame
import app.pushhub.android.protocol.HistoryFrame
import app.pushhub.android.protocol.MessageFrame
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files

/**
 * 通知逻辑 JVM 纯逻辑测试（06-05 Task 1，AND-02）。
 *
 * 覆盖四组断言（计划锁定）：
 *  1. priority → tier 三档映射（含未知值兜底 normal）；
 *  2. 摘要 150 截断边界（chars 计数，CJK 每字 1——桌面 A7 裁决同构）；
 *  3. 通道 ID 组装格式（ph_ 前缀/tier 后缀/含 channelId **不含频道名**——
 *     D-87 不可变纪律：含特殊字符的频道名断言其不出现在通道 ID）；
 *  4. 深链 extra 键值构造（ph_channel/ph_wid——SC2 契约）。
 *
 * 另含源码结构断言（acceptance criteria）：notify/cancel 同 NOTIF_ID 常量与
 * tag=wid 配对、PendingIntent 含 FLAG_IMMUTABLE——lint 型结构锁定（源文件经
 * 测试工作目录相对路径读取，与 FixturesContractTest ../../shared/fixtures
 * 同一 A7 通路先例）。
 */
class NotificationLogicTest {

    // ---- ① priority → tier 三档映射 ----

    @Test
    fun `tier mapping three known priorities`() {
        assertEquals(NotificationRouter.TIER_HIGH, NotificationRouter.tierOf("high"))
        assertEquals(NotificationRouter.TIER_NORMAL, NotificationRouter.tierOf("normal"))
        assertEquals(NotificationRouter.TIER_LOW, NotificationRouter.tierOf("low"))
    }

    @Test
    fun `tier mapping unknown priorities fall back to normal`() {
        // 未知值兜底归 normal（协议层 isMessageShape 已守卫三值——防御纵深）
        assertEquals(NotificationRouter.TIER_NORMAL, NotificationRouter.tierOf("urgent"))
        assertEquals(NotificationRouter.TIER_NORMAL, NotificationRouter.tierOf(""))
        assertEquals(NotificationRouter.TIER_NORMAL, NotificationRouter.tierOf("HIGH"))
    }

    // ---- ② 摘要 150 截断边界 ----

    @Test
    fun `summary boundary at 150 chars`() {
        // 恰 150：原样保留
        val exact = "a".repeat(NotificationRouter.SUMMARY_MAX_CHARS)
        assertEquals(exact, NotificationRouter.summarize(exact))
        // 151 → 截到 150
        val over = "a".repeat(NotificationRouter.SUMMARY_MAX_CHARS + 1)
        assertEquals(
            NotificationRouter.SUMMARY_MAX_CHARS,
            NotificationRouter.summarize(over).length,
        )
        // 短文本原样
        assertEquals("short", NotificationRouter.summarize("short"))
    }

    @Test
    fun `summary counts cjk chars as one each`() {
        // chars 计数（非 UTF-16 code unit / byte）：300 个汉字截到 150
        val long = "推".repeat(300)
        val cut = NotificationRouter.summarize(long)
        assertEquals(NotificationRouter.SUMMARY_MAX_CHARS, cut.length)
        assertEquals("推".repeat(NotificationRouter.SUMMARY_MAX_CHARS), cut)
    }

    @Test
    fun `body prefers title and falls back to text`() {
        // title 优先
        assertEquals("the title", NotificationRouter.bodyOf("the title", "body text"))
        // null / 空白 title 视为缺失（桌面 make_title 同判）
        assertEquals("body text", NotificationRouter.bodyOf(null, "body text"))
        assertEquals("body text", NotificationRouter.bodyOf("   ", "body text"))
        // 正文超限统一截断
        val longText = "x".repeat(200)
        assertEquals(
            NotificationRouter.SUMMARY_MAX_CHARS,
            NotificationRouter.bodyOf(null, longText).length,
        )
    }

    // ---- ③ 通道 ID 组装格式（D-87 不可变纪律） ----

    @Test
    fun `channel id assembly format`() {
        // 通道 ID：ph_<channelId>_<tier>
        assertEquals("ph_ch1_high", NotificationRouter.notificationChannelIdOf("ch1", "high"))
        assertEquals("ph_ch1_normal", NotificationRouter.notificationChannelIdOf("ch1", "normal"))
        assertEquals("ph_ch1_low", NotificationRouter.notificationChannelIdOf("ch1", "low"))
        // 通道组 ID：phg_<channelId>
        assertEquals("phg_ch1", NotificationRouter.groupIdOf("ch1"))
    }

    @Test
    fun `channel ids never contain channel name`() {
        // D-87 不可变纪律：含特殊字符的频道名绝不出现在通道 ID（改名不换通道）
        val nastyName = "告警/频道 & <x> \"引号\" ch1"
        for (tier in listOf("high", "normal", "low")) {
            val id = NotificationRouter.notificationChannelIdOf("ch3", tier)
            assertFalse("通道 ID 不含频道名字面: $id", id.contains(nastyName))
            assertFalse("通道 ID 不含频道名任一片段", id.contains("告警"))
            assertTrue("通道 ID 含内部 channelId", id.contains("ch3"))
        }
        assertFalse(NotificationRouter.groupIdOf("ch3").contains("告警"))
    }

    @Test
    fun `channel label is user readable`() {
        // 系统设置用户可辨识：「频道名 · 高/中/低」
        assertEquals("alerts · 高", NotificationRouter.channelLabel("alerts", "high"))
        assertEquals("alerts · 中", NotificationRouter.channelLabel("alerts", "normal"))
        assertEquals("alerts · 低", NotificationRouter.channelLabel("alerts", "low"))
    }

    // ---- ④ 深链 extra 枮值构造（SC2 契约） ----

    @Test
    fun `deep link extras keys and values`() {
        val extras = NotificationRouter.deepLinkExtras("ch2", "m_abc123")
        // 键恰 ph_channel/ph_wid（06-07 onNewIntent 消费契约）
        assertEquals(setOf("ph_channel", "ph_wid"), extras.keys)
        assertEquals("ch2", extras[NotificationRouter.EXTRA_CHANNEL])
        assertEquals("m_abc123", extras[NotificationRouter.EXTRA_WID])
        // 常量即字面键（Intent.putExtra 与消费方 getStringExtra 同源）
        assertEquals("ph_channel", NotificationRouter.EXTRA_CHANNEL)
        assertEquals("ph_wid", NotificationRouter.EXTRA_WID)
    }

    // ---- 源码结构断言（acceptance criteria：notify/cancel 配对 + IMMUTABLE） ----

    /** 源文件定位：测试工作目录 = app 模块目录（FixturesContractTest 同一通路）。 */
    private fun routerSource(): String {
        val file = File("src/main/kotlin/app/pushhub/android/service/NotificationRouter.kt")
        assertTrue("源文件应存在（测试工作目录 = packages/android/app）: ${file.absolutePath}", file.isFile)
        return file.readText()
    }

    @Test
    fun `notify and cancel pair on same tag and notif id`() {
        val src = routerSource()
        // notify(tag=wid, NOTIF_ID) 与 cancel(tag=wid, NOTIF_ID) 同常量配对（D-69）
        assertTrue("notify 必须使用 nm.notify(wid, NOTIF_ID", src.contains("nm.notify(wid, NOTIF_ID"))
        assertTrue("cancel 必须使用 nm.cancel(wid, NOTIF_ID", src.contains("nm.cancel(wid, NOTIF_ID"))
        // 禁 hash 转 Int 作通知 id（Pitfall 5）：wid.hashCode() 仅允许出现在
        // PendingIntent requestCode 一处
        val hashCodeUses = Regex("wid\\.hashCode\\(\\)").findAll(src).count()
        assertEquals("wid.hashCode() 仅 PendingIntent requestCode 一处", 1, hashCodeUses)
    }

    @Test
    fun `pending intent flags include immutable`() {
        val src = routerSource()
        // targetSdk 31+ 强制 IMMUTABLE（T-06-05-02）
        assertTrue(
            "PendingIntent 标志须含 FLAG_IMMUTABLE",
            src.contains("PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE"),
        )
    }

    // ---- 双计数器与接线测试（06-05 Task 2——两流分离不变量锁定，Pitfall 9 / D-61/D-63）----

    /** 计数假实现（ChannelWiring 依赖 Notifier 接口——JVM 脱真机计数）。 */
    private class FakeNotifier : Notifier {
        val shown = mutableListOf<String>()
        val cancelled = mutableListOf<String>()

        override fun show(
            channelId: String,
            channelName: String,
            wid: String,
            title: String?,
            text: String,
            priority: String,
            createdAt: Long,
        ) {
            shown += wid
        }

        override fun cancel(wid: String) {
            cancelled += wid
        }
    }

    private fun msg(seq: Long, priority: String = "normal"): MessageFrame = MessageFrame(
        v = 1,
        wid = "m_w$seq",
        seq = seq,
        text = "text $seq",
        priority = priority,
        answered = false,
        createdAt = 1_700_000_000 + seq,
    )

    private fun history(vararg seqs: Long): HistoryFrame = HistoryFrame(
        v = 1,
        messages = seqs.map { msg(it) },
        oldestKeptSeq = seqs.min(),
        hasMore = false,
    )

    private fun answered(wid: String): AnsweredFrame = AnsweredFrame(
        v = 1,
        wid = wid,
        seq = 0,
        answered = true,
        answeredAt = 1_700_000_100,
    )

    /** 权限全开的装配（blocked=false 基线）。 */
    private fun newWiring(
        runtimeGranted: Boolean = true,
        notificationsEnabled: Boolean = true,
        sdkInt: Int = 34,
        events: MutableList<HubEvent> = mutableListOf(),
    ): Triple<ChannelWiring, FakeNotifier, ChannelHub> {
        val hub = ChannelHub(
            runtimePermissionGranted = { runtimeGranted },
            notificationsEnabled = { notificationsEnabled },
            sdkInt = { sdkInt },
        )
        val notifier = FakeNotifier()
        val wiring = ChannelWiring(
            channelId = "ch1",
            channelName = "alerts",
            buffer = Buffer(),
            notifier = notifier,
            hub = hub,
            spikeLog = SpikeLog(Files.createTempDirectory("spike-test").toFile()),
            refreshBlocked = hub::refreshNotificationsBlocked,
            onStatusChanged = {},
        )
        // Unconfined 订阅使 tryEmit 同步送达（SharedFlow 无当前值语义——先挂监听）
        val job = CoroutineScope(Dispatchers.Unconfined).launch { hub.events.collect { events += it } }
        Runtime.getRuntime().addShutdownHook(Thread { job.cancel() })
        return Triple(wiring, notifier, hub)
    }

    @Test
    fun `dual counter mixed stream notifies exactly message count`() {
        // 混合 history+message 事件序列（06-03 AdapterResyncTest 同款序列形态）：
        // show 调用数恰等于 message 帧数、history 批次零通知——两流分离不变量。
        val (wiring, notifier, _) = newWiring()
        wiring.onStatus(Status.Online)
        wiring.onHistory(history(1, 2))
        wiring.onMessage(msg(3))
        wiring.onHistory(history(4, 5))
        wiring.onMessage(msg(6))
        wiring.onAnswered(answered("m_w3"))

        assertEquals("show 调用数恰等于 message 帧数", listOf("m_w3", "m_w6"), notifier.shown)
        assertEquals("answered 恰取消同 wid（D-69）", listOf("m_w3"), notifier.cancelled)
    }

    @Test
    fun `blocked notifications skip show but keep connection side effects`() {
        // Pitfall 4：POST_NOTIFICATIONS 拒绝（API 33+ 路径）——notify 跳过，
        // 缓冲/Hub 事件照常（连接功能不受影响），状态可查（UI 横幅数据源）。
        val events = mutableListOf<HubEvent>()
        val (wiring, notifier, hub) = newWiring(runtimeGranted = false, sdkInt = 34, events = events)
        wiring.onMessage(msg(1))

        assertEquals("被拒时零通知", 0, notifier.shown.size)
        assertTrue("notificationsBlocked 状态为真", hub.notificationsBlocked.value)
        assertEquals("Hub 事件照发（消息界面不受权限影响）", 1, events.size)

        // API 33- 路径：系统总开关禁用同样阻断（双路计算——ChannelHub 版本分流）。
        val (wiringOld, notifierOld, hubOld) = newWiring(notificationsEnabled = false, sdkInt = 31)
        wiringOld.onMessage(msg(1))
        assertEquals(0, notifierOld.shown.size)
        assertTrue(hubOld.notificationsBlocked.value)
    }

    @Test
    fun `onStatus publishes hub state and invokes callback`() {
        // onStatus → ChannelHub.channelStatus 写入 + Service 回调（FGS 汇总更新口）。
        var seen: Status? = null
        val hub = ChannelHub({ true }, { true }, { 34 })
        val wiring = ChannelWiring(
            channelId = "ch1",
            channelName = "alerts",
            buffer = Buffer(),
            notifier = FakeNotifier(),
            hub = hub,
            spikeLog = SpikeLog(Files.createTempDirectory("spike-test").toFile()),
            refreshBlocked = {},
            onStatusChanged = { seen = it },
        )
        wiring.onStatus(Status.Reconnecting)
        assertEquals(Status.Reconnecting, hub.channelStatus.value["ch1"])
        assertEquals(Status.Reconnecting, seen)
    }

    @Test
    fun `history and answered write buffer with no notification path`() {
        // 缓冲接线（D-62）：history 批次与 answered 原位更新进缓冲，全程零通知。
        val buffer = Buffer()
        val hub = ChannelHub({ true }, { true }, { 34 })
        val notifier = FakeNotifier()
        val wiring = ChannelWiring(
            channelId = "ch1",
            channelName = "alerts",
            buffer = buffer,
            notifier = notifier,
            hub = hub,
            spikeLog = SpikeLog(Files.createTempDirectory("spike-test").toFile()),
            refreshBlocked = {},
            onStatusChanged = {},
        )
        wiring.onHistory(history(1, 2, 3))
        wiring.onMessage(msg(4))
        wiring.onAnswered(answered("m_w4"))
        assertEquals(listOf(1L, 2L, 3L, 4L), buffer.seqs())
        assertTrue("answered 原位更新生效", buffer.snapshot().messages.last().answered)
        assertEquals("仅实时帧一条通知", listOf("m_w4"), notifier.shown)
    }

    @Test
    fun `onHistory branch has no notifier call in source`() {
        // 源码结构断言（acceptance criteria）：ChannelWiring.onHistory 分支零
        // 通知调用——结构性两流分离（非仅测试行为锁定）。
        val file = File("src/main/kotlin/app/pushhub/android/service/PushHubService.kt")
        assertTrue("源文件应存在（测试工作目录 = packages/android/app）", file.isFile)
        val src = file.readText()
        val match = Regex("override fun onHistory\\([\\s\\S]*?\\n    }").find(src)
        assertTrue("onHistory 覆写存在", match != null)
        val body = match!!.value
        assertFalse("onHistory 分支不得调用 notifier.show", body.contains("notifier."))
        assertFalse("onHistory 分支不得调用 router", body.contains("router."))
    }
}
